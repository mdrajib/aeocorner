/**
 * The figures on a free-audit report beyond the scores: four headline stats, the competitor board and the grid of
 * every question against every engine (UI_DESIGN A9). Pure: the audit's answer rows in, numbers out, so each figure
 * can be checked by hand and the "couldn't check" rules live in one tested place.
 *
 *   - An answer we could not read (failed, pending, or not read) is never "absent". It leaves every count and every
 *     denominator, like the scores (`src/core/visibility.js`).
 *   - An engine that said it had no answer (no AI Overview shown) is its own state and also leaves the counts.
 *   - With nothing readable behind a figure it is `null`, and the screen shows "Couldn’t check", never 0.
 *   - The brand is "present" in an answer when the answer names it OR cites its own site; that is what the board and
 *     the stats call presence.
 *
 * Entity names come from a model reading an answer: they are hostile input. Names are cut to `MAX_NAME` characters
 * before any pattern runs, and every pattern here is anchored or a single character class, so the work is linear.
 */

import { AUDIT_ENGINE_LABELS, AUDIT_ENGINE_ORDER } from './audit-progress.js';

export const MAX_NAME = 80;
export const MAX_COMPETITORS = 10;

const LEGAL_SUFFIXES = new Set([
  'inc',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'gmbh',
  'plc',
]);
const TLD = /\.(?:com|ai|io|co|net|org|app)$/;

const ownCited = (row) =>
  Array.isArray(row.citations) && row.citations.some((c) => c?.isOwn === true);

/**
 * What one answer says about the brand: `present` (named, or its site is cited), `absent` (read, and neither),
 * `no_overview` (the engine had no answer to give) or `unknown` (we could not read it).
 */
export function presenceOf(row) {
  if (!row) return 'unknown';
  if (row.status === 'no_answer') return 'no_overview';
  if (row.status !== 'ok') return 'unknown';
  if (row.brand_present === true || ownCited(row)) return 'present';
  if (row.brand_present === false) return 'absent';
  return 'unknown';
}

const isKnown = (state) => state === 'present' || state === 'absent';

/** What a name is compared by: case, accents, punctuation, `www.`, a trailing domain ending and `Inc`/`Ltd` ignored. */
export function entityKey(name) {
  const cut = String(name ?? '')
    .slice(0, MAX_NAME)
    .normalize('NFD')
    .replace(/[̀-ͯ]+/g, '') // Latin accents only: other scripts keep their vowel signs
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/^www\./, '')
    .replace(TLD, '');
  const tokens = cut
    .replaceAll('&', ' and ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1))) tokens.pop();
  return tokens.join(' ');
}

const isShortlisted = (rank, stance) =>
  ((Number.isInteger(rank) && rank >= 1) || stance === 'recommended') &&
  stance !== 'cautioned' &&
  stance !== 'not_recommended';

/** The answers the competitor board is built from: read by Claude, so the entities are a real list. */
const readForBoard = (answers) =>
  answers.filter((r) => Array.isArray(r.entities) && isKnown(presenceOf(r)));

const percent = (count, of) => (of > 0 ? Math.round((100 * count) / of) : null);

/**
 * You and the businesses the engines named, ranked by the answers that shortlist them. `presence` counts each answer
 * once per business. `shareOfVoice` is a business's presences out of everyone's, including businesses past the
 * `limit` (those are counted in `hidden`). A name written two ways ("Jasper" and "Jasper AI") is one business.
 */
export function competitorBoard({
  answers,
  brandName = null,
  domain = null,
  limit = MAX_COMPETITORS,
}) {
  const read = readForBoard(answers);
  if (read.length === 0) return { basis: 0, rows: [], hidden: 0, totalMentions: 0 };

  const own = new Set([entityKey(brandName), entityKey(String(domain ?? '').replace(TLD, ''))]);
  own.delete('');

  // Pass 1: every name each answer carries, keyed.
  const named = read.map((row) =>
    row.entities
      .filter((e) => e && e.kind !== 'brand' && typeof e.name === 'string')
      .map((e) => ({
        key: entityKey(e.name),
        spelling: e.name.trim().slice(0, MAX_NAME),
        shortlisted: isShortlisted(e.rank, e.stance),
      }))
      .filter((e) => e.key),
  );

  // "X AI" folds into "X" only when "X" is also in the answers: that is the same business written two ways.
  const keys = new Set(named.flat().map((e) => e.key));
  const fold = (key) => {
    if (key.endsWith(' ai')) {
      const base = key.slice(0, -3);
      if (keys.has(base)) return base;
    }
    return key;
  };

  // Pass 2: count each business once per answer.
  const rivals = new Map();
  for (const names of named) {
    const seen = new Map();
    for (const e of names) {
      const key = fold(e.key);
      if (own.has(key)) continue;
      const entry = seen.get(key) ?? { spellings: [], shortlisted: false };
      entry.spellings.push(e.spelling);
      entry.shortlisted ||= e.shortlisted;
      seen.set(key, entry);
    }
    for (const [key, entry] of seen) {
      const rival = rivals.get(key) ?? { key, spellings: new Map(), presence: 0, shortlisted: 0 };
      rival.presence += 1;
      if (entry.shortlisted) rival.shortlisted += 1;
      for (const s of entry.spellings) rival.spellings.set(s, (rival.spellings.get(s) ?? 0) + 1);
      rivals.set(key, rival);
    }
  }

  const brandPresence = read.filter((r) => presenceOf(r) === 'present').length;
  const brandShortlisted = read.filter(
    (r) => presenceOf(r) === 'present' && isShortlisted(r.brand_rank, r.brand_stance),
  ).length;
  const totalMentions =
    brandPresence + [...rivals.values()].reduce((sum, rival) => sum + rival.presence, 0);
  const basis = read.length;

  const nameOf = (rival) =>
    [...rival.spellings.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]),
    )[0][0];

  const ranked = [...rivals.values()]
    .map((rival) => ({
      name: nameOf(rival),
      isBrand: false,
      presence: rival.presence,
      presencePct: percent(rival.presence, basis),
      shareOfVoice: percent(rival.presence, totalMentions),
      shortlisted: rival.shortlisted,
    }))
    .sort(
      (a, b) =>
        b.shortlisted - a.shortlisted || b.presence - a.presence || a.name.localeCompare(b.name),
    );

  const brandRow = {
    name: brandName || domain || 'Your brand',
    isBrand: true,
    presence: brandPresence,
    presencePct: percent(brandPresence, basis),
    shareOfVoice: percent(brandPresence, totalMentions),
    shortlisted: brandShortlisted,
  };
  return {
    basis,
    rows: [brandRow, ...ranked.slice(0, limit)],
    hidden: Math.max(0, ranked.length - limit),
    totalMentions,
  };
}

