import { Router } from 'express';
import { dnsRecord, fileProof } from '../../core/domain-verification.js';
import {
  COUNTRIES,
  LANGUAGES,
  checkProjectFields,
  normalizeEntityName,
} from '../../core/project-rules.js';
import { fromLiteKit } from '../../core/brand-kit.js';
import { checkCoverage } from '../../core/prompt-rules.js';
import { describeRun, isRunning, runNowLabel } from '../../core/run-status.js';
import { requestScan } from '../../crawler/request-scan.js';
import { DomainError } from '../../db/index.js';
import { brandKitJobId, slotOf } from '../../lib/job-ids.js';
import { isUlid } from '../../lib/ulid.js';
import { normalizeWebsite } from '../../lib/url.js';
import { clearAuditClaim, readAuditClaim } from '../auth/audit-claim.js';
import { notFound } from '../middleware/errors.js';
import { actionRoutes } from './project-actions.js';
import { contentRoutes } from './project-content.js';
import { brandRoutes } from './project-brand.js';
import { dashboardRoutes } from './project-dashboard.js';
import { dateLabel, idFrom, returnPath, withNotice } from './project-helpers.js';
import { questionRoutes } from './project-questions.js';
import { setupRoutes } from './project-setup.js';
import { trackingRoutes } from './project-tracking.js';
import { trafficRoutes } from './project-traffic.js';

/**
 * Projects inside one organization (Milestone 3): the list, "create a project", and one project's page.
 * Mounted under `/app/o/:org` after `loadOrg`, so `req.orgDb`, `req.membership` and `res.locals.can` exist.
 *
 * A member limited to selected projects (an agency client seat) gets a plain 404 for any other project, the
 * same answer as for a project that doesn't exist.
 */

const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const options = (table) => Object.entries(table).map(([value, label]) => ({ value, label }));
export const COUNTRY_OPTIONS = options(COUNTRIES);
export const LANGUAGE_OPTIONS = options(LANGUAGES);

