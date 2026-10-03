import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { BREAKER_POLICY } from '../../src/core/breaker.js';
import { hourOfWeek, isoWeekKey } from '../../src/core/slots.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { trackingRunJobId } from '../../src/lib/job-ids.js';
import { BUCKET_MS, bucketStartOf } from '../../src/lib/provider-health.js';
import { SCHEDULES } from '../../src/worker/runtime.js';
import { ledgerKey } from '../../src/worker/provider-call.js';
import { startRuntime, until, waitForJob } from '../helpers/worker.js';

const db = connectTestDb();
const fx = fixtures(db);
const uid = () => `t${randomBytes(5).toString('hex')}`;
const cleanups = [];

after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  await fx.cleanup();
  await db.close();
});

/** Start a runtime and make sure it is stopped at the end, even if a test fails. */
async function runtimeFor(options) {
  const h = await startRuntime({ db, ...options });
  cleanups.push(() => h.stop());
  return h;
}

const noopFor = (orgRow, over = {}) => ({ orgId: String(orgRow.org.id), ...over });

describe('waiting is not failing', () => {
  test('an empty rate-limit bucket delays the job; it runs later and no attempt is used up', async () => {
    const h = await runtimeFor();
    const org = await fx.org();
    // Empty the provider's bucket (the default limit is a burst of 10). The drain is stamped a minute in the
    // future, so the worker's FIRST attempt finds it empty however long the worker takes to pick the job up:
    // a plain drain refills in two seconds, which a busy machine (every test file running at once) can exceed.
    // That first attempt defers the job and restarts the bucket's clock, so the retry then finds tokens.
    await h.runtime.ctx.limiter.take('drained', { capacity: 10, refillPerSec: 5 }, 10, {
      nowMs: Date.now() + 60_000,
    });

    const id = uid();
    await h.runtime.jobs.add('system.noop', noopFor(org, { provider: 'drained' }), { jobId: id });
    const delayed = await waitForJob(h.queue('system'), id, ['delayed']);
    assert.equal(delayed.attemptsMade, 0);
    assert.equal((await org.scoped.usage.recent()).length, 0, 'nothing is charged while it waits');

    const done = await waitForJob(h.queue('system'), id, ['completed']);
    assert.equal(done.attemptsMade, 1, 'one attempt: the one that worked');
    assert.ok(done.attemptsStarted >= 2, 'it was started more than once, though');
    assert.equal((await org.scoped.usage.recent()).length, 1);
  });

  test('an organization never has more than its cap running, however many jobs it queues', async () => {
    const running = new Map();
    const most = new Map();
    const h = await runtimeFor({
      concurrencyOverride: { system: 12 }, // plenty of worker slots: only the per-organization cap holds jobs back
      handlers: {
        'system.noop': async (ctx, data, job) => {
          const { value } = await ctx.callProvider(
            job,
            {
              orgId: data.orgId,
              provider: 'noop',
              scope: 'system',
              idempotencyKey: ledgerKey('system', job),
            },
            async () => {
              running.set(data.orgId, (running.get(data.orgId) ?? 0) + 1);
              most.set(data.orgId, Math.max(most.get(data.orgId) ?? 0, running.get(data.orgId)));
              await sleep(250);
              running.set(data.orgId, running.get(data.orgId) - 1);
              return { value: 'ok', usage: { meter: 'other', unit: 'request', costUsd: '0.001' } };
            },
          );
          return value;
        },
      },
    });
    const busy = await fx.org();
    const quiet = await fx.org();
    const queue = h.queue('system');

    const busyIds = Array.from({ length: 9 }, uid);
    for (const id of busyIds) await h.runtime.jobs.add('system.noop', noopFor(busy), { jobId: id });
    const quietId = uid();
    await h.runtime.jobs.add('system.noop', noopFor(quiet), { jobId: quietId });

    const quietJob = await waitForJob(queue, quietId, ['completed']);
    const busyJobs = await Promise.all(busyIds.map((id) => waitForJob(queue, id, ['completed'])));

    const busyMost = most.get(String(busy.org.id));
    assert.ok(busyMost <= 4, `${busyMost} jobs ran at once for one organization (the cap is 4)`);
    assert.ok(busyMost >= 3, 'and it did run in parallel up to the cap');
    // The quiet organization wasn't stuck behind the busy one's backlog.
    const lastBusy = Math.max(...busyJobs.map((j) => j.finishedOn));
    assert.ok(
      quietJob.finishedOn < lastBusy,
      'the quiet organization finished before the busy one’s backlog',
    );
  });
});

