import { analyzeBody, faqPairs, isQuestionHeading, wordsOf } from './content-html.js';
import { validateJsonLd } from './jsonld.js';

/**
 * The QC score of a draft (MVP F8 step 6, task 7.07): seven checks of what answer engines and readers reward, run in
 * code so the same draft always gets the same score and every point lost says why. Pure; nothing here calls a model.
 *
 *   answer_first        25  each question heading has a direct answer of 60 words or fewer right under it
 *   unsupported_claims  20  figures and "studies show" sentences have a source; no `[needs source]` left; no invented quote
 *   heading_structure   15  3 to 12 sections, question-style headings, no skipped levels or repeats, a sensible length
 *   reading_level       10  Flesch-Kincaid grade at or under the Brand Kit's target (9 if it names none)
 *   banned_words        10  none of the Brand Kit's "avoid" words and none of the stock filler phrases
 *   overlap             10  not a copy of a page the site already has
 *   schema_valid        10  the JSON-LD validates and says only what the page says
 *
 * A check's points are its weight times the share it passed. `blocking` problems stop approval no matter the score:
 * a `[needs source]` marker still in the text, an invented quote, near-copy of an existing page, invalid structured
 * data. A score of 80 or more with nothing blocking is `ready`. The weights are v0 guesses, like the readiness rubric.
 */

export const QC_VERSION = 1;
export const READY_SCORE = 80;

export const QC_CHECKS = Object.freeze([
  { code: 'answer_first', label: 'Answer first', weight: 25 },
  { code: 'unsupported_claims', label: 'Claims have sources', weight: 20 },
  { code: 'heading_structure', label: 'Headings', weight: 15 },
  { code: 'reading_level', label: 'Reading level', weight: 10 },
  { code: 'banned_words', label: 'Words to avoid', weight: 10 },
  { code: 'overlap', label: 'Not a copy of your site', weight: 10 },
  { code: 'schema_valid', label: 'Structured data', weight: 10 },
]);

export const DIRECT_ANSWER_WORDS = 60;
const DEFAULT_GRADE = 9;

