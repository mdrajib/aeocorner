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
