import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { checkedAnswer } from '../../src/engines/contract.js';
import { adapterRegistry, createAdapters } from '../../src/engines/index.js';
import { createFileStore } from '../../src/integrations/spaces.js';
import { answerJobId } from '../../src/lib/job-ids.js';
import { startRuntime, until, waitForJob } from '../helpers/worker.js';

/**
 * Collecting one AI answer as a queued job (BUILD_PLAN Phase 5), against real Redis and MySQL, with the providers
 * replayed by a server on this machine: the raw answer stored first, the snapshot completed, one ledger row per
 * charge; queued providers polled for free; failures retried or given up on, and never recorded as "no answer";
 * the fallback provider used when the primary's breaker is open; nothing crossing organizations.
 */

const db = connectTestDb();
const fx = fixtures(db);
const fixture = (p) => readFileSync(new URL(`../fixtures/engines/${p}`, import.meta.url), 'utf8');

let server;
let origin;
let routes = {};
let calls = [];
let storeDir;
let store;
let failStoreWrites = 0;
let h;
let org;
let other;
let project;

/** A stand-in for DataForSEO's own AI Overview element, to be the fallback when SerpApi's breaker is open. */
const fallbackAio = {
  engine: 'google_aio',
  provider: 'dataforseo',
  method: 'serp',
  estimateCostUsd: () => 0.002,
  estimateCostMicros: () => 2_000,
  async submit() {
    calls.push({ fallback: true });
    return {
      providerRef: 'dfs-aio-1',
      raw: { overview: 'Fallback overview text.' },
      costMicros: 2_000,
    };
  },
  poll: async (handle) => handle.raw,
  normalize: (raw, task) =>
    checkedAnswer({
      status: 'ok',
      engine: 'google_aio',
      provider: 'dataforseo',
      method: 'serp',
      text: raw.overview,
      sources: [],
      modelVersion: null,
      locale: { country: task.country, language: task.language },
      answeredAt: null,
      providerRef: 'dfs-aio-1',
    }),
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = `${req.method} ${url.pathname}`;
    req.resume();
    req.on('end', () => {
      calls.push({ key, query: Object.fromEntries(url.searchParams) });
      const route = routes[key];
      const answer = typeof route === 'function' ? route(url) : route;
      if (!answer) return res.writeHead(404).end();
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' }).end(answer.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  storeDir = await mkdtemp(path.join(os.tmpdir(), 'aeo-collect-store-'));
  const real = createFileStore({ dir: storeDir, prefix: 'test/' });
  store = {
    ...real,
    async put(args) {
      if (failStoreWrites > 0) {
        failStoreWrites -= 1;
        throw new Error('the bucket is having a bad moment');
      }
      return real.put(args);
    },
  };

  const real4 = createAdapters(
    {
      dataforseo: { login: 'dfs-login', password: 'dfs-secret' },
      perplexity: { apiKey: 'pplx-secret' },
      serpapi: { apiKey: 'serp-secret', costPerSearchMicros: 10_000 },
    },
    { baseUrls: { dataforseo: origin, perplexity: origin, serpapi: origin } },
  );

  org = await fx.org();
  other = await fx.org();
  project = await fx.project(org.org.id, 'Collected');
  h = await startRuntime({
    db,
    queueNames: ['collect'],
    collection: {
      adapters: adapterRegistry([...real4.list(), fallbackAio]),
      store,
      // Seconds instead of minutes, so a queued provider is polled within a test's patience.
      polling: {
        standard: { everyMs: 1_000, giveUpAfterMs: 60_000 },
        priority: { everyMs: 1_000, giveUpAfterMs: 2_500 },
      },
    },
  });
});

after(async () => {
  await h?.stop();
  server?.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(storeDir, { recursive: true, force: true });
  await fx.cleanup();
  await db.close();
});

beforeEach(() => {
  routes = {};
  calls = [];
  failStoreWrites = 0;
});

const queue = () => h.queue('collect');

/** A new prompt, run and pending snapshot for `engine`, and its job on the queue. */
async function collect(
  engine,
  { mode = 'standard', provider, method, owner = org, proj = project } = {},
) {
  const routing = await db.reference.engines.get(engine);
  const prompt = await fx.prompt(proj, {
    text: `What is the best dental software for a small clinic? ${Math.random()}`,
    searchQuery: engine === 'google_aio' ? 'best dental software' : null,
  });
  const run = await fx.run(proj);
  const { snapshot } = await owner.scoped.snapshots.create({
    runId: run.id,
    promptId: prompt.id,
    engineCode: engine,
    sampleIdx: 0,
    providerCode: provider ?? routing.primaryProviderCode,
    method: method ?? routing.primaryMethod,
    mode,
  });
  await h.runtime.jobs.add(
    'collect.answer',
    { orgId: String(owner.org.id), snapshotId: String(snapshot.id) },
    { jobId: answerJobId(snapshot.id) },
  );
  return snapshot;
}

const finished = (snapshot, states = ['completed'], timeoutMs = 30_000) =>
  waitForJob(queue(), answerJobId(snapshot.id), states, { timeoutMs });
const reload = (snapshot) => org.scoped.snapshots.get(snapshot.id);
const ledgerFor = async (snapshot) =>
  (await org.scoped.usage.recent({ limit: 500 })).filter(
    (r) => r.ref_type === 'snapshot' && r.ref_id === snapshot.id,
  );
const providerCalls = (key) => calls.filter((c) => c.key === key).length;

describe('an answer collected as a job', () => {
  test('Perplexity (answers at once): raw stored first, snapshot complete, one ledger row at the reported cost', async () => {
    routes['POST /v1/agent'] = { body: fixture('perplexity/agent-ok.json') };
    const snapshot = await collect('perplexity');
    const job = await finished(snapshot);
    assert.equal(job.returnvalue.status, 'ok');

    const row = await reload(snapshot);
    assert.equal(row.status, 'ok');
    assert.equal(row.provider_code, 'perplexity_api');
    assert.equal(row.method, 'api_grounded');
    assert.equal(row.is_fallback, false);
    assert.equal(row.model_version, 'perplexity/sonar');
    assert.equal(String(row.cost_usd), '0.003776');
    assert.match(row.text_excerpt, /^For a small clinic, \*\*Curve Dental\*\*/);
    assert.ok(row.answer_chars > 200 && row.collected_at);
    assert.equal(row.extraction_status, 'pending', 'ready for Phase 6');

    // The stored document: the provider's bytes, our reading of them, and a hash that matches.
    assert.match(row.raw_uri, /^test\/answers\/\d{4}\/\d{2}\/[0-9a-f]{64}\.json$/);
    const stored = await store.get(row.raw_uri);
    assert.equal(
      createHash('sha256').update(stored.body).digest('hex'),
      Buffer.from(row.raw_sha256).toString('hex'),
    );
    const doc = JSON.parse(stored.body);
    assert.equal(doc.format, 'aeo-corner.answer.v1');
    assert.deepEqual(doc.raw, JSON.parse(fixture('perplexity/agent-ok.json')));
    assert.equal(doc.normalized.sources.length, 4);
    assert.ok(!stored.body.toString().includes('pplx-secret'), 'no credential in storage');

    const [entry, ...extra] = await ledgerFor(snapshot);
    assert.equal(extra.length, 0);
    assert.deepEqual(
      [entry.meter, entry.provider_code, entry.unit, String(entry.cost_usd), entry.project_id],
      ['answer_collect', 'perplexity_api', 'result', '0.003776', project.id],
    );
    assert.deepEqual(
      [entry.tokens_in, entry.tokens_out, entry.model],
      [1180, 96, 'perplexity/sonar'],
    );
  });

  test('ChatGPT via DataForSEO’s queue: submitted once, polled for free until ready, one ledger row', async () => {
    let polls = 0;
    routes['POST /v3/ai_optimization/chat_gpt/llm_scraper/task_post'] = {
      body: fixture('dataforseo/chatgpt-task-post.json'),
    };
    routes[
      'GET /v3/ai_optimization/chat_gpt/llm_scraper/task_get/advanced/10031512-1535-0636-0000-7f0c2a4e1b11'
    ] = () => {
      polls += 1;
      return {
        body: fixture(
          polls < 2
            ? 'dataforseo/chatgpt-task-get-queued.json'
            : 'dataforseo/chatgpt-task-get-ready.json',
        ),
      };
    };
    const snapshot = await collect('chatgpt');

    // While the provider works on it, the snapshot says so.
    const waiting = await until(async () => {
      const r = await reload(snapshot);
      return r.provider_task_id ? r : null;
    });
    assert.equal(waiting.status, 'pending');
    assert.equal(waiting.provider_task_id, '10031512-1535-0636-0000-7f0c2a4e1b11');
    assert.equal(waiting.attempts, 1);
    assert.equal(String(waiting.cost_usd), '0.0012', 'charged when queued');

    const job = await finished(snapshot);
    assert.equal(job.returnvalue.status, 'ok');
    // BullMQ counts the run that succeeded; the two waits for the provider used up nothing.
    assert.equal(job.attemptsMade, 1, 'waiting for the provider used up no attempts');
    assert.equal(polls, 2);
    assert.equal(providerCalls('POST /v3/ai_optimization/chat_gpt/llm_scraper/task_post'), 1);

    const row = await reload(snapshot);
    assert.deepEqual(
      [row.status, row.model_version, String(row.cost_usd)],
      ['ok', 'gpt-5-3', '0.0012'],
    );
    const ledger = await ledgerFor(snapshot);
    assert.equal(ledger.length, 1, 'the polls are free and write nothing');
    assert.deepEqual([ledger[0].meter, String(ledger[0].cost_usd)], ['answer_collect', '0.0012']);
  });

  test('AI Overviews with none shown: "no_answer", nothing to extract, one search on the ledger', async () => {
    routes['GET /search.json'] = { body: fixture('serpapi/google-no-aio.json') };
    const snapshot = await collect('google_aio');
    assert.equal((await finished(snapshot)).returnvalue.status, 'no_answer');
    const row = await reload(snapshot);
    assert.deepEqual(
      [row.status, row.extraction_status, row.answer_chars],
      ['no_answer', 'skipped', 0],
    );
    assert.ok(row.raw_uri, 'the raw search is kept: it is the evidence that no overview was shown');
    const [entry] = await ledgerFor(snapshot);
    assert.deepEqual(
      [entry.meter, entry.unit, String(entry.quantity), String(entry.cost_usd)],
      ['serp', 'search', '1', '0.01'],
    );
  });

  test('asking twice for the same answer is one job and one charge', async () => {
    routes['POST /v1/agent'] = { body: fixture('perplexity/agent-ok.json') };
    const snapshot = await collect('perplexity');
    await h.runtime.jobs.add(
      'collect.answer',
      { orgId: String(org.org.id), snapshotId: String(snapshot.id) },
      { jobId: answerJobId(snapshot.id) },
    );
    await finished(snapshot);
    // A job for an answer already collected (a late duplicate under another ID) changes nothing.
    const late = await h.runtime.jobs.add(
      'collect.answer',
      { orgId: String(org.org.id), snapshotId: String(snapshot.id) },
      { jobId: `late-${snapshot.id}` },
    );
    const lateJob = await waitForJob(queue(), late.id, ['completed']);
    assert.equal(lateJob.returnvalue.repeated, true);
    assert.equal(providerCalls('POST /v1/agent'), 1);
    assert.equal((await ledgerFor(snapshot)).length, 1);
  });
});

describe('when things go wrong', () => {
  test('a provider hiccup is retried; only the call that was charged is on the ledger', async () => {
    let n = 0;
    routes['POST /v1/agent'] = () =>
      (n += 1) === 1 ? { status: 503, body: '' } : { body: fixture('perplexity/agent-ok.json') };
    const snapshot = await collect('perplexity');
    const job = await finished(snapshot);
    assert.equal(job.attemptsMade, 2, 'one failed attempt, then the success');
    assert.equal((await reload(snapshot)).status, 'ok');
    assert.equal((await ledgerFor(snapshot)).length, 1);
  });

  test('every charge is ledgered exactly once, even when the job fails after paying', async () => {
    routes['POST /v1/agent'] = { body: fixture('perplexity/agent-ok.json') };
    failStoreWrites = 1; // the provider answers (and charges), then the bucket refuses the raw answer
    const snapshot = await collect('perplexity');
    const job = await finished(snapshot);
    assert.equal(job.attemptsMade, 2);
    const charged = providerCalls('POST /v1/agent');
    assert.equal(charged, 2, 'the retry asked again');
    const ledger = await ledgerFor(snapshot);
    assert.equal(ledger.length, charged, 'one row per real charge, never two for one');
    assert.equal(new Set(ledger.map((r) => r.idempotency_key)).size, ledger.length);
  });

  test('refused credentials are not retried: the snapshot is "couldn’t check" at once, nothing charged', async () => {
    routes['GET /search.json'] = { status: 401, body: '{"error":"Invalid API key."}' };
    const snapshot = await collect('google_aio');
    const job = await finished(snapshot, ['failed']);
    assert.equal(job.attemptsMade, 1);
    const row = await reload(snapshot);
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason, /^auth: /);
    assert.ok(!row.failure_reason.includes('serp-secret'));
    assert.equal(row.extraction_status, 'skipped');
    assert.equal((await ledgerFor(snapshot)).length, 0);
  });

  test('a provider that keeps failing: five attempts, then the snapshot is failed (never "no answer")', async () => {
    routes['POST /v1/agent'] = { status: 500, body: '' };
    const snapshot = await collect('perplexity');
    const job = await finished(snapshot, ['failed']);
    assert.equal(job.attemptsMade, 5);
    const row = await reload(snapshot);
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason, /^http_500/);
  });

  test('a response we cannot read is kept in storage, failed without retrying, and was paid for', async () => {
    const body = JSON.parse(fixture('perplexity/agent-ok.json'));
    body.output = body.output.map((i) => (i.type === 'message' ? { ...i, type: 'reply' } : i));
    routes['POST /v1/agent'] = { body: JSON.stringify(body) };
    const snapshot = await collect('perplexity');
    const job = await finished(snapshot, ['failed']);
    assert.equal(job.attemptsMade, 1);
    const row = await reload(snapshot);
    assert.match(row.failure_reason, /^bad_response/);
    assert.match(row.raw_uri, /^test\/answers\//, 'it points at what the provider sent');
    const doc = JSON.parse((await store.get(row.raw_uri)).body);
    assert.equal(doc.normalized, null);
    assert.match(doc.readError, /no readable answer/);
    assert.equal((await ledgerFor(snapshot)).length, 1, 'the provider charged for it');
  });

  test('a queued task that never finishes is given up on after the deadline', async () => {
    routes['POST /v3/ai_optimization/gemini/llm_scraper/task_post'] = {
      body: fixture('dataforseo/chatgpt-task-post.json'),
    };
    routes[
      'GET /v3/ai_optimization/gemini/llm_scraper/task_get/advanced/10031512-1535-0636-0000-7f0c2a4e1b11'
    ] = {
      body: fixture('dataforseo/chatgpt-task-get-queued.json'),
    };
    const snapshot = await collect('gemini', { mode: 'priority' });
    const job = await finished(snapshot, ['completed'], 30_000);
    assert.equal(job.returnvalue.reason, 'provider_timeout');
    const row = await reload(snapshot);
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason, /provider_timeout/);
    assert.equal((await ledgerFor(snapshot)).length, 1, 'it was still charged when queued');
  });
});

