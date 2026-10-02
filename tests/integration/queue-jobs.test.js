import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { fromMicros } from '../../src/core/spend.js';
import { bucketStartOf } from '../../src/lib/provider-health.js';
import { startRuntime, until, waitForJob } from '../helpers/worker.js';

/**
 * The queue, end to end, against real Redis and real MySQL: duplicate job IDs, retries and the dead-letter set,
 * the ledger staying exact across retries, and the whole path a job takes (BUILD_PLAN Phase 3 tests).
 */
const db = connectTestDb();
const fx = fixtures(db);
const uid = () => `t${randomBytes(5).toString('hex')}`;

let org;
let other;
let h; // the running worker
let queue;

before(async () => {
  org = await fx.org();
  other = await fx.org();
  h = await startRuntime({ db });
  queue = h.queue('system');
});

after(async () => {
  await h.stop();
  await fx.cleanup();
  await db.close();
});

const payload = (over = {}) => ({ orgId: String(org.org.id), ...over });
const rowsFor = async (scoped, jobId) =>
  (await scoped.usage.recent({ limit: 500 })).filter((r) => r.idempotency_key.includes(jobId));

describe('the same job ID is one job, not two', () => {
  test('adding it twice leaves a single job in the queue', async () => {
    const id = uid();
    const first = await h.runtime.jobs.add('system.noop', payload(), {
      jobId: id,
      delayMs: 60_000,
    });
    const second = await h.runtime.jobs.add('system.noop', payload(), {
      jobId: id,
      delayMs: 60_000,
    });
    assert.equal(second.id, first.id);
    const delayed = await queue.getDelayed();
    assert.equal(delayed.filter((j) => j.id === id).length, 1);
    await first.remove();
  });

  test('and it still counts as a duplicate after it has finished: the work is not repeated', async () => {
    const id = uid();
    await h.runtime.jobs.add('system.noop', payload(), { jobId: id });
    await waitForJob(queue, id, ['completed']);
    await h.runtime.jobs.add('system.noop', payload(), { jobId: id });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await rowsFor(org.scoped, id)).length, 1, 'one ledger row, so it ran once');
  });

  test('a hundred simultaneous adds of one ID make one job', async () => {
    const id = uid();
    await Promise.all(
      Array.from({ length: 100 }, () =>
        h.runtime.jobs.add('system.noop', payload(), { jobId: id, delayMs: 60_000 }),
      ),
    );
    const delayed = await queue.getDelayed();
    assert.equal(delayed.filter((j) => j.id === id).length, 1);
    await (await queue.getJob(id)).remove();
  });

  test('different IDs are different jobs', async () => {
    const [a, b] = [uid(), uid()];
    await h.runtime.jobs.add('system.noop', payload(), { jobId: a });
    await h.runtime.jobs.add('system.noop', payload(), { jobId: b });
    await waitForJob(queue, a, ['completed']);
    await waitForJob(queue, b, ['completed']);
  });

  test('IDs BullMQ would refuse are refused up front, with a clear reason', async () => {
    await assert.rejects(
      h.runtime.jobs.add('system.noop', payload(), { jobId: 'a:b' }),
      /Not usable/,
    );
    await assert.rejects(
      h.runtime.jobs.add('system.noop', payload(), { jobId: '12345' }),
      /digits/,
    );
  });
});

