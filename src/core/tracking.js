import { presenceValue } from './visibility.js';

/**
 * The rules of a tracking run (MVP F4, §6.3, §6.5). Pure: the database layer reads the answers and writes what
 * these functions return, so every number on the dashboard can be checked by hand.
 *
 * A run is a grid: each active question × each enabled engine × a few samples. Each sample is one answer, and an
 * answer is one of four things: `ok` (read it), `no_answer` (the engine said it had none, e.g. no AI Overview),
 * `failed` (we could not check) or `pending` (still out). Only `ok` answers say anything about the brand.
 * A failed or pending answer is never "not mentioned": it leaves every count except the "couldn't check" ones.
 */

/** How many answers to collect for one engine in one cell: the plan's cap on the engine's own default. */
export function samplesFor({ engineDefault, planSamples, override = null }) {
  const wanted = override ?? Math.min(engineDefault, planSamples ?? engineDefault);
  return Math.max(1, Math.min(10, Math.floor(wanted)));
}

/**
 * Expand a run: every question on every engine, `samples` times. `engines` is `[{ code, samples }]`.
 * Order is stable (question, engine, sample) so a repeated planner makes the same list.
 */
export function planTasks({ prompts, engines }) {
  const tasks = [];
  for (const p of prompts) {
    for (const e of engines) {
      for (let sampleIdx = 0; sampleIdx < e.samples; sampleIdx += 1) {
        tasks.push({ promptId: p.id, engineCode: e.code, sampleIdx });
      }
    }
  }
  return tasks;
}

/** An answer's final state for counting: a pending one at settle time is one we could not check. */
const settled = (status) => (status === 'pending' ? 'failed' : status);

/**
 * One cell (question × engine): how many answers were planned and how each ended.
 *   complete   every answer read
 *   no_answer  the engine had none to give, every time (no AI Overview)
 *   partial    some read, some failed
 *   failed     nothing could be read
 */
export function classifyCell(samples) {
  const count = { ok: 0, no_answer: 0, failed: 0 };
  for (const s of samples) count[settled(s.status)] += 1;
  const nPlanned = samples.length;
  let status;
  if (count.failed === 0) status = count.ok > 0 ? 'complete' : 'no_answer';
  else status = count.ok + count.no_answer > 0 ? 'partial' : 'failed';
  return {
    status,
    nPlanned,
    nOk: count.ok,
    nNoAnswer: count.no_answer,
    nFailed: count.failed,
  };
}

const okSamples = (samples) => samples.filter((s) => s.status === 'ok');

/** Does this sample cite a page of the entity? (Its own domain, or a citation that supports it.) */
function citesEntity(sample, entityId) {
  return (sample.citations ?? []).some(
    (c) =>
      (c.ownerEntityId != null && String(c.ownerEntityId) === String(entityId)) ||
      (c.supportsEntityIds ?? []).some((id) => String(id) === String(entityId)),
  );
}

const mentionOf = (sample, entityId) =>
  (sample.mentions ?? []).find((m) => String(m.entityId) === String(entityId)) ?? null;

/**
 * s(p,e): the brand's average presence value over the cell's readable answers (MVP §6.5), 0 to 1, or null when no
 * answer was readable. The brand's own domain being cited counts when the brand is not named.
 */
export function cellScore(samples, brandId) {
  const read = okSamples(samples);
  if (read.length === 0) return null;
  let total = 0;
  for (const s of read) {
    const m = mentionOf(s, brandId);
    const ownCited = (s.citations ?? []).some((c) => c.isOwn) || citesEntity(s, brandId);
    total += presenceValue({
      brandPresent: Boolean(m),
      brandRank: m?.listRank ?? null,
      brandStance: m?.stance ?? null,
      domainCited: ownCited,
    });
  }
  return Math.round((total / read.length) * 10000) / 10000;
}

/**
 * The sums for one tracked entity in one cell: in how many of the readable answers it was named, recommended and
 * cited, and its list ranks and sentiment (sums and counts, never averages, so cells add up).
 */
export function entityTally(samples, entityId, { isBrand = false } = {}) {
  const t = {
    kMentioned: 0,
    kRecommended: 0,
    kCited: 0,
    rankSum: 0,
    rankN: 0,
    bestRank: null,
    sentimentSum: 0,
    sentimentN: 0,
  };
  for (const s of okSamples(samples)) {
    const m = mentionOf(s, entityId);
    if (m) {
      t.kMentioned += 1;
      if (m.stance === 'recommended') t.kRecommended += 1;
      if (Number.isInteger(m.listRank) && m.listRank >= 1) {
        t.rankSum += m.listRank;
        t.rankN += 1;
        t.bestRank = t.bestRank === null ? m.listRank : Math.min(t.bestRank, m.listRank);
      }
      if (Number.isInteger(m.sentiment)) {
        t.sentimentSum += m.sentiment;
        t.sentimentN += 1;
      }
    }
    if (citesEntity(s, entityId) || (isBrand && hasOwn(s))) {
      t.kCited += 1;
    }
  }
  return t;
}

const hasOwn = (s) => (s.citations ?? []).some((c) => c.isOwn);

/**
 * Every cell of a run from its answers.
 *
 * @param samples  `{ promptId, engineCode, sampleIdx, status, mentions: [{ entityId, listRank, stance, sentiment }],
 *                 citations: [{ ownerEntityId, isOwn, supportsEntityIds }] }`, one per planned answer.
 * @param brandId  the project's brand entity.
 * @param entityIds  the tracked entities to tally (brand and competitors).
 * @returns cells, `{ promptId, engineCode, status, nPlanned, nOk, nNoAnswer, nFailed, cellScore, citationsTotal,
 *   citationsOwn, entities: [{ entityId, ...tally }] }`. An entity appears only if it was named or cited.
 */