describe('routing', () => {
  test('with the primary’s breaker open, the fallback answers, and the snapshot says so', async () => {
    await h.runtime.ctx.health.setState('serpapi', 'google_aio', {
      state: 'open',
      openedAt: Date.now(),
    });
    try {
      routes['GET /search.json'] = { body: fixture('serpapi/google-aio-inline.json') };
      const snapshot = await collect('google_aio');
      await finished(snapshot);
      const row = await reload(snapshot);
      assert.deepEqual(
        [row.status, row.provider_code, row.is_fallback],
        ['ok', 'dataforseo', true],
      );
      assert.equal(providerCalls('GET /search.json'), 0, 'the tripped provider was not asked');
      const [entry] = await ledgerFor(snapshot);
      assert.equal(entry.provider_code, 'dataforseo');
    } finally {
      await h.runtime.ctx.health.setState('serpapi', 'google_aio', { state: 'closed' });
    }
  });
});

describe('an answer stays inside its organization', () => {
  test('a payload naming another organization’s snapshot is refused, and that snapshot is untouched', async () => {
    routes['POST /v1/agent'] = { body: fixture('perplexity/agent-ok.json') };
    const routing = await db.reference.engines.get('perplexity');
    const prompt = await fx.prompt(project);
    const run = await fx.run(project);
    const { snapshot } = await org.scoped.snapshots.create({
      runId: run.id,
      promptId: prompt.id,
      engineCode: 'perplexity',
      sampleIdx: 0,
      providerCode: routing.primaryProviderCode,
      method: routing.primaryMethod,
    });
    const forged = await h.runtime.jobs.add(
      'collect.answer',
      { orgId: String(other.org.id), snapshotId: String(snapshot.id) },
      { jobId: `forged-${snapshot.id}` },
    );
    const failed = await waitForJob(queue(), forged.id, ['failed']);
    assert.match(failed.failedReason, /not found/);
    assert.equal(failed.attemptsMade, 1);
    assert.equal(providerCalls('POST /v1/agent'), 0, 'no provider was asked');
    const row = await reload(snapshot);
    assert.equal(row.status, 'pending');
    assert.equal((await other.scoped.usage.recent()).length, 0, 'nothing charged to the other org');
  });
});

