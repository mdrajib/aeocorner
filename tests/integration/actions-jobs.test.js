import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { createHostPacer } from '../../src/crawler/pacer.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { ProviderError } from '../../src/engines/contract.js';
import { createFileStore } from '../../src/integrations/spaces.js';
import { createLogger } from '../../src/lib/logger.js';
import { Deferral } from '../../src/worker/deferral.js';
import { actionHandlers, judgeCheck } from '../../src/worker/handlers/actions.js';
import { crawlHandlers } from '../../src/worker/handlers/crawl.js';
import { goodSite, route, serveRoutes } from '../helpers/fixture-sites.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';

/**
 * The Action Center's jobs (Milestone 6): refreshing a project's recommendations after a scan, the model-written
 * narrative and its evidence check, the same-day re-check of a fix (a fixed page is verified, an unfixed one is not),
 * and the daily sweep. The handlers run directly against the real database and a fixture website (the queue plumbing is
 * proved elsewhere); Claude is a stand-in that answers as the test says.
 */
const db = connectTestDb();
const fx = fixtures(db);
const logger = createLogger({ isTest: true, appEnv: 'test' });
const HOUR = 3_600_000;

let site;
let holder;
let storeDir;
let store;
let fetcher;
let org;

const BLOCKED = 'User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nDisallow: /wp-admin/\n';
const OPEN = 'User-agent: *\nDisallow: /wp-admin/\n';
const setRobots = (text) => {
  holder.routes = { ...holder.routes, '/robots.txt': route(text, { type: 'text/plain' }) };
};

before(async () => {
  holder = { routes: {} };
  site = await startServer((req, res) => serveRoutes(holder.routes)(req, res));
  holder.routes = goodSite(site.origin('good.test'));
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'aeo-actions-store-'));
  store = createFileStore({ dir: storeDir, prefix: 'test/' });
  fetcher = testFetcher({ ports: [site.port], pacer: createHostPacer({ minGapMs: 0 }) });
  org = await fx.org();
});

after(async () => {
  await site?.close();
  await rm(storeDir, { recursive: true, force: true });
  await fx.cleanup();
  await db.close();
});

const message = (json, over = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(json) }],
  usage: { input_tokens: 800, output_tokens: 300 },
  ...over,
});

function fakeClaude(reply) {
  const requests = [];
  return {
    requests,
    async extract(request) {
      requests.push(request);
      return reply(request);
    },
  };
}

/** The worker's `callProvider` reduced to what matters here: run the call, write its ledger row once per key. */
const callProvider = async (job, params, fn) => {
  const { value, usage } = await fn();
  if (usage && !usage.free) {
    await db.forOrg(BigInt(params.orgId)).usage.record({
      ...usage,
      projectId: BigInt(params.projectId),
      providerCode: params.provider,
      idempotencyKey: params.idempotencyKey,
    });
  }
  return { value };
};

/** A job client that remembers what was queued. */
const recorder = () => {
  const added = [];
  return { added, add: async (name, data, opts) => added.push({ name, data, opts }) };
};

let clock = () => new Date();
const ctxWith = (claude, over = {}) => ({
  db,
  logger,
  now: () => clock(),
  jobs: recorder(),
  callProvider,
  crawler: { fetcher, store, renderer: null, targetFor: () => site.origin('good.test') },
  extraction: claude ? { claude } : null,
  audit: {},
  ...over,
});

let jobSeq = 0;
const job = (attemptsMade = 0) => ({
  id: `test-${(jobSeq += 1)}`,
  attemptsMade,
  opts: { attempts: 5 },
});
const unique = () => Math.random().toString(36).slice(2, 8);

async function newProject() {
  const project = await org.scoped.projects.create({
    name: `Acme ${unique()}`,
    domain: `${unique()}.example.test`,
    country: 'US',
    language: 'en',
  });
  await fx.prompt(project, { text: `Best widget maker ${unique()}?` });
  return project;
}

