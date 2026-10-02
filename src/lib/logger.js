import pino from 'pino';

/** Structured JSON logger. Silent under `node --test` so test output stays readable. */
export function createLogger(config) {
  return pino({
    level: config.isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
    base: { app: 'aeo-corner', env: config.appEnv },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  });
}
