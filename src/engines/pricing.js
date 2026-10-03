import { fromMicros, toMicros } from '../core/spend.js';

/**
 * What answers cost, from the providers' published price pages, in micro-dollars (whole numbers, src/core/spend.js).
 * Checked 2026-10-03. Re-check before signing anything, and whenever a provider's invoice disagrees with the ledger.
 *
 * Where a provider reports the real cost in its response (DataForSEO's `cost`, Perplexity's `usage.cost`), the
 * ledger records THAT; these tables are for estimates made before asking (spend checks, plan maths) and for
 * providers that report nothing (SerpApi bills by plan, per successful search).
 */
export const PRICES = Object.freeze({
  checked: '2026-10-03',

  // https://dataforseo.com/pricing/ai-optimization/llm-scraper: the same price for ChatGPT and Gemini, per
  // results page. Standard queue answers within 45 minutes, priority within 5, live within 90 seconds.
  dataforseo: {
    llmScraper: { standard: 1_200, priority: 2_400, live: 4_000 },
  },

  // https://docs.perplexity.ai/docs/getting-started/pricing: Agent API (Sonar Chat Completions ended on
  // 2026-09-27). The `perplexity/sonar` model is $1 per million tokens in and out; each web search the run makes
  // is $0.0025. The typical run (the docs' median for a quick lookup) is about 1,000 tokens in, 500 out and one
  // search.
  perplexity: {
    sonar: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 },
    webSearchPerCall: 2_500,
    typical: { inputTokens: 1_000, outputTokens: 500, searches: 1 },
  },

  // https://serpapi.com/pricing: a monthly plan with a number of searches. Only successful searches count;
  // cached, errored and failed ones are free. The per-search cost depends on the plan, so it is configuration
  // (SERPAPI_COST_PER_SEARCH_USD); the default is the Production plan ($150 for 15,000 = $0.010).
  serpapi: { defaultPerSearch: 10_000 },
});

/** Tokens at a price per million tokens, rounded up to the next micro-dollar (never under-count). */
export const tokenCostMicros = (tokens, perMTokMicros) =>
  Math.ceil((Math.max(0, tokens) * perMTokMicros) / 1_000_000);

export function llmScraperMicros(mode) {
  const price = PRICES.dataforseo.llmScraper[mode];
  if (price === undefined) throw new RangeError(`No DataForSEO price for mode ${mode}`);
  return price;
}

export function perplexityMicros({ inputTokens, outputTokens, searches }) {
  const { sonar, webSearchPerCall } = PRICES.perplexity;
  return (
    tokenCostMicros(inputTokens, sonar.inputPerMTok) +
    tokenCostMicros(outputTokens, sonar.outputPerMTok) +
    Math.max(0, searches) * webSearchPerCall
  );
}

/** A provider-reported dollar figure (a float in JSON) as micro-dollars, or null if it isn't a usable number. */
export function reportedMicros(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  // Floats like 0.0012000000000000001: round to the micro-dollar, which is what the ledger can hold.
  return toMicros(value.toFixed(6));
}

export const usd = (micros) => fromMicros(micros);
