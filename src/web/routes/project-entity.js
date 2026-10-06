import { emptyBrandKit } from '../../core/brand-kit.js';
import { entityView } from '../../core/entity-view.js';
import { DomainError } from '../../db/index.js';
import { entityCheckJobId, slotOf } from '../../lib/job-ids.js';
import { notFound } from '../middleware/errors.js';
import { withNotice } from './project-helpers.js';

/**
 * The Entity screen (Milestone 12, UI_DESIGN D7): which profiles describe the business, whether Wikidata knows it, what
 * the AI engines say about its facts compared with the Brand Kit, and the text to put on each profile we cannot touch.
 * Registers on the project router.
 *
 *   GET  /projects/:pid/entity         the screen (anyone who can see the project)
 *   POST /projects/:pid/entity/check   look at the profiles and Wikidata now (strategy.edit); the same ten minutes is one job
 *   POST …/entity/confirm | unconfirm  say you checked a profile our crawler could not read yourself, or take that back (strategy.edit)
 *
 * Nothing is posted anywhere and no account is made: the checklists are for the customer to carry out. The profile
 * addresses and facts themselves are edited on the Brand Kit's Entity tab.
 */

const WINDOW_DAYS = 28;

const text = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function entityRoutes(router, { appPage, edit, jobs, logger }) {
  router.get('/projects/:pid/entity', async (req, res, next) => {
    try {
      const now = new Date();
      const from = new Date(now.getTime() - (WINDOW_DAYS - 1) * 86_400_000);
      const [kitRow, checks, said] = await Promise.all([
        req.orgDb.brandKits.current(req.project.id),
        req.orgDb.entityChecks.checks(req.project.id),
        req.orgDb.entityChecks.accuracyInputs(req.project.id, { from, to: now }),
      ]);
      const view = entityView({
        // Before the first Brand Kit exists the screen still works from the name and the website.
        kit: kitRow?.data ?? emptyBrandKit({ name: req.project.name, domain: req.project.domain }),
        checks,
        said,
        domain: req.project.domain ?? '',
        country: req.project.country,
      });
      appPage(res, 'entity', {
        domain: req.project.domain ?? '',
        view,
        canEdit: res.locals.can('strategy.edit'),
        meta: {
          title: `Entity · ${req.project.name} | AEO Corner`,
          description: 'How AI engines can tell your business from a namesake.',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // A person says they looked at a listed profile that our crawler may not read (LinkedIn, most often). Only a profile in
  // the current Brand Kit can be confirmed, and only while its latest check could not look.
  router.post('/projects/:pid/entity/confirm', edit, async (req, res, next) => {
    try {
      const back = (notice) =>
        res.redirect(303, withNotice(`${res.locals.projectBase}/entity`, notice));
      const url = text(req.body.url);
      const kit = await req.orgDb.brandKits.current(req.project.id);
      const listed = (kit?.data?.entity?.profiles ?? []).some((p) => p.url === url);
      if (!listed) return back('profile-not-listed');
      try {
        await req.orgDb.entityChecks.confirmProfile(req.project.id, url, { userId: req.user.id });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'NOT_FOUND')
          return back('profile-not-checked');
        if (err instanceof DomainError && err.code === 'NOT_CONFIRMABLE')
          return back('profile-read');
        throw err;
      }
      return back('profile-confirmed');
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:pid/entity/unconfirm', edit, async (req, res, next) => {
    try {
      await req.orgDb.entityChecks.unconfirmProfile(req.project.id, text(req.body.url), {
        userId: req.user.id,
      });
      return res.redirect(
        303,
        withNotice(`${res.locals.projectBase}/entity`, 'profile-unconfirmed'),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:pid/entity/check', edit, async (req, res, next) => {
    try {
      const back = (notice) =>
        res.redirect(303, withNotice(`${res.locals.projectBase}/entity`, notice));
      if (!jobs) return back('queue-down');
      if (req.project.status === 'archived') return notFound(req, res);
      try {
        await jobs.add(
          'entity.check',
          { orgId: String(req.org.id), projectId: String(req.project.id) },
          { jobId: entityCheckJobId(req.project.id, `m${slotOf(new Date())}`) },
        );
      } catch (err) {
        logger.error(
          { err, projectId: String(req.project.id) },
          'Could not queue the entity check',
        );
        return back('queue-down');
      }
      return back('entity-checking');
    } catch (err) {
      next(err);
    }
  });
}
