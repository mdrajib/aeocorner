import 'dotenv/config';
import { z } from 'zod';
import { DEFAULT_AUDIT_DAILY_BUDGET_USD, toMicros } from '../core/spend.js';
import { parseMasterKey } from './secrets.js';

// Empty strings in .env mean "not set" — treat them as undefined so optional keys stay optional.
const optional = (schema) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // NODE_ENV is production on both staging and prod; APP_ENV tells them apart (indexing, banners).
  APP_ENV: optional(z.enum(['development', 'staging', 'production'])),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  TRUST_PROXY: optional(z.coerce.number().int().min(0)),
  MAINTENANCE_MODE: z.stringbool().default(false),
  TURNSTILE_SITE_KEY: optional(z.string().min(1)),
  TURNSTILE_SECRET_KEY: optional(z.string().min(1)),
  AUDIT_DAILY_BUDGET_USD: optional(z.coerce.number().positive().max(10_000)),
  POSTHOG_API_KEY: optional(z.string().min(1)),
  POSTHOG_HOST: optional(z.url()),
  POSTHOG_ASSETS_HOST: optional(z.url()),

  // Signs CSRF tokens. Required in production; development and tests fall back to a fixed value.
  APP_SECRET: optional(z.string().min(32)),
  DATABASE_URL: optional(z.string().min(1)),

  // Queues, rate limits and circuit breakers (MVP §7.8). BullMQ needs Redis with eviction off.
  REDIS_URL: optional(z.string().regex(/^rediss?:\/\//, 'must start redis:// or rediss://')),
  QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/, 'letters, digits, - and _ only')
    .default('aeo'),
  ALERT_WEBHOOK_URL: optional(z.url()),

  // Object storage for raw crawled pages (MVP §7.1): a DigitalOcean Spaces bucket, or any S3-compatible service.
  // Set all of endpoint, bucket, key and secret, or none (development then writes to local disk).
  DO_SPACES_ENDPOINT: optional(z.url()),
  DO_SPACES_REGION: optional(z.string().min(1)),
  DO_SPACES_BUCKET: optional(
    z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*$/, 'lower-case letters, digits, . and -'),
  ),
  DO_SPACES_KEY: optional(z.string().min(1)),
  DO_SPACES_SECRET: optional(z.string().min(1)),
  // A directory inside the bucket, ending in "/". Defaults to aeo-corner/dev/, aeo-corner/staging/ or aeo-corner/prod/.
  DO_SPACES_PREFIX: optional(z.string().regex(/^([A-Za-z0-9_-]+\/)*$/, 'folder names ending in /')),

  // Clerk, customer app: identity only (DATABASE_SCHEMA §10.1). Both keys or neither.
  CLERK_PUBLISHABLE_KEY: optional(
    z.string().regex(/^pk_(test|live)_/, 'must start pk_test_ or pk_live_'),
  ),
  CLERK_SECRET_KEY: optional(
    z.string().regex(/^sk_(test|live)_/, 'must start sk_test_ or sk_live_'),
  ),
  CLERK_WEBHOOK_SECRET: optional(z.string().min(1)),
  // Default: Clerk's hosted Account Portal, derived from the publishable key (ADR-0004).
  CLERK_SIGN_IN_URL: optional(z.url()),
  CLERK_SIGN_UP_URL: optional(z.url()),

  // Staff app: a separate Clerk application, served on its own host behind Cloudflare Access.
  CLERK_STAFF_PUBLISHABLE_KEY: optional(z.string().regex(/^pk_(test|live)_/)),
  CLERK_STAFF_SECRET_KEY: optional(z.string().regex(/^sk_(test|live)_/)),
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: optional(z.string().min(1)),
  CLOUDFLARE_ACCESS_AUD: optional(z.string().min(1)),
  STAFF_HOST: optional(z.string().min(1)),

  // Answer-engine data providers (MVP §6.2, src/engines). A provider without credentials is simply unavailable:
  // its engines fall back or say "couldn't check". DataForSEO needs both login and password, or neither.
  DATAFORSEO_LOGIN: optional(z.string().min(1)),
  DATAFORSEO_PASSWORD: optional(z.string().min(1)),
  PERPLEXITY_API_KEY: optional(z.string().min(1)),
  // The Agent API model asked for Perplexity answers. perplexity/sonar is the old Sonar answer (ADR-0006).
  PERPLEXITY_MODEL: optional(z.string().regex(/^[a-z0-9-]+\/[a-z0-9.-]+$/, 'provider/model')),
  SERPAPI_API_KEY: optional(z.string().min(1)),
  // What one SerpApi search costs on the plan we pay for (the plan's price / its searches). Default: Production.
  SERPAPI_COST_PER_SEARCH_USD: optional(
    z.string().regex(/^0\.\d{1,6}$/, 'a dollar amount under $1, such as 0.010'),
  ),

  // Claude (src/llm): answer extraction now, the rest of MVP §7.7 later. Without a key, extraction jobs fail at once.
  ANTHROPIC_API_KEY: optional(z.string().min(1)),
  // The model that answers when Claude is tracked as an engine (Milestone 16, decision F2), with web search on.
  CLAUDE_ENGINE_MODEL: z
    .enum(['claude-sonnet-5-5', 'claude-opus-5-5'])
    .default('claude-sonnet-5-5'),
  // The model that reads answers (decision D4, ADR-0007): opus55 or haiku45.
  EXTRACTION_MODEL: z.enum(['opus55', 'haiku45']).default('opus55'),
  // The model that researches, plans and writes Content Studio drafts. The checked facts come from code, not the model.
  CONTENT_MODEL: z.enum(['opus55', 'haiku45']).default('opus55'),

  // Envelope-encryption master key for customers' integration credentials (WordPress, later Google): 32 random
  // bytes, base64. The previous key stays set while old secrets are re-wrapped after a rotation. Without a key the
  // integrations screens say they are not set up; development falls back to a fixed key.
  SECRETS_MASTER_KEY: optional(z.string().min(40)),
  SECRETS_MASTER_KEY_VERSION: z.coerce.number().int().min(1).max(32000).default(1),
  SECRETS_MASTER_KEY_PREVIOUS: optional(z.string().min(40)),

  // Billing (Milestone 8). With a secret key set, billing is ENFORCED: an organization with no subscription can set a
  // project up but nothing is tracked until it has started a trial. Without one (a laptop, the tests) nothing is locked.
  STRIPE_SECRET_KEY: optional(
    z.string().regex(/^(sk|rk)_(test|live)_/, 'must be a Stripe secret or restricted key'),
  ),
  STRIPE_PUBLISHABLE_KEY: optional(z.string().min(1)),
  STRIPE_WEBHOOK_SECRET: optional(z.string().regex(/^whsec_/, 'must start with whsec_')),
  STRIPE_API_VERSION: optional(z.string().regex(/^d{4}-d{2}-d{2}(.[a-z]+)?$/)),

  // Google OAuth for GA4 and Search Console (Milestone 8). Both or neither.
  GOOGLE_OAUTH_CLIENT_ID: optional(z.string().min(1)),
  GOOGLE_OAUTH_CLIENT_SECRET: optional(z.string().min(1)),

  RESEND_API_KEY: optional(z.string().min(1)),
  // Signs Resend's delivery, bounce and complaint webhooks (Svix). Without it those webhooks are refused.
  RESEND_WEBHOOK_SECRET: optional(z.string().regex(/^whsec_/, 'must start with whsec_')),
  EMAIL_FROM_ADDRESS: optional(z.string().min(3)),
  // Billing notices (trial ending, account closing, plan changes) and support notices send from these.
  // Each must be on a domain verified in Resend. Unset: the message goes from EMAIL_FROM_ADDRESS.
  EMAIL_BILL_ADDRESS: optional(z.string().min(3)),
  EMAIL_SUPPORT_ADDRESS: optional(z.string().min(3)),
  // Where a customer's reply goes, on every email: a mailbox that exists (the From address on a sending subdomain may not).
  EMAIL_REPLY_TO: optional(z.string().min(3)),
});

