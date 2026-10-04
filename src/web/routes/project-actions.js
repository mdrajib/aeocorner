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
import { AUTOFIX_RULES, buildAutofix, isAutofixable, parseExtras } from '../../core/autofix.js';
import { STATUS_LABELS } from '../../core/content-lifecycle.js';
import { DEFAULT_ENGINE_LABELS } from '../../core/narrative.js';
import { effortLabel } from '../../core/ice.js';
import { canShare, NEVER_SHARED, SHARED_FIELDS } from '../../core/proof-share.js';
import { DISMISS_REASONS, timelineFor } from '../../core/recommendation-lifecycle.js';
import { describeRun, isRunning } from '../../core/run-status.js';
import { DomainError } from '../../db/index.js';
import { autofixJobId, fixVerifyJobId } from '../../lib/job-ids.js';
import { notFound } from '../middleware/errors.js';
import { dateLabel, idFrom, text, withNotice } from './project-helpers.js';

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
 *   POST /projects/:pid/actions/:rid/proof/:oid/share    D4  make a proven win's public link (`site.approve`)
 *   POST /projects/:pid/actions/:rid/proof/:oid/unshare  D4  stop sharing it: the link stops working
 *   GET  /projects/:pid/actions/:rid/autofix          D3  preview the exact structured data an auto-fix would put on the home page
 *   POST /projects/:pid/actions/:rid/autofix/approve  approve exactly what was previewed (`site.approve`): queues the write
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

