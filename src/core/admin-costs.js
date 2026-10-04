/**
 * The cost and margin screen's arithmetic (Milestone 8, task 8.17; ADMIN_OPERATIONS module 5). Pure: totals from the cost
 * ledger come in, margins, anomalies and cost per answer go out. Money is whole micro-dollars until the last step.
 */

/** Extraction and collection of one answer should cost no more than this on average (MVP §12; the weekly runbook target). */
export const TARGET_COST_PER_ANSWER_MICROS = 40_000; // $0.04: the ≈ $0.12 a question-run of three samples
export const MARGIN_TARGET_PCT = 70;
/** Today's spend above this multiple of the recent daily average is an anomaly (ADMIN_OPERATIONS §7: 150% of budget). */
export const ANOMALY_FACTOR = 1.5;

export const usd = (micros, digits = 2) =>
  `${micros < 0 ? '−' : ''}$${(Math.abs(micros) / 1_000_000).toFixed(digits)}`;
const pctText = (n) => `${Math.round(n)}%`;

/**
 * Margin on a plan or an organization: what it pays against what it cost us in the same period. An organization that pays
 * nothing (a trial, a design partner, no plan) has no margin to speak of, never "−100%".
 *
 * @param {{ revenueMicros: number, costMicros: number }} input
 */
export function margin({ revenueMicros, costMicros }) {
  if (!(revenueMicros > 0)) {
    return { state: 'no_revenue', pct: null, text: 'No revenue', profitMicros: -costMicros };
  }
  const profitMicros = revenueMicros - costMicros;
  const pct = (profitMicros / revenueMicros) * 100;
  return {
    state: pct >= MARGIN_TARGET_PCT ? 'on_target' : pct >= 0 ? 'below_target' : 'loss',
    pct,
    text: pctText(pct),
    profitMicros,
  };
}

/**
 * Per-plan figures from per-organization ones: `rows` are `{ orgId, planCode, billingStatus, priceMicros, costMicros }`.
 * Only an organization that is paying (`active`) counts as revenue; a trial's cost is still counted, as the cost of winning
 * customers, under the plan it is on.
 */
export function byPlan(rows) {
  const plans = new Map();
  for (const r of rows) {
    const code = r.planCode ?? 'none';
    const p = plans.get(code) ?? {
      planCode: code,
      orgs: 0,
      paying: 0,
      revenueMicros: 0,
      costMicros: 0,
    };
    p.orgs += 1;
    p.costMicros += r.costMicros;
    if (r.billingStatus === 'active') {
      p.paying += 1;
      p.revenueMicros += r.priceMicros;
    }
    plans.set(code, p);
  }
  return [...plans.values()]
    .map((p) => ({ ...p, margin: margin(p) }))
    .sort((a, b) => b.costMicros - a.costMicros);
}

/** Each organization with its margin, most expensive first. */
export function byOrganization(rows) {
  return rows
    .map((r) => ({
      ...r,
      revenueMicros: r.billingStatus === 'active' ? r.priceMicros : 0,
      margin: margin({
        revenueMicros: r.billingStatus === 'active' ? r.priceMicros : 0,
        costMicros: r.costMicros,
      }),
    }))
    .sort((a, b) => b.costMicros - a.costMicros);
}

/**
 * Is today's spend out of line? Compared with the average of the days before it (today is partial, so a quiet morning is
 * never an anomaly; only a figure that has already passed the threshold is).
 *
 * @param {{ todayMicros: number, priorMicros: number[] }} input   daily totals of the days before today, oldest first
 */
export function spendAnomaly({ todayMicros, priorMicros }) {
  const days = priorMicros.filter((m) => m > 0);
  if (days.length < 3)
    return { state: 'unknown', averageMicros: null, text: 'Not enough days to compare yet' };
  const averageMicros = Math.round(days.reduce((a, b) => a + b, 0) / days.length);
  const over = todayMicros > averageMicros * ANOMALY_FACTOR;
  return {
    state: over ? 'high' : 'normal',
    averageMicros,
    text: over
      ? `Today is already ${pctText((todayMicros / averageMicros) * 100)} of the recent daily average`
      : 'In line with recent days',
  };
}

/** Cost per answer collected and read, against the target. `answers` of 0 is "no data", never a cost of 0. */
export function costPerAnswer({ costMicros, answers }) {
  if (!(answers > 0))
    return { state: 'unknown', perAnswerMicros: null, text: 'No answers in this period' };
  const perAnswerMicros = Math.round(costMicros / answers);
  return {
    state: perAnswerMicros <= TARGET_COST_PER_ANSWER_MICROS ? 'on_target' : 'over_target',
    perAnswerMicros,
    perQuestionRunMicros: perAnswerMicros * 3,
    text: `${usd(perAnswerMicros, 4)} per answer, about ${usd(perAnswerMicros * 3, 3)} per question and engine`,
  };
}

/** What each meter is called on the screen. */
export const METER_LABELS = Object.freeze({
  answer_collect: 'Collecting answers',
  serp: 'Search results (AI Overviews)',
  llm_extract: 'Reading answers (Claude)',
  llm_content: 'Writing content (Claude)',
  llm_brand_kit: 'Brand Kit (Claude)',
  llm_prompts: 'Writing questions (Claude)',
  llm_narrative: 'Explaining recommendations (Claude)',
  web_search: 'Web search for research',
  crawl: 'Reading websites',
  email: 'Email',
  other: 'Other',
});
