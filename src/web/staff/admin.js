import express, { Router } from 'express';
import {
  METER_LABELS,
  byOrganization,
  byPlan,
  costPerAnswer,
  spendAnomaly,
  usd,
} from '../../core/admin-costs.js';
import { STATUS_TEXT, summarizeHealth } from '../../core/admin-health.js';
import { FLAG_KEY, KNOWN_FLAGS } from '../../core/flags.js';
import { createJobClient } from '../../lib/jobs.js';
import { extractAnswerJobId } from '../../lib/job-ids.js';
import { csrfProtection, csrfToken } from '../auth/csrf.js';
import { notFound } from '../middleware/errors.js';
import { listFailedJobs, retryFailedJob } from './jobs.js';

/**
 * The staff console's modules (Milestone 8, tasks 8.17–8.23; ADMIN_OPERATIONS §3). Everything here sits behind one wall,
 * set up once at the top: Cloudflare Access (outside this file), then a staff Clerk session with a second factor and an
 * active staff row (`staffAuth.identify`), then the role each module needs (`staffAuth.requireRole`; a super admin passes all).
 *
 *   /costs       cost and margin (finance, ops)
 *   /providers   provider health (ops)
 *   /jobs        failed jobs, with retry (ops)
 *   /review      the extraction review queue (reviewer)
 *   /flags       feature flags (super admin only)
 *   /audit       what staff have done (super admin only)
 *
 * Every change is written to `admin_audit_log` BEFORE it is made, by `audited()`, and refused if that write fails: there
 * are no unrecorded staff actions. A test walks the router and fails if a write route is not wrapped, or a route is not
 * behind the wall.
 */

export const MODULES = Object.freeze([
  {
    id: 'costs',
    href: '/costs',
    label: 'Cost and margin',
    icon: 'money',
    roles: ['finance', 'ops'],
    text: 'What the system costs, by provider and by customer, and the margin on each plan.',
  },
  {
    id: 'providers',
    href: '/providers',
    label: 'Provider health',
    icon: 'bolt',
    roles: ['ops'],
    text: 'Error rates, speed and circuit breakers for every data provider.',
  },
  {
    id: 'jobs',
    href: '/jobs',
    label: 'Failed jobs',
    icon: 'alert',
    roles: ['ops'],
    text: 'Jobs that ran out of attempts, with a retry button. The full queue board is under Queues.',
  },
  {
    id: 'review',
    href: '/review',
    label: 'Review queue',
    icon: 'eye',
    roles: ['reviewer'],
    text: 'Answers where the two readers disagree, and customers’ “That’s not us” reports.',
  },
  {
    id: 'flags',
    href: '/flags',
    label: 'Feature flags',
    icon: 'flag',
    roles: [],
    text: 'Switch a feature on or off for everyone, or for one customer.',
  },
  {
    id: 'audit',
    href: '/audit',
    label: 'Audit log',
    icon: 'shield',
    roles: [],
    text: 'Everything staff have changed: who, what, when, and why.',
  },
]);

/** Can a staff member with these roles open this module? A super admin can open every one; `roles: []` is super admin only. */
export const canOpen = (staffRoles, module) =>
  staffRoles.includes('super_admin') || module.roles.some((r) => staffRoles.includes(r));

const DAY_MS = 86_400_000;
const ID = /^[1-9]\d{0,18}$/;
const idFrom = (v) => (ID.test(String(v)) ? BigInt(v) : null);
const text = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const RESOLUTIONS = ['extraction_correct', 'extraction_wrong', 'rule_fixed', 'no_action'];

/** The sidebar for a staff member: the overview, the queue board (where there is one), and the modules their roles open. */
export function navFor(staff, path, hasQueues) {
  return [
    { href: '/', label: 'Overview', icon: 'chart', current: path === '/' },
    ...(hasQueues && (staff.roles.includes('super_admin') || staff.roles.includes('ops'))
      ? [{ href: '/queues', label: 'Queues', icon: 'list', current: path.startsWith('/queues') }]
      : []),
    ...MODULES.filter((m) => canOpen(staff.roles, m)).map((m) => ({
      href: m.href,
      label: m.label,
      icon: m.icon,
      current: path === m.href || path.startsWith(`${m.href}/`),
    })),
  ];
}

