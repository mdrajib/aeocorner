import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { ProviderError } from '../../src/engines/contract.js';
import { createFileStore, storeRaw } from '../../src/integrations/spaces.js';
import { extractAnswerJobId, extractPollJobId, extractRunJobId } from '../../src/lib/job-ids.js';
import { parseCustomId } from '../../src/llm/extraction.js';
import { startRuntime, until, waitForJob } from '../helpers/worker.js';

/**
 * Reading collected answers as queued jobs (BUILD_PLAN Phase 6), against real Redis and MySQL, with Claude replaced
 * by a stand-in that answers each request the way a test says: a run's answers go out as one batch, the results
 * become mentions, citations and claims, the batch is ledgered once; a malformed or cut-off reply writes nothing
 * and leaves earlier rows alone; items Anthropic failed are read again one by one; nothing crosses organizations.
 */

const db = connectTestDb();
const fx = fixtures(db);
const DOMAINS = ['acme-x.test', 'rival-x.test', 'g2-x.test', 'blog.rival-x.test'];

let storeDir;
let store;
let h;
let org;
let other;
let project;
let brand;
let rival;
let run;
let prompt;

/** What the stand-in replies, per snapshot ID, and what it was sent. */
let replies;
let sent;
let batches;
let failExtract;

const message = (json, over = {}) => ({
  id: 'msg_1',
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }],
  usage: {
    input_tokens: 1_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 3_000,
    output_tokens: 400,
  },
  ...over,
});

const reading = (over = {}) => ({
  answer_type: 'list',
  entities: [
    {
      name: 'RivalCRM',
      tracked_ref: 'E2',
      list_rank: 1,
      prominence: 'primary',
      stance: 'recommended',
      sentiment: 1,
      excerpt: 'RivalCRM – fast and cheap.',
      claims: [{ attribute: 'pricing', value: 'cheap', polarity: 'positive' }],
    },
    {
      name: 'Pipedrive',
      tracked_ref: null,
      list_rank: 2,
      prominence: 'primary',
      stance: 'recommended',
      sentiment: 1,
      excerpt: 'Pipedrive – visual.',
      claims: [],
    },
    {
      name: 'Acme CRM',
      tracked_ref: 'E1',
      list_rank: 3,
      prominence: 'primary',
      stance: 'cautioned',
      sentiment: -1,
      excerpt: 'Acme CRM – powerful, but pricey.',
      claims: [{ attribute: 'pricing', value: 'pricey', polarity: 'negative' }],
    },
  ],
  citations: [
    { source: 1, supports: ['E2', 'Pipedrive'] },
    { source: 2, supports: ['E1'] },
  ],
  ...over,
});

const claude = {
  provider: 'anthropic',
  async extract(params) {
    sent.push({ kind: 'sync', params });
    if (failExtract > 0) {
      failExtract -= 1;
      throw new ProviderError('anthropic messages.create: HTTP 529 (overloaded_error)', {
        status: 'overloaded',
      });
    }
    return replies.get('sync') ?? message(reading());
  },
  batches: {
    async create(requests) {
      const id = `msgbatch_test${Object.keys(batches).length + 1}x${Date.now()}`;
      batches[id] = { requests, polls: 0 };
      sent.push({ kind: 'batch', id, count: requests.length });
      return { id, processing_status: 'in_progress' };
    },
    async retrieve(id) {
      const b = batches[id];
      b.polls += 1;
      return { id, processing_status: b.polls >= 2 ? 'ended' : 'in_progress' };
    },
    async results(id) {
      return batches[id].requests.map((r) => {
        const { snapshotId } = parseCustomId(r.custom_id);
        const result = replies.get(String(snapshotId)) ?? {
          type: 'succeeded',
          message: message(reading()),
        };
        return { custom_id: r.custom_id, result };
      });
    },
  },
};

