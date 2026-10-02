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
});

// PostHog serves its JS from a sibling "-assets" host of the ingestion host
// (us.i.posthog.com -> us-assets.i.posthog.com). Self-hosted or proxied setups set POSTHOG_ASSETS_HOST.
function posthogAssetsHost(host) {
  const url = new URL(host);
  if (url.hostname.endsWith('.i.posthog.com')) {
    return `${url.protocol}//${url.hostname.replace('.i.posthog.com', '-assets.i.posthog.com')}`;
  }
  return url.origin;
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
  };
}
