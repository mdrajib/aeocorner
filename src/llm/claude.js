import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from '../engines/contract.js';

/**
 * The Claude API, as the rest of the app sees it: send one extraction, or submit, check and read a batch.
 * Calls go through `callProvider` in the worker (provider code `anthropic`), so they are rate-limited, counted for
 * the circuit breaker and written to the ledger like every other paid call.
 *
 * Errors come out as `ProviderError`s, classified the way the engine adapters' are (src/engines/http.js):
 *   401, 403                our key is wrong: not retryable, not Anthropic's fault (the breaker stays shut)
 *   400, 404, 413, 422      we sent something wrong: not retryable, not Anthropic's fault
 *   408, 429, 5xx, 529      try again later (529 is "overloaded")
 *   no connection, timeout  try again later
 * The message never includes the response body.
 *
 * The SDK's own retries are kept low: the job system retries with backoff, and a retry there is visible.
 */
export function createClaude({
  apiKey,
  baseURL,
  timeoutMs = 120_000,
  maxRetries = 1,
  client,
} = {}) {
  const anthropic = client ?? new Anthropic({ apiKey, baseURL, timeout: timeoutMs, maxRetries });

  const call = async (what, fn) => {
    try {
      return await fn();
    } catch (err) {
      throw toProviderError(what, err);
    }
  };

  return {
    provider: 'anthropic',

    /** One request, answered now (the free audit, a batch item that has to be redone, the eval). */
    extract: (params) => call('messages.create', () => anthropic.messages.create(params)),

    /**
     * One request whose text arrives in pieces: `onText(piece, soFar)` is called as it comes, and the whole message is
     * returned at the end (the Content Studio's draft appears on the customer's screen while it is written).
     */
    stream: (params, { onText } = {}) =>
      call('messages.stream', async () => {
        const stream = anthropic.messages.stream(params);
        if (onText) stream.on('text', (piece, soFar) => onText(piece, soFar));
        return stream.finalMessage();
      }),

    batches: {
      /** `requests` are `{ custom_id, params }`; returns the batch (its `id` is what to poll). */
      create: (requests) =>
        call('batches.create', () => anthropic.messages.batches.create({ requests })),
      retrieve: (batchId) =>
        call('batches.retrieve', () => anthropic.messages.batches.retrieve(batchId)),
      /** Every result of an ended batch, in whatever order the API returns them (key them by custom_id). */
      results: (batchId) =>
        call('batches.results', async () => {
          const out = [];
          for await (const result of await anthropic.messages.batches.results(batchId)) {
            out.push(result);
          }
          return out;
        }),
    },

    /** How many input tokens a request would use (to check the cached prefix is long enough to be cached). */
    countTokens: ({ model, system, messages, output_config }) =>
      call('messages.countTokens', () =>
        anthropic.messages.countTokens({ model, system, messages, output_config }),
      ),
  };
}

export function toProviderError(what, err) {
  if (err instanceof ProviderError) return err;
  const label = `anthropic ${what}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    const e = new ProviderError(`${label}: timed out`, { status: 'timeout' });
    e.name = 'TimeoutError';
    return e;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`${label}: could not connect`, { status: 'network' });
  }
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    const status = err.status;
    const type = err.error?.error?.type ?? err.error?.type ?? null;
    const detail = type ? ` (${String(type).slice(0, 40)})` : '';
    if (status === 401 || status === 403) {
      return new ProviderError(`${label}: HTTP ${status}, the API key was refused`, {
        status: 'auth',
        retryable: false,
        countsAgainstProvider: false,
      });
    }
    if (status === 408 || status === 429 || status >= 500) {
      return new ProviderError(`${label}: HTTP ${status}${detail}`, {
        status: status === 429 ? 'rate_limited' : status === 529 ? 'overloaded' : `http_${status}`,
      });
    }
    return new ProviderError(`${label}: HTTP ${status}${detail}, the request was refused`, {
      status: `http_${status}`,
      retryable: false,
      countsAgainstProvider: false,
    });
  }
  return new ProviderError(`${label}: ${String(err?.message ?? err).slice(0, 200)}`, {
    status: 'error',
  });
}
