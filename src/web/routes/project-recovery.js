import { caseView, listView } from '../../core/recovery-view.js';
import { DEFAULT_ENGINE_LABELS } from '../../core/narrative.js';
import { notFound } from '../middleware/errors.js';

/**
 * The Recovery screens (Milestone 14, UI_DESIGN D8): when visibility drops and stays down, what probably caused it and what to
 * do, and how it ended. Registers on the project router.
 *
 *   GET /projects/:pid/recovery        the open cases and the closed ones
 *   GET /projects/:pid/recovery/:cid   one case (`:cid` is its public id): the numbers, the diagnosis with its facts, the
 *                                      repairs in progress and the timeline
 *
 * Read-only on purpose. Only the system opens, diagnoses and closes a case, and a repair is an ordinary Action Center item that
 * a person approves there. Anyone who can see the project can read it.
 */
export function recoveryRoutes(router, { appPage }) {
  router.get('/projects/:pid/recovery', async (req, res, next) => {
    try {
      const cases = await req.orgDb.recovery.list(req.project.id, { limit: 100 });
      appPage(res, 'recovery', {
        view: listView({ cases, engineNames: DEFAULT_ENGINE_LABELS }),
        meta: {
          title: `Recovery · ${req.project.name} | AEO Corner`,
          description:
            'When your AI visibility drops and stays down, what caused it and how to fix it.',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:pid/recovery/:cid', async (req, res, next) => {
    try {
      const kase = await req.orgDb.recovery.get(req.project.id, req.params.cid);
      if (!kase) return notFound(req, res);
      const [events, progress] = await Promise.all([
        req.orgDb.recovery.events(req.project.id, kase.id),
        req.orgDb.recovery.repairProgress(req.project.id, kase),
      ]);
      // The titles of the fixes the re-check looked at, for the ones it names.
      const fixTitles = {};
      for (const f of kase.recheck?.fixes ?? []) {
        const rec = await req.orgDb.recommendations.load(BigInt(f.recommendationId));
        if (rec && rec.projectId === req.project.id)
          fixTitles[String(f.recommendationId)] = rec.title;
      }
      const view = caseView({
        kase,
        events,
        progress,
        fixTitles,
        engineNames: DEFAULT_ENGINE_LABELS,
      });
      // The diagnosis arrives a few minutes after the case opens: the page reloads itself until it does.
      if (view.diagnosis.state === 'waiting') res.locals.refreshSeconds = 30;
      appPage(res, 'recovery-case', {
        view,
        meta: {
          title: `${view.title} · ${req.project.name} | AEO Corner`,
          description: 'A recovery case: what changed, the likely cause and the repairs.',
        },
      });
    } catch (err) {
      next(err);
    }
  });
}
