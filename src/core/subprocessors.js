/**
 * The public subprocessor list (Milestone 10, tasks 10.10 and 10.11): every company that handles customer or visitor
 * data for us. This is the one place it is written; the privacy page, the subprocessor page and the DPA read it, and
 * `tests/routes/subprocessors.test.js` checks it against the vendors the code is actually wired to, so a vendor can't be
 * added to the code (or the list) without the other.
 *
 * `status`:
 *   in_use      the code calls this company today
 *   if_enabled  wired as a switched-off fallback in the reference data; it becomes a subprocessor the day it is
 *               switched on, and customers are told 30 days before that
 *
 * `evidence` is how the test finds the vendor in the code: environment variables the config reads, host names in the
 * source, and provider codes in the reference data. A vendor with none of them is not in the code and must not be here.
 */

export const SUBPROCESSORS = Object.freeze([
  {
    key: 'anthropic',
    name: 'Anthropic',
    status: 'in_use',
    purpose:
      'Language model that reads AI answers, reads your site, drafts content and researches facts, and, where Claude is tracked as an engine, answers your tracked questions with web search',
    data: 'Answer text, brand details, page excerpts, content briefs, the tracked questions (when Claude is tracked)',
    location: 'United States',
    evidence: {
      env: ['ANTHROPIC_API_KEY'],
      deps: ['@anthropic-ai/sdk'],
      providerCodes: ['anthropic'],
    },
  },
  {
    key: 'dataforseo',
    name: 'DataForSEO',
    status: 'in_use',
    purpose: 'Collects ChatGPT and Gemini answers',
    data: 'The questions we ask on your behalf',
    location: 'European Union / United States',
    evidence: {
      env: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
      hosts: ['api.dataforseo.com'],
      providerCodes: ['dataforseo'],
    },
  },
  {
    key: 'perplexity',
    name: 'Perplexity',
    status: 'in_use',
    purpose: 'Collects Perplexity answers',
    data: 'The questions we ask on your behalf',
    location: 'United States',
    evidence: {
      env: ['PERPLEXITY_API_KEY'],
      hosts: ['api.perplexity.ai'],
      providerCodes: ['perplexity_api'],
    },
  },
  {
    key: 'serpapi',
    name: 'SerpApi',
    status: 'in_use',
    purpose: 'Collects Google AI Overviews',
    data: 'The search queries we run on your behalf',
    location: 'United States',
    evidence: { env: ['SERPAPI_API_KEY'], hosts: ['serpapi.com'], providerCodes: ['serpapi'] },
  },
  {
    key: 'google',
    name: 'Google',
    status: 'in_use',
    purpose: 'Google Analytics and Search Console, only if you connect them (read-only)',
    data: 'The traffic and search figures you authorise us to read',
    location: 'United States',
    evidence: {
      env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      hosts: ['oauth2.googleapis.com'],
    },
  },
  {
    key: 'wikidata',
    name: 'Wikimedia Foundation (Wikidata)',
    status: 'in_use',
    purpose:
      'Looks up whether a public Wikidata item exists for your business (read-only, no account)',
    data: 'Your brand name and aliases, and the item number if you give one: public information only',
    location: 'United States',
    evidence: { hosts: ['www.wikidata.org'] },
  },
  {
    key: 'digitalocean',
    name: 'DigitalOcean',
    status: 'in_use',
    purpose: 'Hosting, managed database, queue store and file storage',
    data: 'All service data',
    location: 'United States',
    evidence: { env: ['DO_SPACES_KEY', 'DO_SPACES_SECRET'], deps: ['@aws-sdk/client-s3'] },
  },
  {
    key: 'cloudflare',
    name: 'Cloudflare',
    status: 'in_use',
    purpose:
      'DNS, network protection, staff sign-in protection and the bot check on the audit form',
    data: 'IP address, request metadata',
    location: 'United States / global network',
    evidence: {
      env: ['TURNSTILE_SECRET_KEY', 'CLOUDFLARE_ACCESS_TEAM_DOMAIN'],
      hosts: ['challenges.cloudflare.com'],
    },
  },
  {
    key: 'clerk',
    name: 'Clerk',
    status: 'in_use',
    purpose: 'Sign-in and sessions',
    data: 'Name, email, sign-in details',
    location: 'United States',
    evidence: {
      env: ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_WEBHOOK_SECRET'],
      deps: ['@clerk/express'],
    },
  },
  {
    key: 'stripe',
    name: 'Stripe',
    status: 'in_use',
    purpose: 'Payments and billing',
    data: 'Payment and billing details (we never see card numbers)',
    location: 'United States / European Union',
    evidence: { env: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], hosts: ['api.stripe.com'] },
  },
  {
    key: 'bkash',
    name: 'bKash',
    status: 'in_use',
    purpose: 'Payments in Bangladeshi taka',
    data: 'Payment amount and our invoice number (the customer signs in to bKash on bKash’s own page; we never see their number or PIN)',
    location: 'Bangladesh',
    evidence: {
      env: ['BKASH_APP_KEY', 'BKASH_APP_SECRET', 'BKASH_USERNAME', 'BKASH_PASSWORD'],
      hosts: ['tokenized.pay.bka.sh', 'tokenized.sandbox.bka.sh'],
    },
  },
  {
    key: 'resend',
    name: 'Resend',
    status: 'in_use',
    purpose: 'Sending email',
    data: 'Email address, message content',
    location: 'United States',
    evidence: { env: ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET'], hosts: ['api.resend.com'] },
  },
  {
    key: 'posthog',
    name: 'PostHog',
    status: 'in_use',
    purpose: 'Cookieless site analytics',
    data: 'Page views and referrer; no cookies or stored identifiers',
    location: 'United States',
    evidence: { env: ['POSTHOG_API_KEY'], hosts: ['us.i.posthog.com'] },
  },
  {
    key: 'slack',
    name: 'Slack',
    status: 'in_use',
    purpose: 'Internal alerts to our team (provider outages, spend caps), if configured',
    data: 'Organization names and technical details; no answers, no personal data beyond a name',
    location: 'United States',
    evidence: { env: ['ALERT_WEBHOOK_URL'] },
  },
  {
    key: 'openai',
    name: 'OpenAI',
    status: 'if_enabled',
    purpose: 'Fallback collection of ChatGPT answers; switched off',
    data: 'The questions we ask on your behalf',
    location: 'United States',
    evidence: { providerCodes: ['openai_api'] },
  },
]);

/** Vendors we are NOT wired to, so the public list must not claim them (kept so nobody adds one back from the spec). */
export const NOT_WIRED = Object.freeze({
  sentry: 'error monitoring is not built into the app',
  langfuse: 'model monitoring is not built into the app',
  gemini_api:
    'the Gemini API fallback adapter is not built; Gemini answers come through DataForSEO',
});

export const subprocessorsInUse = () => SUBPROCESSORS.filter((s) => s.status === 'in_use');
