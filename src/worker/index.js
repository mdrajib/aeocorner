import { createHostPacer, RENDER_PACING } from '../crawler/pacer.js';
import { createRenderer } from '../crawler/render.js';
import { createSafeFetcher } from '../crawler/safe-fetch.js';
import { createDb } from '../db/index.js';
import { createObjectStore } from '../integrations/spaces.js';
import { createAlerter } from '../lib/alerts.js';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { closeRedis, createRedis, evictionPolicy } from '../lib/redis.js';
import { createWorkerRuntime } from './runtime.js';

/**
 * The worker process: runs the BullMQ workers for every queue plus the hourly scheduler and the guards.
 * Separate from the web process (MVP §7.9), started with `npm run worker` (PM2 in production).
 */
const config = loadConfig();
const logger = createLogger(config);

if (!config.databaseUrl || !config.redis) {
  logger.fatal('The worker needs DATABASE_URL and REDIS_URL.');
  process.exit(1);
}

const db = createDb({
  databaseUrl: config.databaseUrl,
  caCertPath: process.env.DATABASE_CA_CERT,
  connectionLimit: 10,
});
const redis = createRedis(config.redis.url, { role: 'worker', name: 'aeo-corner-worker' });
redis.on('error', (err) => logger.error({ err: err.message }, 'Redis connection error'));

const policy = await evictionPolicy(redis);
if (policy !== 'noeviction') {
  // With any other policy Redis may delete queued jobs when memory fills up.
  logger.error(
    { policy },
    'Redis eviction policy is not "noeviction": queued jobs can be lost. Fix it in the Redis settings.',
  );
}

// Reading customers' websites: one polite, SSRF-safe fetcher, one headless browser (started on first use), and
// the bucket where raw pages are kept. Production refuses to start without Spaces.
const store = createObjectStore(config, { logger });
const fetcher = createSafeFetcher({ pacer: createHostPacer() });
// The browser's own requests while rendering one page are paced like a visitor's, not like the crawl.
const renderer = createRenderer({
  fetcher: createSafeFetcher({ pacer: createHostPacer(RENDER_PACING) }),
});

const runtime = createWorkerRuntime({
  redis,
  prefix: config.redis.prefix,
  db,
  logger,
  alerts: createAlerter({ logger, webhookUrl: config.alertWebhookUrl }),
  crawler: { fetcher, renderer, store },
});
await runtime.start();
logger.info(
  { queues: Object.keys(runtime.queues), prefix: config.redis.prefix },
  'AEO Corner worker running',
);

// PM2 sends SIGINT/SIGTERM on reload: stop taking jobs, let the running ones finish, then close.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Worker shutting down');
    setTimeout(() => process.exit(1), 30_000).unref();
    try {
      await runtime.stop();
      await renderer.close();
      store.close();
      await closeRedis(redis);
      await db.close();
    } finally {
      process.exit(0);
    }
  });
}
