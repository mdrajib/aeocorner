import { assertAdapter } from './contract.js';
import { createDataForSeoAdapter } from './dataforseo.js';
import { createPerplexityAdapter } from './perplexity.js';
import { createSerpApiAdapter } from './serpapi.js';

export { PENDING, ProviderError } from './contract.js';

/**
 * The adapters this process can use, keyed `provider/engine` (MVP §7.5). Which one answers for an engine is
 * decided by the `engines` table (primary, fallback) and the circuit breakers, not here: this only says which
 * pairs exist. A provider without credentials has no adapters, and routing treats it as unavailable.
 *
 * Built today: the MVP primaries. The fallbacks in the `engines` table (OpenAI and Gemini APIs, DataForSEO for
 * Perplexity and AI Overviews) arrive when they are needed; until then a tripped primary means "couldn't check".
 *
 * @param {object} providers  config.providers: { dataforseo, perplexity, serpapi }, each null when not set
 * @param {object} [overrides] { baseUrls: { dataforseo, perplexity, serpapi }, fetchImpl } for the contract tests
 */
export function createAdapters(providers, { baseUrls = {}, fetchImpl } = {}) {
  const list = [];
  if (providers?.dataforseo) {
    for (const engine of ['chatgpt', 'gemini']) {
      list.push(
        createDataForSeoAdapter({
          engine,
          ...providers.dataforseo,
          baseUrl: baseUrls.dataforseo,
          fetchImpl,
        }),
      );
    }
  }
  if (providers?.perplexity) {
    list.push(
      createPerplexityAdapter({ ...providers.perplexity, baseUrl: baseUrls.perplexity, fetchImpl }),
    );
  }
  if (providers?.serpapi) {
    list.push(createSerpApiAdapter({ ...providers.serpapi, baseUrl: baseUrls.serpapi, fetchImpl }));
  }
  return adapterRegistry(list);
}

/** A lookup over a list of adapters, each checked against the contract. */
export function adapterRegistry(list) {
  const byKey = new Map();
  for (const adapter of list) {
    assertAdapter(adapter);
    byKey.set(`${adapter.provider}/${adapter.engine}`, adapter);
  }
  return {
    get: (provider, engine) => byKey.get(`${provider}/${engine}`) ?? null,
    has: (provider, engine) => byKey.has(`${provider}/${engine}`),
    list: () => [...byKey.values()],
  };
}