describe('the daily spend cap', () => {
  let clock;
  let h;
  let queue;

  before(async () => {
    clock = new Date();
    h = await runtimeFor({ now: () => clock });
    queue = h.queue('system');
  });

  const run = async (name, data = {}) => {
    const id = uid();
    await h.runtime.jobs.add(name, data, { jobId: id });
    return (await waitForJob(queue, id, ['completed', 'failed'])).returnvalue;
  };
  const spend = async (org, costUsd) => {
    const id = uid();
    await h.runtime.jobs.add('system.noop', noopFor(org, { costUsd }), { jobId: id });
    return id;
  };
  const midnight = (date) =>
    new Date(Math.floor(date.getTime() / 86_400_000) * 86_400_000 + 86_400_000);

  test('reaching the cap pauses collection, tells the owner and the team, and holds the next job', async () => {
    const org = await fx.org();
    await fx.setOrgSpend(org.org.id, { capUsd: '0.05' });

    const first = await spend(org, '0.03');
    await waitForJob(queue, first, ['completed']);
    assert.equal(
      (await fx.organizationRow(org.org.id)).collection_paused_until,
      null,
      '0.03 is under the cap',
    );

    const second = await spend(org, '0.03');
    await waitForJob(queue, second, ['completed']); // the call that crosses the line still completes
    const row = await fx.organizationRow(org.org.id);
    assert.equal(row.collection_paused_until.toISOString(), midnight(clock).toISOString());

    const mine = await org.scoped.notifications.forUser(org.owner.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'spend_cap_reached');
    assert.equal(mine[0].channel, 'in_app');
    assert.equal(
      h.alerts.sent.filter((a) => a.key.startsWith(`spend_cap:${org.org.id}`)).length,
      1,
    );
    assert.equal(h.alerts.sent.at(-1).severity, 'critical');
    const log = await org.scoped.activity.recent();
    assert.ok(log.some((e) => e.action === 'collection.paused' && e.actor_type === 'system'));

    // The next job is held until the reset, not failed, and costs nothing.
    const third = await spend(org, '0.03');
    const held = await waitForJob(queue, third, ['delayed']);
    assert.equal(held.attemptsMade, 0);
    assert.equal((await org.scoped.usage.recent()).length, 2);
    await held.remove();
  });

  test('checking again, many times at once, pauses once and notifies once', async () => {
    const org = await fx.org();
    await fx.setOrgSpend(org.org.id, { capUsd: '0.01' });
    await org.scoped.usage.record({
      meter: 'other',
      providerCode: 'noop',
      unit: 'request',
      costUsd: '0.5',
      idempotencyKey: `race.${uid()}`,
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => h.runtime.ctx.spendGuard.check(org.org.id)),
    );
    assert.equal(results.filter((r) => r.changed).length, 1, 'only one check did the pausing');
    assert.equal((await org.scoped.notifications.forUser(org.owner.id)).length, 1);
    assert.equal(
      h.alerts.sent.filter((a) => a.key.startsWith(`spend_cap:${org.org.id}`)).length,
      1,
    );
  });

  test('every owner and admin is told; a viewer is not', async () => {
    const org = await fx.org();
    const admin = await fx.member(org.org, 'admin');
    const viewer = await fx.member(org.org, 'viewer');
    await fx.setOrgSpend(org.org.id, { capUsd: '0.01' });
    await org.scoped.usage.record({
      meter: 'other',
      providerCode: 'noop',
      unit: 'request',
      costUsd: '1',
      idempotencyKey: `who.${uid()}`,
    });
    await h.runtime.ctx.spendGuard.check(org.org.id);
    assert.equal((await org.scoped.notifications.forUser(org.owner.id)).length, 1);
    assert.equal((await org.scoped.notifications.forUser(admin.user.id)).length, 1);
    assert.equal((await org.scoped.notifications.forUser(viewer.user.id)).length, 0);
  });

  test('raising the cap resumes collection as soon as the guard runs', async () => {
    const org = await fx.org();
    await fx.setOrgSpend(org.org.id, { capUsd: '0.01' });
    await org.scoped.usage.record({
      meter: 'other',
      providerCode: 'noop',
      unit: 'request',
      costUsd: '0.2',
      idempotencyKey: `raise.${uid()}`,
    });
    await h.runtime.ctx.spendGuard.check(org.org.id);
    assert.ok((await fx.organizationRow(org.org.id)).collection_paused_until);

    await fx.setOrgSpend(org.org.id, { capUsd: '5.00' });
    const result = await run('guard.spend', { orgId: String(org.org.id) });
    assert.equal(result.resumed, 1);
    assert.equal((await fx.organizationRow(org.org.id)).collection_paused_until, null);
    const log = await org.scoped.activity.recent();
    assert.ok(log.some((e) => e.action === 'collection.resumed'));
  });

  test('the next UTC day starts at zero: the guard lifts the pause and the held job runs', async () => {
    const org = await fx.org();
    await fx.setOrgSpend(org.org.id, { capUsd: '0.05' });
    await waitForJob(queue, await spend(org, '0.06'), ['completed']); // over the cap in one go
    assert.ok((await fx.organizationRow(org.org.id)).collection_paused_until);

    const held = uid();
    await h.runtime.jobs.add('system.noop', noopFor(org, { costUsd: '0.01' }), { jobId: held });
    await waitForJob(queue, held, ['delayed']);

    clock = new Date(midnight(clock).getTime() + 60_000); // 00:01 the next day
    try {
      const result = await run('guard.spend', { orgId: String(org.org.id) });
      assert.equal(result.resumed, 1);
      assert.equal((await fx.organizationRow(org.org.id)).collection_paused_until, null);

      await (await queue.getJob(held)).promote();
      await waitForJob(queue, held, ['completed']);
      assert.equal((await org.scoped.usage.recent()).length, 2);
    } finally {
      clock = new Date();
    }
  });

  test('the 15-minute guard only touches organizations that need it', async () => {
    const calm = await fx.org();
    await fx.setOrgSpend(calm.org.id, { capUsd: '100' });
    await waitForJob(queue, await spend(calm, '0.01'), ['completed']);
    const result = await run('guard.spend', {});
    assert.ok(result.checked >= 1);
    assert.equal((await fx.organizationRow(calm.org.id)).collection_paused_until, null);
  });

  test('plans have their own default caps, and an organization with no plan gets the smallest', async () => {
    const org = await fx.org();
    await fx.setOrgSpend(org.org.id, { planCode: 'agency' });
    await org.scoped.usage.record({
      meter: 'other',
      providerCode: 'noop',
      unit: 'request',
      costUsd: '100',
      idempotencyKey: `plan.${uid()}`,
    });
    const agency = await h.runtime.ctx.spendGuard.check(org.org.id);
    assert.equal(agency.action, 'none', '$100 is under the Agency cap of $150');

    const starter = await fx.org(); // no plan
    await starter.scoped.usage.record({
      meter: 'other',
      providerCode: 'noop',
      unit: 'request',
      costUsd: '16',
      idempotencyKey: `plan.${uid()}`,
    });
    assert.equal((await h.runtime.ctx.spendGuard.check(starter.org.id)).action, 'pause');
  });
});

