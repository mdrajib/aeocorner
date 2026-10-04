import {
  evidenceRows,
  FIX_PATH_LABELS,
  FIX_PATH_NOTES,
  historyLines,
  listItem,
  paragraphsOf,
  proofCards,
  statusBadge,
  statusPanel,
  stepsOf,
  CATEGORY_LABELS,
} from '../../core/action-center.js';
import { STATUS_LABELS } from '../../core/content-lifecycle.js';
import { DEFAULT_ENGINE_LABELS } from '../../core/narrative.js';
import { effortLabel } from '../../core/ice.js';
import { DISMISS_REASONS, timelineFor } from '../../core/recommendation-lifecycle.js';
import { describeRun, isRunning } from '../../core/run-status.js';
import { DomainError } from '../../db/index.js';
import { fixVerifyJobId } from '../../lib/job-ids.js';
import { notFound } from '../middleware/errors.js';
import { idFrom, text, withNotice } from './project-helpers.js';

/**
 * The Action Center of one project (Milestone 6, UI_DESIGN D1-D4). Registers on the project router.
 *
 *   GET  /projects/:pid/actions              D1  the ranked list: to do, in progress, results, dismissed
 *   GET  /projects/:pid/actions/:rid         D2  one recommendation: why, evidence, the steps, where it is, its proof
 *   POST /projects/:pid/actions/:rid/start       open → in progress
 *   POST /projects/:pid/actions/:rid/stop        in progress → open
 *   POST /projects/:pid/actions/:rid/done        "Mark as done": saves the baseline, queues the same-day re-check
 *   POST /projects/:pid/actions/:rid/dismiss     with a reason
 *   POST /projects/:pid/actions/:rid/confirm     an unverified fix: "I have fixed it, start measuring"
 *   POST /projects/:pid/actions/:rid/redo        an unverified fix: "fix it again"
 *
 * Everyone in the organization who can see the project can read these screens; changing one needs `content.create`
 * (owner, admin or editor). A person's moves go through `recommendations.transition` and `markDone`, which ask the
 * lifecycle table: the screen never decides that something is "verified" or "a win".
 */

const VIEW_TABS = [
  { id: 'todo', label: 'To do' },
  { id: 'progress', label: 'Checking and measuring' },
  { id: 'results', label: 'Results' },
  { id: 'dismissed', label: 'Dismissed' },
];

const EMPTY = {
  todo: {
    title: 'Nothing to fix right now',
    text: 'Recommendations appear after we have scanned your website and checked your questions. When something is worth doing, it shows up here, best first.',
  },
  progress: {
    title: 'Nothing is being checked or measured',
    text: 'When you mark a recommendation as done, we check your site straight away and then measure whether the AI engines start naming you.',
  },
  results: {
    title: 'No results yet',
    text: 'A result appears two weeks after a fix is confirmed, and again after four. Answers often take 2–6 weeks to change.',
  },
  dismissed: {
    title: 'Nothing dismissed',
    text: 'Recommendations you dismiss are kept here, and are not suggested again for a while.',
  },
};