/** Scan the project's site now (the crawl job), and return the jobs it queued. */
async function scan(project, ctx = ctxWith(null)) {
  const made = await org.scoped.scans.create({
    projectId: project.id,
    trigger: 'manual',
    rubricVersion: 'v0.1',
  });
  await crawlHandlers['crawl.readiness'](
    ctx,
    { orgId: String(org.org.id), projectId: String(project.id), scanId: String(made.id) },
    job(),
  );
  return { scanId: made.id, queued: ctx.jobs.added };
}

const payload = (project, extra = {}) => ({
  orgId: String(org.org.id),
  projectId: String(project.id),
  ...extra,
});

/** Raise recommendations for a project from a scan of the (currently blocked) site, and return the A1 one. */
async function raisedA1(project) {
  setRobots(BLOCKED);
  await scan(project);
  const ctx = ctxWith(null);
  await actionHandlers['recommendations.refresh'](ctx, payload(project), job());
  const todo = await org.scoped.recommendations.list(project.id, { view: 'todo' });
  const rec = todo.find((r) => r.ruleCode === 'readiness.A1');
  assert.ok(rec, 'a blocked answer crawler is raised');
  return rec;
}

describe('refreshing a project after a scan', () => {
  test('a finished scan asks for a refresh, and the refresh raises what the scan found', async () => {
    const project = await newProject();
    setRobots(BLOCKED);
    const { queued } = await scan(project);
    const asked = queued.filter((j) => j.name === 'recommendations.refresh');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].data, payload(project));
    assert.match(asked[0].opts.jobId, /^recs-\d+-scan\d+$/);

    const ctx = ctxWith(null);
    const result = await actionHandlers['recommendations.refresh'](ctx, payload(project), job());
    assert.ok(result.created >= 1);
    const todo = await org.scoped.recommendations.list(project.id, { view: 'todo' });
    const a1 = todo.find((r) => r.ruleCode === 'readiness.A1');
    assert.equal(a1.evidence.check.code, 'A1');
    assert.match(a1.whyMd, new RegExp(project.domain.replace(/\./g, '\\.')));
    assert.equal(ctx.jobs.added.length, 0, 'no Claude configured, so no narration is queued');
  });

  test('it is safe to repeat, and an archived project is skipped', async () => {
    const project = await newProject();
    setRobots(BLOCKED);
    await scan(project);
    const ctx = ctxWith(null);
    await actionHandlers['recommendations.refresh'](ctx, payload(project), job());
    const again = await actionHandlers['recommendations.refresh'](ctx, payload(project), job());
    assert.equal(again.created, 0);
    await org.scoped.projects.archive(project.id);
    assert.deepEqual(
      await actionHandlers['recommendations.refresh'](ctx, payload(project), job()),
      { skipped: 'project_gone' },
    );
  });

  test('with Claude configured, each new recommendation gets one narration job, named by its evidence', async () => {
    const project = await newProject();
    setRobots(BLOCKED);
    await scan(project);
    const ctx = ctxWith(fakeClaude(() => message({})));
    const first = await actionHandlers['recommendations.refresh'](ctx, payload(project), job());
    const narrations = ctx.jobs.added.filter((j) => j.name === 'recommendations.narrate');
    assert.equal(narrations.length, first.narrations);
    assert.ok(narrations.length >= 1);
    assert.match(narrations[0].opts.jobId, /^narrate-\d+-[0-9a-f]{12}$/);
    // an unchanged project asks for no more
    ctx.jobs.added.length = 0;
    await actionHandlers['recommendations.refresh'](ctx, payload(project), job());
    assert.equal(ctx.jobs.added.filter((j) => j.name === 'recommendations.narrate').length, 0);
  });
});

