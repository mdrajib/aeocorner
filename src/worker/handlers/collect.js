import { UnrecoverableError } from 'bullmq';
import { chooseRoute } from '../../core/routing.js';
import { fromMicros } from '../../core/spend.js';
import { collectTaskSchema, PENDING, ProviderError } from '../../engines/contract.js';
import { storeRaw } from '../../integrations/spaces.js';
import { Deferral } from '../deferral.js';
import { ledgerKey } from '../provider-call.js';

/**
 * Handlers for the `collect` queue: asking AI engines our customers' questions (MVP F4, §7.6).
 *
 * `collect.answer` fills one `answer_snapshots` row:
 *
 *   1. route     the engine's primary provider, or its fallback if the primary's breaker is open (MVP §7.8).
 *                Only providers this worker has an adapter for count.
 *   2. submit    through callProvider (spend cap, breaker, org slot, rate limit, ledger). Providers that answer
 *                at once hand back the answer; DataForSEO's standard queue hands back a task ID, which is saved on
 *                the snapshot, and the job comes back later (a Deferral, which costs no attempt) to:
 *   3. poll      also through callProvider, but free: no ledger row. Still working -> come back later, until the
 *                provider's own deadline has clearly passed.
 *   4. store     the raw response first (raw-first, MVP §7.1), with our normalized reading of it, in one JSON
 *                document under a content-addressed key.
 *   5. complete  the snapshot: ok or no_answer, with the model, the cost and where the raw document is.
 *
 * A failure that won't get better by trying again (bad credentials, a response we can't read) marks the snapshot
 * failed at once; any other failure is retried, and the last attempt marks it failed. Failed is "couldn't check",
 * never "not mentioned".
 */

const TERMINAL = new Set(['ok', 'no_answer', 'failed']);

/** How often to ask a queue-based provider whether it is done, and when to stop asking (DataForSEO's promise
 * is 45 minutes for standard and 5 for priority; the deadlines leave room). */
export const POLLING = Object.freeze({
  standard: { everyMs: 60_000, giveUpAfterMs: 75 * 60_000 },
  priority: { everyMs: 15_000, giveUpAfterMs: 20 * 60_000 },
  live: { everyMs: 5_000, giveUpAfterMs: 5 * 60_000 },
});

/** The polling schedule for a mode. Tests pass a faster one as `collection.polling`. */
const pollingFor = (ctx, mode) => {
  const table = ctx.collection?.polling ?? POLLING;
  return table[mode] ?? table.standard;
};

async function collectAnswer(ctx, data, job) {
  const collection = ctx.collection;
  if (!collection?.adapters || !collection?.store) {
    throw new UnrecoverableError('Answer collection is not configured on this worker');
  }
  const orgId = BigInt(data.orgId);
  const snapshotId = BigInt(data.snapshotId);
  const scoped = ctx.db.forOrg(orgId);

  // Read through the organization in the payload: someone else's snapshot is simply not found.
  const snapshot = await scoped.snapshots.get(snapshotId);
  if (!snapshot?.prompt) throw new UnrecoverableError(`Snapshot ${data.snapshotId} was not found`);
  if (TERMINAL.has(snapshot.status)) {
    return { snapshotId: data.snapshotId, status: snapshot.status, repeated: true };
  }

  const engine = await ctx.db.reference.engines.get(snapshot.engine_code);
  if (!engine) throw new UnrecoverableError(`Unknown engine ${snapshot.engine_code}`);

  const task = collectTaskSchema.parse({
    ref: String(snapshot.id),
    engine: engine.code,
    text: snapshot.prompt.text,
    searchQuery: snapshot.prompt.search_query,
    country: snapshot.country,
    language: snapshot.language,
    city: snapshot.city,
    mode: snapshot.mode,
  });
  const callParams = (provider, step) => ({
    orgId: data.orgId,
    projectId: String(snapshot.project_id),
    provider,
    engine: engine.code,
    scope: 'collect',
    idempotencyKey: ledgerKey('collect', job, step),
  });

  try {
    // A provider is already working on it: ask whether it has finished.
    if (snapshot.provider_task_id && collection.adapters.has(snapshot.provider_code, engine.code)) {
      const adapter = collection.adapters.get(snapshot.provider_code, engine.code);
      const { value: raw } = await ctx.callProvider(
        job,
        callParams(adapter.provider, 'poll'),
        async () => ({
          value: await adapter.poll({ providerRef: snapshot.provider_task_id, raw: null }),
          usage: { free: true },
        }),
      );
      if (raw === PENDING) return waitForProvider(ctx, job, data, snapshot, scoped);
      return await finish(ctx, scoped, {
        snapshot,
        adapter,
        task,
        raw,
        isFallback: snapshot.is_fallback,
        providerRef: snapshot.provider_task_id,
        costMicros: null, // recorded when it was submitted
      });
    }

    // 1. Route. A provider whose breaker is open, or that this worker has no adapter (credentials) for, is skipped.
    // Only the breaker's state is read here; callProvider makes the real admission (and takes a half-open probe).
    const route = await chooseRoute(engine, async (provider, engineCode) => {
      if (!collection.adapters.has(provider, engineCode)) return 'deny';
      const { state } = await ctx.health.state(provider, engineCode);
      return state === 'open' ? 'deny' : 'allow';
    });
    if (!route) {
      if (!collection.adapters.list().some((a) => a.engine === engine.code)) {
        throw new ProviderError(`No provider is configured for ${engine.code}`, {
          status: 'no_provider',
          retryable: false,
          countsAgainstProvider: false,
        });
      }
      throw new Deferral(60_000, `every provider for ${engine.code} is unavailable`);
    }
    const adapter = collection.adapters.get(route.provider, engine.code);

    // 2. Submit. Each attempt that reaches the provider is a charge of its own, so the ledger key carries the
    // attempt number: a retry after a crash is counted, a repeat of the same attempt is not.
    const { value: handle } = await ctx.callProvider(
      job,
      callParams(adapter.provider, `submit${job.attemptsMade}`),
      async () => {
        const h = await adapter.submit(task);
        return {
          value: h,
          usage: {
            meter: engine.queryField === 'search_query' ? 'serp' : 'answer_collect',
            unit: engine.queryField === 'search_query' ? 'search' : 'result',
            quantity: h.quantity ?? 1,
            model: h.model ?? null,
            tokensIn: h.tokensIn ?? null,
            tokensOut: h.tokensOut ?? null,
            costUsd: fromMicros(h.costMicros),
            refType: 'snapshot',
            refId: snapshot.id,
          },
        };
      },
    );

    if (!handle.raw) {
      await scoped.snapshots.submitted(snapshot.id, {
        providerCode: adapter.provider,
        method: adapter.method,
        isFallback: route.kind === 'fallback',
        providerTaskId: handle.providerRef,
        costUsd: fromMicros(handle.costMicros),
      });
      await job.updateData({ ...data, submittedAt: ctx.now().toISOString() });
      throw new Deferral(pollingFor(ctx, task.mode).everyMs, 'the provider queued the question');
    }

    return await finish(ctx, scoped, {
      snapshot,
      adapter,
      task,
      raw: handle.raw,
      isFallback: route.kind === 'fallback',
      providerRef: handle.providerRef,
      costMicros: handle.costMicros,
    });
  } catch (err) {
    if (err instanceof Deferral || err instanceof UnrecoverableError) throw err;
    const giveUp = err instanceof ProviderError && !err.retryable;
    const lastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
    if (giveUp || lastAttempt) {
      await scoped.snapshots
        .fail(snapshot.id, reasonOf(err), { rawUri: err?.storedAt })
        .catch(() => {});
    }
    if (giveUp) throw new UnrecoverableError(err.message);
    throw err;
  }
}

