import { canonicalJson } from '../../core/canonical-json.js';
import {
  afterWindow,
  baselineWindow,
  countWindow,
  dayBounds,
  HORIZONS,
  measureOutcome,
  nextDueHorizon,
  statusAfterOutcome,
} from '../../core/outcomes.js';
import {
  canTransition,
  DISMISS_REASONS,
  EDITABLE_STATUSES,
  FINAL_STATUSES,
  LIVE_STATUSES,
  mayRaiseAgain,
  verificationSchedule,
  verifyMethodFor,
} from '../../core/recommendation-lifecycle.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { Prisma } from '../generated/client/client.ts';
import { transaction } from '../transaction.js';

/**
 * One organization's Action Center (Milestone 6, MVP F7): the recommendations the rules engine raises, what a person
 * does with them, the same-day re-check, and the before/after outcome. Merged into `forOrg(orgId)` as `recommendations`
 * and `outcomes`; the organization is bound once and no function takes an `org_id` from its arguments.
 *
 * What lives here and what does not: the rules, the scoring, the lifecycle table and the significance test are pure
 * code in `src/core`; this file reads and writes. Every write to a recommendation's status goes through
 * `transitionRow`, which asks the lifecycle table first, writes with the old status in the WHERE (so two clicks or a
 * click and a job cannot both win), and records the move in `recommendation_events`.
 *
 * The fact tables under the reads here (`cell_results`, `cell_entity_results`) have no foreign keys, so every query
 * names the organization, the project and the run date.
 */

const toNumber = (value) => (value == null ? 0 : Number(value));
const toJson = (value) => JSON.parse(JSON.stringify(value));
const day = (value) => new Date(`${new Date(value).toISOString().slice(0, 10)}T00:00:00Z`);
const dayText = (value) => new Date(value).toISOString().slice(0, 10);

export const VIEWS = Object.freeze({
  todo: ['open', 'in_progress'],
  progress: ['done', 'verified', 'unverified', 'measuring'],
  results: ['proven_win', 'no_change', 'declined'],
  dismissed: ['dismissed'],
});

const toRecommendation = (r) => ({
  id: r.id,
  ruleCode: r.rule_code,
  ruleVersion: r.rule_version,
  stableKey: r.stable_key,
  category: r.category,
  fixPath: r.fix_path,
  title: r.title,
  whyMd: r.why_md,
  stepsMd: r.steps_md,
  narrativeVersion: r.narrative_version,
  evidence: r.evidence,
  affectedUrls: Array.isArray(r.affected_urls) ? r.affected_urls : [],
  impact: toNumber(r.impact),
  confidence: toNumber(r.confidence),
  effort: r.effort,
  ice: toNumber(r.ice),
  status: r.status,
  statusChangedAt: r.status_changed_at,
  dismissReason: r.dismiss_reason,
  dismissNote: r.dismiss_note,
  doneAt: r.done_at,
  doneByUserId: r.done_by_user_id,
  verifiedAt: r.verified_at,
  verification: r.verification,
  measuringStartedAt: r.measuring_started_at,
  baseline: r.baseline,
  signalClearedAt: r.signal_cleared_at,
  firstSeenRunId: r.first_seen_run_id,
  lastSeenRunId: r.last_seen_run_id,
  parentId: r.parent_recommendation_id,
  createdAt: r.created_at,
});

const toOutcome = (o) => ({
  id: o.id,
  recommendationId: o.recommendation_id,
  horizon: o.horizon,
  engineScope: o.engine_scope,
  promptsCount: o.prompts_count,
  baselineRunIds: o.baseline_run_ids,
  afterRunIds: o.after_run_ids,
  nBefore: o.n_before,
  kBefore: o.k_before,
  nAfter: o.n_after,
  kAfter: o.k_after,
  rateBefore: o.rate_before == null ? null : Number(o.rate_before),
  rateAfter: o.rate_after == null ? null : Number(o.rate_after),
  deltaPp: o.delta_pp == null ? null : Number(o.delta_pp),
  p: o.p_value == null ? null : Number(o.p_value),
  verdict: o.verdict,
  computedAt: o.computed_at,
});

