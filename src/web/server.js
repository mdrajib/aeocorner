import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { createApp } from './app.js';

const config = loadConfig();
const logger = createLogger(config);
const app = createApp({ config, logger });

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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
