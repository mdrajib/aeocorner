import { parseSettings, REJECT_REASONS } from '../../core/autopilot.js';
import { listView, lastTickText, settingsView, standing } from '../../core/autopilot-view.js';
import { DomainError } from '../../db/index.js';
import { notFound } from '../middleware/errors.js';
import { text, withNotice } from './project-helpers.js';

/**
 * The Autopilot screen (Milestone 15, UI_DESIGN D9; ADR-0016): what it prepared this week for a person to approve, what it may
 * do, and the switches. Registers on the project router.
 *
 *   GET  /projects/:pid/autopilot                  the inbox ("Ready for you"), the settings, what the last tick did
 *   POST /projects/:pid/autopilot/settings         turn it on or off, choose what it may prepare, the weekly draft budget
 *                                                  (`autopilot.manage`: owner and admin)
 *   POST /projects/:pid/autopilot/pause|resume     the project-level pause (`autopilot.manage`)
 *   POST /projects/:pid/autopilot/:iid/reject      turn an item down, with a reason (`site.approve`)
 *
 * There is NO approve route here, on purpose. Approving is the Action Center's: the item links to the screen that shows the exact
 * code or the draft, and that screen's approval carries the fingerprint or the pinned revision. Reading is for anyone who can see
 * the project.
 */
export function autopilotRoutes(router, { db, appPage, approve, manage }) {
  const base = (res) => `${res.locals.projectBase}/autopilot`;

  router.get('/projects/:pid/autopilot', async (req, res, next) => {
    try {
      const projectId = req.project.id;
      // Record what people did since the last tick (an item they approved on its own screen), so the list is true.
      await req.orgDb.autopilot.settle(projectId);
      const [settings, flagOn, planAllows, ready, decided] = await Promise.all([
        req.orgDb.autopilot.settings(projectId),
        db.system.flags.isEnabled('autopilot', req.org.id),
        req.orgDb.billing.featureAllowed('autopilot'),
        req.orgDb.autopilot.inbox(projectId),
        req.orgDb.autopilot.list(projectId, {
          statuses: ['approved', 'rejected', 'withdrawn'],
          limit: 30,
        }),
      ]);
      const content = new Map();
      for (const item of ready) {
        if (item.kind === 'content' && item.contentItemId != null) {
          const row = await req.orgDb.content.get(projectId, String(item.contentItemId));
          if (row) content.set(String(item.contentItemId), row);
        }
      }
      const view = listView({ ready, decided, content, projectBase: res.locals.projectBase });
      // A draft that is still being written changes on its own: the page looks again until it is ready.
      if (view.ready.some((r) => r.waiting)) res.locals.refreshSeconds = 20;
      appPage(res, 'autopilot', {
        standing: standing({ settings, planAllows, flagOn }),
        lastTick: lastTickText(settings),
        settings: settingsView(settings),
        view,
        rejectReasons: Object.entries(REJECT_REASONS).map(([value, label]) => ({ value, label })),
        canManage: res.locals.can('autopilot.manage'),
        canDecide: res.locals.can('site.approve'),
        planAllows,
        errors: {},
        meta: {
          title: `Autopilot · ${req.project.name} | AEO Corner`,
          description:
            'Fixes and drafts prepared for you each week. You review and approve; nothing changes without you.',
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:pid/autopilot/settings', manage, async (req, res, next) => {
    try {
      const parsed = parseSettings(req.body);
      if (!parsed.ok) return res.redirect(303, withNotice(base(res), 'autopilot-invalid'));
      if (parsed.value.enabled && !(await req.orgDb.billing.featureAllowed('autopilot'))) {
        return res.redirect(303, withNotice(base(res), 'autopilot-plan'));
      }
      await req.orgDb.autopilot.saveSettings(req.project.id, parsed.value, { userId: req.user.id });
      return res.redirect(303, withNotice(base(res), 'autopilot-saved'));
    } catch (err) {
      next(err);
    }
  });

  for (const [path, paused, notice] of [
    ['pause', true, 'autopilot-paused'],
    ['resume', false, 'autopilot-resumed'],
  ]) {
    router.post(`/projects/:pid/autopilot/${path}`, manage, async (req, res, next) => {
      try {
        await req.orgDb.autopilot.setPaused(req.project.id, paused, { userId: req.user.id });
        return res.redirect(303, withNotice(base(res), notice));
      } catch (err) {
        next(err);
      }
    });
  }

  router.post('/projects/:pid/autopilot/:iid/reject', approve, async (req, res, next) => {
    try {
      const item = await req.orgDb.autopilot.get(req.project.id, req.params.iid);
      if (!item) return notFound(req, res);
      const reason = text(req.body.reason, 20);
      if (!Object.hasOwn(REJECT_REASONS, reason)) {
        return res.redirect(303, withNotice(base(res), 'autopilot-reason'));
      }
      try {
        await req.orgDb.autopilot.reject(req.project.id, item.publicId, {
          userId: req.user.id,
          reason,
          note: text(req.body.note, 500),
        });
      } catch (err) {
        if (err instanceof DomainError && ['STALE_STATUS', 'ITEM_NOT_FOUND'].includes(err.code)) {
          return res.redirect(303, withNotice(base(res), 'autopilot-stale'));
        }
        throw err;
      }
      // A draft nobody wants stays off the board. One that already moved on (approved, say) is left as it is.
      if (item.kind === 'content' && item.contentItemId != null) {
        await req.orgDb.content.archive(req.project.id, item.contentItemId).catch(() => {});
      }
      return res.redirect(303, withNotice(base(res), 'autopilot-rejected'));
    } catch (err) {
      next(err);
    }
  });
}
