import { createHash } from 'node:crypto';

/**
 * Rules for a project's buyer questions (MVP F3 "Prompt Manager", §7.7 "intent coverage rules"). Pure, so the
 * generator, the CSV import and the screens all judge a question set the same way.
 *
 * A question's text is immutable once tracked: trend lines must never mix two different questions. Everything here
 * serves that: duplicates are found by a normalized form, and "edit" is archive-and-replace in the repository.
 */

export const INTENTS = Object.freeze([
  'discovery',
  'comparison',
  'problem_solution',
  'brand',
  'local',
  'transactional',
]);

export const INTENT_LABELS = Object.freeze({
  discovery: 'Finding options',
  comparison: 'Comparing',
  problem_solution: 'Solving a problem',
  brand: 'About the brand',
  local: 'Near me',
  transactional: 'Buying',
});

/** Questions in a set: below the minimum there is too little data to trust, above the maximum the plan is exceeded. */
export const MIN_SET = 25;
export const MAX_SET = 50;

export const MAX_TEXT = 1000;
const MIN_WORDS = 3;

/** The intents a question must (true) or must not (false) name the brand in; others may do either. */
const NAMES_BRAND = Object.freeze({
  discovery: false,
  problem_solution: false,
  comparison: true,
  brand: true,
});

/** The share of a set each intent needs at least, so one kind of question can't crowd out the others. */
export const MIN_SHARE = Object.freeze({
  discovery: 0.25,
  comparison: 0.1,
  problem_solution: 0.2,
  brand: 0.1,
});

/** A question compared without case, accents, punctuation or spacing. */
export function normalizeQuestion(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’]/gu, '') // what's = whats
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** SHA-256 of the normalized question: what the unique key on `prompts` compares. */
export const questionHash = (text) => createHash('sha256').update(normalizeQuestion(text)).digest();

const bigrams = (s) => {
  const padded = ` ${s} `;
  const out = new Map();
  for (let i = 0; i < padded.length - 1; i += 1) {
    const g = padded.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
};

/** Dice similarity of two questions' letter pairs, 0 to 1. Linear in their length. */
export function similarity(a, b) {
  const x = normalizeQuestion(a);
  const y = normalizeQuestion(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let shared = 0;
  for (const [g, n] of gx) shared += Math.min(n, gy.get(g) ?? 0);
  const total =
    [...gx.values()].reduce((s, n) => s + n, 0) + [...gy.values()].reduce((s, n) => s + n, 0);
  return (2 * shared) / total;
}

export const NEAR_DUPLICATE = 0.85;

/**
 * Existing questions that say nearly the same thing as `text` ("best family dentist in Austin" and "best family
 * dentist austin tx"). Not an error: the screen flags it and the customer decides.
 * @param {Array<{ id: *, text: string }>} existing
 */
export function nearDuplicates(text, existing, threshold = NEAR_DUPLICATE) {
  return existing
    .map((e) => ({ id: e.id, text: e.text, score: similarity(text, e.text) }))
    .filter((e) => e.score >= threshold && e.score < 1)
    .sort((p, q) => q.score - p.score);
}

/**
 * Check one question before it is saved. `{ ok: true, text }` (tidied) or `{ ok: false, error }`.
 * A question that names the brand when it should not (or does not when it should) is a warning, not an error: a
 * customer may know better than the rule. `namingProblem` reports it.
 */
export function checkQuestion(input) {
  const text = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
  if (!text) return { ok: false, error: 'Write the question.' };
  if (text.length > MAX_TEXT) return { ok: false, error: `Keep it under ${MAX_TEXT} characters.` };
  if (normalizeQuestion(text).split(' ').length < MIN_WORDS) {
    return { ok: false, error: 'Write it as a full question, a few words at least.' };
  }
  if (hasControlCharacter(text)) {
    return { ok: false, error: 'This has characters we can’t use.' };
  }
  return { ok: true, text };
}

/** Control characters other than tab and line breaks (whitespace is already collapsed). */
const hasControlCharacter = (s) => [...s].some((c) => c.charCodeAt(0) < 32);

/** Does `text` contain any of `names` as whole words (case and accents ignored)? */
export function mentionsBrand(text, names) {
  const hay = ` ${normalizeQuestion(text)} `;
  return names.some((n) => {
    const needle = normalizeQuestion(n);
    return needle.length > 1 && hay.includes(` ${needle} `);
  });
}

/**
 * Whether a question breaks the naming rule of its intent: finding-options and problem questions must not name the
 * brand (the answer would give itself away); comparison and brand questions must. Returns a sentence or null.
 */
export function namingProblem({ text, intent }, names) {
  if (!Object.hasOwn(NAMES_BRAND, intent) || names.length === 0) return null;
  const named = mentionsBrand(text, names);
  if (NAMES_BRAND[intent] === false && named) {
    return 'This names your brand, so the engine is handed the answer. Unnamed questions test whether AI finds you on its own.';
  }
  if (NAMES_BRAND[intent] === true && !named) {
    return 'A question like this should name your brand.';
  }
  return null;
}

/**
 * Does a question set cover the intents it should? Counts active questions per intent and says what is short.
 * `hasCity` adds "local" (a business that serves one area is asked "near me" questions).
 * @returns {{ ok: boolean, total: number, counts: Record<string, number>, problems: string[] }}
 */
export function checkCoverage(questions, { hasCity = false } = {}) {
  const counts = Object.fromEntries(INTENTS.map((i) => [i, 0]));
  let total = 0;
  for (const q of questions) {
    if (!Object.hasOwn(counts, q.intent)) continue;
    counts[q.intent] += 1;
    total += 1;
  }
  const problems = [];
  if (total < MIN_SET)
    problems.push(
      `Add ${MIN_SET - total} more: ${MIN_SET} to ${MAX_SET} questions give a reliable picture.`,
    );
  if (total > MAX_SET)
    problems.push(`There are ${total - MAX_SET} more than the ${MAX_SET} allowed.`);
  for (const [intent, share] of Object.entries(MIN_SHARE)) {
    const need = Math.ceil(Math.max(total, MIN_SET) * share);
    if (counts[intent] < need) {
      problems.push(
        `Add ${need - counts[intent]} more “${INTENT_LABELS[intent].toLowerCase()}” question${need - counts[intent] === 1 ? '' : 's'}.`,
      );
    }
  }
  if (hasCity && counts.local === 0)
    problems.push('Add at least one “near me” question for your area.');
  return { ok: problems.length === 0, total, counts, problems };
}