describe('retries', () => {
  test('a job that always fails is tried five times with growing waits, then lands in the failed set', async () => {
    const attempts = [];
    const failing = await startRuntime({
      db,
      handlers: {
        'system.noop': async () => {
          attempts.push(Date.now());
          throw new Error('provider exploded');
        },
      },
      retry: { baseMs: 40, capMs: 10_000 },
    });
    try {
      const id = uid();
      await failing.runtime.jobs.add('system.noop', payload(), { jobId: id });
      const job = await waitForJob(failing.queue('system'), id, ['failed']);

      assert.equal(attempts.length, 5, 'exactly five attempts');
      assert.equal(job.attemptsMade, 5);
      assert.match(job.failedReason, /provider exploded/);

      // Backoff: the wait after failure n is between half of base*2^(n-1) and that ceiling (40, 80, 160, 320 ms).
      const gaps = attempts.slice(1).map((t, i) => t - attempts[i]);
      gaps.forEach((gap, i) => {
        const ceiling = 40 * 2 ** i;
        assert.ok(
          gap >= ceiling / 2 - 5,
          `wait ${i + 1} was ${gap} ms, under the ${ceiling / 2} ms floor`,
        );
      });
      assert.ok(gaps[3] > gaps[0], 'later waits are longer than earlier ones');

      const failedSet = await failing.queue('system').getFailed();
      assert.ok(
        failedSet.some((j) => j.id === id),
        'it is in the dead-letter set',
      );
      assert.equal(job.opts.removeOnFail.age, 30 * 24 * 60 * 60, 'and stays there for 30 days');
    } finally {
      await failing.stop();
    }
  });

  test('a job that fails twice and then works completes, once', async () => {
    const id = uid();
    await h.runtime.jobs.add('system.noop', payload({ failTimes: 2 }), { jobId: id });
    const job = await waitForJob(queue, id, ['completed']);
    assert.equal(job.attemptsMade, 3, 'two failures, then the attempt that worked');
    assert.equal((await rowsFor(org.scoped, id)).length, 1);
  });

  test('a job that needs more than five attempts fails, and writes nothing to the ledger', async () => {
    const id = uid();
    await h.runtime.jobs.add('system.noop', payload({ failTimes: 6 }), { jobId: id });
    const job = await waitForJob(queue, id, ['failed']);
    assert.equal(job.attemptsMade, 5);
    assert.equal((await rowsFor(org.scoped, id)).length, 0, 'a call that failed was not billed');
  });

  test('a payload that can never work fails at once, without retries', async () => {
    const id = uid();
    await queue.add('system.noop', { orgId: 'not-an-id' }, { jobId: id });
    const job = await waitForJob(queue, id, ['failed']);
    assert.equal(job.attemptsMade, 1);
    assert.match(job.failedReason, /Bad payload/);
  });

  test('a job name nobody handles fails at once too', async () => {
    const id = uid();
    await queue.add('system.does_not_exist', {}, { jobId: id });
    const job = await waitForJob(queue, id, ['failed']);
    assert.equal(job.attemptsMade, 1);
    assert.match(job.failedReason, /Unexpected job/);
  });

  test('a failed job can be retried by hand (the admin console’s retry button)', async () => {
    const id = uid();
    await queue.add('system.noop', { orgId: 'not-an-id' }, { jobId: id });
    const job = await waitForJob(queue, id, ['failed']);
    await job.retry();
    const again = await until(async () => {
      const j = await queue.getJob(id);
      return j && j.attemptsStarted >= 2 && (await j.getState()) === 'failed' ? j : null;
    });
    assert.ok(again);
  });
});

