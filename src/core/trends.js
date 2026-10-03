import { compareWindows } from './significance.js';

/**
 * Finding the changes worth telling a customer about (MVP §6.3). Pure: daily rollup rows in, change events out.
 *
 * The trailing 28 days are compared with the 28 days before them. A change is reported only if the significance
 * test says so (core/significance.js); "within normal variation" and "not enough data" produce nothing.
 *
 * Which days count: a day whose engine did not finish cleanly (`cellsPartial > 0`) is left out of BOTH windows for
 * that engine. Its readable answers are real, but a half-collected week must not look like a drop or a rise: a
 * trend line made of weeks with different coverage would flag our own outages as the customer's decline.
 */

const DAY_MS = 86_400_000;

export const TREND_WINDOW_DAYS = 28;

const toDay = (value) =>
  new Date(
    `${(value instanceof Date ? value.toISOString() : String(value)).slice(0, 10)}T00:00:00Z`,
  );
const dayString = (date) => date.toISOString().slice(0, 10);
const addDays = (day, n) => dayString(new Date(toDay(day).getTime() + n * DAY_MS));

/** The two windows ending on `asOf`: `{ before: [start, end], after: [start, end] }`, whole UTC days, inclusive. */
export function windowsAt(asOf, days = TREND_WINDOW_DAYS) {
  const day = dayString(toDay(asOf));
  return {
    after: [addDays(day, -(days - 1)), day],
    before: [addDays(day, -(2 * days - 1)), addDays(day, -days)],
  };
}

const within = (date, [start, end]) => {
  const d = String(date).slice(0, 10);
  return d >= start && d <= end;
};

/** Rows of one window that count: they finished cleanly, optionally for one engine. */
function usable(rows, window, engineCode) {
  return rows.filter(
    (r) =>
      within(r.metricDate, window) &&
      Number(r.cellsPartial) === 0 &&
      (engineCode == null || r.engineCode === engineCode),
  );
}

const sum = (rows, pick) => rows.reduce((n, r) => n + Number(pick(r)), 0);

/** Counts `{ n, k }` of one metric for one window. */
const MEASURES = {
  mention_rate_change: ({ rows, entityId }) => {
    const mine = rows.filter((r) => String(r.entityId) === String(entityId));
    return { n: sum(mine, (r) => r.nAnswers), k: sum(mine, (r) => r.kMentioned) };
  },
  competitor_surge: (args) => MEASURES.mention_rate_change(args),
  sov_change: ({ rows, entityId }) => {
    const mine = rows.filter((r) => String(r.entityId) === String(entityId));
    return { n: sum(rows, (r) => r.kMentioned), k: sum(mine, (r) => r.kMentioned) };
  },
  citation_share_change: ({ rows, entityId }) => {
    // citationsTotal is the same on every entity row of a day and engine, so read it from the brand's row only.
    const mine = rows.filter((r) => String(r.entityId) === String(entityId));
    return { n: sum(mine, (r) => r.citationsTotal), k: sum(mine, (r) => r.citationsEntity) };
  },
};

/**
 * Significant changes as of a date.
 *
 * @param rows      `metric_daily` rows: `{ metricDate, engineCode, entityId, cellsPartial, nAnswers, kMentioned,
 *                  citationsTotal, citationsEntity }`.
 * @param brandId   the brand entity.
 * @param asOf      the day the newest window ends on (the run's date).
 * @returns events, each `{ kind, engineCode (null = all engines), entityId, before, after, nBefore, kBefore, nAfter,
 *   kAfter, valueBefore, valueAfter, deltaPp, p, direction, dedupeKey }`. Brand metrics are reported per engine
 *   and across all engines; a competitor is reported only when its mention rate went significantly UP.
 */
export function detectChanges({ rows, brandId, asOf, windowDays = TREND_WINDOW_DAYS, options }) {
  const windows = windowsAt(asOf, windowDays);
  const engines = [...new Set(rows.map((r) => r.engineCode))].sort();
  const competitors = [
    ...new Set(rows.map((r) => String(r.entityId)).filter((id) => id !== String(brandId))),
  ].sort();
  const events = [];

  const check = (kind, engineCode, entityId) => {
    const read = (window) => {
      const found = usable(rows, window, engineCode);
      return { rows: found, ...MEASURES[kind]({ rows: found, entityId }) };
    };
    const before = read(windows.before);
    const after = read(windows.after);
    const result = compareWindows(
      { n: before.n, k: before.k },
      { n: after.n, k: after.k },
      options,
    );
    if (!result.significant) return;
    if (kind === 'competitor_surge' && result.direction !== 'up') return;
    events.push({
      kind,
      engineCode,
      entityId: String(entityId),
      before: windows.before,
      after: windows.after,
      nBefore: before.n,
      kBefore: before.k,
      nAfter: after.n,
      kAfter: after.k,
      valueBefore: result.valueBefore,
      valueAfter: result.valueAfter,
      deltaPp: result.deltaPp,
      p: result.p,
      direction: result.direction,
      dedupeKey: `${kind}:${engineCode ?? 'all'}:${entityId}:${windows.after[1]}`,
    });
  };

  for (const kind of ['mention_rate_change', 'sov_change', 'citation_share_change']) {
    for (const engineCode of [null, ...engines]) check(kind, engineCode, brandId);
  }
  for (const entityId of competitors) {
    for (const engineCode of [null, ...engines]) check('competitor_surge', engineCode, entityId);
  }
  return events;
}