export function buildCells({ samples, brandId, entityIds }) {
  const groups = new Map();
  for (const s of samples) {
    const key = `${s.promptId}|${s.engineCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const cells = [];
  for (const group of groups.values()) {
    const read = okSamples(group);
    const entities = [];
    for (const entityId of entityIds) {
      const t = entityTally(group, entityId, { isBrand: String(entityId) === String(brandId) });
      if (t.kMentioned > 0 || t.kCited > 0) entities.push({ entityId, ...t });
    }
    cells.push({
      promptId: group[0].promptId,
      engineCode: group[0].engineCode,
      ...classifyCell(group),
      cellScore: cellScore(group, brandId),
      citationsTotal: read.reduce((n, s) => n + (s.citations ?? []).length, 0),
      citationsOwn: read.reduce(
        (n, s) =>
          n +
          (s.citations ?? []).filter(
            (c) =>
              c.isOwn || (c.ownerEntityId != null && String(c.ownerEntityId) === String(brandId)),
          ).length,
        0,
      ),
      entities,
    });
  }
  return cells.sort((a, b) =>
    a.promptId === b.promptId
      ? a.engineCode.localeCompare(b.engineCode)
      : a.promptId < b.promptId
        ? -1
        : 1,
  );
}

/**
 * How a whole run ended, from its cells' answers. `failed` only when not one answer could be read; `partial` when
 * any could not; otherwise `complete`. A partial run still has numbers, but they never count towards a trend.
 */
export function runOutcome(samples) {
  let ok = 0;
  let noAnswer = 0;
  let failed = 0;
  for (const s of samples) {
    const status = settled(s.status);
    if (status === 'ok') ok += 1;
    else if (status === 'no_answer') noAnswer += 1;
    else failed += 1;
  }
  const status = ok + noAnswer === 0 && failed > 0 ? 'failed' : failed > 0 ? 'partial' : 'complete';
  return {
    status,
    tasksPlanned: samples.length,
    tasksOk: ok,
    tasksNoAnswer: noAnswer,
    tasksFailed: failed,
  };
}

/**
 * The daily rollup rows (`metric_daily`) for one date: one per engine × tracked entity, holding sums only.
 *
 * @param cells          cell rows of every complete or partial run that day (as `buildCells` returns, with
 *                       `entities`), each with `engineCode`, `promptId`, `status`, `nOk`, `nNoAnswer`.
 * @param entityIds      the tracked entities to write a row for, brand first; an entity not named anywhere still
 *                       gets its row (with its n), because "0 of 30" and "no data" are different things.
 * @param brandId        the brand entity: only its row carries the visibility sums.
 * @param promptWeights  `{ [promptId]: 1-3 }`, defaulting to 1.
 * @param engineWeights  `{ [engineCode]: weight }`, defaulting to 1.
 * @param citationCounts `{ [engineCode]: { total, byEntity: { [entityId]: n } } }` from the citations table.
 *
 * `cellsPartial` counts cells that did not finish cleanly (partial or failed), so a screen can say "incomplete".
 * Their readable answers are still in n and k; the trend code leaves such days out of significance tests.
 */
export function rollupDay({
  cells,
  entityIds,
  brandId,
  promptWeights = {},
  engineWeights = {},
  citationCounts = {},
}) {
  const engines = [...new Set(cells.map((c) => c.engineCode))].sort();
  const rows = [];
  for (const engineCode of engines) {
    const mine = cells.filter((c) => c.engineCode === engineCode);
    const readableAnswers = mine.reduce((n, c) => n + c.nOk, 0);
    const noAnswers = mine.reduce((n, c) => n + c.nNoAnswer, 0);
    const cites = citationCounts[engineCode] ?? { total: 0, byEntity: {} };

    let visTop = 0;
    let visBottom = 0;
    for (const c of mine) {
      if (c.cellScore == null) continue;
      const w = (promptWeights[c.promptId] ?? 1) * (engineWeights[engineCode] ?? 1);
      visTop += w * c.cellScore;
      visBottom += w;
    }

    for (const entityId of entityIds) {
      const isBrand = String(entityId) === String(brandId);
      const sums = {
        kMentioned: 0,
        kRecommended: 0,
        kCited: 0,
        rankSum: 0,
        rankN: 0,
        sentimentSum: 0,
        sentimentN: 0,
      };
      for (const c of mine) {
        const e = c.entities.find((x) => String(x.entityId) === String(entityId));
        if (!e) continue;
        for (const key of Object.keys(sums)) sums[key] += e[key];
      }
      rows.push({
        engineCode,
        entityId,
        cellsTotal: mine.length,
        cellsPartial: mine.filter((c) => c.status === 'partial' || c.status === 'failed').length,
        nAnswers: readableAnswers,
        ...sums,
        citationsTotal: cites.total,
        citationsEntity: cites.byEntity?.[String(entityId)] ?? 0,
        visWeightedSum: isBrand && visBottom > 0 ? round4(visTop) : null,
        visWeightTotal: isBrand && visBottom > 0 ? round4(visBottom) : null,
        aioQueries: engineCode === 'google_aio' ? readableAnswers + noAnswers : null,
        aioTriggered: engineCode === 'google_aio' ? readableAnswers : null,
      });
    }
  }
  return rows;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

/** The AI Visibility Score of a day's brand rows, 0-100, or null when nothing was readable. */
export function visibilityOfRows(brandRows) {
  let top = 0;
  let bottom = 0;
  for (const r of brandRows) {
    if (r.visWeightTotal == null || Number(r.visWeightTotal) <= 0) continue;
    top += Number(r.visWeightedSum);
    bottom += Number(r.visWeightTotal);
  }
  return bottom > 0 ? Math.round((100 * top) / bottom) : null;
}
