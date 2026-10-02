// AI crawler user agents — MVP.md Appendix A. Kept as configuration, not logic: verify against each
// vendor's documentation quarterly (last checked 2026-09-28 when the appendix was written).
// Used by our own robots.txt now (Phase 1) and by the readiness checks later (Phase 4).
//
// `guidance`:
//   allow           - answer/search bots; blocking them removes you from AI answers
//   business_choice - training bots; a customer's call, never penalised heavily
//   case_by_case    - various
export const AI_CRAWLERS = [
  {
    vendor: 'OpenAI',
    agent: 'OAI-SearchBot',
    purpose: 'Indexing for ChatGPT search',
    guidance: 'allow',
  },
  { vendor: 'OpenAI', agent: 'ChatGPT-User', purpose: 'User-initiated fetches', guidance: 'allow' },
  { vendor: 'OpenAI', agent: 'GPTBot', purpose: 'Model training', guidance: 'business_choice' },
  { vendor: 'Anthropic', agent: 'Claude-SearchBot', purpose: 'Search indexing', guidance: 'allow' },
  {
    vendor: 'Anthropic',
    agent: 'Claude-User',
    purpose: 'User-initiated fetches',
    guidance: 'allow',
  },
  {
    vendor: 'Anthropic',
    agent: 'ClaudeBot',
    purpose: 'Model training',
    guidance: 'business_choice',
  },
  { vendor: 'Perplexity', agent: 'PerplexityBot', purpose: 'Indexing', guidance: 'allow' },
  {
    vendor: 'Perplexity',
    agent: 'Perplexity-User',
    purpose: 'User-initiated fetches',
    guidance: 'allow',
  },
  {
    vendor: 'Google',
    agent: 'Googlebot',
    purpose: 'Search, including AI Overviews / AI Mode',
    guidance: 'allow',
  },
  {
    vendor: 'Google',
    agent: 'Google-Extended',
    purpose: 'robots token for Gemini training/grounding (does not affect Search)',
    guidance: 'business_choice',
  },
  { vendor: 'Microsoft', agent: 'Bingbot', purpose: 'Bing + Copilot', guidance: 'allow' },
  { vendor: 'Apple', agent: 'Applebot', purpose: 'Siri / Spotlight', guidance: 'allow' },
  {
    vendor: 'Apple',
    agent: 'Applebot-Extended',
    purpose: 'Training opt-out token',
    guidance: 'business_choice',
  },
  { vendor: 'Meta', agent: 'Meta-ExternalAgent', purpose: 'Training', guidance: 'business_choice' },
  {
    vendor: 'Meta',
    agent: 'Meta-ExternalFetcher',
    purpose: 'User fetches',
    guidance: 'business_choice',
  },
  {
    vendor: 'Common Crawl',
    agent: 'CCBot',
    purpose: 'Open crawl used by many models',
    guidance: 'business_choice',
  },
  { vendor: 'Amazon', agent: 'Amazonbot', purpose: 'Various', guidance: 'case_by_case' },
  { vendor: 'DuckDuckGo', agent: 'DuckAssistBot', purpose: 'Various', guidance: 'case_by_case' },
  { vendor: 'Mistral', agent: 'MistralAI-User', purpose: 'Various', guidance: 'case_by_case' },
  { vendor: 'ByteDance', agent: 'Bytespider', purpose: 'Various', guidance: 'case_by_case' },
];

/**
 * The user-agent strings the readiness check "A3" sends to see whether a firewall or CDN turns AI crawlers away
 * (MVP §6.6). Sites block by these strings, so they must look like the real thing.
 *
 * Checked against each vendor's documentation on 2026-10-02:
 *   OpenAI      https://developers.openai.com/api/docs/bots   (published in full)
 *   Perplexity  https://docs.perplexity.ai/guides/bots        (published in full)
 *   Anthropic   https://support.claude.com/en/articles/8896518 publishes the names but not the full string, so
 *               the string below is built in the same shape as the others and carries the documented token.
 * Re-check them with the rest of this file every quarter.
 *
 * What this cannot tell: many firewalls verify a bot by its network address as well as its name, so they would
 * turn away our look-alike while admitting the real crawler. A3 words its findings accordingly.
 */
export const PROBE_USER_AGENTS = [
  {
    agent: 'OAI-SearchBot',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot',
  },
  {
    agent: 'ChatGPT-User',
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  },
  {
    agent: 'PerplexityBot',
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  },
  {
    agent: 'Claude-SearchBot',
    userAgent:
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)',
  },
];

/**
 * The crawlers the readiness rubric names (MVP §6.6). A1 checks that the first group may read the site;
 * A2 looks for a stated policy on the second. Both are subsets of the list above.
 */
export const ANSWER_BOTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'PerplexityBot',
  'Perplexity-User',
  'Claude-SearchBot',
  'Claude-User',
  'Bingbot',
  'Googlebot',
];
export const TRAINING_BOTS = [
  'GPTBot',
  'ClaudeBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
];