const DEV_SECRETS_KEY = Buffer.alloc(32, 'aeo-corner-development-only-key').toString('base64');

const DEV_APP_SECRET = 'development-only-secret-do-not-use-in-production';

// PostHog serves its JS from a sibling "-assets" host of the ingestion host
// (us.i.posthog.com -> us-assets.i.posthog.com). Self-hosted or proxied setups set POSTHOG_ASSETS_HOST.
function posthogAssetsHost(host) {
  const url = new URL(host);
  if (url.hostname.endsWith('.i.posthog.com')) {
    return `${url.protocol}//${url.hostname.replace('.i.posthog.com', '-assets.i.posthog.com')}`;
  }
  return url.origin;
}

/** A Clerk publishable key is "pk_<test|live>_" + base64("<frontend API host>$"). */
export function frontendApiOf(publishableKey) {
  const decoded = Buffer.from(String(publishableKey).split('_')[2] ?? '', 'base64').toString(
    'utf8',
  );
  return decoded.endsWith('$') && decoded.length > 1 ? decoded.slice(0, -1) : null;
}

/**
 * Clerk's hosted Account Portal lives on the "accounts" sibling of the frontend API host
 * (clerk.aeocorner.com -> accounts.aeocorner.com; x.clerk.accounts.dev -> x.accounts.dev).
 */
