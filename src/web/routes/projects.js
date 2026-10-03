import { Router } from 'express';
import { dnsRecord, fileProof } from '../../core/domain-verification.js';
import { COUNTRIES, LANGUAGES, checkProjectFields } from '../../core/project-rules.js';
import { requestScan } from '../../crawler/request-scan.js';
import { DomainError } from '../../db/index.js';
import { isUlid } from '../../lib/ulid.js';
import { normalizeWebsite } from '../../lib/url.js';
import { notFound } from '../middleware/errors.js';

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

export function projectRoutes({ db, jobs, auth, logger, appPage, verifier = null }) {
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

  const form = (req, res, { values = {}, errors = {}, status } = {}) =>
    appPage(
      res,
      'project-new',
      {
        values: { country: 'US', language: 'en', ...values },
        errors,
        countries: COUNTRY_OPTIONS,
        languages: LANGUAGE_OPTIONS,
        meta: formMeta(req),
      },
      status ? { status } : {},
    );

  router.get('/projects/new', create, (req, res) => form(req, res));

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
      const site = normalizeWebsite(values.website);
      if (!site.ok) errors.website = 'Enter your website, like acme-dental.com.';
      const checked = checkProjectFields({ ...values, website: undefined });
      if (!checked.ok) Object.assign(errors, checked.errors);
      if (Object.keys(errors).length) return form(req, res, { values, errors, status: 422 });

      let project;
      try {
        project = await req.orgDb.projects.create({
          ...checked.value,
          domain: site.domain.replace(/^www\./, ''),
          createdByUserId: req.user.id,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'DOMAIN_TAKEN') {
          return form(req, res, {
            values,
            errors: { website: 'This organization already has a project for that website.' },
            status: 422,
          });
        }
        if (err instanceof DomainError && err.code === 'INVALID_DOMAIN') {
          return form(req, res, {
            values,
            errors: { website: 'Enter your website, like acme-dental.com.' },
            status: 422,
          });
        }
        throw err;
      }

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
      }
      return res.redirect(
        303,
        `${res.locals.orgBase}/projects/${project.public_id}?notice=project-created`,
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
      res.locals.project = { name: project.name, publicId: project.public_id };
      res.locals.projectBase = `${res.locals.orgBase}/projects/${project.public_id}`;
      return next();
    } catch (err) {
      return next(err);
    }
  });

  const edit = auth.requirePermission('strategy.edit');

  async function renderProject(req, res, { verifyResult = null, status } = {}) {
    const [entities, engines, proof] = await Promise.all([
      req.orgDb.entities.list(req.project.id),
      req.orgDb.projectEngines.list(req.project.id),
      req.orgDb.projects.verification(req.project.id),
    ]);
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
  const idFrom = (value) => (/^\d{1,18}$/.test(String(value)) ? BigInt(value) : null);

  router.post('/projects/:pid/competitors', edit, async (req, res, next) => {
    try {
      const back = (notice) => res.redirect(303, `${res.locals.projectBase}?notice=${notice}`);
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
      if (current.filter((e) => e.status !== 'ignored').length >= MAX_COMPETITORS) {
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
      return res.redirect(303, `${res.locals.projectBase}?notice=competitor-removed`);
    } catch (err) {
      next(err);
    }
  });

  return { router, visibleIds };
}