describe('provider health and the circuit breaker', () => {
  let clock;
  let h;
  let queue;
  const record = async (provider, engine, outcomes, extra = {}) => {
    for (const outcome of outcomes) {
      await h.runtime.ctx.health.record(provider, engine, {
        outcome,
        ms: 100,
        nowMs: clock.getTime(),
        ...extra,
      });
    }
  };
  const ok = (n) => Array(n).fill('success');
  const bad = (n) => Array(n).fill('failure');
  const guard = async () => {
    const id = uid();
    await h.runtime.jobs.add('guard.provider_health', {}, { jobId: id });
    return (await waitForJob(queue, id, ['completed', 'failed'])).returnvalue;
  };
  const stateOf = async (provider, engine) =>
    (await h.runtime.ctx.health.state(provider, engine)).state;

  before(async () => {
    clock = new Date();
    h = await runtimeFor({ now: () => clock });
    queue = h.queue('system');
  });

  test('more than 10% failures over 15 minutes trips the breaker and alerts the team', async () => {
    await record('flaky', 'e1', [...ok(20), ...bad(10)]);
    const result = await guard();
    assert.equal(result.opened, 1);
    assert.equal(await stateOf('flaky', 'e1'), 'open');
    const alert = h.alerts.sent.find((a) => a.key === 'breaker.open:flaky:e1');
    assert.equal(alert.severity, 'critical');
  });

  test('exactly 10%, or too few requests, does not trip it', async () => {
    await record('steady', 'e1', [...ok(90), ...bad(10)]);
    await record('quiet', 'e1', bad(5));
    await guard();
    assert.equal(await stateOf('steady', 'e1'), 'closed');
    assert.equal(await stateOf('quiet', 'e1'), 'closed');
  });

  test('timeouts count as failures', async () => {
    await record('slow', 'e1', [...ok(15), ...Array(5).fill('timeout')]);
    await guard();
    assert.equal(await stateOf('slow', 'e1'), 'open');
  });

  test('an open breaker holds jobs for that provider without failing them', async () => {
    const org = await fx.org();
    const id = uid();
    await h.runtime.jobs.add('system.noop', noopFor(org, { provider: 'flaky', engine: 'e1' }), {
      jobId: id,
    });
    const held = await waitForJob(queue, id, ['delayed']);
    assert.equal(held.attemptsMade, 0);
    assert.equal((await org.scoped.usage.recent()).length, 0);
    await held.remove();
  });

  test('the breaker is per engine: the same provider is fine for another engine', async () => {
    assert.equal(await h.runtime.ctx.health.admit('flaky', 'e1'), 'deny');
    assert.equal(await h.runtime.ctx.health.admit('flaky', 'e2'), 'allow');
  });

  test('after the cooldown it probes, lets one test request through at a time, and closes on good probes', async () => {
    clock = new Date(clock.getTime() + BREAKER_POLICY.cooldownMs + 1000);
    try {
      const half = await guard();
      assert.equal(half.halfOpened >= 1, true);
      assert.equal(await stateOf('flaky', 'e1'), 'half_open');

      assert.equal(await h.runtime.ctx.health.admit('flaky', 'e1'), 'probe');
      assert.equal(await h.runtime.ctx.health.admit('flaky', 'e1'), 'deny', 'one probe at a time');

      await record('flaky', 'e1', ok(3), { probe: true });
      const closed = await guard();
      assert.equal(closed.closed, 1);
      assert.equal(await stateOf('flaky', 'e1'), 'closed');
      assert.equal(await h.runtime.ctx.health.admit('flaky', 'e1'), 'allow');
      assert.ok(h.alerts.sent.some((a) => a.key === 'breaker.closed:flaky:e1'));
    } finally {
      clock = new Date();
    }
  });

  test('a failed probe opens it again', async () => {
    await record('wobbly', 'e1', [...ok(20), ...bad(10)]);
    await guard();
    assert.equal(await stateOf('wobbly', 'e1'), 'open');
    clock = new Date(clock.getTime() + BREAKER_POLICY.cooldownMs + 1000);
    try {
      await guard();
      assert.equal(await stateOf('wobbly', 'e1'), 'half_open');
      await record('wobbly', 'e1', ['failure'], { probe: true });
      await guard();
      assert.equal(await stateOf('wobbly', 'e1'), 'open');
    } finally {
      clock = new Date();
    }
  });

  test('a call that fails through the worker is counted against the provider', async () => {
    const org = await fx.org();
    const id = uid();
    await h.runtime.jobs.add('system.noop', noopFor(org, { provider: 'counted', failTimes: 1 }), {
      jobId: id,
    });
    await waitForJob(queue, id, ['completed']);
    const bucket = await h.runtime.ctx.health.bucket('counted', '', bucketStartOf(Date.now()));
    assert.equal(bucket.failures, 1);
    assert.equal(bucket.successes, 1);
    assert.equal(bucket.requests, 2);
  });

  test('five-minute buckets are copied to MySQL for real providers, with latency percentiles', async () => {
    const start = bucketStartOf(clock.getTime());
    cleanups.push(() =>
      fx.deleteProviderHealth({
        providerCode: 'dataforseo',
        from: new Date(start - 3_600_000),
        to: new Date(start + 3_600_000),
      }),
    );
    for (const [ms, outcome] of [
      [100, 'success'],
      [200, 'success'],
      [300, 'success'],
      [400, 'failure'],
    ]) {
      await h.runtime.ctx.health.record('dataforseo', 'chatgpt', {
        outcome,
        ms,
        costMicros: 1500,
        nowMs: clock.getTime(),
      });
    }
    await guard();
    const rows = await db.system.providerHealth.recent({ providerCode: 'dataforseo' });
    const row = rows.find((r) => r.bucket_start.getTime() === start && r.engine_code === 'chatgpt');
    assert.ok(row, 'the bucket was written');
    assert.equal(row.requests, 4);
    assert.equal(row.successes, 3);
    assert.equal(row.failures, 1);
    assert.equal(row.p50_ms, 200);
    assert.equal(row.p95_ms, 400);
    assert.equal(row.cost_usd.toString(), '0.006');
    assert.equal(row.breaker_state, 'closed');

    // Running the guard again refreshes the same row instead of adding another.
    await h.runtime.ctx.health.record('dataforseo', 'chatgpt', {
      outcome: 'success',
      ms: 50,
      nowMs: clock.getTime(),
    });
    await guard();
    const after = (await db.system.providerHealth.recent({ providerCode: 'dataforseo' })).filter(
      (r) => r.bucket_start.getTime() === start && r.engine_code === 'chatgpt',
    );
    assert.equal(after.length, 1);
    assert.equal(after[0].requests, 5);
  });

  test('a provider that is not in the providers table gets no history row, and no error', async () => {
    await record('unlisted', 'e1', ok(3));
    const result = await guard();
    assert.ok(result.pairs >= 1);
    assert.equal((await db.system.providerHealth.recent({ providerCode: 'unlisted' })).length, 0);
  });

  test('window size: only the last 15 minutes count', async () => {
    const old = clock.getTime() - 40 * 60_000;
    for (let i = 0; i < 30; i += 1) {
      await h.runtime.ctx.health.record('ancient', 'e1', { outcome: 'failure', nowMs: old });
    }
    await record('ancient', 'e1', ok(25));
    assert.deepEqual(await h.runtime.ctx.health.window('ancient', 'e1', clock.getTime()), {
      requests: 25,
      failures: 0,
    });
    await guard();
    assert.equal(
      await stateOf('ancient', 'e1'),
      'closed',
      'failures from 40 minutes ago are history',
    );
    assert.ok(BUCKET_MS === 300_000);
  });
});