export function accountsOrigin(frontendApi) {
  const host = frontendApi
    .replace(/clerk\.accountsstage\./, 'accountsstage.')
    .replace(/clerk\.accounts\.|clerk\./, 'accounts.');
  return `https://${host}`;
}

/** "acme", "acme.cloudflareaccess.com" and "https://acme.cloudflareaccess.com/" all name the same team. */
export function cloudflareTeamDomain(value) {
  const host = String(value)
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return host.includes('.') ? host : `${host}.cloudflareaccess.com`;
}

/** Stripe: a secret key turns billing on. A live key outside production is refused, as is a key without its webhook secret. */
function stripeConfig(e, appEnv) {
  if (!e.STRIPE_SECRET_KEY) return null;
  const isLive = /^(sk|rk)_live_/.test(e.STRIPE_SECRET_KEY);
  if (isLive && appEnv !== 'production') {
    throw new Error(
      'A live Stripe key is only allowed in the production environment: use a test key here.',
    );
  }
  if (!isLive && appEnv === 'production') {
    throw new Error('The live site needs a live Stripe key (this one is a test key).');
  }
  return {
    secretKey: e.STRIPE_SECRET_KEY,
    publishableKey: e.STRIPE_PUBLISHABLE_KEY ?? null,
    webhookSecret: e.STRIPE_WEBHOOK_SECRET ?? null,
    apiVersion: e.STRIPE_API_VERSION ?? null,
    isLive,
  };
}

/** Google OAuth needs the client ID and secret together. */
function googleConfig(e) {
  const id = e.GOOGLE_OAUTH_CLIENT_ID;
  const secret = e.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id && !secret) return null;
  if (!id || !secret) {
    throw new Error(
      'Google OAuth: set both GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or neither.',
    );
  }
  return { clientId: id, clientSecret: secret };
}

/**
 * Spaces needs all four of endpoint, bucket, key and secret, or none. The region is the first part of a
 * DigitalOcean address (sgp1.digitaloceanspaces.com) unless it is set. Everything this app stores goes inside its
 * own directory, aeo-corner/<environment>/, so the bucket can be shared with other apps and staging and
 * production never touch each other's files.
 */
function spacesConfig(e, appEnv) {
  const given = {
    DO_SPACES_ENDPOINT: e.DO_SPACES_ENDPOINT,
    DO_SPACES_BUCKET: e.DO_SPACES_BUCKET,
    DO_SPACES_KEY: e.DO_SPACES_KEY,
    DO_SPACES_SECRET: e.DO_SPACES_SECRET,
  };
  const missing = Object.entries(given)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length === Object.keys(given).length) return null;
  if (missing.length) {
    throw new Error(
      `Spaces: set ${missing.join(', ')} too, or remove the other DO_SPACES_* values.`,
    );
  }
  const endpoint = new URL(e.DO_SPACES_ENDPOINT);
  // DigitalOcean's dashboard shows a bucket's address as "<bucket>.<region>.digitaloceanspaces.com". The client
  // adds the bucket name itself, so that form would end up as "<bucket>.<bucket>.<region>...". Accept it anyway.
  if (endpoint.hostname.startsWith(`${e.DO_SPACES_BUCKET}.`)) {
    endpoint.hostname = endpoint.hostname.slice(e.DO_SPACES_BUCKET.length + 1);
  }
  const folder = { production: 'prod', staging: 'staging', development: 'dev' }[appEnv];
  return {
    endpoint: endpoint.origin,
    region: e.DO_SPACES_REGION ?? endpoint.hostname.split('.')[0],
    bucket: e.DO_SPACES_BUCKET,
    accessKeyId: e.DO_SPACES_KEY,
    secretAccessKey: e.DO_SPACES_SECRET,
    prefix: e.DO_SPACES_PREFIX ?? `aeo-corner/${folder}/`,
  };
}

