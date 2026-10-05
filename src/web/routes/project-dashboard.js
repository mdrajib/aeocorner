import {
  RANGES,
  byEngine,
  citationRows,
  competitorTable,
  describeChange,
  headline,
  incompleteNotice,
  matrixCell,
  rangeKey,
  staleNotice,
  trendSeries,
  winRate,
} from '../../core/dashboard.js';
import { ENGINE_LABELS, ENGINE_ORDER } from '../../core/engines.js';
import { PAGE_FORMAT_LABELS } from '../../core/citation-format.js';
import {
  ownPageRows,
  rankOpportunities,
  uncitedKeyPages,
  weeklyCitationShare,
} from '../../core/citation-opportunities.js';
import { classifyDomain, SOURCE_TYPE_LABELS, typeBreakdown } from '../../core/citation-types.js';
import { describeRun, isRunning } from '../../core/run-status.js';
import { windowsAt } from '../../core/trends.js';
import { listItem } from '../../core/action-center.js';
import { DomainError } from '../../db/index.js';
import { notFound } from '../middleware/errors.js';
import { dateLabel, idFrom, text, withNotice } from './project-helpers.js';

/**
 * The dashboard screens of one project (Milestone 5, UI_DESIGN group C). They register on the project router.
 *
 *   GET  /projects/:pid/dashboard               C1  the figures, the trend, the engines, the competitors, what changed
 *   GET  /projects/:pid/answers                 C2  the question matrix
 *   GET  /projects/:pid/answers/:qid            C3  one question: its history and its answers, with feedback buttons
 *   POST /projects/:pid/answers/:qid/report         "That's not us" / "This answer was misread" → the review queue
 *   GET  /projects/:pid/compare                     the brand against its competitors
 *   GET  /projects/:pid/citations               C4  the sources AI cites, and where the brand is missing from them
 *
 * Every number comes from `src/core/dashboard.js` over stored sums; a template never computes one. Anything that could
 * not be read stays "Couldn’t check": it is never drawn as zero or as "not mentioned".
 */

const shortDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

const METHOD_LABELS = {
  ui_capture: 'as a visitor sees the answer',
  api_grounded: 'through the engine’s API, with web search on',
  serp: 'from the search results page',
};

const STANCE_LABELS = {
  recommended: 'Recommended',
  neutral: 'Mentioned',
  cautioned: 'Mentioned with a caution',
  not_recommended: 'Not recommended',
};

const SENTIMENT_LABELS = {
  '-2': 'very negative',
  '-1': 'negative',
  0: 'neutral',
  1: 'positive',
  2: 'very positive',
};

/** `ui.stat` props for one headline figure. */
function statOf(tile, label, extra = {}) {
  if (tile.state === 'unknown') return { label, state: 'unknown', note: tile.note, ...extra };
  if (tile.state === 'empty') return { label, value: '—', note: tile.note, ...extra };
  return {
    label,
    value: tile.display,
    delta: tile.change
      ? {
          direction: tile.change.direction,
          text: tile.change.text,
          significant: tile.change.significant,
        }
      : undefined,
    interval: tile.interval ? `95% range ${tile.interval.low}–${tile.interval.high}%` : undefined,
    note: tile.note,
    ...extra,
  };
}

