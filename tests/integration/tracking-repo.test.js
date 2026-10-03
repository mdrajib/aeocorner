import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DomainError, RUNS_NOW_PLACEHOLDER } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/**
 * The repositories behind tracking (Milestone 4) against the real database: a slot is one run, a run only moves forward,
 * an answer that was collected but never read is "couldn't check", the allowance for "check now" cannot be overspent,
 * and a change is reported once. The orchestration on top of these is tests/integration/tracking-run.test.js.
 */

const db = connectTestDb();
const fx = fixtures(db);
let org;
const scoped = () => db.forOrg(org.org.id);

before(async () => {
  org = await fx.org();
});

after(async () => {
  await fx.cleanup();
  await db.close();
});

const refuses = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof DomainError && e.code === code);

describe('runs.start', () => {
  test('a slot is one run per project: asking again returns the same run', async () => {
    const project = await fx.project(org.org.id);
    const a = await scoped().runs.start({
      projectId: project.id,
      slotKey: '2026-W40',
      trigger: 'schedule',
    });
    const b = await scoped().runs.start({
      projectId: project.id,
      slotKey: '2026-W40',
      trigger: 'schedule',
    });
    assert.deepEqual([a.created, b.created, b.run.id], [true, false, a.run.id]);
    const c = await scoped().runs.start({
      projectId: project.id,
      slotKey: '2026-W41',
      trigger: 'schedule',
    });
    assert.equal(c.created, true);
    assert.deepEqual(
      [a.run.status, a.run.extraction_mode, a.run.tasks_planned],
      ['queued', 'batch', 0],
    );
  });

  test('ten starts at once for one slot make one run', async () => {
    const project = await fx.project(org.org.id);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        scoped().runs.start({ projectId: project.id, slotKey: '2026-W42', trigger: 'schedule' }),
      ),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.run.id)).size, 1);
    assert.equal((await scoped().runs.recent(project.id)).length, 1);
  });

  test('records the Brand Kit version it ran with and who asked', async () => {
    const project = await fx.project(org.org.id);
    await scoped().brandKits.save(project.id, {
      kit: { identity: { brandName: 'Kit Co', domains: [] } },
      source: 'edited',
      expectedVersion: null,
    });
    const { run } = await scoped().runs.start({
      projectId: project.id,
      slotKey: 'm-ABC',
      trigger: 'manual',
      extractionMode: 'sync',
      requestedByUserId: org.owner.id,
    });
    assert.equal(run.brand_profile_version, 1);
    assert.equal(run.extraction_mode, 'sync');
    assert.equal(run.requested_by_user_id, org.owner.id);
    assert.equal(run.run_date.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
  });

  test('refuses a bad trigger, mode or slot, an unknown project, and a paused or archived one', async () => {
    const project = await fx.project(org.org.id);
    const ok = { projectId: project.id, slotKey: '2026-W43', trigger: 'schedule' };
    await refuses(scoped().runs.start({ ...ok, trigger: 'sometimes' }), 'INVALID');
    await refuses(scoped().runs.start({ ...ok, extractionMode: 'fast' }), 'INVALID');
    await refuses(scoped().runs.start({ ...ok, slotKey: 'has space' }), 'INVALID');
    await refuses(scoped().runs.start({ ...ok, slotKey: 'x'.repeat(41) }), 'INVALID');
    await refuses(scoped().runs.start({ ...ok, projectId: 999_999_999n }), 'PROJECT_NOT_IN_ORG');
    const paused = await fx.project(org.org.id, 'Paused', { status: 'paused' });
    await refuses(scoped().runs.start({ ...ok, projectId: paused.id }), 'PROJECT_NOT_TRACKABLE');
    assert.deepEqual(await scoped().runs.recent(paused.id), []);
  });
});