describe('the narrative', () => {
  const goodWords = (domain, check) => ({
    why: `Your robots.txt turns away a crawler that AI search engines use. Our scan of ${domain} found that “${check.title}” earned ${check.points} of ${check.possible} points, so engines cannot read your pages to quote them.`,
    steps: [
      'Open your robots.txt and remove the rule that blocks the search crawler.',
      'Check the crawler is allowed on your home page and your key pages.',
      'When it is live, press “Mark as done” so we re-check your site.',
    ],
  });

  test('words that stay inside the evidence replace the template, and the cost is on the record', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const claude = fakeClaude(() => message(goodWords(project.domain, rec.evidence.check)));
    const warnings = [];
    const spy = { ...logger, warn: (o) => warnings.push(o) };
    const result = await actionHandlers['recommendations.narrate'](
      ctxWith(claude, { logger: spy }),
      { orgId: String(org.org.id), recommendationId: String(rec.id) },
      job(),
    );
    assert.equal(result.saved, true, JSON.stringify([result, warnings]));
    const saved = (await org.scoped.recommendations.get(project.id, rec.id)).recommendation;
    assert.equal(saved.narrativeVersion, 'n1');
    assert.match(saved.whyMd, /robots\.txt turns away/);
    assert.match(saved.stepsMd, /^1\. Open your robots\.txt/);
    assert.match(saved.stepsMd, /\n3\. When it is live/);
    // what the model was shown: the facts, fenced, and the advice
    const sent = claude.requests[0].messages[0].content[0].text;
    assert.match(sent, /<facts>/);
    assert.match(sent, /earned \d+ of 8 points/);
    const ledger = (await org.scoped.usage.recent({ limit: 500 })).filter(
      (r) => r.meter === 'llm_narrative',
    );
    assert.ok(ledger.length >= 1);
    assert.ok(Number(ledger[0].cost_usd) > 0);
  });

  test('a reply that states a figure the evidence does not have is thrown away, and the template stays', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const words = goodWords(project.domain, rec.evidence.check);
    words.why += ' Sites that fix this see 40% more mentions.';
    const claude = fakeClaude(() => message(words));
    const result = await actionHandlers['recommendations.narrate'](
      ctxWith(claude),
      { orgId: String(org.org.id), recommendationId: String(rec.id) },
      job(),
    );
    assert.equal(result.skipped, 'unsupported');
    const kept = (await org.scoped.recommendations.get(project.id, rec.id)).recommendation;
    assert.equal(kept.narrativeVersion, 't1');
    assert.equal(kept.whyMd, rec.whyMd);
  });

  test('a malformed reply is tried once more, then given up on; a refusal is not retried', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const data = { orgId: String(org.org.id), recommendationId: String(rec.id) };
    const broken = fakeClaude(() => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'not json' }],
      usage: {},
    }));
    await assert.rejects(
      actionHandlers['recommendations.narrate'](ctxWith(broken), data, job(0)),
      (e) => e instanceof ProviderError && e.status === 'unusable_invalid_json',
    );
    const second = await actionHandlers['recommendations.narrate'](ctxWith(broken), data, job(1));
    assert.equal(second.skipped, 'invalid_json');
    const refusal = fakeClaude(() => ({ stop_reason: 'refusal', content: [], usage: {} }));
    assert.equal(
      (await actionHandlers['recommendations.narrate'](ctxWith(refusal), data, job(0))).skipped,
      'refusal',
    );
  });

  test('a recommendation that has moved on, or has a person’s words, is left alone', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const claude = fakeClaude(() => message(goodWords(project.domain, rec.evidence.check)));
    const data = { orgId: String(org.org.id), recommendationId: String(rec.id) };
    await org.scoped.recommendations.markDone(project.id, rec.id, { userId: org.owner.id });
    const result = await actionHandlers['recommendations.narrate'](ctxWith(claude), data, job());
    assert.equal(result.skipped, 'not_needed');
    assert.equal(claude.requests.length, 0, 'nothing asked, nothing paid');
  });

  test('without Claude the job fails at once; for another organization’s recommendation it is not found', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    await assert.rejects(
      actionHandlers['recommendations.narrate'](
        ctxWith(null),
        { orgId: String(org.org.id), recommendationId: String(rec.id) },
        job(),
      ),
      UnrecoverableError,
    );
    const other = await fx.org();
    await assert.rejects(
      actionHandlers['recommendations.narrate'](
        ctxWith(fakeClaude(() => message({}))),
        { orgId: String(other.org.id), recommendationId: String(rec.id) },
        job(),
      ),
      UnrecoverableError,
    );
  });
});

