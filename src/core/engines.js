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
 */
export function engineChoices(catalog, rows, allowed = () => true) {
  const byCode = new Map(rows.map((r) => [r.engine_code, r]));
  return catalog.map(({ code, name }) => {
    const row = byCode.get(code);
    return {
      engine_code: code,
      name: name ?? ENGINE_LABELS[code] ?? code,
      enabled: Boolean(row?.enabled),
      notTracked: !row,
      allowed: allowed(code),
    };
  });
}