/** Store an answer document the way collect.answer does, and return its key. */
async function storedAnswer(text, sources = []) {
  const doc = {
    format: 'aeo-corner.answer.v1',
    raw: {},
    normalized: { status: 'ok', text, sources },
  };
  const { key } = await storeRaw(store, {
    kind: 'answer',
    body: JSON.stringify(doc),
    contentType: 'application/json',
    url: 'perplexity_api/perplexity',
    status: 'ok',
  });
  return key;
}

const ANSWER =
  'Good CRMs for small teams:\n\n1. **RivalCRM** – fast and cheap.[1]\n2. **Pipedrive** – visual.\n3. **Acme CRM** – powerful, but pricey.[2]';
const SOURCES = [
  { url: 'https://www.g2-x.test/crm?utm_source=perplexity', title: 'G2 CRM grid', position: 1 },
  { url: 'https://acme-x.test/pricing', title: 'Acme pricing', position: 2 },
];

/** A collected answer in `run`, with its text in the bucket. */
async function answer({ text = ANSWER, sources = SOURCES, inRun = run, sample = 0 } = {}) {
  const key = await storedAnswer(text, sources);
  const snap = await fx.collectedAnswer(inRun, prompt, { rawUri: key, sampleIdx: sample });
  return snap;
}

before(async () => {
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'aeo-extract-store-'));
  store = createFileStore({ dir: storeDir, prefix: 'test/' });
  org = await fx.org();
  other = await fx.org();
  project = await fx.project(org.org.id, 'Extracted');
  brand = await fx.entity(project, {
    kind: 'brand',
    name: 'Acme CRM',
    aliases: ['Acme'],
    domains: ['acme-x.test'],
  });
  rival = await fx.entity(project, {
    kind: 'competitor',
    name: 'RivalCRM',
    domains: ['rival-x.test'],
  });
  prompt = await fx.prompt(project, { text: 'Best CRM for a small team?' });
  h = await startRuntime({
    db,
    queueNames: ['extract'],
    extraction: { claude, store, model: 'opus55', polling: { everyMs: 1_000 } },
  });
});

after(async () => {
  await h?.stop();
  await rm(storeDir, { recursive: true, force: true });
  await fx.cleanup();
  await fx.forgetDomains(DOMAINS);
  await db.close();
});

beforeEach(async () => {
  replies = new Map();
  sent = [];
  batches = {};
  failExtract = 0;
  run = await fx.run(project);
});

const scoped = () => db.forOrg(org.org.id);
const runBatch = async (r = run, round = 1) => {
  const job = await h.runtime.jobs.add(
    'extract.batch',
    { orgId: String(org.org.id), runId: String(r.id) },
    { jobId: extractRunJobId(r.id, round) },
  );
  const done = await waitForJob(h.queue('extract'), job.id);
  assert.equal(await done.getState(), 'completed', done.failedReason);
  return done.returnvalue;
};
const waitPoll = async (batchId) => {
  const done = await waitForJob(
    h.queue('extract'),
    extractPollJobId(batchId),
    ['completed', 'failed'],
    {
      timeoutMs: 20_000,
    },
  );
  assert.equal(await done.getState(), 'completed', done.failedReason);
  return done.returnvalue;
};