export function adminModules({ config, db, staffAuth, queues = null, logger }) {
  const router = Router();
  // The wall: nothing under these paths is reachable without a staff session that has a second factor and an active row.
  router.use(
    MODULES.map((m) => m.href),
    staffAuth.identify,
  );

  const jobs = queues ? createJobClient(queues) : null;
  const form = [
    express.urlencoded({ extended: false, limit: '8kb' }),
    csrfProtection({ secret: config.appSecret }),
  ];

  const page = (req, res, view, locals = {}, status) =>
    res.page(
      view,
      {
        showAuditBand: false,
        staff: req.staff,
        project: { name: 'Staff console' },
        csrfToken: csrfToken(config.appSecret, req.session.sessionId),
        flash: locals.flash ?? [],
        nav: navFor(req.staff, req.path, Boolean(queues)),
        meta: {
          title: `${locals.title ?? 'Staff'} | AEO Corner staff`,
          description: 'Staff console.',
          noindex: true,
        },
        ...locals,
      },
      { layout: 'app', ...(status ? { status } : {}) },
    );

  /**
   * A write: recorded first, then done. If the record cannot be written the action is refused. `describe(req)` says what is
   * about to happen (`action`, `targetType`, `targetId`, `orgId`, `reason`, `afterState`); nothing secret goes in it.
   */
  const audited = (describe, handler) => async (req, res, next) => {
    try {
      await db.staff.audit({
        staffId: req.staff.id,
        ...describe(req),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
    } catch (err) {
      logger.error({ err }, 'Refusing a staff action: it could not be written to the audit log');
      return next(err);
    }
    return handler(req, res, next);
  };
  const flash = (tone, message) => [{ tone, text: message }];
  const NOTICES = {
    'job-retried': ['success', 'The job is queued to run again.'],
    'job-gone': ['warning', 'That job is not there any more (it may have been retried already).'],
    'review-taken': ['success', 'It is yours. Decide it below.'],
    'review-resolved': ['success', 'Decided and saved.'],
    'review-rejected': ['success', 'Turned down, with your reason.'],
    'review-alias': [
      'success',
      'Added. The next time answers are read it applies; ask for this one to be read again to see it now.',
    ],
    'review-alias-exists': ['info', 'That was already there.'],
    'review-reextract': ['success', 'The answer will be read again in a moment.'],
    'review-reextract-no': [
      'warning',
      'That answer was never collected, so there is nothing to read again.',
    ],
    'review-golden': [
      'success',
      'Marked for the golden set. It joins evals/extraction in the next export.',
    ],
    'review-invalid': ['danger', 'That was not understood, so nothing was changed.'],
    'review-late': ['warning', 'Someone else decided it first, so nothing was changed.'],
    'flag-saved': ['success', 'Saved.'],
    'flag-invalid': [
      'danger',
      'That was not understood, so nothing was changed. A reason of at least five characters is needed.',
    ],
    'flag-missing': ['warning', 'That flag or organization was not found.'],
  };
  const notice = (req) => {
    const n = typeof req.query.notice === 'string' && NOTICES[req.query.notice];
    return n ? flash(n[0], n[1]) : [];
  };
  const here = (path, n) => `${path}?notice=${n}`;

  // --- Cost and margin (8.17) --------------------------------------------------------------------------------
  router.get('/costs', staffAuth.requireRole('finance', 'ops'), async (req, res, next) => {
    try {
      const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
      const now = new Date();
      const since = new Date(now.getTime() - days * DAY_MS);
      const [meters, daily, orgs, audits, answers] = await Promise.all([
        db.system.costs.byMeter({ since }),
        db.system.costs.daily({ since: new Date(now.getTime() - 14 * DAY_MS) }),
        db.system.costs.byOrganization({ since }),
        db.system.costs.auditsMicros({ since }),
        db.system.costs.answers({ since }),
      ]);
      const total = meters.reduce((n, m) => n + m.costMicros, 0);
      const todayKey = now.toISOString().slice(0, 10);
      const todayMicros = daily.find((d) => d.day === todayKey)?.costMicros ?? 0;
      const orgRows = byOrganization(orgs);
      page(req, res, 'staff-costs', {
        title: 'Cost and margin',
        flash: notice(req),
        days,
        ranges: [7, 30, 90].map((d) => ({ days: d, current: d === days })),
        total: usd(total),
        todayText: usd(todayMicros),
        anomaly: spendAnomaly({
          todayMicros,
          priorMicros: daily.filter((d) => d.day < todayKey).map((d) => d.costMicros),
        }),
        perAnswer: costPerAnswer({
          costMicros: meters
            .filter((m) => ['answer_collect', 'serp', 'llm_extract'].includes(m.meter))
            .reduce((n, m) => n + m.costMicros, 0),
          answers,
        }),
        answers,
        auditsText: usd(audits),
        meters: meters.map((m) => ({
          label: METER_LABELS[m.meter] ?? m.meter,
          provider: m.providerCode,
          model: m.model ?? '',
          calls: m.calls,
          cost: usd(m.costMicros, 2),
          share: total > 0 ? `${Math.round((m.costMicros / total) * 100)}%` : '—',
        })),
        plans: byPlan(orgs).map((p) => ({
          plan: p.planCode,
          orgs: p.orgs,
          paying: p.paying,
          revenue: usd(p.revenueMicros),
          cost: usd(p.costMicros),
          margin: p.margin.text,
          marginState: p.margin.state,
        })),
        orgs: orgRows.slice(0, 25).map((o) => ({
          name: o.orgName,
          plan: o.planCode ?? '—',
          status: o.billingStatus,
          cost: usd(o.costMicros),
          margin: o.margin.text,
          marginState: o.margin.state,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Provider health (8.18) --------------------------------------------------------------------------------
  router.get('/providers', staffAuth.requireRole('ops'), async (req, res, next) => {
    try {
      const now = new Date();
      const buckets = await db.system.providers.buckets({
        since: new Date(now.getTime() - DAY_MS),
      });
      page(req, res, 'staff-providers', {
        title: 'Provider health',
        rows: summarizeHealth(buckets, now).map((r) => ({
          ...r,
          statusText: STATUS_TEXT[r.status].text,
          statusTone: STATUS_TEXT[r.status].tone,
          p95: r.p95Ms ? `${r.p95Ms} ms` : '—',
          cost: usd(Math.round(r.costUsd * 1_000_000), 2),
          lastSeenText: r.lastSeen.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        })),
        redisReady: Boolean(queues),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Failed jobs, with retry (8.19) ------------------------------------------------------------------------
  router.get('/jobs', staffAuth.requireRole('ops'), async (req, res, next) => {
    try {
      page(req, res, 'staff-jobs', {
        title: 'Failed jobs',
        flash: notice(req),
        available: Boolean(queues),
        failed: queues ? await listFailedJobs(queues) : [],
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/jobs/retry',
    staffAuth.requireRole('ops'),
    ...form,
    audited(
      (req) => ({
        action: 'job.retry',
        targetType: 'job',
        targetId: `${text(req.body.queue, 32)}/${text(req.body.id, 100)}`.slice(0, 64),
        afterState: { queue: text(req.body.queue, 32), jobId: text(req.body.id, 100) },
      }),
      async (req, res, next) => {
        try {
          if (!queues) return res.redirect(303, here('/jobs', 'job-gone'));
          const done = await retryFailedJob(queues, {
            queue: text(req.body.queue, 32),
            id: text(req.body.id, 200),
          });
          return res.redirect(303, here('/jobs', done ? 'job-retried' : 'job-gone'));
        } catch (err) {
          return next(err);
        }
      },
    ),
  );

  // --- The extraction review queue (8.20) --------------------------------------------------------------------
  const reviewer = staffAuth.requireRole('reviewer');
  router.get('/review', reviewer, async (req, res, next) => {
    try {
      const source = ['disagreement', 'customer_report', 'low_confidence', 'staff'].includes(
        req.query.source,
      )
        ? req.query.source
        : null;
      const [items, counts] = await Promise.all([
        db.system.review.list({ source }),
        db.system.review.counts(),
      ]);
      page(req, res, 'staff-review', {
        title: 'Review queue',
        flash: notice(req),
        items,
        counts,
        source,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/review/:id', reviewer, async (req, res, next) => {
    try {
      const id = idFrom(req.params.id);
      const item = id ? await db.system.review.get(id) : null;
      if (!item) return notFound(req, res);
      return page(req, res, 'staff-review-item', {
        title: 'Review',
        flash: notice(req),
        item,
        resolutions: RESOLUTIONS,
        queued: Boolean(jobs),
      });
    } catch (err) {
      return next(err);
    }
  });

  /** Every review write: one audited route per action, each naming the item and what was decided, never the customer. */
  const reviewWrite = (action, perform) =>
    router.post(
      `/review/:id/${action}`,
      reviewer,
      ...form,
      audited(
        (req) => ({
          action: `review.${action}`,
          targetType: 'review_item',
          targetId: req.params.id,
          reason: text(req.body.note, 500) || null,
          afterState: {
            resolution: text(req.body.resolution, 40) || undefined,
            kind: text(req.body.kind, 10) || undefined,
          },
        }),
        async (req, res, next) => {
          try {
            const id = idFrom(req.params.id);
            if (!id || !(await db.system.review.get(id))) return notFound(req, res);
            const back = `/review/${req.params.id}`;
            return res.redirect(303, here(back, await perform({ req, id })));
          } catch (err) {
            return next(err);
          }
        },
      ),
    );

  reviewWrite('take', async ({ req, id }) =>
    (await db.system.review.assign(id, req.staff.id)) ? 'review-taken' : 'review-late',
  );
  reviewWrite('resolve', async ({ req, id }) => {
    const resolution = text(req.body.resolution, 40);
    if (!RESOLUTIONS.includes(resolution)) return 'review-invalid';
    const done = await db.system.review.resolve(id, {
      staffId: req.staff.id,
      resolution,
      note: text(req.body.note, 1000),
    });
    return done ? 'review-resolved' : 'review-late';
  });
  reviewWrite('reject', async ({ req, id }) => {
    const note = text(req.body.note, 1000);
    if (note.length < 5) return 'review-invalid';
    return (await db.system.review.reject(id, { staffId: req.staff.id, note }))
      ? 'review-rejected'
      : 'review-late';
  });
  reviewWrite('alias', async ({ req, id }) => {
    const kind = req.body.kind === 'exclude' ? 'exclude' : req.body.kind === 'name' ? 'name' : null;
    if (!kind) return 'review-invalid';
    try {
      const added = await db.system.review.addAlias(id, {
        staffId: req.staff.id,
        kind,
        value: text(req.body.value, 255),
      });
      if (!added) return 'review-alias-exists';
      await db.system.review.resolve(id, {
        staffId: req.staff.id,
        resolution: kind === 'name' ? 'alias_added' : 'exclusion_added',
        note: text(req.body.note, 1000),
      });
      return 'review-alias';
    } catch (err) {
      if (err?.code === 'INVALID_VALUE' || err?.code === 'NO_ENTITY') return 'review-invalid';
      throw err;
    }
  });
  reviewWrite('reextract', async ({ id }) => {
    const ids = await db.system.review.requestReextract(id);
    if (!ids) return 'review-reextract-no';
    if (jobs) {
      await jobs.add(
        'extract.answer',
        { orgId: String(ids.orgId), snapshotId: String(ids.snapshotId) },
        { jobId: extractAnswerJobId(ids.snapshotId, `review-${id}`) },
      );
    }
    return 'review-reextract';
  });
  reviewWrite('golden', async ({ id }) =>
    (await db.system.review.markGolden(id)) ? 'review-golden' : 'review-late',
  );

  // --- Feature flags (8.21) ----------------------------------------------------------------------------------
  const superOnly = staffAuth.requireRole();
  router.get('/flags', superOnly, async (req, res, next) => {
    try {
      await db.system.flags.ensureKnown();
      const flags = await db.system.flags.list();
      page(req, res, 'staff-flags', {
        title: 'Feature flags',
        flash: notice(req),
        flags: flags.map((f) => ({ ...f, read: Object.hasOwn(KNOWN_FLAGS, f.key) })),
      });
    } catch (err) {
      next(err);
    }
  });

  const flagWrite = (action, describe, perform) =>
    router.post(
      `/flags/${action}`,
      superOnly,
      ...form,
      audited(
        (req) => ({
          action: `flag.${action}`,
          targetType: 'feature_flag',
          targetId: text(req.body.key, 64),
          reason: text(req.body.reason, 500) || null,
          ...describe(req),
        }),
        async (req, res, next) => {
          try {
            const key = text(req.body.key, 64);
            const reason = text(req.body.reason, 500);
            if (!FLAG_KEY.test(key) || reason.length < 5)
              return res.redirect(303, here('/flags', 'flag-invalid'));
            const ok = await perform({ req, key });
            return res.redirect(303, here('/flags', ok === false ? 'flag-missing' : 'flag-saved'));
          } catch (err) {
            return next(err);
          }
        },
      ),
    );
  flagWrite(
    'default',
    (req) => ({ afterState: { enabledDefault: req.body.enabled === 'on' } }),
    async ({ req, key }) => {
      const existing = (await db.system.flags.list()).find((f) => f.key === key);
      return db.system.flags.set({
        key,
        description: existing?.description ?? text(req.body.description, 255) ?? key,
        enabledDefault: req.body.enabled === 'on',
        staffId: req.staff.id,
      });
    },
  );
  flagWrite(
    'override',
    (req) => ({
      orgId: null,
      afterState: { organization: text(req.body.org, 26), enabled: req.body.enabled === 'on' },
    }),
    ({ req, key }) =>
      db.system.flags.setOverride({
        key,
        orgPublicId: text(req.body.org, 26),
        enabled: req.body.enabled === 'on',
        staffId: req.staff.id,
      }),
  );
  flagWrite(
    'clear',
    (req) => ({ afterState: { organization: text(req.body.org, 26), cleared: true } }),
    ({ req, key }) => db.system.flags.clearOverride({ key, orgPublicId: text(req.body.org, 26) }),
  );

  // --- The audit log ----------------------------------------------------------------------------------------
  router.get('/audit', superOnly, async (req, res, next) => {
    try {
      const entries = await db.staff.recentAudit({ limit: 100 });
      page(req, res, 'staff-audit', {
        title: 'Audit log',
        entries: entries.map((e) => ({
          when: e.created_at.toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
          staff: e.staff_name ?? String(e.staff_user_id),
          action: e.action,
          target: [e.target_type, e.target_id].filter(Boolean).join(' '),
          reason: e.reason ?? '',
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
