import { createHash } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { fromMicros } from '../../core/spend.js';
import { ProviderError } from '../../engines/contract.js';
import { extractAnswerJobId, extractPollJobId } from '../../lib/job-ids.js';
import { trackedEntitiesBlock } from '../../llm/extraction-prompt.js';
import {
  buildExtractionRequest,
  customIdFor,
  extractionVersion,
  mergeReading,
  parseCustomId,
  readReply,
  trackedEntities,
} from '../../llm/extraction.js';
import { costMicros, modelProfile, sumUsage } from '../../llm/models.js';
import { prepassRecord, runPrepass } from '../../llm/prepass.js';
import { Deferral } from '../deferral.js';
import { ledgerKey } from '../provider-call.js';

/**
 * Handlers for the `extract` queue: reading collected answers (MVP §6.4, §7.6).
 *
 *   extract.batch   every answer of a run still waiting to be read goes into one Claude batch (half price). The
 *                   batch is recorded on the run, then extract.poll is queued for it.
 *   extract.poll    asks whether the batch has ended (free; a Deferral while it hasn't), then downloads every
 *                   result and writes one ledger row for the whole batch, then stores each reading. An item that
 *                   errored or expired on Anthropic's side is read again on its own (extract.answer); one Claude
 *                   refused, cut short or answered in the wrong shape is marked failed and stores nothing.
 *   extract.answer  one answer, read now, at full price: the fallback for batch items, and the free audit's path.
 *
 * Each reading is the pre-pass and Claude combined (src/llm/extraction.js) and is stored whole or not at all.
 * The tracked brands are numbered E1..En in the prompt; if the project's brands changed while a batch was out,
 * those numbers no longer mean the same thing, so its results are not trusted: every item is read again now.
 */

/** How often to ask whether a batch has ended. Most end within the hour; none runs past 24 hours. */
export const BATCH_POLLING = Object.freeze({ everyMs: 60_000 });

const configured = (ctx) => {
  const extraction = ctx.extraction;
  if (!extraction?.claude || !extraction?.store) {
    throw new UnrecoverableError(
      'Answer extraction is not configured on this worker (ANTHROPIC_API_KEY)',
    );
  }
  return { ...extraction, profile: modelProfile(extraction.model ?? 'opus55') };
};

/** A fingerprint of the numbered brand list a prompt used, to notice it changing under a batch. */
const entitiesHash = (entities) =>
  createHash('sha256').update(trackedEntitiesBlock(entities)).digest('hex').slice(0, 16);

/** The answer as collected: the normalized text and sources stored with its raw payload (collect.js). */
async function loadAnswer(store, snapshot) {
  if (!snapshot.raw_uri) throw new UnreadableAnswer('no stored answer');
  const object = await store.get(snapshot.raw_uri);
  if (!object) throw new ProviderError('the stored answer is missing', { status: 'store_missing' });
  let doc;
  try {
    doc = JSON.parse(object.body.toString('utf8'));
  } catch {
    throw new UnreadableAnswer('the stored answer is not JSON');
  }
  const normalized = doc?.normalized;
  if (typeof normalized?.text !== 'string' || !Array.isArray(normalized.sources)) {
    throw new UnreadableAnswer('the stored answer has no normalized reading');
  }
  return normalized;
}

/** An answer that can't be sent: trying again won't change that. */
class UnreadableAnswer extends Error {}

/** What Claude is asked about this answer: the wording the engine was given. */
async function questionFor(ctx, snapshot) {
  const engine = await ctx.db.reference.engines.get(snapshot.engine_code);
  const prompt = snapshot.prompt ?? {};
  return engine?.queryField === 'search_query' && prompt.search_query
    ? prompt.search_query
    : (prompt.text ?? '');
}

/** Everything one answer's request and reading need. */
async function prepare(ctx, { snapshot, entities, profile, store }) {
  const answer = await loadAnswer(store, snapshot);
  const prepass = runPrepass(answer, entities);
  const params = buildExtractionRequest({
    profile,
    entities,
    question: await questionFor(ctx, snapshot),
    engine: snapshot.engine_code,
    text: answer.text,
    citations: prepass.citations,
  });
  return { answer, prepass, params };
}

/** Store a reading, or mark the answer failed when Claude's reply can't be used. */
async function store(scoped, { snapshot, entities, prepared, message, profile, now }) {
  const reply = readReply(message);
  if (!reply.ok) {
    await scoped.extractions.fail(
      snapshot.id,
      reply.reason + (reply.detail ? ` (${reply.detail})` : ''),
      {
        prepass: prepassRecord(prepared.prepass),
      },
    );
    return { status: 'failed', reason: reply.reason };
  }
  const plan = mergeReading({
    entities,
    prepass: prepared.prepass,
    reading: reply.reading,
    text: prepared.answer.text,
  });
  const counts = await scoped.extractions.save(snapshot.id, {
    plan,
    prepass: prepassRecord(prepared.prepass),
    version: extractionVersion(profile),
    extractedAt: now,
  });
  return { status: 'done', ...counts };
}

