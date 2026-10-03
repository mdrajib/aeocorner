import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { isoWeekKey } from '../../src/core/slots.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createFileStore, storeRaw } from '../../src/integrations/spaces.js';
import { parseCustomId } from '../../src/llm/extraction.js';
import { startRuntime, until, waitForJob } from '../helpers/worker.js';

/**
 * A project's tracking run, end to end (Milestone 4): the scheduler's job plans questions × engines × samples, every
 * answer is collected and read, and the run becomes cells, a daily rollup and a verdict. Real Redis and MySQL; the
 * engines are replaced by a collector that answers as each test says, and Claude by a reader that reads the marker
 * in the answer. What is under test is the orchestration: nothing is invented for a failure, a slot counts once, and
 * a run that could not finish says so.
 */

const db = connectTestDb();
const fx = fixtures(db);
const DOMAINS = ['acme-x.test', 'rival-x.test'];

const TEXT = {
  win: '[[WIN]] 1. Acme CRM – the best fit. 2. RivalCRM – fine too.',
  lose: '[[LOSE]] 1. RivalCRM – the best fit.',
  absent: '[[ABSENT]] It depends on what you need.',
  refuse: '[[REFUSE]] It depends on what you need.',
};

let storeDir;
let store;
let h;
let behave;
let collected;
let sent;
let batches;
let org;

/** What a collector does for a snapshot: `win` by default; a test overrides with `behave`. */
const behaviourOf = (snapshot) =>
  behave({
    question: snapshot.prompt.text,
    engine: snapshot.engine_code,
    sample: snapshot.sample_idx,
  }) ?? 'win';

async function collect(ctx, data) {
  const scoped = ctx.db.forOrg(BigInt(data.orgId));
  const snapshot = await scoped.snapshots.get(BigInt(data.snapshotId));
  collected.push(data.snapshotId);
  const what = behaviourOf(snapshot);
  if (what === 'hang') return { hung: true };
  if (what === 'fail') {
    await scoped.snapshots.fail(snapshot.id, 'provider said no');
    return { failed: true };
  }
  const document = {
    format: 'aeo-corner.answer.v1',
    raw: {},
    normalized: {
      status: what === 'no_answer' ? 'no_answer' : 'ok',
      text: what === 'no_answer' ? '' : TEXT[what],
      sources: [],
    },
  };
  const stored = await storeRaw(store, {
    kind: 'answer',
    body: JSON.stringify(document),
    contentType: 'application/json',
    url: 'test/engine',
    status: 'ok',
  });
  await scoped.snapshots.complete(snapshot.id, {
    status: what === 'no_answer' ? 'no_answer' : 'ok',
    providerCode: snapshot.provider_code,
    method: snapshot.method,
    isFallback: false,
    providerTaskId: null,
    modelVersion: 'test',
    collectedAt: new Date(),
    rawUri: stored.key,
    rawSha256: stored.sha256,
    answerChars: 80,
    textExcerpt: 'An answer',
    costUsd: '0.004',
  });
  await scoped.usage.record({
    projectId: snapshot.project_id,
    meter: 'answer_collect',
    unit: 'result',
    providerCode: snapshot.provider_code,
    costUsd: '0.004',
    refType: 'snapshot',
    refId: snapshot.id,
    idempotencyKey: `test-collect-${snapshot.id}`,
  });
  return { ok: true };
}

const entity = (name, ref, rank, stance) => ({
  name,
  tracked_ref: ref,
  list_rank: rank,
  prominence: 'primary',
  stance,
  sentiment: stance === 'recommended' ? 1 : 0,
  excerpt: `${name} – excerpt.`,
  claims: [],
});

/** What Claude says about one answer, read from the marker in its text. */
function reading(requestText) {
  if (requestText.includes('[[REFUSE]]')) return { refusal: true };
  const entities = requestText.includes('[[WIN]]')
    ? [entity('Acme CRM', 'E1', 1, 'recommended'), entity('RivalCRM', 'E2', 2, 'neutral')]
    : requestText.includes('[[LOSE]]')
      ? [entity('RivalCRM', 'E2', 1, 'recommended')]
      : [];
  return { json: { answer_type: 'list', entities, citations: [] } };
}