export function dashboardRoutes(router, { appPage, edit, logger }) {
  const tabs = (req, res) => ({
    orgBase: res.locals.orgBase,
    projectBase: res.locals.projectBase,
    projectName: req.project.name,
  });

  /** What every dashboard screen needs: the period, the people we track, the engines and the latest checks. */
  async function frame(req, res, current) {
    const key = rangeKey(req.query.range);
    const { days, label } = RANGES[key];
    const today = new Date().toISOString().slice(0, 10);
    const windows = windowsAt(today, days);
    const [entities, engines, runs] = await Promise.all([
      req.orgDb.entities.list(req.project.id),
      req.orgDb.projectEngines.list(req.project.id),
      req.orgDb.runs.recent(req.project.id, { limit: 5 }),
    ]);
    const brand = entities.find((e) => e.kind === 'brand');
    const latest = runs[0] ?? null;
    if (isRunning(latest)) res.locals.refreshSeconds = 10;
    const finished = runs.find((r) => r.finished_at && ['complete', 'partial'].includes(r.status));
    const base = res.locals.projectBase;
    return {
      key,
      days,
      today,
      windows,
      brand,
      brandId: brand ? String(brand.id) : null,
      tracked: entities
        .filter((e) => e.kind === 'brand' || (e.kind === 'competitor' && e.status === 'active'))
        .map((e) => ({ id: String(e.id), name: e.name, kind: e.kind })),
      engineCodes: ENGINE_ORDER.filter((c) =>
        engines.some((e) => e.engine_code === c && e.enabled),
      ),
      latest,
      lastRun: describeRun(latest),
      updatedLabel: finished ? dateLabel(finished.finished_at) : null,
      stale: staleNotice(finished?.finished_at ?? null),
      ranges: Object.entries(RANGES).map(([id, r]) => ({
        label: r.label,
        href: `${base}/${current}?range=${id}`,
        current: id === key,
      })),
      rangeLabel: label,
    };
  }

  /** The state shown instead of a screen while tracking is off. */
  function off(req, res, title) {
    return appPage(res, 'dashboard-off', {
      ...tabs(req, res),
      domain: '',
      current: 'dashboard',
      title,
      canEdit: res.locals.can('strategy.edit'),
      meta: { title: `${title} · ${req.project.name} | AEO Corner`, description: title },
    });
  }

  const meta = (req, title) => ({
    title: `${title} · ${req.project.name} | AEO Corner`,
    description: `${title} for ${req.project.name}.`,
  });

  // --- C1 The dashboard ---------------------------------------------------------------------------------
  router.get('/projects/:pid/dashboard', async (req, res, next) => {
    try {
      if (req.project.status !== 'active') return off(req, res, 'Dashboard');
      const f = await frame(req, res, 'dashboard');
      const rows = await req.orgDb.metrics.range(req.project.id, {
        from: f.windows.before[0],
        to: f.windows.after[1],
      });
      const figures = headline({ rows, brandId: f.brandId, asOf: f.today, days: f.days });
      const trend = trendSeries({
        rows,
        brandId: f.brandId,
        from: f.windows.after[0],
        to: f.windows.after[1],
      });
      const [events, topRows, wins] = await Promise.all([
        req.orgDb.changes.forProject(req.project.id, { limit: 5 }),
        req.orgDb.recommendations.top(req.project.id, 3),
        req.orgDb.recommendations.provenWins(req.project.id),
      ]);
      const names = new Map(f.tracked.map((e) => [e.id, e.name]));
      const base = res.locals.projectBase;
      const t = figures.tiles;
      const periodDays = new Set(
        rows
          .filter((r) => r.metricDate >= f.windows.after[0] && r.metricDate <= f.windows.after[1])
          .map((r) => r.metricDate),
      );
      const competitors = competitorTable({
        rows,
        entities: f.tracked,
        brandId: f.brandId,
        asOf: f.today,
        days: f.days,
      });
      return appPage(res, 'dashboard', {
        ...tabs(req, res),
        domain: f.brand?.primary_domain ?? '',
        charts: true,
        current: 'dashboard',
        ranges: f.ranges,
        rangeLabel: f.rangeLabel,
        updatedLabel: f.updatedLabel,
        lastRun: f.lastRun,
        stale: f.stale,
        hasData: figures.hasData,
        incomplete: incompleteNotice(figures.coverage, ENGINE_LABELS),
        baseline: figures.hasData && periodDays.size <= 1,
        tiles: [
          statOf(t.visibility, 'AI Visibility Score', { href: `${base}/answers` }),
          statOf(t.mentionRate, 'Mention rate', { href: `${base}/answers` }),
          statOf(t.shareOfVoice, 'Share of voice', {
            href: `${base}/compare`,
            hrefLabel: 'See the competitors',
          }),
          statOf(t.citationShare, 'Citation share', {
            href: `${base}/citations`,
            hrefLabel: 'See the sources',
          }),
        ],
        more: [
          statOf(t.position, 'Average position'),
          statOf(t.sentiment, 'Sentiment'),
          statOf(t.recommendationRate, 'Recommendation rate'),
        ],
        chart: {
          labels: trend.map((p) => shortDate(p.date)),
          values: trend.map((p) => p.value),
          low: trend.map((p) => p.low),
          high: trend.map((p) => p.high),
          summary: trend.length
            ? `Line chart of your mention rate over ${trend.length} ${trend.length === 1 ? 'check' : 'checks'}, ` +
              `from ${trend[0].value == null ? 'no reading' : `${trend[0].value}%`} to ${trend.at(-1).value == null ? 'no reading' : `${trend.at(-1).value}%`}.`
            : '',
          gaps: trend.some((p) => p.gap),
        },
        engines: byEngine({
          rows,
          brandId: f.brandId,
          engineCodes: f.engineCodes,
          asOf: f.today,
          days: f.days,
        }).map((e) => ({ ...e, name: ENGINE_LABELS[e.engineCode] ?? e.engineCode })),
        competitors: competitors.slice(0, 5),
        topActions: topRows.map((r) =>
          listItem({ ...r, questions: 0 }, { projectBase: base, brandName: f.brand?.name }),
        ),
        wins,
        changes: events.map((e) =>
          describeChange(e, {
            entityName: names.get(String(e.entity_id)),
            engineNames: ENGINE_LABELS,
          }),
        ),
        meta: meta(req, 'Dashboard'),
      });
    } catch (err) {
      return next(err);
    }
  });

  // --- C2 The question matrix ---------------------------------------------------------------------------
  router.get('/projects/:pid/answers', async (req, res, next) => {
    try {
      if (req.project.status !== 'active') return off(req, res, 'Questions and answers');
      const f = await frame(req, res, 'answers');
      const { prompts, cells } = await req.orgDb.dashboard.matrix(req.project.id, {
        from: f.windows.after[0],
        to: f.windows.after[1],
      });
      const byCell = new Map(cells.map((c) => [`${c.promptId}|${c.engineCode}`, c]));
      const base = res.locals.projectBase;
      return appPage(res, 'answers', {
        ...tabs(req, res),
        domain: f.brand?.primary_domain ?? '',
        current: 'answers',
        ranges: f.ranges,
        updatedLabel: f.updatedLabel,
        stale: f.stale,
        lastRun: f.lastRun,
        engines: f.engineCodes.map((code) => ({ code, name: ENGINE_LABELS[code] })),
        rows: prompts.map((p) => ({
          id: String(p.id),
          text: p.text,
          href: `${base}/answers/${p.id}`,
          cells: f.engineCodes.map((code) => ({
            code,
            ...matrixCell(byCell.get(`${p.id}|${code}`)),
          })),
        })),
        meta: meta(req, 'Questions and answers'),
      });
    } catch (err) {
      return next(err);
    }
  });

  // --- C3 One question ----------------------------------------------------------------------------------
  async function drilldown(req, res) {
    const qid = idFrom(req.params.qid);
    const f = await frame(req, res, `answers/${req.params.qid}`);
    const detail = qid
      ? await req.orgDb.dashboard.question(req.project.id, qid, {
          from: f.windows.after[0],
          to: f.windows.after[1],
        })
      : null;
    if (!detail) return notFound(req, res);
    const answers = await req.orgDb.dashboard.answers(req.project.id, qid);
    const reports = answers
      ? await req.orgDb.dashboard.reportsFor(
          req.project.id,
          answers.snapshots.map((s) => s.id),
        )
      : [];
    const reported = new Set(reports.map((r) => `${r.snapshotId}|${r.kind}`));

    // One line per engine over the check dates, with a gap wherever the cell could not be read.
    const dates = [...new Set(detail.history.map((h) => h.runDate))].sort();
    const series = f.engineCodes.map((code) => ({
      label: ENGINE_LABELS[code],
      values: dates.map((date) => {
        const cell = detail.history.find((h) => h.engineCode === code && h.runDate === date);
        if (!cell || cell.status !== 'complete' || cell.nOk === 0) return null;
        return Math.round((100 * cell.kMentioned) / cell.nOk);
      }),
    }));

    const brandId = f.brandId;
    const grouped = ENGINE_ORDER.map((code) => ({
      code,
      name: ENGINE_LABELS[code],
      samples: (answers?.snapshots ?? [])
        .filter((s) => s.engineCode === code)
        .map((s) => ({
          ...s,
          methodLabel: METHOD_LABELS[s.method] ?? '',
          brandNamed: s.mentions.some((m) => String(m.entityId) === brandId),
          highlights: s.mentions.flatMap((m) => {
            const kind = String(m.entityId) === brandId ? 'brand' : 'competitor';
            return [...new Set([m.name, m.nameAsWritten])].map((term) => ({ term, kind }));
          }),
          mentions: s.mentions.map((m) => ({
            ...m,
            isBrand: String(m.entityId) === brandId,
            stanceLabel: STANCE_LABELS[m.stance] ?? 'Mentioned',
            sentimentLabel: m.sentiment == null ? null : SENTIMENT_LABELS[m.sentiment],
          })),
          citations: s.citations.map((c) => ({
            ...c,
            safeUrl: /^https?:\/\//i.test(c.url ?? '') ? c.url : null,
          })),
          reportedNotUs: reported.has(`${s.id}|not_us`),
          reportedMisread: reported.has(`${s.id}|misread`),
        })),
    })).filter((g) => g.samples.length);

    return appPage(res, 'answer-detail', {
      ...tabs(req, res),
      domain: f.brand?.primary_domain ?? '',
      charts: true,
      current: 'answers',
      ranges: f.ranges,
      updatedLabel: f.updatedLabel,
      stale: f.stale,
      lastRun: f.lastRun,
      question: detail.prompt,
      history: detail.history.map((h) => ({
        ...h,
        engineName: ENGINE_LABELS[h.engineCode] ?? h.engineCode,
        result: matrixCell(h),
      })),
      readable: detail.readable,
      named: detail.named,
      chart: {
        labels: dates.map(shortDate),
        series,
        summary: `Line chart of how often each engine named your brand for this question over ${dates.length} ${dates.length === 1 ? 'check' : 'checks'}.`,
      },
      answers: answers
        ? { runDate: answers.runDate, dateLabel: dateLabel(answers.runDate), groups: grouped }
        : null,
      canReport: res.locals.can('strategy.edit'),
      meta: meta(req, 'Question'),
    });
  }

  router.get('/projects/:pid/answers/:qid', async (req, res, next) => {
    try {
      if (req.project.status !== 'active') return off(req, res, 'Questions and answers');
      return await drilldown(req, res);
    } catch (err) {
      return next(err);
    }
  });

  const REPORT_KINDS = ['not_us', 'misread'];
  router.post('/projects/:pid/answers/:qid/report', edit, async (req, res, next) => {
    try {
      const qid = idFrom(req.params.qid);
      const snapshotId = idFrom(req.body.snapshot);
      const kind = REPORT_KINDS.includes(req.body.kind) ? req.body.kind : null;
      const back = (notice) =>
        res.redirect(
          303,
          withNotice(`${res.locals.projectBase}/answers/${req.params.qid}`, notice),
        );
      if (!qid || !snapshotId || !kind) return back('report-invalid');
      // The answer must be one of THIS question's, not just any answer of the project.
      const answers = await req.orgDb.dashboard.answers(req.project.id, qid);
      const answer = answers?.snapshots.find((s) => s.id === snapshotId);
      if (!answer) return notFound(req, res);
      const brand = (await req.orgDb.entities.list(req.project.id, { kind: 'brand' }))[0];
      try {
        const result = await req.orgDb.dashboard.reportAnswer(req.project.id, {
          snapshotId,
          kind,
          // "That's not us" is about the brand's own mention in the answer.
          entityId:
            kind === 'not_us' && answer.mentions.some((m) => m.entityId === brand?.id)
              ? brand.id
              : null,
          comment: text(req.body.comment, 1000),
          userId: req.user.id,
        });
        return back(result.created ? 'report-sent' : 'report-repeat');
      } catch (err) {
        if (err instanceof DomainError) {
          logger.warn({ code: err.code }, 'Answer report refused');
          return back('report-invalid');
        }
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  });

  // --- Competitors ---------------------------------------------------------------------------------------
  router.get('/projects/:pid/compare', async (req, res, next) => {
    try {
      if (req.project.status !== 'active') return off(req, res, 'Competitors');
      const f = await frame(req, res, 'compare');
      const rows = await req.orgDb.metrics.range(req.project.id, {
        from: f.windows.before[0],
        to: f.windows.after[1],
      });
      const table = competitorTable({
        rows,
        entities: f.tracked,
        brandId: f.brandId,
        asOf: f.today,
        days: f.days,
      });
      const cells = await req.orgDb.dashboard.competitorCells(req.project.id, {
        from: f.windows.after[0],
        to: f.windows.after[1],
      });
      const head = headline({ rows, brandId: f.brandId, asOf: f.today, days: f.days });
      return appPage(res, 'compare', {
        ...tabs(req, res),
        domain: f.brand?.primary_domain ?? '',
        charts: true,
        current: 'compare',
        ranges: f.ranges,
        updatedLabel: f.updatedLabel,
        stale: f.stale,
        lastRun: f.lastRun,
        incomplete: incompleteNotice(head.coverage, ENGINE_LABELS),
        hasData: head.hasData,
        competitorCount: f.tracked.length - 1,
        rows: table.map((r) => ({
          ...r,
          wins: r.isBrand ? null : winRate({ cells, brandId: f.brandId, competitorId: r.entityId }),
        })),
        meta: meta(req, 'Competitors'),
      });
    } catch (err) {
      return next(err);
    }
  });

  // --- C4 Citations --------------------------------------------------------------------------------------
  router.get('/projects/:pid/citations', async (req, res, next) => {
    try {
      if (req.project.status !== 'active') return off(req, res, 'Sources');
      const f = await frame(req, res, 'citations');
      const range = { from: f.windows.after[0], to: f.windows.after[1] };
      const [cited, who, oppRows, own, keyPages, daily] = await Promise.all([
        req.orgDb.dashboard.citations(req.project.id, { ...range, limit: 100 }),
        req.orgDb.dashboard.citationContext(req.project.id),
        req.orgDb.dashboard.citationOpportunityRows(req.project.id, range),
        req.orgDb.dashboard.ownPageCitations(req.project.id, range),
        req.orgDb.dashboard.keyPages(req.project.id),
        req.orgDb.dashboard.citationShareDaily(req.project.id, {
          from: f.windows.before[0],
          to: f.windows.after[1],
        }),
      ]);
      const { rows: allRows, gaps } = citationRows({ domains: cited.domains, total: cited.total });
      // Our own reading of what kind of site each is (src/core/citation-types.js), not the stored guess.
      const kindOf = (d) => (d.own ? 'own' : classifyDomain(d.domain, who));
      const rows = allRows
        .map((r) => ({ ...r, classLabel: SOURCE_TYPE_LABELS[kindOf(r)] }))
        .slice(0, 25);
      const { byQuestion, bySite } = rankOpportunities(oppRows, who);
      const ownRows = ownPageRows(own.pages);
      const never = uncitedKeyPages({
        keyPages,
        cited: ownRows,
        ownCitations: own.ownCitations,
        homeUrl: who.homeUrl,
      });
      const trend = weeklyCitationShare(daily, {
        from: f.windows.before[0],
        to: f.windows.after[1],
      });
      const tab = ['overview', 'opportunities', 'pages'].includes(req.query.tab)
        ? req.query.tab
        : 'overview';
      return appPage(res, 'citations', {
        ...tabs(req, res),
        domain: f.brand?.primary_domain ?? '',
        charts: true,
        current: 'citations',
        ranges: f.ranges,
        updatedLabel: f.updatedLabel,
        stale: f.stale,
        lastRun: f.lastRun,
        tab,
        total: cited.total,
        rows,
        gaps: gaps.slice(0, 10).map((g) => ({ ...g, classLabel: SOURCE_TYPE_LABELS[kindOf(g)] })),
        urls: cited.urls,
        types: typeBreakdown(cited.domains, who),
        trend,
        questions: byQuestion.slice(0, 10),
        sites: bySite.slice(0, 10),
        pageFormats: PAGE_FORMAT_LABELS,
        ownPages: ownRows.slice(0, 15).map((p) => ({
          ...p,
          engineLabels: p.engines.map((c) => ENGINE_LABELS[c] ?? c),
        })),
        ownCitations: own.ownCitations,
        never: never.slice(0, 10),
        scanned: keyPages.length > 0,
        actionsHref: `${res.locals.projectBase}/actions`,
        meta: meta(req, 'Sources'),
      });
    } catch (err) {
      return next(err);
    }
  });
}