describe('the hourly scheduler', () => {
  // Sunday 05:30 UTC, ISO week 40 of 2026: hour of the week 149. Nothing else in the test database is
  // scheduled for that hour.
  const at = new Date('2026-10-04T05:30:00Z');
  const HOUR = hourOfWeek(at);
  const WEEK = isoWeekKey(at);

  test('starts each due project once per week, however many times the tick fires', async () => {
    const started = [];
    const h = await runtimeFor({
      queueNames: ['system', 'collect'],
      now: () => at,
      handlers: {
        'tracking.start': async (_ctx, data) => {
          started.push(data);
          return { ok: true };
        },
      },
    });
    const org = await fx.org();
    const due = await fx.project(org.org.id, 'Due now', { status: 'active', slotHour: HOUR });
    const missed = await fx.project(org.org.id, 'Missed an hour ago', {
      status: 'active',
      slotHour: HOUR - 2,
    });
    await fx.project(org.org.id, 'Not active yet', { status: 'onboarding', slotHour: HOUR });
    await fx.project(org.org.id, 'Archived', { status: 'archived', slotHour: HOUR });
    await fx.project(org.org.id, 'Another hour', { status: 'active', slotHour: HOUR + 1 });

    // Five ticks at the same moment, as if the scheduler double-fired.
    const ids = Array.from({ length: 5 }, uid);
    for (const id of ids) await h.runtime.jobs.add('scheduler.tick', {}, { jobId: id });
    const results = await Promise.all(
      ids.map(async (id) => (await waitForJob(h.queue('system'), id, ['completed'])).returnvalue),
    );
    assert.ok(
      results.every((r) => r.due === 2),
      JSON.stringify(results),
    );

    await until(() => started.length >= 2, { message: 'the runs never started' });
    await sleep(300); // a duplicate, if there were one, would have arrived by now
    assert.equal(started.length, 2, 'two projects, one run each');
    assert.deepEqual(
      started.map((s) => s.projectId).sort(),
      [String(due.id), String(missed.id)].sort(),
    );
    assert.ok(started.every((s) => s.weekKey === WEEK && s.orgId === String(org.org.id)));

    // The job for a project and week has one fixed ID.
    const job = await h.queue('collect').getJob(trackingRunJobId(due.id, WEEK));
    assert.ok(job, trackingRunJobId(due.id, WEEK));
    assert.equal(job.data.projectId, String(due.id));

    // A tick an hour later looks back over the same hours. The project whose hour has now come starts, once;
    // the two that already ran are not started again.
    const later = uid();
    await h.runtime.jobs.add(
      'scheduler.tick',
      { at: new Date(at.getTime() + 3_600_000).toISOString() },
      { jobId: later },
    );
    await waitForJob(h.queue('system'), later, ['completed']);
    await sleep(300);
    assert.equal(started.length, 3, 'only the newly due project was added');
    const perProject = Object.groupBy(started, (x) => x.projectId);
    assert.ok(
      Object.values(perProject).every((runs) => runs.length === 1),
      'no project ran twice',
    );
    assert.ok(perProject[String(due.id)] && perProject[String(missed.id)]);
  });

  test('an active project that is due gets its tracking.start job, with the week in its ID', async () => {
    // No worker on the collect queue here: the job stays waiting, so its ID and payload can be read.
    const h = await runtimeFor({ queueNames: ['system'], now: () => at });
    const org = await fx.org();
    const due = await fx.project(org.org.id, 'Waiting for its run', {
      status: 'active',
      slotHour: HOUR,
    });
    const id = uid();
    await h.runtime.jobs.add('scheduler.tick', {}, { jobId: id });
    const result = (await waitForJob(h.queue('system'), id, ['completed'])).returnvalue;
    assert.ok(result.due >= 1);
    assert.equal(result.started, result.due);
    const job = await h.queue('collect').getJob(trackingRunJobId(due.id, WEEK));
    assert.ok(job, 'the run was queued under its fixed ID');
    assert.deepEqual(job.data, {
      orgId: String(org.org.id),
      projectId: String(due.id),
      weekKey: WEEK,
    });
  });
});