describe('a run moves forward only', () => {
  test('begin() only takes a queued run; advance() never goes back; finish() happens once', async () => {
    const project = await fx.project(org.org.id);
    const { run } = await scoped().runs.start({
      projectId: project.id,
      slotKey: 'm-ONE',
      trigger: 'manual',
    });
    assert.equal(
      await scoped().runs.advance(run.id, 'rolling_up'),
      true,
      'a queued run can jump ahead',
    );
    assert.equal(
      await scoped().runs.begin(run.id, { promptsCount: 1, tasksPlanned: 3 }),
      false,
      'but cannot be planned any more',
    );
    assert.equal(await scoped().runs.advance(run.id, 'extracting'), false, 'and never goes back');
    assert.equal((await scoped().runs.get(run.id)).status, 'rolling_up');
    assert.equal(
      await scoped().runs.finish(run.id, 'partial', { errorSummary: { failed: 1 } }),
      true,
    );
    assert.equal(await scoped().runs.finish(run.id, 'complete'), false, 'a finished run is final');
    assert.equal(await scoped().runs.advance(run.id, 'rolling_up'), false);
    const done = await scoped().runs.get(run.id);
    assert.deepEqual([done.status, done.error_summary], ['partial', { failed: 1 }]);
    assert.ok(done.finished_at);
    await assert.rejects(scoped().runs.advance(run.id, 'complete'), DomainError);
    await assert.rejects(scoped().runs.finish(run.id, 'rolling_up'), DomainError);
  });
});

describe('settle', () => {
  test('an answer that was collected but not read is counted as one we couldn’t check', async () => {
    const project = await fx.project(org.org.id);
    await fx.entity(project, { kind: 'brand', name: 'Settle Co' });
    const prompt = await fx.prompt(project);
    const { run } = await scoped().runs.start({
      projectId: project.id,
      slotKey: 'm-TWO',
      trigger: 'manual',
    });
    await fx.collectedAnswer(run, prompt, { sampleIdx: 0 }); // ok, extraction still pending
    await fx.collectedAnswer(run, prompt, { sampleIdx: 1 });
    const outcome = await scoped().runs.settle(run.id);
    assert.deepEqual(
      [outcome.status, outcome.tasksPlanned, outcome.tasksOk, outcome.tasksFailed],
      ['failed', 2, 0, 2],
    );
    const [cell] = await scoped().runs.cells(run.id);
    assert.deepEqual([cell.status, cell.nOk, cell.nFailed, cell.cellScore], ['failed', 0, 2, null]);
    assert.equal((await scoped().runs.get(run.id)).status, 'rolling_up');
  });

  test('settling twice writes the same cells once', async () => {
    const project = await fx.project(org.org.id);
    await fx.entity(project, { kind: 'brand', name: 'Twice Co' });
    const prompt = await fx.prompt(project);
    const { run } = await scoped().runs.start({
      projectId: project.id,
      slotKey: 'm-THREE',
      trigger: 'manual',
    });
    await fx.collectedAnswer(run, prompt);
    await scoped().runs.settle(run.id);
    const first = await scoped().runs.cells(run.id);
    await scoped().runs.settle(run.id);
    assert.deepEqual(await scoped().runs.cells(run.id), first);
    await scoped().runs.finish(run.id, 'failed');
    assert.deepEqual(await scoped().runs.settle(run.id), { repeated: true, status: 'failed' });
  });

  test('a project without a brand cannot be settled', async () => {
    const project = await fx.project(org.org.id);
    const { run } = await scoped().runs.start({
      projectId: project.id,
      slotKey: 'm-FOUR',
      trigger: 'manual',
    });
    await refuses(scoped().runs.settle(run.id), 'NO_BRAND');
  });
});

describe('startTracking', () => {
  test('needs a question and an engine; switches on once; refuses a paused project', async () => {
    const project = await fx.project(org.org.id);
    await refuses(scoped().projects.startTracking(project.id), 'NOT_READY');
    await fx.prompt(project);
    await refuses(scoped().projects.startTracking(project.id), 'NOT_READY');
    await fx.engines(project, ['perplexity']);
    const first = await scoped().projects.startTracking(project.id, { actorUserId: org.owner.id });
    assert.equal(first.changed, true);
    assert.equal((await fx.projectRow(project.id)).status, 'active');
    const second = await scoped().projects.startTracking(project.id);
    assert.equal(second.changed, false);
    const log = (await scoped().activity.recent()).filter(
      (a) => a.action === 'project.tracking_started',
    );
    assert.equal(
      log.filter((a) => a.target_id === String(project.id) || a.target_id === project.id).length,
      1,
    );

    const paused = await fx.project(org.org.id, 'Paused too', { status: 'paused' });
    await refuses(scoped().projects.startTracking(paused.id), 'PROJECT_NOT_TRACKABLE');
  });
});