describe('the daily spend cap holds back real collection (Milestone 10, task 10.07)', () => {
  test('once the cap is reached no more answers are asked for; the jobs wait, nothing fails, and raising the cap lets them through', async () => {
    const capped = await fx.org();
    const cappedProject = await fx.project(capped.org.id, 'Capped');
    // One Perplexity answer costs $0.003776: the third one crosses $0.01 (the cap column keeps whole cents).
    await fx.setOrgSpend(capped.org.id, { capUsd: '0.01' });
    routes['POST /v1/agent'] = { body: fixture('perplexity/agent-ok.json') };
    const mine = { owner: capped, proj: cappedProject };
    const reloadMine = (snapshot) => capped.scoped.snapshots.get(snapshot.id);

    await finished(await collect('perplexity', mine));
    await finished(await collect('perplexity', mine));
    assert.equal((await fx.organizationRow(capped.org.id)).collection_paused_until, null);
    await finished(await collect('perplexity', mine));
    assert.ok(
      (await fx.organizationRow(capped.org.id)).collection_paused_until,
      'the answer that crossed the cap paused collection',
    );
    const askedBefore = providerCalls('POST /v1/agent');
    assert.equal(askedBefore, 3);

    // Three more answers are wanted. None is asked for, none fails, none becomes "not mentioned".
    const wanted = [];
    for (let i = 0; i < 3; i += 1) wanted.push(await collect('perplexity', mine));
    for (const snapshot of wanted) {
      const job = await finished(snapshot, ['delayed']);
      assert.equal(job.attemptsMade, 0, 'waiting for the cap does not use up an attempt');
    }
    assert.equal(providerCalls('POST /v1/agent'), askedBefore, 'the provider was not called');
    for (const snapshot of wanted) {
      const row = await reloadMine(snapshot);
      assert.equal(row.status, 'pending');
      assert.equal(
        (await capped.scoped.usage.recent({ limit: 50 })).filter((r) => r.ref_id === snapshot.id)
          .length,
        0,
      );
    }
    assert.equal(
      (await other.scoped.usage.recent({ limit: 50 })).length,
      0,
      'the cap is the organization’s own: another organization is not held',
    );

    // Another organization carries on while this one is held.
    const unaffected = await collect('perplexity');
    assert.equal((await finished(unaffected)).returnvalue.status, 'ok');

    // The owner raises the cap; the guard lifts the pause; the held jobs run.
    await fx.setOrgSpend(capped.org.id, { capUsd: '5' });
    await h.runtime.ctx.spendGuard.check(capped.org.id);
    assert.equal((await fx.organizationRow(capped.org.id)).collection_paused_until, null);
    for (const snapshot of wanted) {
      await (await queue().getJob(answerJobId(snapshot.id))).promote();
      assert.equal((await finished(snapshot)).returnvalue.status, 'ok');
    }
    assert.equal(providerCalls('POST /v1/agent'), askedBefore + 1 + wanted.length);
  });
});