export function actionRoutes(router, { appPage, act, approve, jobs, logger, baseUrl = '' }) {
  const origin = String(baseUrl ?? '').replace(/\/+$/, '');
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
      const shares = new Map(
        (await req.orgDb.proofShares.forRecommendation(req.project.id, rid)).map((s) => [
          String(s.outcomeId),
          s,
        ]),
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
        proofs: proofCards(detail, { brandName }).map((card, i) => {
          const shared = shares.get(card.id);
          return {
            ...card,
            canShare: canShare(detail.outcomes[i]),
            shareUrl: shared ? `${origin}/p/${shared.publicId}` : null,
          };
        }),
        shareFields: SHARED_FIELDS,
        shareNever: NEVER_SHARED,
        canApprove: res.locals.can('site.approve'),
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
        autofix: isAutofixable(rec.ruleCode)
          ? {
              href: `${base}/actions/${rec.id}/autofix`,
              label: AUTOFIX_RULES[rec.ruleCode].action,
              canStart: ['open', 'in_progress'].includes(rec.status),
              change: autofixChange(await req.orgDb.autofix.current(req.project.id, rec.id)),
            }
          : null,
        actionBase: `${base}/actions/${rec.id}`,
        listHref: `${base}/actions`,
        engineNames: DEFAULT_ENGINE_LABELS,
        meta: meta(req, rec.title),
      });
    } catch (err) {
      return next(err);
    }
  });

  // --- D3 Auto-fix: preview and approve -----------------------------------------------------------------
  /** What the screens say about the latest write for a recommendation, in words a customer can read. */
  function autofixChange(change) {
    if (!change) return null;
    const when = change.appliedAt ?? change.approvedAt ?? change.createdAt;
    const states = {
      approved: { tone: 'info', text: 'Approved. Writing it to your site now.' },
      applying: { tone: 'info', text: 'Writing it to your site now.' },
      applied: { tone: 'success', text: 'Written to your site.' },
      failed: { tone: 'danger', text: change.lastError ?? 'It could not be written to your site.' },
    };
    const s = states[change.status];
    return s ? { ...s, status: change.status, when: dateLabel(when) } : null;
  }

  /**
   * Everything the preview and the approval both need, worked out the same way both times, so what a person approves is
   * what they saw: the recommendation, the connected site, the brand, and what the fix would write.
   */
  async function proposalFor(req, rid, input) {
    const detail = await req.orgDb.recommendations.get(req.project.id, rid);
    if (!detail || !isAutofixable(detail.recommendation.ruleCode)) return { detail: null };
    const rec = detail.recommendation;
    const [integration, kit, brand, change] = await Promise.all([
      req.orgDb.integrations.wordpress(req.project.id),
      req.orgDb.brandKits.current(req.project.id),
      brandOf(req),
      req.orgDb.autofix.current(req.project.id, rec.id),
    ]);
    const connected = integration?.status === 'connected';
    const pluginReady = connected && Boolean(integration.config?.pluginConnected);
    const extras = parseExtras({ logoUrl: input.logoUrl, sameAs: input.sameAs });
    let built = null;
    if (pluginReady) {
      const homeUrl = integration.config.siteUrl;
      const identity = kit?.data?.identity ?? {};
      built = buildAutofix({
        ruleCode: rec.ruleCode,
        brand: {
          name: identity.brandName || brand?.name || req.project.name,
          legalName: identity.legalName,
          definition: identity.definition,
        },
        homeUrl,
        domain: req.project.domain,
        extras: extras.ok ? extras : {},
        existingNodes: await req.orgDb.autofix.appliedNodes(
          req.project.id,
          homeUrl.endsWith('/') ? homeUrl : `${homeUrl}/`,
        ),
      });
    }
    return { detail, rec, integration, connected, pluginReady, extras, built, change, brand };
  }

  router.get('/projects/:pid/actions/:rid/autofix', async (req, res, next) => {
    try {
      const rid = idFrom(req.params.rid);
      const p = rid ? await proposalFor(req, rid, req.query) : { detail: null };
      if (!p.detail) return notFound(req, res);
      const base = res.locals.projectBase;
      const change = autofixChange(p.change);
      // The page looks again by itself while the write is under way.
      if (change && ['approved', 'applying'].includes(change.status)) res.locals.refreshSeconds = 5;
      return appPage(res, 'action-autofix', {
        ...tabs(req, res),
        domain: p.brand?.primary_domain ?? req.project.domain ?? '',
        current: 'actions',
        rec: { id: String(p.rec.id), title: p.rec.title, status: p.rec.status },
        fixLabel: AUTOFIX_RULES[p.rec.ruleCode].label,
        pluginReady: p.pluginReady,
        connected: p.connected,
        wordpressHref: `${base}/integrations/wordpress`,
        canApprove: res.locals.can('site.approve'),
        open: ['open', 'in_progress'].includes(p.rec.status),
        inFlight: Boolean(change && ['approved', 'applying'].includes(change.status)),
        change,
        built: p.built?.ok ? p.built : null,
        builtError: p.built && !p.built.ok ? p.built.reason : null,
        code: p.built?.ok ? JSON.stringify(p.built.jsonld, null, 2) : '',
        extrasErrors: p.extras.ok ? {} : p.extras.errors,
        logoUrl: text(req.query.logoUrl, 2000),
        sameAs: text(req.query.sameAs, 4000),
        actionBase: `${base}/actions/${p.rec.id}`,
        meta: meta(req, `Fix: ${AUTOFIX_RULES[p.rec.ruleCode].label}`),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/actions/:rid/autofix/approve', approve, async (req, res, next) => {
    try {
      const rid = idFrom(req.params.rid);
      const p = rid ? await proposalFor(req, rid, req.body) : { detail: null };
      if (!p.detail) return notFound(req, res);
      const base = `${res.locals.projectBase}/actions/${p.rec.id}`;
      const preview = (notice) => {
        const q = new URLSearchParams();
        if (text(req.body.logoUrl, 2000)) q.set('logoUrl', text(req.body.logoUrl, 2000));
        if (text(req.body.sameAs, 4000)) q.set('sameAs', text(req.body.sameAs, 4000));
        const qs = q.toString();
        return res.redirect(303, withNotice(`${base}/autofix${qs ? `?${qs}` : ''}`, notice));
      };
      if (!p.pluginReady) return preview('autofix-no-plugin');
      if (!p.extras.ok || !p.built?.ok) return preview('autofix-invalid');
      // The person approves the data they saw. If anything under it moved (the Brand Kit, what is already on the page),
      // what we would write is no longer what they looked at: show it again instead of sending something new.
      if (text(req.body.hash, 64) !== p.built.hash) return preview('autofix-changed');
      let begun;
      try {
        if (p.rec.status === 'open') {
          await req.orgDb.recommendations.transition(req.project.id, rid, 'in_progress', {
            userId: req.user.id,
          });
        }
        begun = await req.orgDb.autofix.approve(req.project.id, rid, {
          userId: req.user.id,
          targetUrl: p.built.targetUrl,
          jsonld: p.built.jsonld,
          hash: p.built.hash,
          ruleCode: p.rec.ruleCode,
        });
      } catch (err) {
        if (err instanceof DomainError) {
          if (err.code === 'ALREADY_APPROVED') return preview('autofix-already');
          if (['PLUGIN_NOT_CONNECTED', 'WORDPRESS_NOT_CONNECTED'].includes(err.code))
            return preview('autofix-no-plugin');
          if (['STALE_STATUS', 'INVALID_TRANSITION'].includes(err.code))
            return preview('action-stale');
          if (err.code === 'RECOMMENDATION_NOT_FOUND') return notFound(req, res);
        }
        throw err;
      }
      try {
        await jobs.add(
          'autofix.apply',
          {
            orgId: String(req.org.id),
            projectId: String(req.project.id),
            siteChangeId: String(begun.siteChangeId),
          },
          { jobId: autofixJobId(begun.siteChangeId) },
        );
      } catch (err) {
        logger.error({ err, recommendationId: String(rid) }, 'Could not queue the auto-fix');
        await req.orgDb.autofix.finish(req.project.id, begun.siteChangeId, {
          ok: false,
          error: 'We could not start that just now. Nothing was changed on your site.',
        });
        return preview('autofix-queue-failed');
      }
      return res.redirect(303, withNotice(`${base}/autofix`, 'autofix-applying'));
    } catch (err) {
      return next(err);
    }
  });

  // --- D4 Share a proven win ----------------------------------------------------------------------------
  for (const move of ['share', 'unshare']) {
    router.post(
      `/projects/:pid/actions/:rid/proof/:oid/${move}`,
      approve,
      async (req, res, next) => {
        try {
          const rid = idFrom(req.params.rid);
          const oid = idFrom(req.params.oid);
          if (!rid || !oid) return notFound(req, res);
          const back = (notice) =>
            res.redirect(
              303,
              withNotice(`${res.locals.projectBase}/actions/${req.params.rid}`, notice),
            );
          try {
            if (move === 'share') {
              await req.orgDb.proofShares.share(req.project.id, rid, oid, { userId: req.user.id });
              return back('proof-shared');
            }
            await req.orgDb.proofShares.revoke(req.project.id, rid, oid);
            return back('proof-unshared');
          } catch (err) {
            if (err instanceof DomainError) {
              if (err.code === 'NOT_SHAREABLE') return back('proof-not-shareable');
              if (['OUTCOME_NOT_FOUND', 'PROJECT_NOT_IN_ORG'].includes(err.code))
                return notFound(req, res);
            }
            throw err;
          }
        } catch (err) {
          return next(err);
        }
      },
    );
  }

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