describe('extract.batch → extract.poll', () => {
  test('a run’s answers go out as one batch; each result is stored whole; the batch is ledgered once', async () => {
    const a = await answer();
    const b = await answer({ sample: 1 });
    const submitted = await runBatch();
    assert.equal(submitted.submitted, 2);
    assert.equal(sent.filter((s) => s.kind === 'batch').length, 1);
    const [request] = batches[submitted.batchId].requests;
    assert.match(
      request.params.messages[0].content[0].text,
      /E1 \| Acme CRM \| brand \| aliases: Acme \| domains: acme-x.test/,
    );
    assert.match(
      request.params.messages[0].content[1].text,
      /\[1\] g2-x.test \| G2 CRM grid \| https:\/\/www.g2-x.test\/crm\n/,
    );

    const polled = await waitPoll(submitted.batchId);
    assert.deepEqual(
      { ...polled, batchId: undefined },
      {
        batchId: undefined,
        results: 2,
        done: 2,
        failed: 0,
        redo: 0,
        skipped: 0,
      },
    );

    const r = await scoped().extractions.readingOf(a.id);
    assert.equal(r.snapshot.extraction_status, 'done');
    assert.equal(r.snapshot.extraction_version, 'x1.opus55');
    assert.equal(r.snapshot.answer_type, 'list');
    assert.deepEqual(
      r.snapshot.prepass.found.map((f) => f.entityId).sort(),
      [String(brand.id), String(rival.id)].sort(),
    );
    assert.deepEqual(
      r.mentions.map((m) => [
        m.name_as_written,
        m.list_rank,
        m.mention_order,
        m.stance,
        m.detected_by,
      ]),
      [
        ['RivalCRM', 1, 1, 'recommended', 'both'],
        ['Pipedrive', 2, 2, 'recommended', 'llm'],
        ['Acme CRM', 3, 3, 'cautioned', 'both'],
      ],
    );
    assert.equal(r.mentions[1].excerpt, null, 'discovered brands keep no excerpt');
    assert.deepEqual(
      r.claims.map((c) => [c.attribute, c.claim_value, c.polarity]),
      [
        ['pricing', 'cheap', 'positive'],
        ['pricing', 'pricey', 'negative'],
      ],
    );
    assert.deepEqual(
      r.citations.map((c) => [
        c.position,
        c.is_own,
        c.owner_entity_id === brand.id,
        c.supports_entity_ids.length,
      ]),
      [
        [1, false, false, 2],
        [2, true, true, 1],
      ],
    );
    assert.deepEqual(r.reviews, [], 'the two readers agreed');

    // The discovered brand became a suggestion in the project, once for both answers.
    const pipedrive = r.mentions[1].entity_id;
    assert.equal((await scoped().extractions.readingOf(b.id)).mentions[1].entity_id, pipedrive);

    // One ledger row for the whole batch, at batch prices: 2 × (1000 × 4 + 3000 × 0.2 + 400 × 20) / 2.
    const ledger = await fx.ledgerRow(`extract.batch.${submitted.batchId}`);
    assert.equal(ledger.meter, 'llm_extract');
    assert.equal(ledger.unit, 'batch');
    assert.equal(String(ledger.cost_usd), '0.0126');
    assert.equal(ledger.tokens_cached, 6_000);
    assert.equal(ledger.org_id, org.org.id);

    const recorded = await scoped().extractions.batchesOf(run.id);
    assert.ok(recorded[0].processedAt);
  });

  test('a malformed, cut-off or wrong-shaped reply stores nothing, and earlier rows of that answer survive', async () => {
    // `good` and `truncated` are read once first; `truncated`'s rows must survive a re-read that goes wrong.
    const good = await answer();
    const truncated = await answer({ sample: 1 });
    await waitPoll((await runBatch()).batchId);
    const before = await scoped().extractions.readingOf(truncated.id);
    assert.equal(before.mentions.length, 3);
    await scoped().extractions.requeue(truncated.id);

    const badJson = await answer({ sample: 2 });
    const badShape = await answer({ sample: 3 });
    const refused = await answer({ sample: 4 });

    const partial = JSON.stringify(reading()).slice(0, 200);
    replies.set(String(truncated.id), {
      type: 'succeeded',
      message: message(partial, { stop_reason: 'max_tokens' }),
    });
    replies.set(String(badJson.id), {
      type: 'succeeded',
      message: message('{"answer_type":"list","entities":[{'),
    });
    replies.set(String(badShape.id), {
      type: 'succeeded',
      message: message({ ...reading(), entities: [{ ...reading().entities[0], sentiment: 9 }] }),
    });
    replies.set(String(refused.id), {
      type: 'succeeded',
      message: message('', {
        stop_reason: 'refusal',
        content: [],
        stop_details: { category: 'cyber' },
      }),
    });
    await scoped().extractions.requeue(good.id);
    const polled = await waitPoll((await runBatch(run, 2)).batchId);
    assert.equal(polled.done, 1);
    assert.equal(polled.failed, 4);

    for (const [snap, reason] of [
      [truncated, 'extraction: max_tokens'],
      [badJson, 'extraction: invalid_json'],
      [badShape, 'extraction: invalid_shape'],
      [refused, 'extraction: refusal (cyber)'],
    ]) {
      const r = await scoped().extractions.readingOf(snap.id);
      assert.equal(r.snapshot.extraction_status, 'failed', reason);
      assert.match(r.snapshot.failure_reason, new RegExp(`^${reason.replace(/[()]/g, '\\$&')}`));
      assert.equal(r.snapshot.status, 'ok', 'the answer itself is still a collected answer');
    }
    // Nothing new was written for the failures, and the earlier reading of `truncated` is intact.
    assert.equal((await scoped().extractions.readingOf(badJson.id)).mentions.length, 0);
    assert.equal((await scoped().extractions.readingOf(badJson.id)).citations.length, 0);
    const after = await scoped().extractions.readingOf(truncated.id);
    assert.deepEqual(
      after.mentions.map((m) => [String(m.id), m.name_as_written]),
      before.mentions.map((m) => [String(m.id), m.name_as_written]),
    );
    assert.equal(after.citations.length, 2);
    assert.equal(
      (await scoped().extractions.readingOf(good.id)).snapshot.extraction_status,
      'done',
    );
  });

  test('items Anthropic failed or let expire are read again one by one; an invalid request is not', async () => {
    const errored = await answer();
    const expired = await answer({ sample: 1 });
    const invalid = await answer({ sample: 2 });
    replies.set(String(errored.id), {
      type: 'errored',
      error: { type: 'error', error: { type: 'api_error' } },
    });
    replies.set(String(expired.id), { type: 'expired' });
    replies.set(String(invalid.id), {
      type: 'errored',
      error: { type: 'error', error: { type: 'invalid_request_error' } },
    });
    const { batchId } = await runBatch();
    const polled = await waitPoll(batchId);
    assert.equal(polled.redo, 2);
    assert.equal(polled.failed, 1);

    for (const snap of [errored, expired]) {
      const job = await waitForJob(h.queue('extract'), extractAnswerJobId(snap.id, batchId));
      assert.equal(await job.getState(), 'completed', job.failedReason);
      assert.equal(
        (await scoped().extractions.readingOf(snap.id)).snapshot.extraction_status,
        'done',
      );
    }
    assert.equal(sent.filter((s) => s.kind === 'sync').length, 2);
    assert.equal(
      (await scoped().extractions.readingOf(invalid.id)).snapshot.extraction_status,
      'failed',
    );
  });

  test('a repeated submit job sends no second batch; a repeated poll writes no second ledger row', async () => {
    await answer();
    const first = await runBatch();
    const again = await runBatch(run, 'again');
    assert.equal(again.repeated, true);
    assert.equal(again.batchId, first.batchId);
    assert.equal(sent.filter((s) => s.kind === 'batch').length, 1);
    await waitPoll(first.batchId);

    // Run the poll again by hand: the batch is processed, so nothing changes.
    const job = await h.runtime.jobs.add(
      'extract.poll',
      { orgId: String(org.org.id), runId: String(run.id), batchId: first.batchId },
      { jobId: `${extractPollJobId(first.batchId)}-again` },
    );
    const done = await waitForJob(h.queue('extract'), job.id);
    assert.equal(done.returnvalue.repeated, true);
  });

  test('if the project’s brands change while a batch is out, its results are not trusted: each is read again', async () => {
    const snap = await answer();
    const { batchId } = await runBatch();
    const added = await fx.entity(project, { kind: 'competitor', name: 'Zeta CRM' });
    try {
      const polled = await waitPoll(batchId);
      assert.equal(polled.redo, 1);
      const job = await waitForJob(h.queue('extract'), extractAnswerJobId(snap.id, batchId));
      assert.equal(await job.getState(), 'completed', job.failedReason);
      const sync = sent.find((s) => s.kind === 'sync');
      assert.match(sync.params.messages[0].content[0].text, /Zeta CRM/);
    } finally {
      await fx.removeEntity(added.id);
    }
  });

  test('a poll naming a batch its run never recorded is refused; another organization’s run is not found', async () => {
    const job = await h.runtime.jobs.add('extract.poll', {
      orgId: String(org.org.id),
      runId: String(run.id),
      batchId: 'msgbatch_someone_elses',
    });
    const done = await waitForJob(h.queue('extract'), job.id);
    assert.equal(await done.getState(), 'failed');
    assert.match(done.failedReason, /is not one of run/);
    assert.equal(done.attemptsMade, 1, 'not retried');

    const forged = await h.runtime.jobs.add('extract.batch', {
      orgId: String(other.org.id),
      runId: String(run.id),
    });
    const refused = await waitForJob(h.queue('extract'), forged.id);
    assert.equal(await refused.getState(), 'failed');
    assert.match(refused.failedReason, /was not found/);
  });
});

