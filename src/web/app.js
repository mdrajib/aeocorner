import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pinoHttp from 'pino-http';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { createMailer } from '../lib/mailer.js';
import { createAuthMiddleware } from './auth/middleware.js';
import { createClerkProvider, createProvider } from './auth/provider.js';
import { errorHandler, maintenanceMode, notFound } from './middleware/errors.js';
import { pageRenderer } from './middleware/render.js';
import { sameOriginOnly } from './middleware/same-origin.js';
import { securityHeaders } from './middleware/security.js';
import { createDomainVerifier } from '../crawler/verify-domain.js';
import { createSafeFetcher } from '../crawler/safe-fetch.js';
import { createGoogle } from '../integrations/google.js';
import { createJobClient } from '../lib/jobs.js';
import { appRoutes } from './routes/app.js';
import { auditRoutes, auditStubRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { inviteRoutes } from './routes/invite.js';
import { healthRoutes, publicRoutes } from './routes/public.js';
import { seoRoutes } from './routes/seo.js';
import { styleguideRoutes } from './routes/styleguide.js';
import { unsubscribeRoutes } from './routes/unsubscribe.js';
import { webhookRoutes } from './routes/webhooks.js';
import { onHost, staffRoutes } from './staff/routes.js';

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = join(WEB_DIR, 'views');
const PUBLIC_DIR = join(WEB_DIR, 'public');

/**
 * Build the Express app. Taking its collaborators as arguments (instead of reading globals) is what lets
 * the route tests run production, staging and maintenance configurations in one process, and swap the
 * database, Clerk and the mailer for test doubles.
 *
 *   db             the repositories from src/db. Without one only the public site is served
 *                  (no sign-in, no /app, no webhooks), which is what the public-page tests use.
 *   provider       customer sign-in (Clerk). Defaults to Clerk if configured, else "sign-in unavailable".
 *   staffProvider  the same for the separate staff Clerk app.
 *   mailer         sends transactional email.
 *   audit          { otp, limiter, turnstile, mail, jobs, funnel }: what the free audit needs (src/web/routes/audit.js).
 *                  Without it (or without a database) the audit form says the audit isn't open yet.
 *   billing        { stripe, now? }: the Stripe client (src/integrations/stripe.js). Without it the webhook answers 503 and
 *                  the billing screen cannot start a checkout. Whether plans are ENFORCED is `config.billingEnforced`.
 *   jobs           adds jobs (the first scan of a new project). Defaults to a client on `queues`; none means no job is queued.
 *   queues         the BullMQ queues (src/lib/queues.js). When given, the staff console shows them at /queues.
 *   extraRoutes(app) lets a test mount a route (e.g. one that throws) ahead of the 404 and error handlers.
 */
export function createApp({
  config = loadConfig(),
  logger = createLogger(config),
  db = null,
  provider = createProvider(config),
  staffProvider = config.staff ? createStaffProvider(config) : null,
  mailer = createMailer({ config, logger }),
  queues = null,
  audit = null,
  jobs = null,
  content = null,
  billing = null,
  google = config.google ? createGoogle(config.google) : null,
  domainVerifier = db ? createDomainVerifier({ fetcher: createSafeFetcher() }) : null,
  cloudflareKeys,
  extraRoutes,
} = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy); // Nginx (+ Cloudflare) sit in front in production
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
  if (config.isProduction) app.enable('view cache');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Don't log asset fetches; they drown out real traffic.
      autoLogging: { ignore: (req) => /^\/(build|vendor|js|fonts|img)\//.test(req.url) },
    }),
  );
  app.use(securityHeaders(config));

  app.use(healthRoutes());
  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: config.isProduction ? '7d' : 0, // URLs carry ?v=<mtime>, so long caching is safe
      index: false,
    }),
  );

  app.use(pageRenderer({ config, viewsDir: VIEWS_DIR, publicDir: PUBLIC_DIR }));

  // The staff host, and Clerk's webhooks, stay reachable during maintenance.
  if (db && config.staff && staffProvider) {
    app.use(
      onHost(
        config.staff.host,
        staffRoutes({ config, db, provider: staffProvider, logger, cloudflareKeys, queues }),
      ),
    );
  }
  if (db) app.use(webhookRoutes({ config, db, logger, billing }));

  app.use(maintenanceMode(config));
  app.use(sameOriginOnly());

  app.use(seoRoutes(config));
  app.use(publicRoutes(config));
  app.use(db && audit ? auditRoutes({ config, db, audit, logger }) : auditStubRoutes());
  if (db) app.use(unsubscribeRoutes({ config, db }));
  if (db) {
    const auth = createAuthMiddleware({ config, provider, db });
    app.use(authRoutes({ config, provider, auth }));
    app.use(
      '/app',
      appRoutes({
        config,
        db,
        auth,
        mailer,
        logger,
        verifier: domainVerifier,
        content,
        billing,
        google,
        jobs: jobs ?? (queues ? createJobClient(queues) : null),
      }),
    );
    app.use('/invite', inviteRoutes({ config, db, auth, provider }));
  }
  if (!config.isProduction) app.use('/_styleguide', styleguideRoutes(config));

  if (extraRoutes) extraRoutes(app);

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}

function createStaffProvider(config) {
  const { publishableKey, secretKey, signInUrl, baseUrl } = config.staff;
  return createClerkProvider({ publishableKey, secretKey, signInUrl, signUpUrl: null, baseUrl });
}
