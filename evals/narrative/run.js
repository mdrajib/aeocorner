import {
  adviceTextFor,
  DEFAULT_ENGINE_LABELS,
  factsFor,
  findUnsupported,
  templateNarrative,
} from '../../src/core/narrative.js';
import { BAD_NARRATIVES, CORPUS } from './corpus.js';

/** What a case's narrative may be checked against: its facts, its fixed advice and the names it may use. */
export function materials(c) {
  const words = {
    brandName: c.brandName,
    domain: c.domain,
    engineLabel: (code) => DEFAULT_ENGINE_LABELS[code] ?? code,
  };
  return {
    words,
    facts: factsFor(c.evidence, words),
    advice: adviceTextFor(c.ruleCode, c.evidence),
  };
}

/** Every corpus case's template narrative, checked. `failures` is empty when no narrative states an unsupported fact. */
export function evaluateTemplates(corpus = CORPUS) {
  const failures = [];
  for (const c of corpus) {
    const { words, facts, advice } = materials(c);
    const narrative = templateNarrative(
      { ruleCode: c.ruleCode, category: c.category, evidence: c.evidence },
      words,
    );
    const problems = findUnsupported(narrative, facts, advice, words);
    if (facts.length === 0) failures.push({ name: c.name, problems: [{ kind: 'no_facts' }] });
    else if (problems.length > 0) failures.push({ name: c.name, problems });
  }
  return { cases: corpus.length, failures };
}

/** Narratives that make things up: each must be flagged, for the reasons given. `missed` lists any that were not. */
export function evaluateBadNarratives(bad = BAD_NARRATIVES) {
  const missed = [];
  for (const b of bad) {
    const { words, facts, advice } = materials(b.case);
    const found = findUnsupported(b.narrative, facts, advice, words);
    const lacking = b.expect.filter(
      (want) => !found.some((f) => f.kind === want.kind && f.value === want.value),
    );
    if (lacking.length > 0) missed.push({ name: b.name, lacking, found });
  }
  return { cases: bad.length, missed };
}