function clerkApp({ publishableKey, secretKey, label }) {
  if (!publishableKey && !secretKey) return null;
  if (!publishableKey || !secretKey) {
    throw new Error(`${label}: set both the publishable key and the secret key, or neither.`);
  }
  const frontendApi = frontendApiOf(publishableKey);
  if (!frontendApi) throw new Error(`${label}: the publishable key is not a valid Clerk key.`);
  return { publishableKey, secretKey, frontendApi, isLive: publishableKey.startsWith('pk_live_') };
}

/** The master keys for encrypting integration credentials; null when none is set in production. */
function secretsConfig(e, isProduction) {
  const given = e.SECRETS_MASTER_KEY ?? (isProduction ? null : DEV_SECRETS_KEY);
  if (!given) return null;
  const current = { version: e.SECRETS_MASTER_KEY_VERSION, key: parseMasterKey(given) };
  const previous = e.SECRETS_MASTER_KEY_PREVIOUS
    ? [
        {
          version: e.SECRETS_MASTER_KEY_VERSION - 1,
          key: parseMasterKey(e.SECRETS_MASTER_KEY_PREVIOUS),
        },
      ]
    : [];
  if (previous.length && previous[0].version < 1) {
    throw new Error('SECRETS_MASTER_KEY_PREVIOUS needs SECRETS_MASTER_KEY_VERSION of 2 or more.');
  }
  return { current, previous };
}

/** Credentials for the answer-engine providers; each is null when it is not set. */
function providersConfig(e) {
  if (Boolean(e.DATAFORSEO_LOGIN) !== Boolean(e.DATAFORSEO_PASSWORD)) {
    throw new Error('Set both DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD, or neither.');
  }
  return {
    dataforseo: e.DATAFORSEO_LOGIN
      ? { login: e.DATAFORSEO_LOGIN, password: e.DATAFORSEO_PASSWORD }
      : null,
    perplexity: e.PERPLEXITY_API_KEY
      ? { apiKey: e.PERPLEXITY_API_KEY, model: e.PERPLEXITY_MODEL ?? 'perplexity/sonar' }
      : null,
    serpapi: e.SERPAPI_API_KEY
      ? {
          apiKey: e.SERPAPI_API_KEY,
          costPerSearchMicros: toMicros(e.SERPAPI_COST_PER_SEARCH_USD ?? '0.010'),
        }
      : null,
    // Claude as an answer engine (Milestone 16) uses the same key as extraction; the model is its own choice.
    claude: e.ANTHROPIC_API_KEY
      ? { apiKey: e.ANTHROPIC_API_KEY, model: e.CLAUDE_ENGINE_MODEL }
      : null,
  };
}

/**
 * Parse and validate environment variables into the app's config object.
 * Pure function of `env` so tests can pass their own values.
 */