describe('the same-day re-check', () => {
  const verify = (ctx, rec, attempt = 1) =>
    actionHandlers['fix.verify'](
      ctx,
      { orgId: String(org.org.id), recommendationId: String(rec.id), attempt },
      job(),
    );

  test('a fixed page is verified the same day, and measuring starts', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    clock = () => new Date();
    const done = await org.scoped.recommendations.markDone(project.id, rec.id, {
      userId: org.owner.id,
      now: clock(),
    });
    assert.equal(done.verifiable, true);

    setRobots(OPEN); // the customer fixed it
    const ctx = ctxWith(null);
    const result = await verify(ctx, rec);
    assert.deepEqual([result.verdict, result.status], ['verified', 'measuring']);
    const detail = await org.scoped.recommendations.get(project.id, rec.id);
    assert.equal(detail.recommendation.status, 'measuring');
    assert.ok(detail.recommendation.verifiedAt);
    assert.deepEqual(
      detail.events.map((e) => e.toStatus),
      ['open', 'done', 'verified', 'measuring'],
    );
    assert.equal(detail.verifications[0].status, 'passed');
    // the re-check was its own scan, marked as such
    const scans = await org.scoped.scans.recent({ projectId: project.id });
    assert.ok(scans.some((s) => s.trigger_type === 'verification'));
    // and the scan it made asked for a refresh, which now finds A1 fixed
    assert.ok(ctx.jobs.added.some((j) => j.name === 'recommendations.refresh'));
  });

  test('an unfixed page is not verified: it is re-checked after an hour and after a day, then left unverified', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const start = new Date();
    clock = () => start;
    await org.scoped.recommendations.markDone(project.id, rec.id, {
      userId: org.owner.id,
      now: start,
    });

    setRobots(BLOCKED); // still broken
    const ctx = ctxWith(null);
    const first = await verify(ctx, rec);
    assert.equal(first.verdict, 'continue');
    assert.equal(first.nextAttempt, 2);
    const next = ctx.jobs.added.find((j) => j.name === 'fix.verify');
    assert.equal(next.data.attempt, 2);
    assert.ok(next.opts.delayMs >= HOUR - 5_000 && next.opts.delayMs <= HOUR + 5_000);
    assert.equal(
      (await org.scoped.recommendations.get(project.id, rec.id)).recommendation.status,
      'done',
    );

    // an hour passes: the second attempt waits for its time, then runs
    await assert.rejects(verify(ctx, rec, 2), Deferral);
    clock = () => new Date(start.getTime() + HOUR + 1_000);
    const second = await verify(ctx, rec, 2);
    assert.equal(second.verdict, 'continue');
    assert.equal(second.nextAttempt, 3);

    // a day passes: the third and last
    clock = () => new Date(start.getTime() + 24 * HOUR + 1_000);
    const third = await verify(ctx, rec, 3);
    assert.deepEqual(
      [third.verdict, third.reason, third.status],
      ['unverified', 'still_failing', 'unverified'],
    );
    const detail = await org.scoped.recommendations.get(project.id, rec.id);
    assert.deepEqual(
      detail.verifications.map((v) => v.status),
      ['failed', 'failed', 'failed'],
    );

    // the customer can confirm it anyway, and measuring starts then
    const confirmed = await org.scoped.recommendations.transition(project.id, rec.id, 'measuring', {
      userId: org.owner.id,
    });
    assert.equal(confirmed.status, 'measuring');
    clock = () => new Date();
  });

  test('a fix that passes at the second attempt is verified then', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const start = new Date();
    clock = () => start;
    await org.scoped.recommendations.markDone(project.id, rec.id, {
      userId: org.owner.id,
      now: start,
    });
    setRobots(BLOCKED);
    const ctx = ctxWith(null);
    assert.equal((await verify(ctx, rec)).verdict, 'continue');
    setRobots(OPEN); // the CDN cache cleared
    clock = () => new Date(start.getTime() + HOUR + 1_000);
    const second = await verify(ctx, rec, 2);
    assert.deepEqual([second.verdict, second.status], ['verified', 'measuring']);
    clock = () => new Date();
  });

  test('a scan that could not run is "couldn’t check", never "still failing"', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const start = new Date();
    clock = () => start;
    await org.scoped.recommendations.markDone(project.id, rec.id, {
      userId: org.owner.id,
      now: start,
    });
    // a site that is down
    const down = ctxWith(null, {
      crawler: { fetcher, store, renderer: null, targetFor: () => '127.0.0.1:1' },
    });
    await verify(down, rec);
    clock = () => new Date(start.getTime() + HOUR + 1_000);
    await verify(down, rec, 2);
    clock = () => new Date(start.getTime() + 24 * HOUR + 1_000);
    const last = await verify(down, rec, 3);
    assert.deepEqual([last.verdict, last.reason], ['unverified', 'couldnt_check']);
    const detail = await org.scoped.recommendations.get(project.id, rec.id);
    assert.ok(detail.verifications.every((v) => v.details.couldntCheck === true));
    clock = () => new Date();
  });

  test('a repeated job, or one for a fix that moved on, does nothing', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const ctx = ctxWith(null);
    // not done yet
    assert.deepEqual(await verify(ctx, rec), { skipped: 'open', repeated: true });
    await org.scoped.recommendations.markDone(project.id, rec.id, { userId: org.owner.id });
    setRobots(OPEN);
    await verify(ctx, rec);
    assert.deepEqual(await verify(ctx, rec), { skipped: 'measuring', repeated: true });
    setRobots(BLOCKED);
  });

  test('judgeCheck: a pass and "does not apply" pass; fail and partial fail; an error or no scan is "couldn’t check"', () => {
    const c = (status) => ({ check_code: 'A1', status });
    assert.deepEqual(judgeCheck('complete', c('pass')).status, 'passed');
    assert.deepEqual(judgeCheck('complete', c('not_applicable')).status, 'passed');
    assert.deepEqual(judgeCheck('complete', c('fail')), {
      status: 'failed',
      couldntCheck: false,
      checkStatus: 'fail',
    });
    assert.equal(judgeCheck('complete', c('partial')).couldntCheck, false);
    assert.equal(judgeCheck('complete', c('error')).couldntCheck, true);
    assert.equal(judgeCheck('complete', undefined).couldntCheck, true);
    assert.equal(judgeCheck('failed', c('pass')).couldntCheck, true);
  });
});