/** Still working: come back later, unless the provider has clearly missed its own deadline. */
async function waitForProvider(ctx, job, data, snapshot, scoped) {
  const polling = pollingFor(ctx, snapshot.mode);
  const since = data.submittedAt ? new Date(data.submittedAt) : snapshot.updated_at;
  if (ctx.now().getTime() - since.getTime() > polling.giveUpAfterMs) {
    await scoped.snapshots.fail(snapshot.id, 'provider_timeout: the queued task never finished');
    return { snapshotId: data.snapshotId, status: 'failed', reason: 'provider_timeout' };
  }
  throw new Deferral(polling.everyMs, 'the provider is still working on it');
}

/** Store the raw answer, then read it, then record it. */
async function finish(
  ctx,
  scoped,
  { snapshot, adapter, task, raw, isFallback, providerRef, costMicros },
) {
  const collectedAt = ctx.now();
  let normalized = null;
  let readError = null;
  try {
    normalized = adapter.normalize(raw, task);
  } catch (err) {
    readError = err;
  }

  // Raw-first: the provider's bytes are kept even when we can't read them, so a fixed reader can be run later.
  const document = {
    format: 'aeo-corner.answer.v1',
    provider: adapter.provider,
    engine: adapter.engine,
    method: adapter.method,
    providerRef: providerRef ?? null,
    locale: { country: task.country, language: task.language, city: task.city },
    mode: task.mode,
    raw,
    normalized,
    readError: readError ? String(readError.message).slice(0, 300) : null,
  };
  const stored = await storeRaw(ctx.collection.store, {
    kind: 'answer',
    body: JSON.stringify(document),
    contentType: 'application/json',
    url: `${adapter.provider}/${adapter.engine}`,
    status: normalized?.status ?? 'unreadable',
    fetchedAt: collectedAt,
  });

  if (readError) {
    const err =
      readError instanceof ProviderError
        ? readError
        : new ProviderError(`${adapter.provider}/${adapter.engine}: ${readError.message}`, {
            status: 'bad_response',
          });
    err.retryable = false; // the same bytes will be just as unreadable next time
    err.storedAt = stored.key;
    throw err;
  }

  const done = await scoped.snapshots.complete(snapshot.id, {
    status: normalized.status,
    providerCode: adapter.provider,
    method: adapter.method,
    isFallback,
    providerTaskId: normalized.providerRef ?? providerRef,
    modelVersion: normalized.modelVersion,
    collectedAt,
    rawUri: stored.key,
    rawSha256: stored.sha256,
    answerChars: normalized.text.length,
    textExcerpt: normalized.text.slice(0, 500),
    ...(costMicros !== null ? { costUsd: fromMicros(costMicros) } : {}),
  });
  return {
    snapshotId: String(snapshot.id),
    status: normalized.status,
    provider: adapter.provider,
    sources: normalized.sources.length,
    repeated: !done,
  };
}

const reasonOf = (err) =>
  `${err?.status ?? err?.name ?? 'error'}: ${String(err?.message ?? '').slice(0, 200)}`;

export const collectHandlers = {
  'collect.answer': collectAnswer,
};