export function projectRoutes({
  db,
  jobs,
  auth,
  logger,
  appPage,
  verifier = null,
  content = null,
  google = null,
  config = null,
}) {
  const router = Router({ mergeParams: true });
  const create = auth.requirePermission('project.create');

  /** The IDs a client seat may see, or null for a member who sees every project. */
  async function visibleIds(req) {
    if (req.membership.project_access !== 'selected') return null;
    const members = await req.orgDb.memberships.list();
    return members.find((m) => m.id === req.membership.id)?.projectIds ?? [];
  }

  const formMeta = (req) => ({
    title: `New project · ${req.org.name} | AEO Corner`,
    description: 'Create a project.',
  });

  /**
   * The free audit this visitor pressed "Track this every week" on, if it is theirs to use: finished, verified, and not
   * already owned by another organization. Anything else is simply not offered, and the form is blank.
   */
  async function claimedAudit(req) {
    const publicId = readAuditClaim(req);
    if (!publicId) return null;
    const audit = await db.audits.getByPublicId(publicId);
    if (!audit || !['complete', 'partial'].includes(audit.status)) return null;
    if (audit.org_id !== null && audit.org_id !== req.org.id) return null;
    return audit;
  }

  /**
   * The audit's lite Brand Kit as the project's first version, and its suggested competitors as suggestions. Nothing here
   * may lose the project: a failure is logged and the setup steps are simply blank. Returns the kit version made (0 = none).
   */
  async function prefillFromAudit(req, project, audit) {
    try {
      let version = 0;
      const kit = fromLiteKit(audit.brand_kit_lite, { domain: project.domain });
      if (kit) {
        // The name the customer confirmed on the form is the brand's name; the audit's wording stays as an alias.
        const found = audit.brand_kit_lite?.brand_name;
        kit.identity.brandName = project.name;
        if (found && normalizeEntityName(found) !== normalizeEntityName(project.name)) {
          kit.identity.aliases = [...new Set([found, ...kit.identity.aliases])].slice(0, 20);
        }
        const saved = await req.orgDb.brandKits.save(project.id, {
          kit,
          source: 'audit',
          expectedVersion: null,
          actorUserId: req.user.id,
        });
        version = saved.version;
      }
      for (const c of Array.isArray(audit.suggested_competitors)
        ? audit.suggested_competitors
        : []) {
        try {
          await req.orgDb.entities.addCompetitor(
            project.id,
            {
              name: c?.name,
              primaryDomain: c?.domain ?? null,
              source: 'audit',
              status: 'suggested',
            },
            { actorUserId: req.user.id },
          );
        } catch (err) {
          if (!(err instanceof DomainError)) throw err; // a repeat or a name we can't use: skip it
        }
      }
      return version;
    } catch (err) {
      logger.error(
        { err, projectId: String(project.id) },
        'Could not prefill the project from its audit',
      );
      return 0;
    }
  }

  const form = (req, res, { values = {}, errors = {}, status, audit = null } = {}) =>
    appPage(
      res,
      'project-new',
      {
        values: { country: 'US', language: 'en', ...values },
        fromAudit: audit ? audit.domain : null,
        errors,
        countries: COUNTRY_OPTIONS,
        languages: LANGUAGE_OPTIONS,
        meta: formMeta(req),
      },
      status ? { status } : {},
    );

  router.get('/projects/new', create, async (req, res, next) => {
    try {
      const audit = await claimedAudit(req);
      const values = audit
        ? { website: audit.domain, name: audit.brand_kit_lite?.brand_name ?? '' }
        : {};
      return form(req, res, { values, audit });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects', create, async (req, res, next) => {
    try {
      const values = {
        website: text(req.body.website, 300),
        name: text(req.body.name, 128),
        country: text(req.body.country, 2),
        language: text(req.body.language, 16),
        city: text(req.body.city, 128),
      };
      const errors = {};
      // The plan's number of projects. Archiving one makes room.
      const room = await req.orgDb.billing.canAdd('projects');
      if (!room.allowed) {
        return res.redirect(303, `${res.locals.orgBase}/billing?notice=plan-limit-projects`);
      }
      const audit = await claimedAudit(req);
      const site = normalizeWebsite(values.website);
      if (!site.ok) errors.website = 'Enter your website, like acme-dental.com.';
      const checked = checkProjectFields({ ...values, website: undefined });
      if (!checked.ok) Object.assign(errors, checked.errors);
      if (Object.keys(errors).length) return form(req, res, { values, errors, status: 422, audit });

      const domain = site.domain.replace(/^www\./, '');
      let project;
      try {
        project = await req.orgDb.projects.create({
          ...checked.value,
          domain,
          // Only when the website is the one that was audited: a different site is a different project.
          ...(audit && audit.domain === domain ? { sourceAuditPublicId: audit.public_id } : {}),
          createdByUserId: req.user.id,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'DOMAIN_TAKEN') {
          return form(req, res, {
            values,
            errors: { website: 'This organization already has a project for that website.' },
            status: 422,
            audit,
          });
        }
        if (err instanceof DomainError && err.code === 'INVALID_DOMAIN') {
          return form(req, res, {
            values,
            errors: { website: 'Enter your website, like acme-dental.com.' },
            status: 422,
            audit,
          });
        }
        throw err;
      }

      // A project made from an audit starts with what the audit found: its Brand Kit and the competitors it suggested.
      const fromAudit = Boolean(project.source_audit_id && audit);
      const prefilledVersion = fromAudit ? await prefillFromAudit(req, project, audit) : 0;
      if (fromAudit) clearAuditClaim(res);

      // The first readiness scan starts at once so the checklist is ready when the setup steps are done. A queue
      // that is down must not lose the project: the scan can be started again from the project page.
      if (jobs) {
        try {
          await requestScan(
            { db, jobs },
            { orgId: req.org.id, projectId: project.id, trigger: 'manual' },
          );
        } catch (err) {
          logger.error({ err, projectId: String(project.id) }, 'Could not queue the first scan');
        }
        // The Brand Kit is drafted from the website at the same time, so the first setup step is pre-filled. A
        // project made from an audit already has the audit's kit (version 1) and the reading builds on it.
        try {
          const baseVersion = prefilledVersion;
          await jobs.add(
            'brandkit.extract',
            { orgId: String(req.org.id), projectId: String(project.id), baseVersion },
            { jobId: brandKitJobId(project.id, baseVersion, slotOf(new Date())) },
          );
        } catch (err) {
          logger.error(
            { err, projectId: String(project.id) },
            'Could not queue the Brand Kit reading',
          );
        }
      }
      return res.redirect(
        303,
        `${res.locals.orgBase}/projects/${project.public_id}/setup/brand?notice=project-created`,
      );
    } catch (err) {
      next(err);
    }
  });

  // --- One project ----------------------------------------------------------------------------------------
  router.param('pid', async (req, res, next, pid) => {
    try {
      if (!isUlid(pid)) return notFound(req, res);
      const project = await req.orgDb.projects.getByPublicId(pid);
      const only = project ? await visibleIds(req) : null;
      if (!project || (only && !only.includes(project.id))) return notFound(req, res);
      req.project = project;
      res.locals.project = {
        name: project.name,
        publicId: project.public_id,
        status: project.status,
      };
      res.locals.projectBase = `${res.locals.orgBase}/projects/${project.public_id}`;
      return next();
    } catch (err) {
      return next(err);
    }
  });

  const edit = auth.requirePermission('strategy.edit');
  // Marking a fix done, like writing content, is an editor's job (permissions.js).
  const act = auth.requirePermission('content.create');
  // Approving a draft and publishing it to the customer's site, and connecting their WordPress, are bigger moves.
  const approve = auth.requirePermission('site.approve');
  const manage = auth.requirePermission('integrations.manage');

  async function renderProject(req, res, { verifyResult = null, status } = {}) {
    const [entities, engines, proof, kit, active, runs, usage] = await Promise.all([
      req.orgDb.entities.list(req.project.id),
      req.orgDb.projectEngines.list(req.project.id),
      req.orgDb.projects.verification(req.project.id),
      req.orgDb.brandKits.current(req.project.id),
      req.orgDb.prompts.list(req.project.id, { status: 'active' }),
      req.orgDb.runs.recent(req.project.id, { limit: 1 }),
      req.orgDb.quota.runNowUsage(),
    ]);
    const latest = runs[0] ?? null;
    const lastRun = describeRun(latest);
    // A running check refreshes the page by itself, for as long as it is plausibly still running.
    if (lastRun.running) res.locals.refreshSeconds = 10;
    appPage(
      res,
      'project-home',
      {
        entities,
        engines,
        verification: {
          verifiedAt: proof.verifiedAt,
          method: proof.method,
          dns: dnsRecord(req.project.domain, proof.token),
          file: fileProof(req.project.domain, proof.token),
          result: verifyResult,
          available: Boolean(verifier),
        },
        // Setup is open until there is a Brand Kit and a question set that meets the coverage rules.
        setupOpen:
          req.project.status === 'onboarding' &&
          (!kit || !checkCoverage(active, { hasCity: Boolean(req.project.city) }).ok),
        lastRun: {
          ...lastRun,
          finishedLabel: lastRun.finishedAt ? dateLabel(lastRun.finishedAt) : null,
        },
        runNow: {
          label: runNowLabel(usage),
          left: Math.max(0, usage.limit - usage.used),
          inProgress: isRunning(latest),
        },
        tracking: req.project.status === 'active',
        countryName: COUNTRIES[req.project.country] ?? req.project.country,
        languageName: LANGUAGES[req.project.language] ?? req.project.language,
        meta: {
          title: `${req.project.name} · ${req.org.name} | AEO Corner`,
          description: 'Your project.',
        },
      },
      status ? { status } : {},
    );
  }

  router.get('/projects/:pid', async (req, res, next) => {
    try {
      await renderProject(req, res);
    } catch (err) {
      next(err);
    }
  });

  // Checking costs us a DNS lookup and a fetch, so a project can be checked once every few seconds, not in a loop.
  const lastCheck = new Map();
  const CHECK_GAP_MS = 5_000;

  router.post('/projects/:pid/verify', edit, async (req, res, next) => {
    try {
      if (!verifier) return renderProject(req, res, { verifyResult: { state: 'unavailable' } });
      const proof = await req.orgDb.projects.verification(req.project.id);
      if (proof.verifiedAt) return res.redirect(303, `${res.locals.projectBase}?notice=verified`);
      const key = String(req.project.id);
      const recent = Date.now() - (lastCheck.get(key) ?? 0) < CHECK_GAP_MS;
      if (recent) return renderProject(req, res, { verifyResult: { state: 'wait' }, status: 429 });
      lastCheck.set(key, Date.now());
      if (lastCheck.size > 5_000) lastCheck.clear();

      const method = ['dns', 'file'].includes(req.body.method) ? req.body.method : 'any';
      const result = await verifier.verify({
        domain: req.project.domain,
        token: proof.token,
        method,
      });
      if (result.verified) {
        await req.orgDb.projects.markVerified(req.project.id, result.method, {
          actorUserId: req.user.id,
        });
        return res.redirect(303, `${res.locals.projectBase}?notice=verified`);
      }
      return renderProject(req, res, {
        verifyResult: { state: 'failed', reasons: result.reasons },
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Competitors (onboarding step 2; the project page shows the same form) ------------------------------
  const MAX_COMPETITORS = 10;

  router.post('/projects/:pid/competitors', edit, async (req, res, next) => {
    try {
      const back = (notice) =>
        res.redirect(303, withNotice(returnPath(res.locals.projectBase, req.body.next), notice));
      const name = text(req.body.name, 255);
      const website = text(req.body.website, 300);
      if (name.length < 2) return back('competitor-invalid');
      let primaryDomain = null;
      if (website) {
        const site = normalizeWebsite(website);
        if (!site.ok) return back('competitor-invalid');
        primaryDomain = site.domain.replace(/^www\./, '');
      }
      const current = await req.orgDb.entities.list(req.project.id, { kind: 'competitor' });
      if (
        current.filter((e) => ['active', 'paused'].includes(e.status)).length >= MAX_COMPETITORS
      ) {
        return back('competitors-full');
      }
      try {
        await req.orgDb.entities.addCompetitor(
          req.project.id,
          { name, primaryDomain },
          { actorUserId: req.user.id },
        );
      } catch (err) {
        if (err instanceof DomainError && err.code === 'DUPLICATE')
          return back('competitor-exists');
        if (err instanceof DomainError && ['INVALID_NAME', 'INVALID_DOMAIN'].includes(err.code)) {
          return back('competitor-invalid');
        }
        throw err;
      }
      return back('competitor-added');
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:pid/competitors/:eid/remove', edit, async (req, res, next) => {
    try {
      const entityId = idFrom(req.params.eid);
      // The entity must belong to THIS project: the repository only proves it belongs to the organization.
      const own = entityId
        ? (await req.orgDb.entities.list(req.project.id, { kind: 'competitor' })).find(
            (e) => e.id === entityId,
          )
        : null;
      if (!own) return notFound(req, res);
      await req.orgDb.entities.setStatus(own.id, 'ignored', { actorUserId: req.user.id });
      return res.redirect(
        303,
        withNotice(returnPath(res.locals.projectBase, req.body.next), 'competitor-removed'),
      );
    } catch (err) {
      next(err);
    }
  });

  // Which AI engines this project is checked on. At least one stays on, and only live engines can be chosen.
  router.post('/projects/:pid/engines', edit, async (req, res, next) => {
    try {
      const chosen = Array.isArray(req.body.engine)
        ? req.body.engine
        : typeof req.body.engine === 'string'
          ? [req.body.engine]
          : [];
      try {
        await req.orgDb.projectEngines.setEnabled(req.project.id, chosen);
      } catch (err) {
        if (err instanceof DomainError && err.code === 'NO_ENGINES') {
          return res.redirect(303, withNotice(res.locals.projectBase, 'engines-none'));
        }
        if (err instanceof DomainError && err.code === 'UNKNOWN_ENGINE') {
          return res.redirect(303, withNotice(res.locals.projectBase, 'engines-invalid'));
        }
        throw err;
      }
      return res.redirect(303, withNotice(res.locals.projectBase, 'engines-saved'));
    } catch (err) {
      return next(err);
    }
  });

  // Confirm a competitor we suggested: from now on it is tracked.
  router.post('/projects/:pid/competitors/:eid/track', edit, async (req, res, next) => {
    try {
      const entityId = idFrom(req.params.eid);
      const all = entityId
        ? await req.orgDb.entities.list(req.project.id, { kind: 'competitor' })
        : [];
      const own = all.find((e) => e.id === entityId && e.status === 'suggested');
      if (!own) return notFound(req, res);
      const target = returnPath(res.locals.projectBase, req.body.next);
      if (all.filter((e) => ['active', 'paused'].includes(e.status)).length >= MAX_COMPETITORS) {
        return res.redirect(303, withNotice(target, 'competitors-full'));
      }
      await req.orgDb.entities.setStatus(own.id, 'active', { actorUserId: req.user.id });
      return res.redirect(303, withNotice(target, 'competitor-tracked'));
    } catch (err) {
      next(err);
    }
  });

  brandRoutes(router, { jobs, logger, appPage, edit });
  questionRoutes(router, { jobs, logger, appPage, edit });
  setupRoutes(router, { jobs, logger, appPage, edit });
  trackingRoutes(router, { jobs, logger, edit });
  dashboardRoutes(router, { appPage, edit, logger });
  actionRoutes(router, { appPage, act, jobs, logger });
  contentRoutes(router, { appPage, act, approve, manage, jobs, logger, content });
  trafficRoutes(router, { appPage, manage, jobs, logger, google, config, content });

  return { router, visibleIds };
}