describe('the daily sweep', () => {
  test('queues the measurement of what is due and the re-check that never ran, once per day and hour', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const long = new Date(Date.now() - 3 * HOUR);
    await org.scoped.recommendations.markDone(project.id, rec.id, {
      userId: org.owner.id,
      now: long,
    });

    const ctx = ctxWith(null);
    const out = await actionHandlers['outcomes.sweep'](ctx, {}, job());
    assert.ok(out.reverifications >= 2);
    const mine = ctx.jobs.added.filter(
      (j) => j.name === 'fix.verify' && j.data.recommendationId === String(rec.id),
    );
    assert.deepEqual(mine.map((j) => j.data.attempt).sort(), [1, 2]);
    assert.match(mine[0].opts.jobId, /^fixverify-\d+-a\d-s\d+$/);
  });

  test('measures a fix that is due, and does nothing for one that is not', async () => {
    const project = await newProject();
    const rec = await raisedA1(project);
    const now = new Date();
    await org.scoped.recommendations.markDone(project.id, rec.id, { userId: org.owner.id, now });
    await org.scoped.recommendations.recordVerification(project.id, rec.id, {
      attempt: 1,
      status: 'passed',
      now,
    });
    await org.scoped.recommendations.settleVerification(project.id, rec.id, {
      verdict: 'verified',
      reason: 'passed',
      now,
    });
    const data = { orgId: String(org.org.id), recommendationId: String(rec.id) };
    assert.deepEqual(
      (await actionHandlers['outcomes.measure'](ctxWith(null), data, job())).measured,
      [],
    );
    const later = ctxWith(null, { now: () => new Date(now.getTime() + 15 * 86_400_000) });
    const result = await actionHandlers['outcomes.measure'](later, data, job());
    assert.equal(result.measured.length, 1);
    assert.equal(result.measured[0].horizon, 'week_2');
    assert.equal(result.measured[0].verdict, 'insufficient_data'); // no answers were collected in this project
  });
});