describe('the usage ledger is exact across retries', () => {
  test('a job that fails AFTER its ledger row was written does not count twice when it retries', async () => {
    const id = uid();
    await h.runtime.jobs.add(
      'system.noop',
      payload({ failAfterLedger: true, costUsd: '0.123456' }),
      {
        jobId: id,
      },
    );
    const job = await waitForJob(queue, id, ['completed']);
    assert.equal(job.attemptsMade, 2, 'it failed once and ran again');

    const rows = await rowsFor(org.scoped, id);
    assert.equal(rows.length, 1, 'one row, not two');
    assert.equal(rows[0].cost_usd.toString(), '0.123456');
    assert.equal(rows[0].org_id, org.org.id);
    assert.equal(rows[0].provider_code, 'noop');
  });

  test('the key is derived from the job, so two different jobs each get their own row', async () => {
    const [a, b] = [uid(), uid()];
    await h.runtime.jobs.add('system.noop', payload({ costUsd: '0.5' }), { jobId: a });
    await h.runtime.jobs.add('system.noop', payload({ costUsd: '0.5' }), { jobId: b });
    await waitForJob(queue, a, ['completed']);
    await waitForJob(queue, b, ['completed']);
    assert.equal((await rowsFor(org.scoped, a)).length, 1);
    assert.equal((await rowsFor(org.scoped, b)).length, 1);
  });

  test('writing the same key twice returns the first row, and totals stay exact', async () => {
    const entry = {
      meter: 'other',
      providerCode: 'noop',
      unit: 'request',
      costUsd: '0.000123',
      idempotencyKey: `direct.${uid()}`,
    };
    const first = await other.scoped.usage.record(entry);
    assert.equal(first.recorded, true);
    for (let i = 0; i < 4; i += 1) {
      const again = await other.scoped.usage.record(entry);
      assert.equal(again.recorded, false);
      assert.equal(again.entry.id, first.entry.id);
    }
    const spent = await other.scoped.usage.spentSinceMicros(new Date(Date.now() - 60_000));
    assert.equal(fromMicros(spent), '0.000123');
  });

  test('a key that belongs to another organization is a clash, not a silent "already written"', async () => {
    const key = `shared.${uid()}`;
    const base = { meter: 'other', providerCode: 'noop', unit: 'request', costUsd: '0.1' };
    await org.scoped.usage.record({ ...base, idempotencyKey: key });
    await assert.rejects(
      other.scoped.usage.record({ ...base, idempotencyKey: key }),
      (e) => e.code === 'KEY_IN_USE',
    );
  });
});

describe('a hand-triggered no-op job runs the whole path (Phase 3 exit criterion)', () => {
  test('queue, retries, rate limit, provider health and ledger, for two organizations at once', async () => {
    const projectA = await fx.project(org.org.id);
    const projectB = await fx.project(other.org.id);
    const ids = [uid(), uid()];
    await h.runtime.jobs.add(
      'system.noop',
      { orgId: String(org.org.id), projectId: String(projectA.id), failTimes: 2, costUsd: '0.25' },
      { jobId: ids[0] },
    );
    await h.runtime.jobs.add(
      'system.noop',
      { orgId: String(other.org.id), projectId: String(projectB.id), costUsd: '0.5' },
      { jobId: ids[1] },
    );
    const [jobA, jobB] = await Promise.all(ids.map((id) => waitForJob(queue, id, ['completed'])));

    assert.equal(jobA.attemptsMade, 3, 'A failed twice, then worked');
    assert.equal(jobB.attemptsMade, 1, 'B worked first time');
    assert.deepEqual(jobA.returnvalue, { ok: true });

    const [rowA] = await rowsFor(org.scoped, ids[0]);
    const [rowB] = await rowsFor(other.scoped, ids[1]);
    assert.equal(rowA.project_id, projectA.id, 'each ledger row carries its own project');
    assert.equal(rowB.project_id, projectB.id);
    assert.equal(rowA.org_id, org.org.id);
    assert.equal(rowB.org_id, other.org.id);
    assert.equal((await rowsFor(org.scoped, ids[1])).length, 0, 'and neither leaks into the other');

    // The circuit breaker's numbers saw all of it: 2 failures + 1 + 1 successes for the noop provider.
    const bucket = await h.runtime.ctx.health.bucket('noop', '', bucketStartOf(Date.now()));
    assert.ok(bucket.requests >= 4, `${bucket.requests} requests recorded`);
    assert.ok(bucket.failures >= 2);
    assert.ok(bucket.successes >= 2);
  });

  test('the provider’s token bucket was used', async () => {
    const before = await h.runtime.ctx.limiter.take('noop', { capacity: 50, refillPerSec: 50 }, 1);
    assert.ok(before.tokens < 50, 'earlier calls had already drawn tokens');
  });
});