export function loadConfig(env = process.env) {
  const e = envSchema.parse(env);
  const isProduction = e.NODE_ENV === 'production';
  const appEnv = e.APP_ENV ?? (isProduction ? 'production' : 'development');
  const baseUrl = e.APP_BASE_URL.replace(/\/+$/, '');

  let posthog = null;
  if (e.POSTHOG_API_KEY) {
    const host = e.POSTHOG_HOST ?? 'https://us.i.posthog.com';
    posthog = {
      apiKey: e.POSTHOG_API_KEY,
      host: new URL(host).origin,
      assetsHost: e.POSTHOG_ASSETS_HOST
        ? new URL(e.POSTHOG_ASSETS_HOST).origin
        : posthogAssetsHost(host),
    };
  }

  const customer = clerkApp({
    publishableKey: e.CLERK_PUBLISHABLE_KEY,
    secretKey: e.CLERK_SECRET_KEY,
    label: 'Clerk (customer app)',
  });
  const staffClerk = clerkApp({
    publishableKey: e.CLERK_STAFF_PUBLISHABLE_KEY,
    secretKey: e.CLERK_STAFF_SECRET_KEY,
    label: 'Clerk (staff app)',
  });

  if (isProduction && !e.APP_SECRET) {
    throw new Error('APP_SECRET is required when NODE_ENV=production (staging and live).');
  }

  if (appEnv === 'production') {
    // A development Clerk instance has weaker rules (no MFA enforcement, shared dev domains).
    for (const [label, app] of [
      ['customer', customer],
      ['staff', staffClerk],
    ]) {
      if (app && !app.isLive) {
        throw new Error(
          `The live site needs a production Clerk instance (the ${label} app uses a test key).`,
        );
      }
    }
  }

  const stripe = stripeConfig(e, appEnv);
  const google = googleConfig(e);

  const cloudflareAccess =
    e.CLOUDFLARE_ACCESS_TEAM_DOMAIN && e.CLOUDFLARE_ACCESS_AUD
      ? {
          teamDomain: cloudflareTeamDomain(e.CLOUDFLARE_ACCESS_TEAM_DOMAIN),
          aud: e.CLOUDFLARE_ACCESS_AUD,
        }
      : null;
  if (staffClerk && !cloudflareAccess && appEnv !== 'development') {
    // Cloudflare Access is the outer wall in front of staff pages. It can only be skipped on a laptop.
    throw new Error(
      'The staff app needs Cloudflare Access (team domain and AUD) outside development.',
    );
  }

  const staffHost = e.STAFF_HOST ?? `admin.${new URL(baseUrl).host}`;
  const staff = staffClerk
    ? {
        ...staffClerk,
        host: staffHost,
        baseUrl: `${new URL(baseUrl).protocol}//${staffHost}`,
        signInUrl: `${accountsOrigin(staffClerk.frontendApi)}/sign-in`,
        cloudflareAccess,
      }
    : null;

  return {
    nodeEnv: e.NODE_ENV,
    appEnv,
    isProduction,
    isTest: e.NODE_ENV === 'test',
    // Only the production environment is indexable; staging and dev are noindex.
    indexable: appEnv === 'production',
    port: e.PORT,
    baseUrl,
    trustProxy: e.TRUST_PROXY ?? (isProduction ? 1 : 0),
    maintenance: e.MAINTENANCE_MODE,
    turnstileSiteKey: e.TURNSTILE_SITE_KEY ?? null,
    turnstileSecretKey: e.TURNSTILE_SECRET_KEY ?? null,
    auditDailyBudgetUsd: e.AUDIT_DAILY_BUDGET_USD ?? DEFAULT_AUDIT_DAILY_BUDGET_USD,
    posthog,
    appSecret: e.APP_SECRET ?? DEV_APP_SECRET,
    databaseUrl: e.DATABASE_URL ?? null,
    redis: e.REDIS_URL ? { url: e.REDIS_URL, prefix: e.QUEUE_PREFIX } : null,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL ?? null,
    spaces: spacesConfig(e, appEnv),
    providers: providersConfig(e),
    secrets: secretsConfig(e, isProduction),
    anthropic: e.ANTHROPIC_API_KEY ? { apiKey: e.ANTHROPIC_API_KEY } : null,
    extraction: { model: e.EXTRACTION_MODEL },
    content: { model: e.CONTENT_MODEL },
    stripe,
    google,
    // Plans are enforced exactly when there is a way to pay.
    billingEnforced: Boolean(stripe),
    auth: customer
      ? {
          ...customer,
          webhookSecret: e.CLERK_WEBHOOK_SECRET ?? null,
          signInUrl: e.CLERK_SIGN_IN_URL ?? `${accountsOrigin(customer.frontendApi)}/sign-in`,
          signUpUrl: e.CLERK_SIGN_UP_URL ?? `${accountsOrigin(customer.frontendApi)}/sign-up`,
        }
      : null,
    staff,
    email: {
      resendApiKey: e.RESEND_API_KEY ?? null,
      webhookSecret: e.RESEND_WEBHOOK_SECRET ?? null,
      from: e.EMAIL_FROM_ADDRESS ?? 'AEO Corner <hello@aeocorner.com>',
      billingFrom: e.EMAIL_BILL_ADDRESS ?? null,
      supportFrom: e.EMAIL_SUPPORT_ADDRESS ?? null,
      replyTo: e.EMAIL_REPLY_TO ?? null,
    },
  };
}