/** Stock phrases that make a page read as machine-written; each is a warning, not a ban. */
export const FILLER_PHRASES = Object.freeze([
  'delve',
  'in today’s fast-paced world',
  "in today's fast-paced world",
  'in the ever-evolving',
  'game-changer',
  'game changer',
  'unlock the power',
  'unlock the secrets',
  'tapestry',
  'navigate the landscape',
  "it's important to note",
  'it’s important to note',
  'it is important to note',
  'look no further',
  'take it to the next level',
  'in conclusion',
  'cutting-edge',
  'seamless',
  'revolutionize',
]);

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const sentencesOf = (text) =>
  String(text ?? '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“($[])/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Rough syllables in an English word: vowel groups, minus a silent final "e". Good enough for a grade level. */
export function syllables(word) {
  const w = String(word)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Flesch-Kincaid grade level of a text (about the school year a reader needs); null when there is too little text. */
export function gradeLevel(text) {
  const words = wordsOf(text).filter((w) => /[a-z]/i.test(w));
  const sentences = sentencesOf(text);
  if (words.length < 30 || sentences.length === 0) return null;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const grade = 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59;
  return Math.round(grade * 10) / 10;
}

/** The grade a Brand Kit's "reading level" text asks for: "Grade 8", "8th grade", "plain English", "college". */
export function targetGrade(readingLevel) {
  const text = String(readingLevel ?? '').toLowerCase();
  const num = /(?:grade|year)\s*(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)[\s-]*grade/.exec(text);
  if (num) return Math.min(16, Math.max(4, Number(num[1] ?? num[2])));
  if (/college|university|graduate|expert|technical|professional/.test(text)) return 13;
  if (/plain|simple|easy|everyday|casual/.test(text)) return 8;
  return DEFAULT_GRADE;
}

const shingles = (text, size = 5) => {
  const words = wordsOf(norm(text))
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  const set = new Set();
  for (let i = 0; i + size <= words.length; i += 1) set.add(words.slice(i, i + size).join(' '));
  return set;
};

/** Share of a draft's five-word runs that also appear on one existing page, and which page. */
export function overlapWith(draftText, pages) {
  const mine = shingles(draftText);
  if (mine.size === 0) return { share: 0, url: null };
  let best = { share: 0, url: null };
  for (const page of pages ?? []) {
    const theirs = shingles(page.text);
    if (theirs.size === 0) continue;
    let hit = 0;
    for (const s of mine) if (theirs.has(s)) hit += 1;
    const share = hit / mine.size;
    if (share > best.share) best = { share, url: page.url ?? null };
  }
  return best;
}

const CLAIM_PATTERNS = [
  /\d[\d,.]*\s?%/,
  /\bpercent\b/i,
  /[$€£]\s?\d/,
  /\b\d[\d,.]*\s?(?:times|x)\b/i,
  /\b(?:studies|research|surveys?|data|experts?|statistics|analysts?|reports?)\s+(?:show|shows|say|says|suggest|suggests|found|find|indicate|indicates)\b/i,
  /\baccording to\b/i,
  /\b(?:most|majority of|nearly all|over half)\b.*\b(?:people|patients|customers|users|businesses|companies)\b/i,
];

/** Numbers in a sentence, as plain digit strings ("1,500" and "1500" are the same figure). */
const figuresIn = (text) =>
  (String(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((n) => n.replace(/,/g, ''))
    .filter((n) => n.length > 0);

const QUOTE = /["“]([^"“”]{20,400})["”]/g;

function result(check, fraction, findings, { blocking = false, detail = {} } = {}) {
  const f = Math.max(0, Math.min(1, fraction));
  return {
    code: check.code,
    label: check.label,
    weight: check.weight,
    points: Math.round(check.weight * f * 10) / 10,
    status: f >= 0.999 ? 'pass' : f >= 0.6 ? 'warn' : 'fail',
    blocking,
    findings,
    detail,
  };
}

/**
 * Score a draft.
 *
 * @param {object} input
 * @param {string} input.bodyHtml     sanitized markup (`sanitizeBody`)
 * @param {object|null} input.jsonld  the structured data for the page, or null
 * @param {object} [input.voice]      Brand Kit voice: `{ avoid: string[], readingLevel: string }`
 * @param {string[]} [input.facts]    sentences the draft may state as fact: Brand Kit facts and researched claims
 * @param {{url: string, quote?: string}[]} [input.sources]  researched sources; a link to one supports a claim
 * @param {{url: string, text: string}[]} [input.existingPages]  the site's own pages, for the overlap check
 * @returns {{ score: number, ready: boolean, blocking: string[], checks: object[], version: number, words: number }}
 */
export function scoreDraft({
  bodyHtml,
  jsonld = null,
  voice = {},
  facts = [],
  sources = [],
  existingPages = [],
}) {
  const body = analyzeBody(bodyHtml);
  const plain = body.text;
  const [answerFirst, claims, headings, reading, banned, overlap, schema] = QC_CHECKS;
  const checks = [];

  // Nothing to judge is not a pass: a draft with no text earns no points for "no banned words".
  if (body.words === 0) {
    return {
      version: QC_VERSION,
      score: 0,
      ready: false,
      blocking: [],
      checks: QC_CHECKS.map((c) =>
        result(c, 0, c.code === 'answer_first' ? ['The draft has no text yet.'] : []),
      ),
      words: body.words,
    };
  }

  // 1. Answer first.
  {
    const questions = body.headings.filter((h) => isQuestionHeading(h.text));
    const findings = [];
    let good = 0;
    for (const h of questions) {
      if (!h.answer) findings.push(`"${h.text}" has no paragraph straight under it.`);
      else if (h.answerWords > DIRECT_ANSWER_WORDS) {
        findings.push(
          `"${h.text}": the first paragraph is ${h.answerWords} words; answer in ${DIRECT_ANSWER_WORDS} or fewer, then explain.`,
        );
      } else good += 1;
    }
    if (questions.length === 0) {
      findings.push(
        'No heading is a question a buyer would ask. Add question-style headings with a short answer under each.',
      );
    }
    checks.push(
      result(answerFirst, questions.length ? good / questions.length : 0, findings, {
        detail: { questions: questions.length, answered: good },
      }),
    );
  }

  // 2. Claims have sources.
  {
    const findings = [];
    let blocking = false;
    const marker = /\[(?:needs? source|citation needed|source needed)\]/gi;
    const markers = (plain.match(marker) ?? []).length;
    if (markers > 0) {
      blocking = true;
      findings.push(
        `${markers} "[needs source]" marker${markers === 1 ? '' : 's'} left in the text: add a source or remove the claim.`,
      );
    }
    const allowedFigures = new Set(facts.flatMap((f) => figuresIn(f)));
    const allowedFacts = facts.map(norm);
    const sourceUrls = new Set(sources.map((s) => s.url));
    const hasSourceLink = (paragraphHtml) =>
      [...String(paragraphHtml).matchAll(/href="([^"]+)"/g)].some(
        ([, href]) => sourceUrls.has(href) || /^https?:\/\//i.test(href),
      );
    let claimCount = 0;
    let unsupported = 0;
    for (const block of body.blocks) {
      if (!['paragraph', 'ul', 'ol', 'blockquote', 'table'].includes(block.type)) continue;
      const linked = hasSourceLink(block.html);
      for (const sentence of sentencesOf(block.text)) {
        if (!CLAIM_PATTERNS.some((p) => p.test(sentence))) continue;
        claimCount += 1;
        const figures = figuresIn(sentence);
        const inFacts =
          (figures.length > 0 && figures.every((n) => allowedFigures.has(n) || n.length <= 1)) ||
          allowedFacts.some((f) => f && norm(sentence).includes(f.slice(0, 60)));
        if (linked || inFacts) continue;
        unsupported += 1;
        if (findings.length < 8) findings.push(`No source for: "${sentence.slice(0, 140)}"`);
      }
    }
    const quoteFacts = [...facts, ...sources.map((s) => s.quote ?? '')].map(norm);
    let invented = 0;
    for (const m of plain.matchAll(QUOTE)) {
      const quote = norm(m[1]);
      if (wordsOf(quote).length < 6) continue;
      if (quoteFacts.some((f) => f && (f.includes(quote) || quote.includes(f)))) continue;
      invented += 1;
      blocking = true;
      if (findings.length < 10)
        findings.push(`A quotation that is not in your facts or research: "${m[1].slice(0, 100)}"`);
    }
    const supported = claimCount === 0 ? 1 : (claimCount - unsupported) / claimCount;
    const penalty = (markers > 0 ? 0.5 : 0) + (invented > 0 ? 0.5 : 0);
    checks.push(
      result(claims, Math.max(0, Math.min(supported, 1) - penalty), findings, {
        blocking,
        detail: { claims: claimCount, unsupported, markers, invented },
      }),
    );
  }

  // 3. Heading structure.
  {
    const findings = [];
    let fraction = 1;
    const h2 = body.headings.filter((h) => h.level === 2);
    if (h2.length < 3) {
      fraction -= 0.3;
      findings.push(`Only ${h2.length} main section${h2.length === 1 ? '' : 's'}: use at least 3.`);
    }
    if (h2.length > 12) {
      fraction -= 0.15;
      findings.push(`${h2.length} main sections is a lot: 12 or fewer reads better.`);
    }
    const questionShare = body.headings.length
      ? body.headings.filter((h) => isQuestionHeading(h.text)).length / body.headings.length
      : 0;
    if (questionShare < 0.5) {
      fraction -= 0.25;
      findings.push(
        'Fewer than half of the headings are questions. Buyers ask questions; match them.',
      );
    }
    let previous = 1;
    for (const h of body.headings) {
      if (h.level > previous + 1) {
        fraction -= 0.2;
        findings.push(`"${h.text}" skips a heading level.`);
        break;
      }
      previous = h.level;
    }
    const seen = new Set();
    for (const h of body.headings) {
      const key = norm(h.text);
      if (seen.has(key)) {
        fraction -= 0.1;
        findings.push(`Two headings read "${h.text}".`);
        break;
      }
      seen.add(key);
    }
    body.blocks.forEach((b, i) => {
      const next = body.blocks[i + 1];
      if (
        b.type === 'heading' &&
        b.level === 2 &&
        (!next || (next.type === 'heading' && next.level <= 2))
      ) {
        fraction -= 0.1;
        findings.push(`"${b.text}" has nothing under it.`);
      }
    });
    if (body.words < 300) {
      fraction -= 0.2;
      findings.push(
        `${body.words} words is short: 300 or more gives an answer engine something to cite.`,
      );
    } else if (body.words > 2500) {
      fraction -= 0.1;
      findings.push(`${body.words} words is long: consider splitting it.`);
    }
    checks.push(
      result(headings, fraction, findings, { detail: { sections: h2.length, words: body.words } }),
    );
  }

  // 4. Reading level.
  {
    const target = targetGrade(voice.readingLevel);
    const grade = gradeLevel(plain);
    const findings = [];
    let fraction = 1;
    if (grade === null) {
      fraction = 0.5;
      findings.push('Too little text to judge the reading level.');
    } else if (grade > target) {
      fraction = Math.max(0, 1 - (grade - target) / 6);
      findings.push(
        `Reads at about grade ${grade}; your target is grade ${target}. Shorter sentences and plainer words will help.`,
      );
    }
    checks.push(result(reading, fraction, findings, { detail: { grade, target } }));
  }

  // 5. Banned words.
  {
    const findings = [];
    const lower = ` ${norm(plain)} `;
    const has = (phrase) => {
      const p = norm(phrase);
      if (!p) return false;
      return new RegExp(
        `(?<![\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
        'u',
      ).test(lower);
    };
    const avoid = (voice.avoid ?? []).filter((w) => has(w));
    const filler = FILLER_PHRASES.filter(
      (p, i, all) => all.findIndex((q) => norm(q) === norm(p)) === i,
    ).filter(has);
    for (const w of avoid) findings.push(`Your Brand Kit says to avoid "${w}".`);
    for (const p of filler) findings.push(`"${p}" is stock filler: say it plainly.`);
    const fraction = 1 - Math.min(1, avoid.length * 0.4 + filler.length * 0.2);
    checks.push(result(banned, fraction, findings, { detail: { avoid, filler } }));
  }

  // 6. Overlap with the site's own pages.
  {
    const { share, url } = overlapWith(plain, existingPages);
    const findings = [];
    let fraction = 1;
    let blocking = false;
    if (share >= 0.6) {
      fraction = 0;
      blocking = true;
      findings.push(
        `${Math.round(share * 100)}% of this draft is already on ${url}. Refresh that page instead of adding a copy.`,
      );
    } else if (share >= 0.3) {
      fraction = 0.5;
      findings.push(`${Math.round(share * 100)}% of this draft repeats ${url}. Say something new.`);
    } else if (share >= 0.15) {
      fraction = 0.8;
      findings.push(`${Math.round(share * 100)}% repeats ${url}.`);
    }
    checks.push(
      result(overlap, fraction, findings, {
        blocking,
        detail: { share: Math.round(share * 1000) / 1000, url },
      }),
    );
  }

  // 7. Structured data.
  {
    const findings = [];
    let fraction = 1;
    let blocking = false;
    if (!jsonld) {
      fraction = 0;
      findings.push('No structured data yet.');
    } else {
      const v = validateJsonLd(jsonld);
      if (!v.ok) {
        fraction = 0;
        blocking = true;
        for (const e of v.errors.slice(0, 6)) findings.push(`${e.path}: ${e.message}`);
      } else {
        const nodes = Array.isArray(jsonld) ? jsonld : (jsonld['@graph'] ?? [jsonld]);
        const pairs = faqPairs(body);
        const bodyText = norm(plain);
        for (const node of nodes) {
          if (node['@type'] !== 'FAQPage') continue;
          const entities = [].concat(node.mainEntity ?? []);
          for (const q of entities) {
            const name = norm(q.name);
            const answer = norm(q.acceptedAnswer?.text);
            const onPage = pairs.some((p) => norm(p.question) === name) || bodyText.includes(name);
            if (!onPage) {
              fraction -= 0.4;
              blocking = true;
              findings.push(`The structured data asks "${q.name}" but the page does not.`);
            } else if (answer && !bodyText.includes(answer.slice(0, 80))) {
              fraction -= 0.2;
              findings.push(
                `The structured data's answer to "${q.name}" is not what the page says.`,
              );
            }
          }
        }
        if (v.warnings.length) {
          fraction -= Math.min(0.2, v.warnings.length * 0.05);
          for (const w of v.warnings.slice(0, 3)) findings.push(`${w.path}: ${w.message}`);
        }
      }
    }
    checks.push(result(schema, fraction, findings, { blocking }));
  }

  const score = Math.round(checks.reduce((n, c) => n + c.points, 0));
  const blockingChecks = checks.filter((c) => c.blocking).map((c) => c.code);
  return {
    version: QC_VERSION,
    score,
    ready: score >= READY_SCORE && blockingChecks.length === 0,
    blocking: blockingChecks,
    checks,
    words: body.words,
  };
}

