/**
 * The AI engines AEO Corner can track, as the screens name and order them. Pure. The routing of each engine to a
 * provider is data (the `engines` table); this is only what a person reads.
 *
 * `AUDIT_ENGINE_LABELS` (src/core/audit-progress.js) is deliberately a separate, shorter list: the free audit asks the
 * four engines its $0.75 budget was set for, and Claude stays out of it (Milestone 16, task 16.08).
 */
export const ENGINE_LABELS = Object.freeze({
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  google_aio: 'Google AI Overviews',
  claude: 'Claude',
});

export const ENGINE_ORDER = Object.freeze(Object.keys(ENGINE_LABELS));

/**
 * An engine that needs a plan feature (founder decision F3, a suggestion until answered: Claude is on the top tier,
 * because it costs several times what any other engine does per answer). Engines not listed are in every plan.
 */
export const PLAN_GATED_ENGINES = Object.freeze({ claude: 'claude_engine' });

/** The plan feature an engine needs, or null. */
export const featureForEngine = (code) => PLAN_GATED_ENGINES[code] ?? null;

/**
 * What a project's engine switches show: every live engine in catalog order, with the project's setting for it.
 * An engine the project has no row for was never offered to it and is "Not tracked", never off-with-a-zero: a project
 * that predates an engine is not changed by the engine arriving (task 16.05).
 *
 * @param {{ code: string, name?: string }[]} catalog   live engines, in display order
 * @param {{ engine_code: string, enabled: boolean }[]} rows  the project's rows
 * @param {(code: string) => boolean} allowed  whether the organization's plan lets it use the engine
 * @param {(code: string) => (Date|null)} graceUntil  when an engine the plan no longer includes stops being collected
 */
export function engineChoices(catalog, rows, allowed = () => true, graceUntil = () => null) {
  const byCode = new Map(rows.map((r) => [r.engine_code, r]));
  return catalog.map(({ code, name }) => {
    const row = byCode.get(code);
    return {
      engine_code: code,
      name: name ?? ENGINE_LABELS[code] ?? code,
      enabled: Boolean(row?.enabled),
      notTracked: !row,
      allowed: allowed(code),
      graceUntil: row?.enabled ? graceUntil(code) : null,
    };
  });
}

/**
 * What a plan change does to a plan-gated engine (founder decision F3, option C): the engine keeps being collected,
 * for the projects that already track it, until the end of the billing period the customer has already paid for, then
 * stops. Pure; `src/db/repos/system-billing.js` applies the answer to `organizations.claude_until`.
 *
 *   before, after   the feature flag in the old and the new plan (`true` only when the plan lists it)
 *   periodEnd       the subscription's current period end, or null
 *   existing        the grace already running (a Date) or null
 *
 * Returns what to store: a Date (a grace ends then), or null (no grace). Gaining the feature clears a grace; losing
 * it starts one (never one that is already over); a change that never involved the feature leaves a running grace
 * alone, so moving from one plan without the feature to another cannot extend it.
 */
export function graceAfterPlanChange({
  before,
  after,
  periodEnd,
  existing = null,
  now = new Date(),
}) {
  if (after) return null;
  if (before) return periodEnd && periodEnd > now ? periodEnd : null;
  return existing;
}

/**
 * May the organization collect this engine now? `plan` its plan includes it (or it has no plan yet: billing is not on),
 * `grace` it does not but a paid period is still running, `none` it does not.
 */
export function engineAccess({ code, hasPlan, plan, graceUntil = null, now = new Date() }) {
  const feature = featureForEngine(code);
  if (!feature || !hasPlan || plan?.features?.[feature]) return 'plan';
  return graceUntil && graceUntil > now ? 'grace' : 'none';
}
