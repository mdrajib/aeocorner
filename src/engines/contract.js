import { z } from 'zod';

/**
 * The engine adapter contract (MVP §7.5). Every way of getting an answer out of an AI engine, whoever provides
 * it, looks the same to the rest of the app:
 *
 *   adapter.engine            'chatgpt' | 'perplexity' | 'gemini' | 'google_aio' | 'claude'
 *   adapter.provider          'dataforseo' | 'perplexity_api' | 'serpapi' | 'anthropic' | ...  (providers.code)
 *   adapter.method            'ui_capture' | 'api_grounded' | 'serp'
 *   adapter.submit(task)      -> ProviderHandle { providerRef, raw, costMicros, ... }. A provider that answers
 *                                straight away puts the answer in `raw`; one that queues the work leaves `raw`
 *                                null and `providerRef` is its task ID to poll. `costMicros` is what this answer
 *                                was charged: the provider's own figure where it reports one.
 *   adapter.poll(handle)      -> the raw answer, or 'pending' while the provider is still working
 *   adapter.normalize(raw, task) -> NormalizedAnswer: the same shape whoever provided it
 *   adapter.estimateCostUsd(task) -> what one answer costs at published prices, before asking (a number, as in
 *                                the MVP sketch); `estimateCostMicros(task)` is the same in whole micro-dollars,
 *                                which is what code that adds money up uses (src/core/spend.js)
 *
 * Errors are `ProviderError`s that say whether trying again could help.
 */

export const ENGINES = Object.freeze(['chatgpt', 'perplexity', 'gemini', 'google_aio', 'claude']);
export const METHODS = Object.freeze(['ui_capture', 'api_grounded', 'serp']);
export const MODES = Object.freeze(['standard', 'priority', 'live']);

/** One question to put to one engine. Built by the collection job from a snapshot and its prompt. */
export const collectTaskSchema = z.object({
  /** answer_snapshots.id: providers that accept a label carry it, so a charge can be traced back. */
  ref: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  engine: z.enum(ENGINES),
  /** The question as a person would ask it (chat engines). */
  text: z.string().min(1).max(2000),
  /** The keyword form, for engines whose `query_field` is `search_query` (AI Overviews). */
  searchQuery: z.string().min(1).max(255).nullish(),
  country: z.string().regex(/^[A-Z]{2}$/),
  language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
  city: z.string().max(128).default(''),
  mode: z.enum(MODES).default('standard'),
});

/** A normalized source (citation) as the engine showed it, before any domain classification. */
export const sourceSchema = z.object({
  url: z.string().min(1).max(2048),
  domain: z.string().max(255).nullable(),
  title: z.string().max(1000).nullable(),
  snippet: z.string().max(4000).nullable(),
  /** 1-based order the engine listed it in. */
  position: z.number().int().min(1),
});

/**
 * What every adapter's `normalize()` returns. `status: 'no_answer'` is a real outcome (Google showed no AI
 * Overview, the engine refused), never a failure; a failure is an error and never reaches here.
 */
export const normalizedAnswerSchema = z.object({
  status: z.enum(['ok', 'no_answer']),
  engine: z.enum(ENGINES),
  provider: z.string().min(1).max(32),
  method: z.enum(METHODS),
  /** The answer as the reader saw it, as Markdown where the provider gives Markdown. Empty for no_answer. */
  text: z.string(),
  sources: z.array(sourceSchema),
  /** The model the provider says answered (null when it doesn't say). */
  modelVersion: z.string().max(64).nullable(),
  locale: z.object({ country: z.string().length(2), language: z.string().min(2).max(16) }),
  /** When the provider says it produced the answer (ISO 8601), or null. */
  answeredAt: z.string().nullable(),
  /** The provider's task or response ID, for tracing a charge back. */
  providerRef: z.string().max(128).nullable(),
});

/**
 * Wrong at the provider. `retryable`: trying again later could work (a timeout, a 5xx, a rate limit).
 * `countsAgainstProvider`: false when the fault is ours (bad credentials, a malformed request), so the circuit
 * breaker doesn't trip a healthy provider because of our bug. `status` is a short code for logs and
 * `answer_snapshots.failure_reason`; it never contains the response body (which can echo secrets).
 */
export class ProviderError extends Error {
  constructor(message, { status = 'error', retryable = true, countsAgainstProvider = true } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.countsAgainstProvider = countsAgainstProvider;
  }
}

/** The answer is in, or still being worked on. */
export const PENDING = 'pending';

const REQUIRED = ['submit', 'poll', 'normalize', 'estimateCostUsd', 'estimateCostMicros'];

/** Throws unless `adapter` has everything the contract promises. Run on every adapter at start-up. */
export function assertAdapter(adapter) {
  if (!ENGINES.includes(adapter?.engine)) throw new TypeError(`Unknown engine: ${adapter?.engine}`);
  if (!METHODS.includes(adapter.method)) throw new TypeError(`Unknown method: ${adapter.method}`);
  if (typeof adapter.provider !== 'string' || !adapter.provider) {
    throw new TypeError('An adapter needs a provider code');
  }
  for (const name of REQUIRED) {
    if (typeof adapter[name] !== 'function') {
      throw new TypeError(`${adapter.provider}/${adapter.engine} has no ${name}()`);
    }
  }
  return adapter;
}

/** Validate a normalized answer on its way out of an adapter: a provider changing shape fails here, loudly. */
export function checkedAnswer(answer) {
  return normalizedAnswerSchema.parse(answer);
}