/** One row per question, with how many readable answers were absent. `missed` = absent from at least half. */
function questionRows(answers, questions) {
  const text = new Map(questions.map((q) => [q.promptIdx, q.text]));
  const indexes = [
    ...new Set([...questions.map((q) => q.promptIdx), ...answers.map((r) => r.prompt_idx)]),
  ]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  return indexes.map((idx) => {
    const mine = answers.filter((r) => r.prompt_idx === idx);
    const states = mine.map(presenceOf);
    const known = states.filter(isKnown).length;
    const absent = states.filter((s) => s === 'absent').length;
    return {
      promptIdx: idx,
      question: text.get(idx) ?? `Question ${idx + 1}`,
      known,
      absent,
      missed: known > 0 && absent * 2 >= known,
    };
  });
}

const CELL = {
  present: { status: 'ok', mentioned: true },
  absent: { status: 'ok', mentioned: false },
  no_overview: { status: 'no_overview' },
  unknown: { status: 'unknown' },
};

/**
 * Every question against every engine, for `ui.resultCell`. A cell with no row, or one we could not read, is
 * "Couldn’t check". `link` points at the answer's excerpt lower on the page when there is one.
 */
export function answerGrid({ answers, questions = [] }) {
  const byCell = new Map(answers.map((r) => [`${r.prompt_idx}|${r.engine_code}`, r]));
  const engines = [...new Set([...AUDIT_ENGINE_ORDER, ...answers.map((r) => r.engine_code)])];
  return {
    engines: engines.map((code) => ({ code, label: AUDIT_ENGINE_LABELS[code] ?? code })),
    rows: questionRows(answers, questions).map((q) => ({
      promptIdx: q.promptIdx,
      question: q.question,
      missed: q.missed,
      cells: engines.map((code) => {
        const row = byCell.get(`${q.promptIdx}|${code}`);
        const state = presenceOf(row);
        return {
          code,
          state,
          ...CELL[state],
          link: row?.status === 'ok' && row.text_excerpt ? `#answer-${q.promptIdx}-${code}` : null,
        };
      }),
    })),
  };
}

/**
 * The four headline stats. Every one is `null` when nothing readable is behind it.
 *   mentionRate     whole percent of readable answers that name or cite the brand
 *   mentioned/known the same as a count ("3 of 18 answers")
 *   missed          questions where the brand was absent from at least half of the readable answers, out of the
 *                   questions with at least one readable answer
 *   topCompetitor   the board's first business that is not the brand, or null when the engines named nobody
 */
export function reportStats({ answers, questions = [], board }) {
  const states = answers.map(presenceOf);
  const known = states.filter(isKnown).length;
  const mentioned = states.filter((s) => s === 'present').length;
  const rows = questionRows(answers, questions);
  const considered = rows.filter((q) => q.known > 0);
  const top = (board?.rows ?? []).find((r) => !r.isBrand && r.presence > 0) ?? null;
  return {
    total: answers.length,
    known,
    mentioned,
    unreadable: states.filter((s) => s === 'unknown').length,
    noOverview: states.filter((s) => s === 'no_overview').length,
    mentionRate: percent(mentioned, known),
    questionsConsidered: considered.length,
    questionsMissed: considered.filter((q) => q.missed).length,
    topCompetitor: top ? { name: top.name, presence: top.presence, basis: board.basis } : null,
  };
}

/** Everything the report adds, in one call for the route. */
export function reportFigures({ answers, questions = [], brandName = null, domain = null }) {
  const board = competitorBoard({ answers, brandName, domain });
  return {
    stats: reportStats({ answers, questions, board }),
    board,
    grid: answerGrid({ answers, questions }),
  };
}
