import { createDb } from '../db/index.js';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { closeQueues, createQueues } from '../lib/queues.js';
import { closeRedis, createRedis } from '../lib/redis.js';
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

const app = createApp({ config, logger, db, queues });

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