describe('recurring jobs and shutdown', () => {
  test('the hourly tick and both guards are registered, once, however many times the worker starts', async () => {
    const h = await runtimeFor({ queueNames: [], schedule: true }); // no workers: nothing runs
    await h.runtime.start({ schedule: true });
    await h.runtime.start({ schedule: true });
    const schedulers = await h.queue('system').getJobSchedulers();
    assert.equal(schedulers.length, SCHEDULES.length);
    assert.deepEqual(schedulers.map((s) => s.name).sort(), [
      'guard.provider_health',
      'guard.spend',
      'scheduler.tick',
    ]);
    const tick = schedulers.find((s) => s.name === 'scheduler.tick');
    assert.equal(tick.pattern, '0 * * * *');
    assert.equal(tick.tz, 'UTC');
    assert.equal(schedulers.find((s) => s.name === 'guard.spend').every, 15 * 60_000);
    assert.equal(schedulers.find((s) => s.name === 'guard.provider_health').every, 5 * 60_000);
  });

  test('shutting down waits for the job that is running, and takes no new ones', async () => {
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const h = await startRuntime({
      db,
      handlers: {
        'system.noop': async () => {
          began();
          await sleep(500);
          return { finished: true };
        },
      },
    });
    const id = uid();
    const org = await fx.org();
    await h.runtime.jobs.add('system.noop', noopFor(org), { jobId: id });
    await started;
    await h.runtime.stop(); // returns only once the running job is done

    const reader = new Queue('system', { connection: h.redis, prefix: h.prefix });
    try {
      const job = await reader.getJob(id);
      assert.equal(await job.getState(), 'completed');
      assert.deepEqual(job.returnvalue, { finished: true });
    } finally {
      await reader.close();
      await h.redis.quit().catch(() => {});
    }
  });
});
