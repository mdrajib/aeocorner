import 'dotenv/config';
import { z } from 'zod';
import { toMicros } from '../core/spend.js';

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
  // The model that reads answers (decision D4, ADR-0007): opus55 or haiku45.
  EXTRACTION_MODEL: z.enum(['opus55', 'haiku45']).default('opus55'),

  RESEND_API_KEY: optional(z.string().min(1)),
  EMAIL_FROM_ADDRESS: optional(z.string().min(3)),
});

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
    posthog,
    appSecret: e.APP_SECRET ?? DEV_APP_SECRET,
    databaseUrl: e.DATABASE_URL ?? null,
    redis: e.REDIS_URL ? { url: e.REDIS_URL, prefix: e.QUEUE_PREFIX } : null,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL ?? null,
    spaces: spacesConfig(e, appEnv),
    providers: providersConfig(e),
    anthropic: e.ANTHROPIC_API_KEY ? { apiKey: e.ANTHROPIC_API_KEY } : null,
    extraction: { model: e.EXTRACTION_MODEL },
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
      from: e.EMAIL_FROM_ADDRESS ?? 'AEO Corner <hello@aeocorner.com>',
    },
  };
}
