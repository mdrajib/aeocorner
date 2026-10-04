import express, { Router } from 'express';
import { csrfProtection, csrfToken } from '../auth/csrf.js';
import { clearClerkCookies } from '../routes/auth.js';
import { notFound } from '../middleware/errors.js';
import { cloudflareAccess } from './cloudflare-access.js';
import { createStaffAuth } from './auth.js';
import { adminModules, canOpen, MODULES, navFor } from './admin.js';
import { queueBoard } from './queues.js';

/**
 * The staff console (ADMIN_OPERATIONS §1). Phase 2 builds the doorway only: Cloudflare Access, the separate
 * staff Clerk app, mandatory second factor, and role checks. The modules behind it (customers, runs, providers…)
 * arrive with the phases that need them. Everything here lives on its own host, never on the public one.
 */
export function staffRoutes({ config, db, provider, logger, cloudflareKeys, queues = null }) {
  const router = Router();
  const staffAuth = createStaffAuth({ config, provider, db, logger });

  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });

  // Outer wall: only requests that Cloudflare Access let through are even looked at. It may be absent
  // only in local development (config.js refuses to start a staging or production server without it).
  if (config.staff.cloudflareAccess) {
    router.use(cloudflareAccess({ ...config.staff.cloudflareAccess, keys: cloudflareKeys }));
  }

  router.post(
    '/sign-out',
    staffAuth.identify,
    express.urlencoded({ extended: false, limit: '2kb' }),
    csrfProtection({ secret: config.appSecret }),
    async (req, res, next) => {
      try {
        await provider.endSession(req.session.sessionId).catch((err) => {
          logger.warn({ err }, 'Could not revoke the staff Clerk session');
        });
        clearClerkCookies(req, res);
        res.redirect(303, '/');
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/', staffAuth.identify, (req, res) => {
    res.page(
      'staff-home',
      {
        showAuditBand: false,
        staff: req.staff,
        project: { name: 'Staff console' },
        csrfToken: csrfToken(config.appSecret, req.session.sessionId),
        nav: navFor(req.staff, '/', Boolean(queues)),
        modules: MODULES.filter((m) => canOpen(req.staff.roles, m)),
        flash: [],
        meta: { title: 'Staff console | AEO Corner', description: 'Staff console.', noindex: true },
      },
      { layout: 'app' },
    );
  });

  // The admin modules (costs, providers, failed jobs, review queue, flags, audit log). One wall for all of them.
  router.use(adminModules({ config, db, staffAuth, queues, logger }));

  // The queue dashboard exists only where there is a queue to show (Redis configured).
  if (queues) router.use('/queues', queueBoard({ queues, staffAuth, db, logger }));

  router.use(notFound);
  return router;
}

/** Send requests for `host` to `router`; everything else carries on to the public app. */
export function onHost(host, router) {
  const wanted = host.toLowerCase();
  return (req, res, next) => (req.host?.toLowerCase() === wanted ? router(req, res, next) : next());
}
