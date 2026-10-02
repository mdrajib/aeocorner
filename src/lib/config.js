import 'dotenv/config';
import { z } from 'zod';

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

function clerkApp({ publishableKey, secretKey, label }) {
  if (!publishableKey && !secretKey) return null;
  if (!publishableKey || !secretKey) {
    throw new Error(`${label}: set both the publishable key and the secret key, or neither.`);
  }
  const frontendApi = frontendApiOf(publishableKey);
  if (!frontendApi) throw new Error(`${label}: the publishable key is not a valid Clerk key.`);
  return { publishableKey, secretKey, frontendApi, isLive: publishableKey.startsWith('pk_live_') };
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