describe('quota: "check now"', () => {
  test('ten clicks at once take exactly the allowance, no more', async () => {
    const other = await fx.org();
    const now = new Date('2026-11-10T00:00:00Z');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => other.scoped.quota.takeRunNow({ now })),
    );
    assert.equal(results.filter((r) => r.allowed).length, RUNS_NOW_PLACEHOLDER);
    assert.deepEqual(await other.scoped.quota.runNowUsage({ now }), {
      used: RUNS_NOW_PLACEHOLDER,
      limit: RUNS_NOW_PLACEHOLDER,
    });
    const refused = await other.scoped.quota.takeRunNow({ now });
    assert.deepEqual([refused.allowed, refused.used], [false, RUNS_NOW_PLACEHOLDER]);
  });

  test('a new month starts at zero, and a give-back never goes below zero', async () => {
    const other = await fx.org();
    const october = new Date('2026-10-31T23:59:00Z');
    const november = new Date('2026-11-01T00:01:00Z');
    await other.scoped.quota.takeRunNow({ now: october });
    assert.equal((await other.scoped.quota.runNowUsage({ now: november })).used, 0);
    assert.equal((await other.scoped.quota.takeRunNow({ now: november })).used, 1);
    await other.scoped.quota.returnRunNow({ now: november });
    await other.scoped.quota.returnRunNow({ now: november });
    assert.equal((await other.scoped.quota.runNowUsage({ now: november })).used, 0);
    assert.equal(
      (await other.scoped.quota.runNowUsage({ now: october })).used,
      1,
      'October kept its own count',
    );
  });
});

describe('changes.detect', () => {
  const weeks = ({ before, after, partialAfter = 0 }) => {
    const rows = [];
    for (const date of ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']) {
      rows.push({ date, engine: 'perplexity', entityKind: 'brand', ...before });
    }
    for (const date of ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']) {
      rows.push({
        date,
        engine: 'perplexity',
        entityKind: 'brand',
        cellsPartial: partialAfter,
        ...after,
      });
    }
    return rows;
  };

  test('a real rise is stored once; running the job again adds nothing', async () => {
    const project = await fx.project(org.org.id);
    await fx.entity(project, { kind: 'brand', name: 'Change Co' });
    await fx.seedMetrics(
      project,
      weeks({ before: { nAnswers: 30, kMentioned: 9 }, after: { nAnswers: 30, kMentioned: 18 } }),
    );
    const first = await scoped().changes.detect(project.id, { asOf: '2026-10-26' });
    assert.ok(first.found >= 1);
    assert.equal(first.added, first.found);
    const stored = await scoped().changes.forProject(project.id);
    assert.equal(stored.length, first.added);
    const event = stored.find(
      (e) => e.kind === 'mention_rate_change' && e.engine_code === 'perplexity',
    );
    assert.equal(event.direction, 'up');
    assert.equal(event.is_significant, true);
    assert.deepEqual(
      [event.n_before, event.k_before, event.n_after, event.k_after],
      [120, 36, 120, 72],
    );
    assert.equal(Number(event.delta_pp), 30);
    assert.ok(Number(event.p_value) < 0.001);
    const again = await scoped().changes.detect(project.id, { asOf: '2026-10-26' });
    assert.deepEqual([again.found, again.added], [first.found, 0]);
    assert.equal((await scoped().changes.forProject(project.id)).length, stored.length);
  });

  test('a half-collected week is left out, so an outage is not reported as a decline', async () => {
    const project = await fx.project(org.org.id);
    await fx.entity(project, { kind: 'brand', name: 'Outage Co' });
    await fx.seedMetrics(
      project,
      weeks({
        before: { nAnswers: 30, kMentioned: 12 },
        after: { nAnswers: 30, kMentioned: 3 },
        partialAfter: 2,
      }),
    );
    const result = await scoped().changes.detect(project.id, { asOf: '2026-10-26' });
    assert.deepEqual(result, { found: 0, added: 0 });
    assert.deepEqual(await scoped().changes.forProject(project.id), []);
  });

  test('a project with no history reports nothing', async () => {
    const project = await fx.project(org.org.id);
    await fx.entity(project, { kind: 'brand', name: 'New Co' });
    assert.deepEqual(await scoped().changes.detect(project.id, { asOf: '2026-10-26' }), {
      found: 0,
      added: 0,
    });
  });
});
