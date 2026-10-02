import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pinoHttp from 'pino-http';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { errorHandler, maintenanceMode, notFound } from './middleware/errors.js';
import { pageRenderer } from './middleware/render.js';
import { sameOriginOnly } from './middleware/same-origin.js';
import { securityHeaders } from './middleware/security.js';
import { auditRoutes } from './routes/audit.js';
import { healthRoutes, publicRoutes } from './routes/public.js';
import { seoRoutes } from './routes/seo.js';
import { styleguideRoutes } from './routes/styleguide.js';

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = join(WEB_DIR, 'views');
const PUBLIC_DIR = join(WEB_DIR, 'public');

/**
 * Build the Express app. Taking config and logger as arguments (instead of reading globals) is what
 * lets the route tests run production, staging and maintenance configurations in one process.
 * `extraRoutes(app)` lets a test mount a route (e.g. one that throws) ahead of the 404 and error handlers.
 */
export function createApp({
  config = loadConfig(),
  logger = createLogger(config),
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
  app.use(maintenanceMode(config));
  app.use(sameOriginOnly());

  app.use(seoRoutes(config));
  app.use(publicRoutes(config));
  app.use(auditRoutes());
  if (!config.isProduction) app.use('/_styleguide', styleguideRoutes(config));

  if (extraRoutes) extraRoutes(app);

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
