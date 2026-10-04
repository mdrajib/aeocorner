/**
 * Cost per prompt-run and per free audit, measured from the usage ledger (Milestone 10, task 10.06; MVP §13.3 sets the
 * targets). Pure: the report script reads the ledger and the counts, this works out the figures and whether each
 * target is met. Money is micro-dollars.
 *
 * Definitions, so the number means the same thing every time it is quoted:
 *   prompt-run   one question asked in one run, on every engine and sample it was planned for (MVP §12.2: ten answers)
 *   cost of one  the collection and extraction ledger rows of the window, divided by the prompt-runs collected in it.
 *                Collection is the `answer_collect` and `serp` meters; extraction is `llm_extract`. Content, Brand Kit
 *                and narrative spend is not a prompt-run's cost and is shown separately.
 *   audit        one free audit that ran its own pipeline (a repeat served from the 24-hour cache costs nothing and is
 *                left out of the divisor); its cost is every ledger row carrying its `audit_id`.
 */

export const TARGETS = Object.freeze({
  /** MVP §13.3: ≤ $0.12 per prompt-run. */
  promptRunMicros: 120_000,
  /** MVP §13.3: ≤ $0.75 per audit. */
  auditMicros: 750_000,
});

const COLLECTION = new Set(['answer_collect', 'serp']);
const EXTRACTION = new Set(['llm_extract']);

/**
 * @param {{ meter: string, costMicros: number }[]} meters   organization ledger rows summed by meter in the window
 * @param {number} promptRuns                                prompt-runs collected in the window
 * @returns {{ promptRuns: number, collectionMicros: number, extractionMicros: number, otherMicros: number,
 *             perPromptRunMicros: number|null, collectionPerMicros: number|null, extractionPerMicros: number|null,
 *             verdict: 'met'|'missed'|'unknown' }}
 */
export function promptRunCost(meters, promptRuns) {
  let collectionMicros = 0;
  let extractionMicros = 0;
  let otherMicros = 0;
  for (const { meter, costMicros } of meters) {
    if (COLLECTION.has(meter)) collectionMicros += costMicros;
    else if (EXTRACTION.has(meter)) extractionMicros += costMicros;
    else otherMicros += costMicros;
  }
  if (!(promptRuns > 0)) {
    return {
      promptRuns: 0,
      collectionMicros,
      extractionMicros,
      otherMicros,
      perPromptRunMicros: null,
      collectionPerMicros: null,
      extractionPerMicros: null,
      verdict: 'unknown',
    };
  }
  const per = (micros) => Math.round(micros / promptRuns);
  const perPromptRunMicros = per(collectionMicros + extractionMicros);
  return {
    promptRuns,
    collectionMicros,
    extractionMicros,
    otherMicros,
    perPromptRunMicros,
    collectionPerMicros: per(collectionMicros),
    extractionPerMicros: per(extractionMicros),
    verdict: perPromptRunMicros <= TARGETS.promptRunMicros ? 'met' : 'missed',
  };
}

/**
 * @param {{ audits: number, costMicros: number, worstMicros?: number }} sample  audits that ran their own pipeline in the window
 */
export function auditCost({ audits, costMicros, worstMicros = null }) {
  if (!(audits > 0)) {
    return { audits: 0, costMicros, perAuditMicros: null, worstMicros, verdict: 'unknown' };
  }
  const perAuditMicros = Math.round(costMicros / audits);
  const worst = worstMicros ?? perAuditMicros;
  return {
    audits,
    costMicros,
    perAuditMicros,
    worstMicros: worst,
    // The target is for the typical audit, and no single audit may run away: the worst one is held to the same line.
    verdict:
      perAuditMicros <= TARGETS.auditMicros && worst <= TARGETS.auditMicros ? 'met' : 'missed',
  };
}

/** What a failed target says, as one sentence for the report. */
export function describe(kind, result) {
  const usd = (m) => `$${(m / 1_000_000).toFixed(4)}`;
  if (result.verdict === 'unknown') return `${kind}: nothing measured in this window.`;
  if (kind === 'prompt-run') {
    return `prompt-run: ${usd(result.perPromptRunMicros)} each over ${result.promptRuns} (collection ${usd(
      result.collectionPerMicros,
    )}, extraction ${usd(result.extractionPerMicros)}); target ${usd(TARGETS.promptRunMicros)}: ${result.verdict}.`;
  }
  return `audit: ${usd(result.perAuditMicros)} each over ${result.audits} (worst ${usd(
    result.worstMicros,
  )}); target ${usd(TARGETS.auditMicros)}: ${result.verdict}.`;
}
