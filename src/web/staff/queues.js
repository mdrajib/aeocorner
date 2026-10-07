import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Router } from 'express';
import { sameOriginOnly } from '../middleware/same-origin.js';

/** The queue a Bull Board request is about; `/api/queues/pause` and `/resume` are about all of them. */
const queueNamed = (path) => {
  const name = /^\/api\/queues\/([^/]+)/.exec(path)?.[1] ?? null;
  return name === 'pause' || name === 'resume' ? null : name;
};

/**
 * Bull Board: the dashboard of every queue (waiting, active, delayed, failed), with retry and discard buttons
 * (ADMIN_OPERATIONS §3, module 3; MVP §7.8: failed jobs "shown in admin with a retry button").
 *
 * It lives on the staff host at /queues, behind the same wall as the rest of the console: Cloudflare Access,
 * the staff Clerk session with a second factor, and the `ops` role (super_admin passes everything).
 *
 * Its buttons change things, and ADMIN_OPERATIONS requires every staff write to be audited. So any request that
 * isn't a plain read is written to `admin_audit_log` FIRST, and if that write fails the action is refused:
 * no unrecorded changes.
 *
 * It is a third-party page, not part of the component kit (a reason UI_DESIGN's rule asks for): it ships its own
 * React build. It runs under our strict CSP unchanged and is fully usable (checked in a browser on 2026-10-03:
 * every queue, a job's detail, pause with its confirmation). The policy does block two things, and each shows as a
 * console error: the Google Fonts stylesheet it asks for, which we are glad not to send staff IP addresses to (it
 * falls back to system fonts), and some inline styles, which on that day cost nothing visible. Do not loosen
 * 'style-src' for this page without an ADR; if an upgrade makes the page unusable, that is the moment to decide.
 */
export function queueBoard({ queues, staffAuth, db, logger }) {
  const adapter = new ExpressAdapter();
  adapter.setBasePath('/queues');
  createBullBoard({
    queues: Object.values(queues).map((q) => new BullMQAdapter(q)),
    serverAdapter: adapter,
    options: {
      uiConfig: {
        boardTitle: 'AEO Corner queues',
        // Bull Board has no menu of ours, so give staff the way back to the rest of the console.
        miscLinks: [{ text: 'Back to staff console', url: '/' }],
      },
    },
  });

  const router = Router();
  router.use(staffAuth.identify, staffAuth.requireRole('ops'));
  router.use(sameOriginOnly());
  router.use(async (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    try {
      await db.staff.audit({
        staffId: req.staff.id,
        action: 'queue.write',
        targetType: 'queue',
        targetId: queueNamed(req.path),
        afterState: { method: req.method, path: req.originalUrl.split('?')[0] },
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      next();
    } catch (err) {
      logger.error({ err }, 'Refusing a queue action: it could not be written to the audit log');
      next(err);
    }
  });
  router.use(adapter.getRouter());
  return router;
}