describe('extract.answer', () => {
  test('one answer read now; an overloaded API is retried, and each attempt that reached Claude is ledgered', async () => {
    const snap = await answer();
    failExtract = 1;
    const job = await h.runtime.jobs.add(
      'extract.answer',
      { orgId: String(org.org.id), snapshotId: String(snap.id) },
      { jobId: extractAnswerJobId(snap.id) },
    );
    const done = await waitForJob(h.queue('extract'), job.id);
    assert.equal(await done.getState(), 'completed', done.failedReason);
    assert.equal(done.returnvalue.status, 'done');
    assert.equal(done.attemptsMade, 2, 'one failed attempt, then the success');
    const ledger = await fx.ledgerRow(`extract.${job.id}.call1`);
    // Full price: 1000 × 4 + 3000 × 0.2 + 400 × 20 = 12,600 micro-dollars.
    assert.equal(String(ledger.cost_usd), '0.0126');
    assert.equal(ledger.unit, 'request');
    assert.equal(
      await fx.ledgerRow(`extract.${job.id}.call0`),
      null,
      'the overloaded call was not charged',
    );
  });

  test('a refusal marks the answer failed and is not retried; a pending or failed collection is skipped', async () => {
    const snap = await answer();
    replies.set('sync', message('', { stop_reason: 'refusal', content: [] }));
    const job = await h.runtime.jobs.add('extract.answer', {
      orgId: String(org.org.id),
      snapshotId: String(snap.id),
    });
    const done = await waitForJob(h.queue('extract'), job.id);
    assert.equal(done.returnvalue.status, 'failed');
    assert.equal(done.attemptsMade, 1, 'not retried');
    assert.equal(
      (await scoped().extractions.readingOf(snap.id)).snapshot.extraction_status,
      'failed',
    );

    const { snapshot: pending } = await scoped().snapshots.create({
      runId: run.id,
      promptId: prompt.id,
      engineCode: 'chatgpt',
      sampleIdx: 0,
      providerCode: 'dataforseo',
      method: 'ui_capture',
    });
    const skip = await h.runtime.jobs.add('extract.answer', {
      orgId: String(org.org.id),
      snapshotId: String(pending.id),
    });
    assert.deepEqual((await waitForJob(h.queue('extract'), skip.id)).returnvalue, {
      snapshotId: String(pending.id),
      skipped: 'pending',
    });
  });

  test('another organization’s snapshot is not found, and nothing is sent to Claude', async () => {
    const snap = await answer();
    const job = await h.runtime.jobs.add('extract.answer', {
      orgId: String(other.org.id),
      snapshotId: String(snap.id),
    });
    const done = await waitForJob(h.queue('extract'), job.id);
    assert.equal(await done.getState(), 'failed');
    assert.match(done.failedReason, /was not found/);
    assert.equal(sent.length, 0);
    await until(
      async () =>
        (await scoped().extractions.readingOf(snap.id)).snapshot.extraction_status === 'pending',
    );
  });
});
