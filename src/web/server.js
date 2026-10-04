import { createSafeFetcher } from '../crawler/safe-fetch.js';
import { createDb } from '../db/index.js';
import { createAuditLimiter } from '../lib/audit-limits.js';
import { createAuditMail } from '../lib/audit-mail.js';
import { loadConfig } from '../lib/config.js';
import { createFunnel } from '../lib/funnel.js';
import { createJobClient } from '../lib/jobs.js';
import { createLogger } from '../lib/logger.js';
import { createMailer } from '../lib/mailer.js';
import { createOtpStore } from '../lib/otp.js';
import { createSecretBox } from '../lib/secrets.js';
import { closeQueues, createQueues } from '../lib/queues.js';
import { closeRedis, createRedis } from '../lib/redis.js';
import { createTurnstile } from '../lib/turnstile.js';
import { createApp } from './app.js';

const config = loadConfig();
const logger = createLogger(config);

// The signed-in area needs the database. Without DATABASE_URL (a quick look at the public site) it is simply
// not mounted — but a deployed server must never come up that way.
const db = config.databaseUrl
  ? createDb({ databaseUrl: config.databaseUrl, caCertPath: process.env.DATABASE_CA_CERT })
  : null;
// Redis is where jobs are queued. The web process only ADDS jobs and shows the queues to staff; the worker
// process runs them. Without REDIS_URL the site still serves (a quick local look), but nothing can be queued.
const redis = config.redis
  ? createRedis(config.redis.url, { role: 'producer', name: 'aeo-corner-web' })
  : null;
redis?.on('error', (err) => logger.error({ err: err.message }, 'Redis connection error'));
const queues = redis ? createQueues({ connection: redis, prefix: config.redis.prefix }) : null;

if (config.isProduction) {
  const missing = [
    !db && 'DATABASE_URL',
    !redis && 'REDIS_URL',
    !config.auth && 'CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY',
    !config.auth?.webhookSecret && 'CLERK_WEBHOOK_SECRET',
    !config.email.resendApiKey && 'RESEND_API_KEY',
  ].filter(Boolean);
  if (missing.length) {
    logger.fatal(`Cannot start in production without: ${missing.join(', ')}`);
    process.exit(1);
  }
} else {
  if (!db) {
    logger.warn('DATABASE_URL is not set: serving the public site only (no sign-in, no /app).');
  } else if (!config.auth) {
    logger.warn('Clerk keys are not set: the signed-in area will say sign-in is unavailable.');
  }
  if (!redis) {
    logger.warn(
      'REDIS_URL is not set: jobs cannot be queued and the staff queue dashboard is off.',
    );
  }
}

// The free audit is live when everything it needs is here: the database, Redis (codes, limits, the job queue) and a
// Turnstile secret. Without them the audit form says the audit isn't open yet (src/web/routes/audit.js), which is
// also how production stays closed until the founder's keys are in place (docs/MILESTONES.md 2.13).
function buildAudit() {
  if (!db || !redis || !queues || !config.turnstileSecretKey) return null;
  if (!config.turnstileSiteKey) {
    logger.warn(
      'TURNSTILE_SITE_KEY is not set: the audit form has no bot check, so every audit will be refused.',
    );
  }
  const prefix = config.redis.prefix;
  return {
    otp: createOtpStore(redis, { prefix, secret: config.appSecret }),
    limiter: createAuditLimiter({ redis, prefix, db }),
    turnstile: createTurnstile({
      secretKey: config.turnstileSecretKey,
      // Cloudflare's published test keys answer with a made-up hostname, so only a real deployment checks it.
      expectedHostname: config.isProduction ? new URL(config.baseUrl).hostname : null,
    }),
    mail: createAuditMail({ mailer: createMailer({ config, logger }), baseUrl: config.baseUrl }),
    jobs: createJobClient(queues),
    funnel: createFunnel({ posthog: config.posthog, logger }),
  };
}
const audit = buildAudit();
if (!audit)
  logger.warn(
    'The free audit is closed: it needs DATABASE_URL, REDIS_URL and TURNSTILE_SECRET_KEY.',
  );

// The Content Studio's web side (Milestone 7): Redis to show a draft as it is written, the key that seals a customer's
// WordPress password (the web process only ever encrypts; the worker opens it), and the safe fetcher that checks a
// site before it is saved. Without a secrets key the WordPress screen says it is not set up.
const content = redis
  ? {
      redis,
      prefix: config.redis.prefix,
      secrets: config.secrets ? createSecretBox(config.secrets) : null,
      fetcher: createSafeFetcher(),
    }
  : null;
if (!config.secrets)
  logger.warn('SECRETS_MASTER_KEY is not set: customers cannot connect WordPress.');

const app = createApp({ config, logger, db, queues, audit, content });

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, appEnv: config.appEnv },
    `AEO Corner web listening on ${config.baseUrl}`,
  );
});

// PM2 sends SIGINT/SIGTERM on reload: stop accepting connections, let in-flight requests finish.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      Promise.resolve()
        .then(() => queues && closeQueues(queues))
        .then(() => redis && closeRedis(redis))
        .then(() => db?.close())
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