// --- Easy to cite (Milestone 13, task 13.06) -------------------------------------------------------------------
//
// For a page written to win citations (a `citation.*` recommendation), four more things count: a named author, a date,
// sources linked, and figures that are the business's own. They are ADVISORY: they never change the score, never block
// approval and never invent anything to pass. A draft cannot name an author it was not given, nor state a figure that is
// not in the facts, so "could be better" here usually means "add this to your Brand Kit".

export const CITABLE_CHECKS = Object.freeze([
  { code: 'sources_linked', label: 'Sources are linked' },
  { code: 'dated', label: 'Shows when it was updated' },
  { code: 'author', label: 'Names who wrote it' },
  { code: 'own_figures', label: 'Has figures of your own' },
]);

const HREF = /href="(https?:\/\/[^"\s]{1,2000})"/g;

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * @param {object} input
 * @param {string} input.bodyHtml    sanitized markup
 * @param {object|null} input.jsonld the page's structured data
 * @param {string[]} [input.facts]   sentences the draft may state as fact
 * @param {string} [input.ownDomain] the business's own domain (its links do not count as outside sources)
 * @returns {{ code, label, status, finding }[]}  `status` is 'pass' or 'warn', never 'fail': these do not block
 */
export function citableChecks({ bodyHtml, jsonld = null, facts = [], ownDomain = '' }) {
  const body = analyzeBody(bodyHtml);
  const own = String(ownDomain)
    .toLowerCase()
    .replace(/^www\./, '');
  const outside = new Set();
  for (const m of String(bodyHtml ?? '').matchAll(HREF)) {
    const host = hostOf(m[1]);
    if (host && host !== own && !(own && host.endsWith(`.${own}`))) outside.add(host);
  }
  const nodes = [jsonld].flat().filter(Boolean);
  const graph = nodes.flatMap((n) => (Array.isArray(n['@graph']) ? n['@graph'] : [n]));
  const authored = graph.some((n) => {
    const a = n.author ?? n.creator;
    return Boolean(typeof a === 'string' ? a.trim() : a?.name);
  });
  const dated = graph.some((n) => n.dateModified || n.datePublished);
  const allowedFigures = new Set(facts.flatMap((f) => figuresIn(f)));
  const figuresOnPage = [...new Set(figuresIn(body.text))].filter((n) => n.length > 1);
  const ownFigures = figuresOnPage.filter((n) => allowedFigures.has(n));

  const check = (code, ok, finding) => ({
    code,
    label: CITABLE_CHECKS.find((c) => c.code === code).label,
    status: ok ? 'pass' : 'warn',
    finding: ok ? null : finding,
  });
  return [
    check(
      'sources_linked',
      outside.size >= 2,
      outside.size === 0
        ? 'The page links to no outside source. Link the source of each figure you state.'
        : 'The page links to one outside source. Pages engines cite usually link two or more.',
    ),
    check(
      'dated',
      dated,
      'The structured data carries no date. Publishing through WordPress adds one; otherwise add “Updated” and the date.',
    ),
    check(
      'author',
      authored,
      'No author is named. Add a persona with a name to your Brand Kit’s voice and the page carries it. We never make up a person.',
    ),
    check(
      'own_figures',
      ownFigures.length > 0,
      'No figure of your own on the page. If you have one (a count, a price, a year), add it as a fact in your Brand Kit. We never make one up.',
    ),
  ];
}