const message = ({ json, refusal }) => ({
  id: 'msg_1',
  model: 'claude-opus-5-5',
  stop_reason: refusal ? 'refusal' : 'end_turn',
  content: [{ type: 'text', text: refusal ? '' : JSON.stringify(json) }],
  usage: { input_tokens: 1_000, cache_read_input_tokens: 3_000, output_tokens: 400 },
});

const requestText = (params) => params.messages[0].content.map((c) => c.text ?? '').join('\n');

const claude = {
  provider: 'anthropic',
  async extract(params) {
    sent.push({ kind: 'sync' });
    return message(reading(requestText(params)));
  },
  batches: {
    async create(requests) {
      const id = `msgbatch_run${Object.keys(batches).length + 1}x${Date.now()}`;
      batches[id] = { requests, polls: 0 };
      sent.push({ kind: 'batch', id, count: requests.length });
      return { id, processing_status: 'in_progress' };
    },
    async retrieve(id) {
      batches[id].polls += 1;
      return { id, processing_status: batches[id].polls >= 2 ? 'ended' : 'in_progress' };
    },
    async results(id) {
      return batches[id].requests.map((r) => {
        parseCustomId(r.custom_id);
        return {
          custom_id: r.custom_id,
          result: { type: 'succeeded', message: message(reading(requestText(r.params))) },
        };
      });
    },
  },
};

const week = (at = new Date()) => isoWeekKey(at);
const scoped = () => db.forOrg(org.org.id);

/** An active project with a brand, a rival, two questions and two engines. */
async function makeProject({
  questions = ['Q1: best CRM?', 'Q2: CRM for dentists?'],
  engines,
} = {}) {
  const project = await fx.project(org.org.id, `Tracked ${Math.random()}`, {
    status: 'active',
    slotHour: 5,
  });
  await fx.entity(project, { kind: 'brand', name: 'Acme CRM', domains: ['acme-x.test'] });
  await fx.entity(project, { kind: 'competitor', name: 'RivalCRM', domains: ['rival-x.test'] });
  for (const text of questions) await fx.prompt(project, { text });
  await fx.engines(project, engines ?? ['perplexity', 'google_aio']);
  return project;
}

const startWeekly = async (
  project,
  slot = week(),
  jobId = `t-${Math.random()}`.replace('.', ''),
) => {
  await h.runtime.jobs.add(
    'tracking.start',
    { orgId: String(org.org.id), projectId: String(project.id), weekKey: slot },
    { jobId },
  );
  return jobId;
};

/** What a stuck run looks like, for a failure message. */
async function diagnose(project, slot) {
  const { run } = await scoped().runs.start({
    projectId: project.id,
    slotKey: slot,
    trigger: 'schedule',
  });
  const counts = {};
  for (const q of ['collect', 'extract']) {
    counts[q] = await h
      .queue(q)
      .getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed');
  }
  const failed = await h.queue('collect').getFailed(0, 3);
  return {
    status: run.status,
    progress: await scoped().runs.progress(run.id),
    counts,
    failed: failed.map((j) => [j.name, j.failedReason]),
  };
}

/** Wait until the run of a slot has finished; returns it. A run that never does fails with where it is stuck. */
async function finished(project, slot = week()) {
  try {
    return await until(
      async () => {
        const { run } = await scoped().runs.start({
          projectId: project.id,
          slotKey: slot,
          trigger: 'schedule',
        });
        return ['complete', 'partial', 'failed'].includes(run.status) ? run : null;
      },
      { timeoutMs: 40_000, intervalMs: 250, message: `the ${slot} run never finished` },
    );
  } catch (err) {
    throw new Error(`${err.message}: ${JSON.stringify(await diagnose(project, slot))}`, {
      cause: err,
    });
  }
}

