import pino from 'pino';

/**
 * What the logger blanks out wherever it finds it, one level deep (`{ creds: { appPassword } }` is covered, a field three
 * levels down is not: don't log credentials at all). Names are the ones this app uses for a credential.
 */
const SECRET_FIELDS = [
  'password',
  'appPassword',
  'secret',
  'hmacSecret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secretKey',
  'clientSecret',
  'webhookSecret',
  'masterKey',
  'otp',
  'code',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["stripe-signature"]',
  'req.headers["svix-signature"]',
  'req.headers["x-aeo-signature"]',
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS,
  ...SECRET_FIELDS.map((f) => `*.${f}`),
];

/** Structured JSON logger. Silent under `node --test` so test output stays readable. */
export function createLogger(config, stream) {
  return pino(
    {
      level: config.isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
      base: { app: 'aeo-corner', env: config.appEnv },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    stream,
  );
}