export function actionRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true, domain: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  const findRow = (db, projectId, recId) =>
    db.recommendations.findFirst({ where: { id: recId, project_id: projectId, org_id: orgId } });

  async function brandOf(projectId) {
    return prisma.tracked_entities.findFirst({
      where: { project_id: projectId, org_id: orgId, kind: 'brand' },
      select: { id: true, name: true },
    });
  }

  /**
   * The cells of some questions over a window, with the run each came from and when it was queued, and how many of its
   * answers named the brand. One row per question × engine × run.
   */
  async function cellsFor(db, projectId, brandId, promptIds, window) {
    if (promptIds.length === 0 || !brandId) return [];
    const [from, to] = dayBounds(window);
    const where = {
      org_id: orgId,
      project_id: projectId,
      run_date: { gte: day(from), lte: day(to) },
      prompt_id: { in: promptIds.map((id) => BigInt(id)) },
    };
    const cells = await db.cell_results.findMany({
      where,
      select: { run_id: true, prompt_id: true, engine_code: true, status: true, n_ok: true },
    });
    if (cells.length === 0) return [];
    const runIds = [...new Set(cells.map((c) => c.run_id))];
    const [runs, brandRows] = await Promise.all([
      db.runs.findMany({
        where: { id: { in: runIds }, org_id: orgId },
        select: { id: true, queued_at: true },
      }),
      db.cell_entity_results.findMany({
        where: { ...where, entity_id: brandId, run_id: { in: runIds } },
        select: { run_id: true, prompt_id: true, engine_code: true, k_mentioned: true },
      }),
    ]);
    const queued = new Map(runs.map((r) => [r.id, r.queued_at]));
    const brandK = new Map(
      brandRows.map((r) => [`${r.run_id}|${r.prompt_id}|${r.engine_code}`, r.k_mentioned]),
    );
    return cells
      .filter((c) => queued.has(c.run_id))
      .map((c) => ({
        promptId: String(c.prompt_id),
        runId: String(c.run_id),
        queuedAt: queued.get(c.run_id),
        status: c.status,
        nOk: c.n_ok,
        brandK: brandK.get(`${c.run_id}|${c.prompt_id}|${c.engine_code}`) ?? 0,
      }));
  }

  async function writeEvent(db, rec, { from, to, actor, userId = null, note = null, now }) {
    await db.recommendation_events.create({
      data: {
        org_id: orgId,
        recommendation_id: rec.id,
        from_status: from,
        to_status: to,
        actor_type: actor,
        actor_user_id: actor === 'user' ? userId : null,
        note: note ? String(note).slice(0, 500) : null,
        created_at: now,
      },
    });
  }

  /**
   * Move a recommendation from the status it has to another: checked against the lifecycle table, written only if it
   * still has that status, and recorded. `fields` are written in the same statement.
   */
  async function transitionRow(
    db,
    rec,
    to,
    { actor, userId = null, note = null, now, fields = {} },
  ) {
    if (!canTransition(rec.status, to, actor)) {
      throw new DomainError('INVALID_TRANSITION', `${rec.status} -> ${to} by ${actor}`);
    }
    const result = await db.recommendations.updateMany({
      where: { id: rec.id, org_id: orgId, status: rec.status },
      data: { ...fields, status: to, status_changed_at: now },
    });
    if (result.count !== 1) throw new DomainError('STALE_STATUS');
    await writeEvent(db, rec, { from: rec.status, to, actor, userId, note, now });
    return { ...rec, status: to };
  }

  /** The questions a recommendation targets: the ones stored for it, or every active question for a site-wide one. */
  async function scopeOf(db, rec) {
    const stored = await db.recommendation_prompts.findMany({
      where: { recommendation_id: rec.id, org_id: orgId },
      select: { prompt_id: true },
    });
    if (stored.length) return stored.map((s) => String(s.prompt_id));
    const active = await db.prompts.findMany({
      where: { project_id: rec.project_id, org_id: orgId, status: 'active' },
      select: { id: true },
    });
    return active.map((p) => String(p.id));
  }

  async function replaceScope(db, recId, promptIds) {
    await db.recommendation_prompts.deleteMany({
      where: { recommendation_id: recId, org_id: orgId },
    });
    if (promptIds.length) {
      await db.recommendation_prompts.createMany({
        data: [...new Set(promptIds.map(String))].map((id) => ({
          recommendation_id: recId,
          prompt_id: BigInt(id),
          org_id: orgId,
        })),
      });
    }
  }

  const recommendations = {
    /**
     * What the rules engine reads about a project: the latest finished website scan, the questions and engines, the
     * grid of the last window's cells with who was named in each, and the brand's sentiment.
     *
     * @returns `{ project: { domain }, brandName, enginesCount, prompts, scan, grid, answersTotal, sentiment, window }`;
     *   `scan` is null before the first one finishes; `grid` rows are per question, each with an entry per engine:
     *   `{ engineCode, status, nOk, brandK, rivals }`. `nOk` and `rivals` count COMPLETE cells only; `brandK` counts
     *   every cell, so a half-collected cell that named the brand still means "not lost".
     */
    async signals(projectId, { from, to }) {
      const project = await ownProject(projectId);
      const brand = await brandOf(projectId);
      const range = { gte: day(from), lte: day(to) };
      const where = { org_id: orgId, project_id: projectId, run_date: range };

      const [engines, prompts, scanRow, cells, competitors] = await Promise.all([
        prisma.project_engines.findMany({
          where: { project_id: projectId, org_id: orgId, enabled: true },
          select: { engine_code: true },
        }),
        prisma.prompts.findMany({
          where: { project_id: projectId, org_id: orgId, status: 'active' },
          select: { id: true, text: true, priority: true },
          orderBy: { id: 'asc' },
        }),
        prisma.site_scans.findFirst({
          where: {
            project_id: projectId,
            org_id: orgId,
            status: { in: ['complete', 'partial'] },
          },
          orderBy: [{ finished_at: 'desc' }, { id: 'desc' }],
        }),
        prisma.cell_results.findMany({
          where,
          select: { run_id: true, prompt_id: true, engine_code: true, status: true, n_ok: true },
        }),
        prisma.tracked_entities.findMany({
          where: { project_id: projectId, org_id: orgId, kind: 'competitor', status: 'active' },
          select: { id: true, name: true },
        }),
      ]);

      let scan = null;
      if (scanRow) {
        const checks = await prisma.scan_checks.findMany({
          where: { scan_id: scanRow.id, org_id: orgId },
          orderBy: { check_code: 'asc' },
        });
        scan = {
          id: scanRow.id,
          finishedAt: scanRow.finished_at,
          checks: checks.map((c) => ({
            code: c.check_code,
            status: c.status,
            points: toNumber(c.points_awarded),
            possible: toNumber(c.points_possible),
            summary: typeof c.evidence?.summary === 'string' ? c.evidence.summary : '',
            evidence: c.evidence ?? {},
          })),
        };
      }

      const entityRows = cells.length
        ? await prisma.cell_entity_results.findMany({
            where: { ...where, run_id: { in: [...new Set(cells.map((c) => c.run_id))] } },
            select: {
              run_id: true,
              prompt_id: true,
              engine_code: true,
              entity_id: true,
              k_mentioned: true,
              sentiment_sum: true,
              sentiment_n: true,
            },
          })
        : [];

      const completeCells = new Set(
        cells
          .filter((c) => c.status === 'complete')
          .map((c) => `${c.run_id}|${c.prompt_id}|${c.engine_code}`),
      );
      const rivalName = new Map(competitors.map((c) => [c.id, c.name]));
      const bucket = new Map(); // `${prompt}|${engine}` -> entry
      const entry = (promptId, engineCode) => {
        const key = `${promptId}|${engineCode}`;
        if (!bucket.has(key)) {
          bucket.set(key, {
            promptId: String(promptId),
            engineCode,
            complete: 0,
            nOk: 0,
            brandK: 0,
            rivals: new Map(),
          });
        }
        return bucket.get(key);
      };
      let answersTotal = 0;
      for (const c of cells) {
        const e = entry(c.prompt_id, c.engine_code);
        if (c.status === 'complete') {
          e.complete += 1;
          e.nOk += c.n_ok;
          answersTotal += c.n_ok;
        }
      }
      let sentimentN = 0;
      let sentimentSum = 0;
      for (const r of entityRows) {
        const e = entry(r.prompt_id, r.engine_code);
        if (brand && r.entity_id === brand.id) {
          e.brandK += r.k_mentioned;
          sentimentN += r.sentiment_n;
          sentimentSum += r.sentiment_sum;
        } else if (
          rivalName.has(r.entity_id) &&
          completeCells.has(`${r.run_id}|${r.prompt_id}|${r.engine_code}`)
        ) {
          const name = rivalName.get(r.entity_id);
          e.rivals.set(name, (e.rivals.get(name) ?? 0) + r.k_mentioned);
        }
      }

      const byPrompt = new Map();
      for (const e of bucket.values()) {
        const list = byPrompt.get(e.promptId) ?? [];
        list.push({
          engineCode: e.engineCode,
          status: e.complete > 0 ? 'complete' : 'partial',
          nOk: e.nOk,
          brandK: e.brandK,
          rivals: [...e.rivals].map(([name, k]) => ({ name, k })),
        });
        byPrompt.set(e.promptId, list);
      }
      const grid = prompts
        .filter((p) => byPrompt.has(String(p.id)))
        .map((p) => ({
          promptId: String(p.id),
          text: p.text,
          priority: p.priority,
          engines: byPrompt
            .get(String(p.id))
            .sort((a, b) => a.engineCode.localeCompare(b.engineCode)),
        }));

      return {
        project: { domain: project.domain },
        brandName: brand?.name ?? project.domain,
        enginesCount: engines.length,
        prompts: prompts.map((p) => ({ id: String(p.id), text: p.text, priority: p.priority })),
        scan,
        grid,
        answersTotal,
        sentiment: sentimentN > 0 ? { n: sentimentN, sum: sentimentSum } : null,
        window: { from: dayText(from), to: dayText(to) },
      };
    },

    /**
     * Bring the project's recommendations in line with what the rules engine just found. Safe to run again and again:
     * the key `(project, open_key)` is unique, so a candidate that already has a live recommendation updates it and never
     * adds a second.
     *
     *   - A live recommendation still open or in progress gets its numbers, evidence and (if the evidence changed) words
     *     refreshed. One that is done or beyond keeps its scope: the measurement must compare like with like.
     *   - A candidate with no live recommendation is raised, unless an earlier one for the same issue was dismissed or
     *     finished a short while ago (`mayRaiseAgain`). A declined one is raised again as its follow-up.
     *   - A live recommendation the engine no longer finds, for a family it could evaluate, gets `signal_cleared_at`.
     *     One the engine found but left out of the list (the caps) is left alone.
     *
     * @param items       scored candidates with their words: `{ ...candidate, impact, confidence, ice, why, steps,
     *                    narrativeVersion }`
     * @param detectedKeys every key the engine found, capped or not
     * @param evaluated   `{ readiness, visibility }`: which families had something to read
     * @returns `{ created: [ids], updated, cleared, suppressed, needsNarrative: [ids] }`
     */
    async reconcile(projectId, { items, detectedKeys, evaluated, runId = null, now = new Date() }) {
      await ownProject(projectId);
      const summary = { created: [], updated: 0, cleared: 0, suppressed: 0, needsNarrative: [] };

      const live = await prisma.recommendations.findMany({
        where: { project_id: projectId, org_id: orgId, status: { in: LIVE_STATUSES } },
      });
      const liveByKey = new Map(live.map((r) => [r.stable_key, r]));
      const detected = new Set(detectedKeys ?? items.map((i) => i.stableKey));

      for (const item of items) {
        const current = liveByKey.get(item.stableKey);
        if (current) {
          const { narrativeReplaced } = await refresh(current, item, { runId });
          summary.updated += 1;
          if (narrativeReplaced) summary.needsNarrative.push(current.id);
          continue;
        }
        const previous = await prisma.recommendations.findFirst({
          where: {
            project_id: projectId,
            org_id: orgId,
            stable_key: item.stableKey,
            status: { in: FINAL_STATUSES },
          },
          orderBy: [{ status_changed_at: 'desc' }, { id: 'desc' }],
        });
        const decision = mayRaiseAgain(
          previous && {
            id: previous.id,
            status: previous.status,
            statusChangedAt: previous.status_changed_at,
            dismissReason: previous.dismiss_reason,
          },
          now,
        );
        if (!decision.allowed) {
          summary.suppressed += 1;
          continue;
        }
        const created = await raise(projectId, item, { parentId: decision.parentId, runId, now });
        if (created.created) {
          summary.created.push(created.id);
          summary.needsNarrative.push(created.id);
        } else {
          summary.updated += 1;
        }
      }

      const found = new Set(items.map((i) => i.stableKey));
      for (const rec of live) {
        const family = rec.rule_code.split('.')[0];
        if (!evaluated?.[family]) continue;
        if (found.has(rec.stable_key) || detected.has(rec.stable_key)) continue;
        if (rec.signal_cleared_at) continue;
        const result = await prisma.recommendations.updateMany({
          where: { id: rec.id, org_id: orgId, signal_cleared_at: null },
          data: { signal_cleared_at: now },
        });
        summary.cleared += result.count;
      }
      return summary;
    },

    /**
     * A project's recommendations in a view (`todo`, `progress`, `results`, `dismissed`), best first: by ICE for the
     * to-do list, by when they moved for the rest. Each has how many questions it targets and its latest outcome.
     */
    async list(projectId, { view = 'todo' } = {}) {
      await ownProject(projectId);
      const statuses = VIEWS[view];
      if (!statuses) throw new DomainError('UNKNOWN_VIEW');
      const rows = await prisma.recommendations.findMany({
        where: { project_id: projectId, org_id: orgId, status: { in: statuses } },
        orderBy:
          view === 'todo'
            ? [{ ice: 'desc' }, { id: 'asc' }]
            : [{ status_changed_at: 'desc' }, { id: 'desc' }],
      });
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const [links, outcomes] = await Promise.all([
        prisma.recommendation_prompts.groupBy({
          by: ['recommendation_id'],
          where: { recommendation_id: { in: ids }, org_id: orgId },
          _count: { _all: true },
        }),
        prisma.action_outcomes.findMany({
          where: { recommendation_id: { in: ids }, org_id: orgId },
          orderBy: { id: 'asc' },
        }),
      ]);
      const questions = new Map(links.map((l) => [l.recommendation_id, l._count._all]));
      const latest = new Map();
      for (const o of outcomes) latest.set(o.recommendation_id, toOutcome(o));
      return rows.map((r) => ({
        ...toRecommendation(r),
        questions: questions.get(r.id) ?? 0,
        outcome: latest.get(r.id) ?? null,
      }));
    },

    /** How many recommendations are in each view, for the tabs. */
    async counts(projectId) {
      await ownProject(projectId);
      const grouped = await prisma.recommendations.groupBy({
        by: ['status'],
        where: { project_id: projectId, org_id: orgId },
        _count: { _all: true },
      });
      const by = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
      return Object.fromEntries(
        Object.entries(VIEWS).map(([view, statuses]) => [
          view,
          statuses.reduce((n, s) => n + (by[s] ?? 0), 0),
        ]),
      );
    },

    /**
     * One recommendation with what the detail screen shows: the questions it targets, its history, its re-checks and
     * its outcomes. Null when it is not this project's (or this organization's).
     */
    async get(projectId, recId) {
      await ownProject(projectId);
      const rec = await findRow(prisma, projectId, recId);
      if (!rec) return null;
      const [links, events, verifications, outcomes] = await Promise.all([
        prisma.recommendation_prompts.findMany({
          where: { recommendation_id: rec.id, org_id: orgId },
          select: { prompt_id: true },
        }),
        prisma.recommendation_events.findMany({
          where: { recommendation_id: rec.id, org_id: orgId },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        }),
        prisma.fix_verifications.findMany({
          where: { recommendation_id: rec.id, org_id: orgId },
          orderBy: { attempt: 'asc' },
        }),
        prisma.action_outcomes.findMany({
          where: { recommendation_id: rec.id, org_id: orgId },
          orderBy: { id: 'asc' },
        }),
      ]);
      const prompts = links.length
        ? await prisma.prompts.findMany({
            where: {
              id: { in: links.map((l) => l.prompt_id) },
              project_id: projectId,
              org_id: orgId,
            },
            select: { id: true, text: true },
            orderBy: { id: 'asc' },
          })
        : [];
      return {
        recommendation: toRecommendation(rec),
        prompts: prompts.map((p) => ({ id: p.id, text: p.text })),
        events: events.map((e) => ({
          fromStatus: e.from_status,
          toStatus: e.to_status,
          actorType: e.actor_type,
          note: e.note,
          createdAt: e.created_at,
        })),
        verifications: verifications.map((v) => ({
          attempt: v.attempt,
          method: v.method,
          status: v.status,
          scheduledFor: v.scheduled_for,
          checkedAt: v.checked_at,
          details: v.details,
        })),
        outcomes: outcomes.map(toOutcome),
      };
    },

    /** A recommendation by ID, for a job that has only the ID. Includes its project. Null if not this organization's. */
    async load(recId) {
      const rec = await prisma.recommendations.findFirst({ where: { id: recId, org_id: orgId } });
      return rec ? { ...toRecommendation(rec), projectId: rec.project_id } : null;
    },

    /**
     * The fix this recommendation was about is no longer on the site (an auto-fix was taken back). If it was being
     * checked or measured, it goes back to "in progress": the baseline, the re-checks and any measurement of the removed
     * fix no longer describe the site. One that is not in that state (still open, or final) is left alone.
     *
     * @returns `{ changed }`
     */
    async fixRemoved(projectId, recId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const rec = await findRow(prisma, projectId, recId);
      if (!rec) throw new DomainError('RECOMMENDATION_NOT_FOUND');
      if (!['done', 'verified', 'unverified', 'measuring'].includes(rec.status)) {
        return { changed: false, status: rec.status };
      }
      await transaction(prisma, async (tx) => {
        await tx.fix_verifications.deleteMany({
          where: { recommendation_id: rec.id, org_id: orgId },
        });
        await tx.action_outcomes.deleteMany({
          where: { recommendation_id: rec.id, org_id: orgId },
        });
        await transitionRow(tx, rec, 'in_progress', {
          actor: 'system',
          now,
          note: 'The fix was removed from the site',
          fields: {
            done_at: null,
            verified_at: null,
            verification: Prisma.DbNull,
            baseline: Prisma.DbNull,
            measuring_started_at: null,
          },
        });
      });
      return { changed: true, status: 'in_progress' };
    },

    /** The best things to do now (open or in progress, not already fixed on the site), for the dashboard. */
    async top(projectId, limit = 3) {
      await ownProject(projectId);
      const rows = await prisma.recommendations.findMany({
        where: {
          project_id: projectId,
          org_id: orgId,
          status: { in: VIEWS.todo },
          signal_cleared_at: null,
        },
        orderBy: [{ ice: 'desc' }, { id: 'asc' }],
        take: Math.min(Math.max(1, limit), 20),
      });
      return rows.map(toRecommendation);
    },

    /**
     * Replace a recommendation's words with a model-written narrative that already passed the evidence check. Only
     * while it is open or in progress, and only if its evidence is still what the narrative was written from.
     */
    async saveNarrative(projectId, recId, { why, steps, version, evidenceHash }) {
      await ownProject(projectId);
      const rec = await findRow(prisma, projectId, recId);
      if (!rec || !EDITABLE_STATUSES.includes(rec.status)) return false;
      if (evidenceHash && evidenceHash !== canonicalJson(rec.evidence)) return false;
      const result = await prisma.recommendations.updateMany({
        where: { id: rec.id, org_id: orgId, status: rec.status },
        data: { why_md: why, steps_md: steps, narrative_version: version },
      });
      return result.count === 1;
    },

    /**
     * A person's move: start, stop, dismiss, "fix again" or confirm an unverified fix. Marking done is `markDone`
     * (it also saves the baseline); the system's moves (verified, measuring, verdicts) are made by the functions that
     * decide them, never by a caller's say-so.
     */
    async transition(
      projectId,
      recId,
      to,
      { userId = null, dismissReason = null, dismissNote = null, now = new Date() } = {},
    ) {
      await ownProject(projectId);
      if (to === 'done') throw new DomainError('USE_MARK_DONE');
      const rec = await findRow(prisma, projectId, recId);
      if (!rec) throw new DomainError('RECOMMENDATION_NOT_FOUND');
      const fields = {};
      if (to === 'dismissed') {
        if (!(dismissReason in DISMISS_REASONS)) throw new DomainError('DISMISS_REASON_REQUIRED');
        fields.dismiss_reason = dismissReason;
        fields.dismiss_note = dismissNote ? String(dismissNote).slice(0, 500) : null;
      }
      if (to === 'measuring') fields.measuring_started_at = now;
      if (to === 'in_progress' && rec.status === 'unverified') {
        // Fixing it again: the old check and baseline no longer describe what will be on the site.
        Object.assign(fields, {
          verified_at: null,
          verification: Prisma.DbNull,
          baseline: Prisma.DbNull,
          done_at: null,
        });
      }
      const note =
        to === 'measuring' && rec.status === 'unverified'
          ? 'The customer confirmed the fix is in place'
          : to === 'dismissed'
            ? DISMISS_REASONS[dismissReason]
            : null;
      return transaction(prisma, async (tx) => {
        await transitionRow(tx, rec, to, {
          actor: 'user',
          userId,
          note,
          now,
          fields,
        });
        if (to === 'in_progress' && rec.status === 'unverified') {
          await tx.fix_verifications.deleteMany({
            where: { recommendation_id: rec.id, org_id: orgId },
          });
        }
        return toRecommendation(await findRow(tx, projectId, rec.id));
      });
    },

    /**
     * "Mark as done": the baseline is saved (what the targeted questions look like right now), the earlier re-checks
     * of a recommendation that was fixed again are forgotten, and the re-check is planned. A fix a machine cannot check
     * goes straight to measuring: marking it done was the customer's confirmation.
     *
     * @returns `{ recommendation, verifiable, schedule }`: `verifiable` is whether a re-check job should be queued
     *          now, `schedule` the three attempts' times
     */
    async markDone(projectId, recId, { userId = null, now = new Date(), verify = null } = {}) {
      await ownProject(projectId);
      const rec = await findRow(prisma, projectId, recId);
      if (!rec) throw new DomainError('RECOMMENDATION_NOT_FOUND');
      if (!canTransition(rec.status, 'done', 'user')) {
        throw new DomainError('INVALID_TRANSITION', `${rec.status} -> done`);
      }
      const brand = await brandOf(projectId);
      const promptIds = await scopeOf(prisma, rec);
      const window = baselineWindow(now);
      const cells = await cellsFor(prisma, projectId, brand?.id, promptIds, window);
      const counted = countWindow({ cells, promptIds, window });
      const baseline = {
        capturedAt: now.toISOString(),
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        promptIds,
        n: counted.n,
        k: counted.k,
        runIds: counted.runIds,
        perPrompt: counted.perPrompt,
        partialCellsLeftOut: counted.partialCells,
      };
      // A published page has its own check (the page is fetched and read); every other fix uses what its rule says.
      const method = verify?.method ?? verifyMethodFor(rec.rule_code);
      const schedule = verificationSchedule(now);

      await transaction(prisma, async (tx) => {
        await tx.fix_verifications.deleteMany({
          where: { recommendation_id: rec.id, org_id: orgId },
        });
        await transitionRow(tx, rec, 'done', {
          actor: 'user',
          userId,
          now,
          fields: {
            done_at: now,
            done_by_user_id: userId,
            baseline: toJson(baseline),
            verified_at: null,
            verification: Prisma.DbNull,
            measuring_started_at: null,
          },
        });
        for (const [index, scheduledFor] of schedule.entries()) {
          if (!method && index > 0) break;
          await tx.fix_verifications.create({
            data: {
              org_id: orgId,
              project_id: projectId,
              recommendation_id: rec.id,
              attempt: index + 1,
              method: method ?? 'manual',
              status: method ? 'pending' : 'not_verifiable',
              target_url: verify?.targetUrl ? String(verify.targetUrl).slice(0, 2048) : null,
              scheduled_for: scheduledFor,
              checked_at: method ? null : now,
              details: method
                ? verify?.expect
                  ? toJson({ expect: verify.expect })
                  : undefined
                : { reason: 'no automatic check for this kind of fix' },
            },
          });
        }
      });

      if (!method) {
        await recommendations.settleVerification(projectId, rec.id, {
          verdict: 'unverified',
          reason: 'not_verifiable',
          now,
        });
      }
      const after = await findRow(prisma, projectId, rec.id);
      return { recommendation: toRecommendation(after), verifiable: Boolean(method), schedule };
    },

    /** The re-check attempts of a recommendation, oldest first. */
    async verificationsOf(projectId, recId) {
      await ownProject(projectId);
      const rows = await prisma.fix_verifications.findMany({
        where: { recommendation_id: recId, project_id: projectId, org_id: orgId },
        orderBy: { attempt: 'asc' },
      });
      return rows.map((v) => ({
        attempt: v.attempt,
        method: v.method,
        targetUrl: v.target_url,
        status: v.status,
        scheduledFor: v.scheduled_for,
        checkedAt: v.checked_at,
        scanId: v.scan_id,
        details: v.details,
      }));
    },

    /** Remember which scan a re-check attempt started, so a retried job reuses it instead of scanning twice. */
    async attachScan(projectId, recId, { attempt, scanId }) {
      await ownProject(projectId);
      const result = await prisma.fix_verifications.updateMany({
        where: {
          recommendation_id: recId,
          project_id: projectId,
          org_id: orgId,
          attempt,
          status: 'pending',
          scan_id: null,
        },
        data: { scan_id: scanId },
      });
      return result.count === 1;
    },

    /** Write what one re-check attempt found. A finished attempt is not overwritten (a repeated job). */
    async recordVerification(
      projectId,
      recId,
      { attempt, status, scanId = null, details = null, now = new Date() },
    ) {
      await ownProject(projectId);
      const result = await prisma.fix_verifications.updateMany({
        where: {
          recommendation_id: recId,
          project_id: projectId,
          org_id: orgId,
          attempt,
          status: 'pending',
        },
        data: {
          status,
          scan_id: scanId,
          details: details == null ? undefined : toJson(details),
          checked_at: now,
        },
      });
      return result.count === 1;
    },

    /**
     * Settle the re-check: `verified` moves done → verified → measuring (the baseline was saved when it was marked
     * done); `unverified` moves done → unverified, and straight on to measuring when the reason is that no machine can
     * check this kind of fix. Does nothing if the recommendation is no longer `done` (a repeated job).
     */
    async settleVerification(
      projectId,
      recId,
      { verdict, reason, details = null, now = new Date() },
    ) {
      await ownProject(projectId);
      const rec = await findRow(prisma, projectId, recId);
      if (!rec || rec.status !== 'done') return { changed: false, status: rec?.status ?? null };
      const summary = toJson({ verdict, reason, checkedAt: now.toISOString(), ...(details ?? {}) });
      return transaction(prisma, async (tx) => {
        if (verdict === 'verified') {
          const verified = await transitionRow(tx, rec, 'verified', {
            actor: 'system',
            now,
            note: 'The re-check found the fix on your site',
            fields: { verified_at: now, verification: summary },
          });
          await transitionRow(tx, verified, 'measuring', {
            actor: 'system',
            now,
            note: 'Measuring against the baseline saved when it was marked done',
            fields: { measuring_started_at: now },
          });
          return { changed: true, status: 'measuring' };
        }
        const unverified = await transitionRow(tx, rec, 'unverified', {
          actor: 'system',
          now,
          note:
            {
              not_verifiable: 'No automatic check exists for this kind of fix',
              couldnt_check: 'We could not check your site',
              still_failing: 'The re-check still found the problem',
            }[reason] ?? null,
          fields: { verification: summary },
        });
        if (reason === 'not_verifiable') {
          await transitionRow(tx, unverified, 'measuring', {
            actor: 'system',
            now,
            note: 'Marking it done was the confirmation: measuring against the baseline',
            fields: { measuring_started_at: now },
          });
          return { changed: true, status: 'measuring' };
        }
        return { changed: true, status: 'unverified' };
      });
    },

    /** Proven wins in a project: the recommendations that ended as a proven win, and the questions they targeted. */
    async provenWins(projectId) {
      await ownProject(projectId);
      const wins = await prisma.recommendations.findMany({
        where: { project_id: projectId, org_id: orgId, status: 'proven_win' },
        select: { id: true },
      });
      if (wins.length === 0) return { recommendations: 0, questions: 0 };
      const links = await prisma.recommendation_prompts.findMany({
        where: { recommendation_id: { in: wins.map((w) => w.id) }, org_id: orgId },
        select: { prompt_id: true },
      });
      return {
        recommendations: wins.length,
        questions: new Set(links.map((l) => String(l.prompt_id))).size,
      };
    },
  };

  /** Update a live recommendation from a fresh candidate. Says whether its words were replaced (a model may rewrite them). */
  async function refresh(current, item, { runId }) {
    const editable = EDITABLE_STATUSES.includes(current.status);
    let narrativeReplaced = false;
    const data = { last_seen_run_id: runId ?? current.last_seen_run_id, signal_cleared_at: null };
    let scopeChanged = false;
    if (editable) {
      const sameEvidence = canonicalJson(current.evidence) === canonicalJson(toJson(item.evidence));
      Object.assign(data, {
        rule_version: item.ruleVersion ?? current.rule_version,
        title: item.title.slice(0, 255),
        evidence: toJson(item.evidence),
        affected_urls: item.affectedUrls?.length ? toJson(item.affectedUrls) : Prisma.DbNull,
        impact: String(item.impact),
        confidence: String(item.confidence),
        effort: item.effort,
        ice: String(item.ice),
      });
      // A narrative a model wrote stays while its evidence is unchanged; new evidence gets a new one.
      if (!sameEvidence || !current.narrative_version) {
        Object.assign(data, {
          why_md: item.why,
          steps_md: item.steps,
          narrative_version: item.narrativeVersion,
        });
        narrativeReplaced = true;
      }
      scopeChanged = true;
    }
    await prisma.recommendations.updateMany({
      where: { id: current.id, org_id: orgId, status: current.status },
      data,
    });
    if (scopeChanged) {
      const stored = await prisma.recommendation_prompts.findMany({
        where: { recommendation_id: current.id, org_id: orgId },
        select: { prompt_id: true },
      });
      const have = new Set(stored.map((s) => String(s.prompt_id)));
      const want = new Set((item.promptIds ?? []).map(String));
      if (have.size !== want.size || [...want].some((id) => !have.has(id))) {
        await replaceScope(prisma, current.id, [...want]);
      }
    }
    return { narrativeReplaced };
  }

  /** Raise a new recommendation. `{ created: true, id }`, or `{ created: false }` if another run raised it first. */
  async function raise(projectId, item, { parentId, runId, now }) {
    try {
      const id = await transaction(prisma, async (tx) => {
        const row = await tx.recommendations.create({
          data: {
            org_id: orgId,
            project_id: projectId,
            rule_code: item.ruleCode,
            rule_version: item.ruleVersion ?? 1,
            stable_key: item.stableKey,
            category: item.category,
            fix_path: item.fixPath,
            title: item.title.slice(0, 255),
            why_md: item.why,
            steps_md: item.steps,
            narrative_version: item.narrativeVersion,
            evidence: toJson(item.evidence),
            affected_urls: item.affectedUrls?.length ? toJson(item.affectedUrls) : undefined,
            impact: String(item.impact),
            confidence: String(item.confidence),
            effort: item.effort,
            ice: String(item.ice),
            status: 'open',
            status_changed_at: now,
            first_seen_run_id: runId,
            last_seen_run_id: runId,
            parent_recommendation_id: parentId,
          },
          select: { id: true },
        });
        await replaceScope(tx, row.id, item.promptIds ?? []);
        await tx.recommendation_events.create({
          data: {
            org_id: orgId,
            recommendation_id: row.id,
            from_status: null,
            to_status: 'open',
            actor_type: 'system',
            note: parentId
              ? 'Raised again: the earlier fix made things worse'
              : 'Raised from evidence',
            created_at: now,
          },
        });
        return row.id;
      });
      return { created: true, id };
    } catch (err) {
      // Another refresh raised the same issue between our read and our write: the unique key held.
      if (!isUniqueViolation(err)) throw err;
      return { created: false };
    }
  }

  const outcomes = {
    /**
     * Take the next due before/after measurement of a recommendation that is measuring, and act on it. The baseline was
     * saved when it was marked done; the after window is the runs queued since measuring started. Safe to repeat: an
     * outcome is unique per recommendation and horizon.
     *
     * @returns `{ skipped }` when nothing is due, or `{ horizon, verdict, status }` (`status` is the recommendation's
     *          status afterwards)
     */
    async measure(projectId, recId, { now = new Date() } = {}) {
      await ownProject(projectId);
      const rec = await findRow(prisma, projectId, recId);
      if (!rec || rec.status !== 'measuring' || !rec.measuring_started_at || !rec.baseline) {
        return { skipped: 'not_measuring' };
      }
      const have = (
        await prisma.action_outcomes.findMany({
          where: { recommendation_id: rec.id, org_id: orgId },
          select: { horizon: true },
        })
      ).map((o) => o.horizon);
      const horizon = nextDueHorizon({ startedAt: rec.measuring_started_at, have, now });
      if (!horizon) return { skipped: 'not_due' };

      const brand = await brandOf(projectId);
      const baseline = rec.baseline;
      const window = afterWindow(rec.measuring_started_at, horizon);
      const cells = await cellsFor(prisma, projectId, brand?.id, baseline.promptIds ?? [], window);
      const after = countWindow({ cells, promptIds: baseline.promptIds ?? [], window });
      const result = measureOutcome({ baseline: { n: baseline.n, k: baseline.k }, after });

      try {
        await prisma.action_outcomes.create({
          data: {
            org_id: orgId,
            project_id: projectId,
            recommendation_id: rec.id,
            horizon,
            engine_scope: 'all',
            prompts_count: (baseline.promptIds ?? []).length,
            baseline_run_ids: toJson(baseline.runIds ?? []),
            after_run_ids: toJson(after.runIds),
            n_before: baseline.n,
            k_before: baseline.k,
            n_after: after.n,
            k_after: after.k,
            rate_before: result.rateBefore == null ? null : result.rateBefore.toFixed(4),
            rate_after: result.rateAfter == null ? null : result.rateAfter.toFixed(4),
            delta_pp: result.deltaPp == null ? null : String(result.deltaPp),
            p_value: result.p == null ? null : Math.min(0.99999999, result.p).toFixed(8),
            verdict: result.verdict,
            computed_at: now,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) return { skipped: 'repeated' };
        throw err;
      }
      const next = statusAfterOutcome(result.verdict, horizon);
      let status = rec.status;
      if (next) {
        await transaction(prisma, async (tx) => {
          await transitionRow(tx, rec, next, {
            actor: 'system',
            now,
            note: `${HORIZONS[horizon].label} check: ${result.verdict.replaceAll('_', ' ')}`,
          });
        }).catch((err) => {
          // Someone else moved it first (a repeated job): the outcome row is written, which is what counts.
          if (!(err instanceof DomainError)) throw err;
        });
        status = next;
      }
      return { horizon, verdict: result.verdict, status, nBefore: baseline.n, nAfter: after.n };
    },

    /** The measured outcomes of a project's recommendations, newest first. */
    async recent(projectId, { limit = 20 } = {}) {
      await ownProject(projectId);
      const rows = await prisma.action_outcomes.findMany({
        where: { project_id: projectId, org_id: orgId },
        orderBy: [{ computed_at: 'desc' }, { id: 'desc' }],
        take: Math.min(limit, 100),
      });
      return rows.map(toOutcome);
    },
  };

  return { recommendations, outcomes };
}