before(async () => {
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'aeo-tracking-store-'));
  store = createFileStore({ dir: storeDir, prefix: 'test/' });
  org = await fx.org();
  h = await startRuntime({
    db,
    queueNames: ['collect', 'extract'],
    handlers: { 'collect.answer': collect },
    extraction: { claude, store, model: 'opus55', polling: { everyMs: 500 } },
    // The tracking job looks again after a second (the floor for any deferral) and gives up after three.
    tracking: {
      timing: {
        collectEveryMs: 1_000,
        extractEveryMs: 1_000,
        collectDeadlineMs: 3_000,
        extractDeadlineMs: 30_000,
      },
    },
  });
});

after(async () => {
  await h?.stop();
  await rm(storeDir, { recursive: true, force: true });
  await fx.cleanup();
  await fx.forgetDomains(DOMAINS);
  await db.close();
});

beforeEach(() => {
  behave = () => 'win';
  collected = [];
  sent = [];
  batches = {};
});

describe('a weekly run', () => {
  test('plans every question on every engine, reads the answers, and writes cells, a rollup and a verdict', async () => {
    const project = await makeProject();
    behave = ({ question, engine, sample }) => {
      if (engine === 'google_aio' && question.startsWith('Q1')) return 'no_answer';
      if (engine === 'perplexity' && question.startsWith('Q2')) {
        return ['win', 'lose', 'fail'][sample];
      }
      return 'win';
    };
    await startWeekly(project);
    const run = await finished(project);

    // 2 questions × (perplexity 3 + google_aio 1) answers, planned before any was collected.
    assert.equal(run.status, 'partial', 'one answer could not be checked');
    assert.equal(run.tasks_planned, 8);
    assert.equal(run.tasks_ok, 6);
    assert.equal(run.tasks_no_answer, 1);
    assert.equal(run.tasks_failed, 1);
    assert.equal(run.prompts_count, 2);
    assert.equal(run.extraction_mode, 'batch');
    assert.ok(run.finished_at && run.collected_at && run.extracted_at);
    assert.deepEqual(run.error_summary, { failed: 1, planned: 8, ok: 6 });
    assert.equal(
      sent.filter((s) => s.kind === 'batch').length,
      1,
      'a weekly run is read in one batch',
    );
    assert.equal(sent.filter((s) => s.kind === 'sync').length, 0);

    const cells = await scoped().runs.cells(run.id);
    assert.deepEqual(
      cells.map((c) => [c.engineCode, c.status, c.nOk, c.nNoAnswer, c.nFailed]),
      [
        ['google_aio', 'no_answer', 0, 1, 0],
        ['perplexity', 'complete', 3, 0, 0],
        ['google_aio', 'complete', 1, 0, 0],
        ['perplexity', 'partial', 2, 0, 1],
      ],
    );
    assert.equal(cells[0].cellScore, null, 'an engine with no answer has no score, not 0');
    assert.equal(cells[1].cellScore, 1);
    assert.equal(cells[3].cellScore, 0.5, 'one win (1.0) and one loss (0), the failure left out');

    const metrics = await scoped().metrics.range(project.id, {
      from: run.run_date,
      to: run.run_date,
    });
    const row = (engine, kind) => {
      const entityId = metrics
        .filter((m) => m.engineCode === engine)
        .map((m) => m.entityId)
        .sort((a, b) => Number(a) - Number(b))[kind === 'brand' ? 0 : 1];
      return metrics.find((m) => m.engineCode === engine && m.entityId === entityId);
    };
    const brand = row('perplexity', 'brand');
    assert.equal(brand.nAnswers, 5, 'the failed answer is not an answer');
    assert.equal(brand.kMentioned, 4);
    assert.equal(brand.cellsTotal, 2);
    assert.equal(brand.cellsPartial, 1, 'the cell that did not finish is counted as incomplete');
    assert.equal(brand.rankSum, 4);
    assert.equal(row('perplexity', 'rival').kMentioned, 5);
    const aio = row('google_aio', 'brand');
    assert.equal(aio.nAnswers, 1);
    assert.equal(aio.aioQueries, 2);
    assert.equal(aio.aioTriggered, 1);
    assert.equal(metrics.length, 4, 'two engines × brand and rival');

    // What the run cost comes from the ledger: seven collected answers and the one extraction batch.
    assert.ok(Number(run.cost_usd) > 7 * 0.004);
  });

  test('the first readable run ends “setting up” for the project, once', async () => {
    const project = await makeProject({ questions: ['Q1: first?'], engines: ['perplexity'] });
    await startWeekly(project);
    const run = await finished(project);
    assert.equal(run.status, 'complete');
    const row = await fx.projectRow(project.id);
    assert.ok(row.first_run_at, 'first_run_at is set');
    const stamp = row.first_run_at.getTime();
    await startWeekly(project, week(new Date(Date.now() + 7 * 86_400_000)));
    await finished(project, week(new Date(Date.now() + 7 * 86_400_000)));
    assert.equal((await fx.projectRow(project.id)).first_run_at.getTime(), stamp);
  });

  test('the same slot fired twice is one run: nothing is planned, collected or counted twice', async () => {
    const project = await makeProject({ engines: ['perplexity'] });
    await startWeekly(project);
    const run = await finished(project);
    const before = {
      collected: collected.length,
      cells: (await scoped().runs.cells(run.id)).length,
      metrics: (await scoped().metrics.range(project.id, { from: run.run_date, to: run.run_date }))
        .length,
      snapshots: (await scoped().snapshots.forRun(run.id)).length,
    };
    assert.equal(before.snapshots, 6);

    // A scheduler that fires again, under a different job ID (a catch-up tick after a deploy).
    const again = await startWeekly(project);
    const job = await waitForJob(h.queue('collect'), again, ['completed']);
    assert.equal(job.returnvalue.created, false);
    assert.equal(job.returnvalue.repeated, true);

    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await scoped().runs.recent(project.id)).length, 1);
    assert.equal(collected.length, before.collected, 'no answer was collected again');
    assert.equal((await scoped().snapshots.forRun(run.id)).length, before.snapshots);
    assert.equal((await scoped().runs.cells(run.id)).length, before.cells);
    // …and rolling the day up again changes nothing.
    await scoped().metrics.rollupDay(project.id, run.run_date);
    const rows = await scoped().metrics.range(project.id, { from: run.run_date, to: run.run_date });
    assert.equal(rows.length, before.metrics);
    assert.equal(rows.find((r) => r.kMentioned > 0).nAnswers, 6, 'counted once');
  });

  test('an engine that failed all week shows as incomplete, never as zero mentions', async () => {
    const project = await makeProject();
    behave = ({ engine }) => (engine === 'perplexity' ? 'fail' : 'win');
    await startWeekly(project);
    const run = await finished(project);
    assert.equal(run.status, 'partial');
    const cells = await scoped().runs.cells(run.id);
    assert.ok(
      cells.filter((c) => c.engineCode === 'perplexity').every((c) => c.status === 'failed'),
    );
    const metrics = await scoped().metrics.range(project.id, {
      from: run.run_date,
      to: run.run_date,
    });
    const perplexity = metrics.filter((m) => m.engineCode === 'perplexity');
    for (const m of perplexity) {
      assert.equal(m.nAnswers, 0, 'no answers were read');
      assert.equal(m.kMentioned, 0);
      assert.equal(m.cellsPartial, m.cellsTotal, 'every cell says it is incomplete');
      assert.equal(m.visWeightTotal, null, 'and there is no visibility figure to show');
    }
    const mentions = metrics.filter((m) => m.engineCode === 'google_aio' && m.kMentioned > 0);
    assert.ok(mentions.length > 0, 'the other engine is unaffected');
  });

  test('an answer that was collected but could not be read is “couldn’t check”, not “not mentioned”', async () => {
    const project = await makeProject({ questions: ['Q1: only?'], engines: ['perplexity'] });
    behave = ({ sample }) => (sample === 2 ? 'refuse' : 'win');
    await startWeekly(project);
    const run = await finished(project);
    assert.equal(run.status, 'partial');
    assert.equal(run.tasks_ok, 2);
    assert.equal(run.tasks_failed, 1);
    const [cell] = await scoped().runs.cells(run.id);
    assert.deepEqual([cell.status, cell.nOk, cell.nFailed], ['partial', 2, 1]);
    const metrics = await scoped().metrics.range(project.id, {
      from: run.run_date,
      to: run.run_date,
    });
    assert.equal(Math.max(...metrics.map((m) => m.nAnswers)), 2);
    assert.equal(metrics.find((m) => m.kMentioned > 0).kMentioned, 2, 'not 2 of 3');
  });

  test('answers that never arrive are given up on at the deadline, and the run finishes with the rest', async () => {
    const project = await makeProject({ questions: ['Q1: waits?'], engines: ['perplexity'] });
    behave = ({ sample }) => (sample === 1 ? 'hang' : 'win');
    await startWeekly(project);
    const run = await finished(project);
    assert.equal(run.status, 'partial');
    assert.equal(run.tasks_ok, 2);
    assert.equal(run.tasks_failed, 1);
    const stuck = (await scoped().snapshots.forRun(run.id)).find((s) => s.sample_idx === 1);
    assert.equal(stuck.status, 'failed');
    assert.match(stuck.failure_reason, /timed out/);
  });

  test('a run with nothing readable fails, says so, and does not end “setting up”', async () => {
    const project = await makeProject({ questions: ['Q1: nobody?'], engines: ['perplexity'] });
    behave = () => 'fail';
    await startWeekly(project);
    const run = await finished(project);
    assert.equal(run.status, 'failed');
    assert.equal(run.tasks_ok, 0);
    assert.equal((await fx.projectRow(project.id)).first_run_at, null);
    assert.ok(
      h.alerts.sent.some((a) => a.key === `run.failed:${run.id}`),
      'staff are told',
    );
  });

  test('a project with no questions has nothing to track: a failed run, no answers', async () => {
    const project = await makeProject({ questions: [] });
    await startWeekly(project);
    const run = await finished(project);
    assert.equal(run.status, 'failed');
    assert.equal(run.error_summary.reason, 'nothing_to_track');
    assert.equal((await scoped().snapshots.forRun(run.id)).length, 0);
  });

  test('a project that was paused or archived after the scheduler looked is skipped, not retried', async () => {
    const project = await makeProject();
    await scoped().projects.archive(project.id);
    const id = await startWeekly(project);
    const job = await waitForJob(h.queue('collect'), id, ['completed', 'failed']);
    assert.equal(await job.getState(), 'completed');
    assert.deepEqual(job.returnvalue, { skipped: 'PROJECT_NOT_IN_ORG' });
  });
});

