import { emptyBrandKit, parseBrandKit } from '../../core/brand-kit.js';
import { checkCoverage } from '../../core/prompt-rules.js';
import { DomainError } from '../../db/index.js';
import { normalizeEntityName } from '../../core/project-rules.js';
import { questionsJobId, slotOf } from '../../lib/job-ids.js';
import { notFound } from '../middleware/errors.js';
import { READING_WINDOW_MS, readableErrors, sectionFromBody } from './project-brand.js';
import { questionLimit } from './project-questions.js';
import { lines, withNotice } from './project-helpers.js';

/**
 * The setup steps a new project walks through (B3–B7): brand → competitors → questions → connect → start. Each step is
 * pre-filled from what we found, so a customer mostly confirms. The steps use the same repositories as the Brand Kit
 * and Prompt Manager screens: this is a guided order, not a second copy of the data.
 *
 * The last step shows what is ready and, for someone who can edit, offers "Start tracking" (routes in
 * project-tracking.js): it switches the project to active and starts its first check at once.
 */

export const STEPS = Object.freeze(['brand', 'competitors', 'questions', 'connect', 'start']);
const STEP_LABELS = Object.freeze(['Brand', 'Competitors', 'Questions', 'Connect', 'Start']);
const GENERATING_WINDOW_MS = 3 * 60_000;

const TITLES = Object.freeze({
  brand: 'Confirm your brand',
  competitors: 'Your competitors',
  questions: 'The questions buyers ask',
  connect: 'Connect your tools',
  start: 'You’re set up',
});

export function setupRoutes(router, { jobs, logger, appPage, edit }) {
  const base = (res) => `${res.locals.projectBase}/setup`;

  async function renderStep(req, res, step, extra = {}) {
    const project = req.project;
    const [current, entities, active, engines] = await Promise.all([
      req.orgDb.brandKits.current(project.id),
      req.orgDb.entities.list(project.id, { kind: 'competitor' }),
      req.orgDb.prompts.list(project.id, { status: 'active' }),
      step === 'start' ? req.orgDb.projectEngines.list(project.id) : [],
    ]);
    const coverage = checkCoverage(active, { hasCity: Boolean(project.city) });
    const sinceWindow = Date.now() - new Date(project.created_at).getTime();
    const reading = !current && Boolean(jobs) && sinceWindow < READING_WINDOW_MS;

    const since = Number(req.query.since);
    const before = Number(req.query.n);
    const recent =
      Number.isFinite(since) && Date.now() - since < GENERATING_WINDOW_MS && since <= Date.now();
    const generating = step === 'questions' && recent && active.length === before;
    const slow =
      step === 'questions' &&
      Number.isFinite(since) &&
      !recent &&
      Number.isFinite(before) &&
      active.length === before;
    if (reading && step === 'brand') res.locals.refreshSeconds = 8;
    if (generating) res.locals.refreshSeconds = 8;

    return appPage(
      res,
      'project-setup',
      {
        step,
        stepIndex: STEPS.indexOf(step),
        stepLabels: STEP_LABELS,
        title: TITLES[step],
        kit:
          extra.kit ??
          current?.data ??
          emptyBrandKit({ name: project.name, domain: project.domain }),
        version: current?.version ?? null,
        reading: step === 'brand' && reading,
        readFailed: step === 'brand' && !current && !reading && Boolean(jobs),
        conflict: false,
        errors: {},
        competitors: entities.filter((e) => ['active', 'paused'].includes(e.status)),
        suggested: entities.filter((e) => e.status === 'suggested'),
        prompts: active,
        coverage,
        limit: await questionLimit(req),
        generating,
        slow,
        engines,
        hasKit: Boolean(current),
        canEdit: res.locals.can('strategy.edit'),
        meta: {
          title: `${TITLES[step]} · ${project.name} | AEO Corner`,
          description: 'Set up your project.',
        },
        ...extra,
      },
      extra.status ? { status: extra.status } : {},
    );
  }

  router.get('/projects/:pid/setup', (req, res) => {
    res.redirect(302, `${base(res)}/brand`);
  });

  router.get('/projects/:pid/setup/:step', async (req, res, next) => {
    try {
      if (!STEPS.includes(req.params.step)) return notFound(req, res);
      return await renderStep(req, res, req.params.step);
    } catch (err) {
      return next(err);
    }
  });

  // Step 1: the identity fields and the products and services, saved as one new Brand Kit version.
  router.post('/projects/:pid/setup/brand', edit, async (req, res, next) => {
    try {
      const current = await req.orgDb.brandKits.current(req.project.id);
      const kitBase =
        current?.data ?? emptyBrandKit({ name: req.project.name, domain: req.project.domain });
      const identity = sectionFromBody('identity', {
        ...req.body,
        // This step doesn't show these two: they keep what the kit has.
        legalName: kitBase.identity.legalName,
        domains: kitBase.identity.domains.join('\n'),
      });
      const known = new Map(
        kitBase.offerings.items.map((item) => [normalizeEntityName(item.name), item]),
      );
      const items = lines(req.body.products, 120).map(
        (name) => known.get(normalizeEntityName(name)) ?? { name },
      );
      const merged = {
        ...kitBase,
        identity,
        offerings: { ...kitBase.offerings, items: items.slice(0, 30) },
      };
      const parsed = parseBrandKit(merged);
      if (!parsed.ok) {
        return renderStep(req, res, 'brand', {
          kit: merged,
          errors: readableErrors(parsed.errors),
          status: 422,
        });
      }
      const expected = /^\d{1,9}$/.test(String(req.body.expectedVersion))
        ? Number(req.body.expectedVersion)
        : null;
      try {
        await req.orgDb.brandKits.save(req.project.id, {
          kit: parsed.kit,
          source: 'edited',
          expectedVersion: expected,
          actorUserId: req.user.id,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'STALE_VERSION') {
          return renderStep(req, res, 'brand', { conflict: true, status: 409 });
        }
        throw err;
      }
      return res.redirect(303, `${base(res)}/competitors`);
    } catch (err) {
      return next(err);
    }
  });

  // Step 2 → 3: with the competitors settled, write the questions (comparison questions name them).
  router.post('/projects/:pid/setup/competitors', edit, async (req, res, next) => {
    try {
      const active = (await req.orgDb.prompts.list(req.project.id, { status: 'active' })).length;
      if (active === 0 && jobs) {
        try {
          await jobs.add(
            'questions.generate',
            { orgId: String(req.org.id), projectId: String(req.project.id), count: 30 },
            { jobId: questionsJobId(req.project.id, active, slotOf(new Date())) },
          );
          return res.redirect(303, `${base(res)}/questions?since=${Date.now()}&n=${active}`);
        } catch (err) {
          logger.error(
            { err, projectId: String(req.project.id) },
            'Could not queue the question set',
          );
          return res.redirect(303, withNotice(`${base(res)}/questions`, 'queue-down'));
        }
      }
      return res.redirect(303, `${base(res)}/questions`);
    } catch (err) {
      return next(err);
    }
  });
}
