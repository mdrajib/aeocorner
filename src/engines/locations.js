/**
 * Where a question is asked from. Prompts carry an ISO country code and a language; DataForSEO wants Google's
 * numeric location codes (https://docs.dataforseo.com/v3/appendix/locations/), SerpApi and Perplexity take the
 * country code itself.
 *
 * Only countries listed here can be tracked through DataForSEO; adding one is a line here and a check that the
 * LLM Scraper accepts it (its locations endpoint lists what each engine supports).
 */
export const DATAFORSEO_LOCATION_CODES = Object.freeze({
  US: 2840,
  GB: 2826,
  CA: 2124,
  AU: 2036,
  NZ: 2554,
  IE: 2372,
  IN: 2356,
  SG: 2702,
  ZA: 2710,
  AE: 2784,
  DE: 2276,
  FR: 2250,
  ES: 2724,
  IT: 2380,
  NL: 2528,
  SE: 2752,
  BR: 2076,
  MX: 2484,
  JP: 2392,
  PH: 2608,
});

/** "en-US" -> "en". Providers take the bare language. */
export const baseLanguage = (language) => String(language).split('-')[0].toLowerCase();