describe('a first run', () => {
  test('is read answer by answer, at once, and its answers go through the fast queue', async () => {
    const project = await makeProject({ questions: ['Q1: first look?'], engines: ['perplexity'] });
    const { run: created } = await scoped().runs.start({
      projectId: project.id,
      slotKey: week(),
      trigger: 'onboarding',
      extractionMode: 'sync',
    });
    await h.runtime.jobs.add(
      'tracking.run',
      { orgId: String(org.org.id), runId: String(created.id) },
      { jobId: `plan-${created.id}` },
    );
    const run = await finished(project);
    assert.equal(run.status, 'complete');
    assert.equal(run.trigger_type, 'onboarding');
    assert.equal(run.extraction_mode, 'sync');
    assert.equal(sent.filter((s) => s.kind === 'batch').length, 0);
    assert.equal(sent.filter((s) => s.kind === 'sync').length, 3);
    const snapshots = await scoped().snapshots.forRun(run.id);
    assert.ok(snapshots.every((s) => s.mode === 'live'));
  });

  test('counts as this week’s run: the scheduler finding the same week plans nothing more', async () => {
    const project = await makeProject({ questions: ['Q1: once a week?'], engines: ['perplexity'] });
    const { run: created } = await scoped().runs.start({
      projectId: project.id,
      slotKey: week(),
      trigger: 'onboarding',
      extractionMode: 'sync',
    });
    await h.runtime.jobs.add(
      'tracking.run',
      { orgId: String(org.org.id), runId: String(created.id) },
      { jobId: `plan-${created.id}` },
    );
    await finished(project);
    const after = collected.length;
    const id = await startWeekly(project);
    const job = await waitForJob(h.queue('collect'), id, ['completed']);
    assert.equal(job.returnvalue.created, false);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(collected.length, after);
    assert.equal((await scoped().runs.recent(project.id)).length, 1);
  });
});