const usageOf = (profile, usage, { batch, quantity, refType, refId }) => ({
  meter: 'llm_extract',
  unit: batch ? 'batch' : 'request',
  quantity,
  model: profile.id,
  tokensIn: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  tokensOut: usage.output_tokens ?? 0,
  tokensCached: usage.cache_read_input_tokens ?? 0,
  costUsd: fromMicros(costMicros(profile, usage, { batch })),
  refType,
  refId,
});

// ---------------------------------------------------------------------------------------------------------------

async function extractBatch(ctx, data, job) {
  const { claude, store: bucket, profile } = configured(ctx);
  const scoped = ctx.db.forOrg(BigInt(data.orgId));
  const run = await scoped.extractions.run(BigInt(data.runId));
  if (!run) throw new UnrecoverableError(`Run ${data.runId} was not found`);

  // A batch already out for this run (a repeated job): make sure it is being waited for, and stop.
  const open = (await scoped.extractions.batchesOf(run.id)).find((b) => !b.processedAt);
  if (open) {
    await queuePoll(ctx, data, open.id);
    return { runId: data.runId, batchId: open.id, repeated: true };
  }

  const pending = await scoped.extractions.pendingForRun(run.id);
  if (pending.length === 0) return { runId: data.runId, submitted: 0 };
  const entities = trackedEntities(await scoped.extractions.entitiesFor(run.project_id));

  const requests = [];
  for (const snapshot of pending) {
    try {
      const { params } = await prepare(ctx, { snapshot, entities, profile, store: bucket });
      requests.push({ custom_id: customIdFor(snapshot.id, snapshot.run_date), params });
    } catch (err) {
      if (!(err instanceof UnreadableAnswer) && !(err instanceof RangeError)) throw err;
      await scoped.extractions.fail(snapshot.id, err.message);
    }
  }
  if (requests.length === 0) return { runId: data.runId, submitted: 0 };

  // Creating a batch costs nothing; what it costs is known, and ledgered, when its results are read.
  const { value: batch } = await ctx.callProvider(
    job,
    {
      orgId: data.orgId,
      projectId: String(run.project_id),
      provider: 'anthropic',
      scope: 'extract',
      idempotencyKey: ledgerKey('extract', job, 'submit'),
    },
    async () => ({ value: await claude.batches.create(requests), usage: { free: true } }),
  );
  await scoped.extractions.addBatch(run.id, {
    batchId: batch.id,
    model: profile.key,
    count: requests.length,
    submittedAt: ctx.now(),
    entities: entitiesHash(entities),
  });
  await queuePoll(ctx, data, batch.id);
  return { runId: data.runId, batchId: batch.id, submitted: requests.length };
}

const queuePoll = (ctx, data, batchId) =>
  ctx.jobs.add(
    'extract.poll',
    { orgId: data.orgId, runId: data.runId, batchId },
    {
      jobId: extractPollJobId(batchId),
      delayMs: ctx.extraction?.polling?.everyMs ?? BATCH_POLLING.everyMs,
    },
  );