export function actionRoutes(router, { appPage, act, jobs, logger }) {
  const tabs = (req, res) => ({
    orgBase: res.locals.orgBase,
    projectBase: res.locals.projectBase,
    projectName: req.project.name,
  });

  const meta = (req, title) => ({
    title: `${title} · ${req.project.name} | AEO Corner`,
    description: `${title} for ${req.project.name}.`,
  });

  async function brandOf(req) {
    const [brand] = await req.orgDb.entities.list(req.project.id, { kind: 'brand' });
    return brand ?? null;
  }

  /** The latest run's status, so the page can say a check is under way. */
  async function lastRunOf(req, res) {
    const [latest] = await req.orgDb.runs.recent(req.project.id, { limit: 1 });
    if (isRunning(latest ?? null)) res.locals.refreshSeconds = 15;
    return describeRun(latest ?? null);
  }

  // --- D1 The list ---------------------------------------------------------------------------------------
  router.get('/projects/:pid/actions', async (req, res, next) => {
    try {
      const view = VIEW_TABS.some((t) => t.id === req.query.view) ? req.query.view : 'todo';
      const base = res.locals.projectBase;
      const [rows, counts, wins, brand, lastRun] = await Promise.all([
        req.orgDb.recommendations.list(req.project.id, { view }),
        req.orgDb.recommendations.counts(req.project.id),
        req.orgDb.recommendations.provenWins(req.project.id),
        brandOf(req),
        lastRunOf(req, res),
      ]);
      // A fix in the middle of its same-day re-check is waiting on a job: the page looks again by itself.
      if (view === 'progress' && rows.some((r) => r.status === 'done'))
        res.locals.refreshSeconds = 15;
      return appPage(res, 'actions', {
        ...tabs(req, res),
        domain: brand?.primary_domain ?? req.project.domain ?? '',
        current: 'actions',
        view,
        viewTabs: VIEW_TABS.map((t) => ({
          ...t,
          count: counts[t.id],
          href: `${base}/actions?view=${t.id}`,
          current: t.id === view,
        })),
        items: rows.map((r) => listItem(r, { projectBase: base, brandName: brand?.name })),
        empty: EMPTY[view],
        wins,
        lastRun,
        canAct: res.locals.can('content.create'),
        meta: meta(req, 'Action Center'),
      });
    } catch (err) {
      return next(err);
    }
  });

  // --- D2 One recommendation -----------------------------------------------------------------------------
  router.get('/projects/:pid/actions/:rid', async (req, res, next) => {
    try {
      const rid = idFrom(req.params.rid);
      const detail = rid ? await req.orgDb.recommendations.get(req.project.id, rid) : null;
      if (!detail) return notFound(req, res);
      const rec = detail.recommendation;
      const base = res.locals.projectBase;
      const brand = await brandOf(req);
      const brandName = brand?.name ?? req.project.name;
      const domain = brand?.primary_domain ?? req.project.domain ?? '';
      // The page looks again by itself while the same-day re-check is under way.
      if (rec.status === 'done' || rec.status === 'verified') res.locals.refreshSeconds = 15;
      const reached = detail.events.map((e) => e.toStatus);
      // A fix that is a page to write can be started in the Content Studio (Milestone 7); one already started is linked.
      const written = (await req.orgDb.content.forRecommendations(req.project.id, [rec.id])).get(
        rec.id,
      );
      return appPage(res, 'action-detail', {
        ...tabs(req, res),
        domain,
        current: 'actions',
        rec: {
          id: String(rec.id),
          title: rec.title,
          status: rec.status,
          badge: statusBadge(rec.status, detail.outcomes.at(-1) ?? null),
          category: CATEGORY_LABELS[rec.category] ?? rec.category,
          fixPath: rec.fixPath,
          fixPathLabel: FIX_PATH_LABELS[rec.fixPath] ?? rec.fixPath,
          fixPathNote: FIX_PATH_NOTES[rec.fixPath] ?? '',
          effort: effortLabel(rec.effort),
          looksFixed: Boolean(rec.signalClearedAt) && ['open', 'in_progress'].includes(rec.status),
          followUp: rec.parentId != null,
          affectedUrls: rec.affectedUrls.slice(0, 20),
        },
        why: paragraphsOf(rec.whyMd),
        steps: stepsOf(rec.stepsMd),
        evidence: evidenceRows(rec, { projectBase: base, domain, brandName }),
        questions: detail.prompts.map((p) => ({ text: p.text, href: `${base}/answers/${p.id}` })),
        timeline: timelineFor(rec.status, { reached }),
        panel: statusPanel(detail),
        proofs: proofCards(detail, { brandName }),
        history: historyLines(detail.events),
        dismissReasons: Object.entries(DISMISS_REASONS).map(([value, label]) => ({ value, label })),
        canAct: res.locals.can('content.create'),
        contentItem: written
          ? {
              href: `${base}/content/${written.publicId}`,
              status: STATUS_LABELS[written.status] ?? written.status,
            }
          : null,
        writable: rec.fixPath === 'content' && ['open', 'in_progress'].includes(rec.status),
        actionBase: `${base}/actions/${rec.id}`,
        listHref: `${base}/actions`,
        engineNames: DEFAULT_ENGINE_LABELS,
        meta: meta(req, rec.title),
      });
    } catch (err) {
      return next(err);
    }
  });

  // --- Moves ---------------------------------------------------------------------------------------------
  const MOVES = {
    start: { to: 'in_progress', notice: 'action-started' },
    stop: { to: 'open', notice: 'action-stopped' },
    confirm: { to: 'measuring', notice: 'action-confirmed' },
    redo: { to: 'in_progress', notice: 'action-redo' },
  };

  for (const [move, def] of Object.entries(MOVES)) {
    router.post(`/projects/:pid/actions/:rid/${move}`, act, async (req, res, next) => {
      try {
        const rid = idFrom(req.params.rid);
        const back = (notice) =>
          res.redirect(
            303,
            withNotice(`${res.locals.projectBase}/actions/${req.params.rid}`, notice),
          );
        if (!rid) return notFound(req, res);
        try {
          await req.orgDb.recommendations.transition(req.project.id, rid, def.to, {
            userId: req.user.id,
          });
          return back(def.notice);
        } catch (err) {
          return handleRefusal(err, rid, req, res, back);
        }
      } catch (err) {
        return next(err);
      }
    });
  }

  router.post('/projects/:pid/actions/:rid/dismiss', act, async (req, res, next) => {
    try {
      const rid = idFrom(req.params.rid);
      if (!rid) return notFound(req, res);
      const back = (notice, path = `/actions/${req.params.rid}`) =>
        res.redirect(303, withNotice(`${res.locals.projectBase}${path}`, notice));
      try {
        await req.orgDb.recommendations.transition(req.project.id, rid, 'dismissed', {
          userId: req.user.id,
          dismissReason: text(req.body.reason, 32),
          dismissNote: text(req.body.note, 500),
        });
        return back('action-dismissed', '/actions');
      } catch (err) {
        return handleRefusal(err, rid, req, res, back);
      }
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/actions/:rid/done', act, async (req, res, next) => {
    try {
      const rid = idFrom(req.params.rid);
      if (!rid) return notFound(req, res);
      const back = (notice) =>
        res.redirect(
          303,
          withNotice(`${res.locals.projectBase}/actions/${req.params.rid}`, notice),
        );
      let done;
      try {
        done = await req.orgDb.recommendations.markDone(req.project.id, rid, {
          userId: req.user.id,
        });
      } catch (err) {
        return handleRefusal(err, rid, req, res, back);
      }
      if (!done.verifiable) return back('action-done-measuring');
      // The first re-check runs at once. A queue that is down must not lose the fix: the daily sweep asks again for a
      // re-check that never ran.
      try {
        await jobs?.add(
          'fix.verify',
          { orgId: String(req.org.id), recommendationId: String(rid), attempt: 1 },
          { jobId: fixVerifyJobId(rid, 1) },
        );
      } catch (err) {
        logger.error({ err, recommendationId: String(rid) }, 'Could not queue the re-check');
      }
      return back('action-done-checking');
    } catch (err) {
      return next(err);
    }
  });

  /** A move the lifecycle refused: the page changed under the person (or the form was wrong). Say so; never a 500. */
  function handleRefusal(err, rid, req, res, back) {
    if (err instanceof DomainError) {
      if (err.code === 'RECOMMENDATION_NOT_FOUND') return notFound(req, res);
      if (err.code === 'DISMISS_REASON_REQUIRED') return back('action-reason');
      if (['INVALID_TRANSITION', 'STALE_STATUS'].includes(err.code)) return back('action-stale');
      logger.warn({ code: err.code }, 'Action refused');
      return back('action-stale');
    }
    throw err;
  }
}
