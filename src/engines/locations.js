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
  // Every country below is listed by both the ChatGPT and the Gemini LLM Scraper locations endpoints (checked 2026-10-06).
  BD: 2050,
  // Middle East and North Africa
  SA: 2682,
  QA: 2634,
  KW: 2414,
  BH: 2048,
  OM: 2512,
  JO: 2400,
  LB: 2422,
  IQ: 2368,
  IL: 2376,
  EG: 2818,
  MA: 2504,
  DZ: 2012,
  TN: 2788,
  TR: 2792,
  // South and South-East Asia, Korea
  PK: 2586,
  LK: 2144,
  NP: 2524,
  ID: 2360,
  MY: 2458,
  TH: 2764,
  VN: 2704,
  KR: 2410,
  // Sub-Saharan Africa
  NG: 2566,
  KE: 2404,
  GH: 2288,
  // Europe
  PL: 2616,
  PT: 2620,
  CH: 2756,
  AT: 2040,
  BE: 2056,
  DK: 2208,
  NO: 2578,
  FI: 2246,
  CZ: 2203,
  GR: 2300,
  UA: 2804,
  // Latin America
  AR: 2032,
  CL: 2152,
  CO: 2170,
  PE: 2604,
});

/** "en-US" -> "en". Providers take the bare language. */
export const baseLanguage = (language) => String(language).split('-')[0].toLowerCase();