async function extractPoll(ctx, data, job) {
  const { claude, store: bucket } = configured(ctx);
  const scoped = ctx.db.forOrg(BigInt(data.orgId));
  const runId = BigInt(data.runId);
  // Only a batch the run itself recorded: a payload naming someone else's batch is refused here.
  const record = (await scoped.extractions.batchesOf(runId)).find((b) => b.id === data.batchId);
  if (!record)
    throw new UnrecoverableError(`Batch ${data.batchId} is not one of run ${data.runId}'s`);
  if (record.processedAt) return { batchId: data.batchId, repeated: true };
  const run = await scoped.extractions.run(runId);
  const profile = modelProfile(record.model);
  const call = (step, fn) =>
    ctx.callProvider(
      job,
      {
        orgId: data.orgId,
        projectId: String(run.project_id),
        provider: 'anthropic',
        scope: 'extract',
        idempotencyKey:
          step === 'results' ? `extract.batch.${data.batchId}` : ledgerKey('extract', job, step),
      },
      fn,
    );

  const { value: status } = await call('retrieve', async () => ({
    value: await claude.batches.retrieve(data.batchId),
    usage: { free: true },
  }));
  if (status.processing_status !== 'ended') {
    throw new Deferral(
      ctx.extraction?.polling?.everyMs ?? BATCH_POLLING.everyMs,
      'the batch is still running',
    );
  }

  // Every result, and one ledger row for the batch: keyed by the batch, so a retried poll can't count it twice.
  const { value: results } = await call('results', async () => {
    const all = await claude.batches.results(data.batchId);
    const usage = sumUsage(
      all.filter((r) => r.result?.type === 'succeeded').map((r) => r.result.message.usage),
    );
    return {
      value: all,
      usage: usageOf(profile, usage, {
        batch: true,
        quantity: all.length,
        refType: 'run',
        refId: runId,
      }),
    };
  });

  const entities = trackedEntities(await scoped.extractions.entitiesFor(run.project_id));
  const brandsChanged = record.entities && record.entities !== entitiesHash(entities);
  const tally = { done: 0, failed: 0, redo: 0, skipped: 0 };
  for (const result of results) {
    const ref = parseCustomId(result.custom_id);
    const snapshot = ref ? await scoped.extractions.snapshot(ref.snapshotId) : null;
    if (
      !snapshot ||
      snapshot.run_id !== runId ||
      snapshot.run_date.toISOString().slice(0, 10) !== ref.runDate ||
      snapshot.extraction_status !== 'pending'
    ) {
      tally.skipped += 1;
      continue;
    }
    const type = result.result?.type;
    if (type === 'errored' && result.result.error?.error?.type === 'invalid_request_error') {
      await scoped.extractions.fail(snapshot.id, 'invalid_request');
      tally.failed += 1;
      continue;
    }
    if (type !== 'succeeded' || brandsChanged) {
      // Anthropic's side failed, the batch expired, or the brand numbering changed: read it again on its own.
      await ctx.jobs.add(
        'extract.answer',
        { orgId: data.orgId, snapshotId: String(snapshot.id) },
        { jobId: extractAnswerJobId(snapshot.id, data.batchId) },
      );
      tally.redo += 1;
      continue;
    }
    let prepared;
    try {
      prepared = await prepare(ctx, { snapshot, entities, profile, store: bucket });
    } catch (err) {
      if (!(err instanceof UnreadableAnswer) && !(err instanceof RangeError)) throw err;
      await scoped.extractions.fail(snapshot.id, err.message);
      tally.failed += 1;
      continue;
    }
    const outcome = await store(scoped, {
      snapshot,
      entities,
      prepared,
      message: result.result.message,
      profile,
      now: ctx.now(),
    });
    tally[outcome.status] += 1;
  }
  await scoped.extractions.batchProcessed(runId, data.batchId, ctx.now());
  return { batchId: data.batchId, results: results.length, ...tally };
}

async function extractAnswer(ctx, data, job) {
  const { claude, store: bucket, profile } = configured(ctx);
  const scoped = ctx.db.forOrg(BigInt(data.orgId));
  const snapshot = await scoped.extractions.snapshot(BigInt(data.snapshotId));
  if (!snapshot) throw new UnrecoverableError(`Snapshot ${data.snapshotId} was not found`);
  if (snapshot.status !== 'ok') return { snapshotId: data.snapshotId, skipped: snapshot.status };
  if (snapshot.extraction_status !== 'pending') {
    return { snapshotId: data.snapshotId, repeated: snapshot.extraction_status };
  }
  const entities = trackedEntities(await scoped.extractions.entitiesFor(snapshot.project_id));

  try {
    let prepared;
    try {
      prepared = await prepare(ctx, { snapshot, entities, profile, store: bucket });
    } catch (err) {
      if (!(err instanceof UnreadableAnswer) && !(err instanceof RangeError)) throw err;
      await scoped.extractions.fail(snapshot.id, err.message);
      return { snapshotId: data.snapshotId, status: 'failed', reason: err.message };
    }
    // Each attempt that reaches Claude is a charge of its own.
    const { value: message } = await ctx.callProvider(
      job,
      {
        orgId: data.orgId,
        projectId: String(snapshot.project_id),
        provider: 'anthropic',
        scope: 'extract',
        idempotencyKey: ledgerKey('extract', job, `call${job.attemptsMade}`),
      },
      async () => {
        const reply = await claude.extract(prepared.params);
        return {
          value: reply,
          usage: usageOf(profile, reply.usage ?? {}, {
            batch: false,
            quantity: 1,
            refType: 'snapshot',
            refId: snapshot.id,
          }),
        };
      },
    );
    const outcome = await store(scoped, {
      snapshot,
      entities,
      prepared,
      message,
      profile,
      now: ctx.now(),
    });
    return { snapshotId: data.snapshotId, ...outcome };
  } catch (err) {
    if (err instanceof Deferral || err instanceof UnrecoverableError) throw err;
    const giveUp = err instanceof ProviderError && !err.retryable;
    const lastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
    if (giveUp || lastAttempt) {
      await scoped.extractions
        .fail(snapshot.id, `${err?.status ?? 'error'}: ${String(err?.message ?? '').slice(0, 200)}`)
        .catch(() => {});
    }
    if (giveUp) throw new UnrecoverableError(err.message);
    throw err;
  }
}

export const extractHandlers = {
  'extract.batch': extractBatch,
  'extract.poll': extractPoll,
  'extract.answer': extractAnswer,
};
