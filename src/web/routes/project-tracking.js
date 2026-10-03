import { isoWeekKey } from '../../core/slots.js';
import { isRunning } from '../../core/run-status.js';
import { DomainError } from '../../db/index.js';
import { trackingPlanJobId } from '../../lib/job-ids.js';
import { ulid } from '../../lib/ulid.js';
import { withNotice } from './project-helpers.js';

/**
 * Switching tracking on and asking for a check now (Milestone 4). Both register on the project router.
 *
 *   POST /projects/:pid/setup/start   an `onboarding` project becomes `active` and its first check starts at once.
 *   POST /projects/:pid/run-now       an extra check, taken from the plan's monthly allowance.
 *
 * A first check and a "run now" are made for a person who is waiting, so they are read answer by answer at once (the
 * weekly run is read in one half-price batch). The first check takes the slot of the current week: the scheduler,
 * finding that week already run, plans nothing more, so a new project is not charged twice in its first week.
 */

export function trackingRoutes(router, { jobs, logger, edit }) {
  /** Make the run's row and queue its planning. The row is the identity, so asking twice is one run. */
  async function queueRun(req, { slotKey, trigger }) {
    const { created, run } = await req.orgDb.runs.start({
      projectId: req.project.id,
      slotKey,
      trigger,
      extractionMode: 'sync',
      requestedByUserId: req.user.id,
    });
    await jobs.add(
      'tracking.run',
      { orgId: String(req.org.id), runId: String(run.id) },
      { jobId: trackingPlanJobId(run.id) },
    );
    return { created, run };
  }

  router.post('/projects/:pid/setup/start', edit, async (req, res, next) => {
    try {
      const setup = `${res.locals.projectBase}/setup/start`;
      if (!jobs) return res.redirect(303, withNotice(setup, 'queue-down'));
      try {
        await req.orgDb.projects.startTracking(req.project.id, { actorUserId: req.user.id });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'NOT_READY') {
          return res.redirect(303, withNotice(setup, 'tracking-not-ready'));
        }
        if (err instanceof DomainError && err.code === 'PROJECT_NOT_TRACKABLE') {
          return res.redirect(303, withNotice(setup, 'tracking-unavailable'));
        }
        throw err;
      }
      try {
        await queueRun(req, { slotKey: isoWeekKey(new Date()), trigger: 'onboarding' });
      } catch (err) {
        // Tracking is on: the weekly run will happen. Only the first check could not be started just now.
        logger.error({ err, projectId: String(req.project.id) }, 'Could not queue the first check');
        return res.redirect(303, withNotice(res.locals.projectBase, 'tracking-on-no-first-run'));
      }
      return res.redirect(303, withNotice(res.locals.projectBase, 'tracking-started'));
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/run-now', edit, async (req, res, next) => {
    try {
      const home = res.locals.projectBase;
      if (!jobs) return res.redirect(303, withNotice(home, 'queue-down'));
      if (req.project.status !== 'active') {
        return res.redirect(303, withNotice(home, 'run-now-inactive'));
      }
      // One check at a time: a second click while one is running costs nothing and starts nothing.
      const [latest] = await req.orgDb.runs.recent(req.project.id, { limit: 1 });
      if (isRunning(latest)) {
        return res.redirect(303, withNotice(home, 'run-in-progress'));
      }
      const taken = await req.orgDb.quota.takeRunNow();
      if (!taken.allowed) return res.redirect(303, withNotice(home, 'run-now-limit'));
      try {
        await queueRun(req, { slotKey: `m-${ulid()}`, trigger: 'manual' });
      } catch (err) {
        await req.orgDb.quota.returnRunNow().catch(() => {});
        logger.error({ err, projectId: String(req.project.id) }, 'Could not queue a check');
        return res.redirect(303, withNotice(home, 'queue-down'));
      }
      return res.redirect(303, withNotice(home, 'run-started'));
    } catch (err) {
      return next(err);
    }
  });
}
