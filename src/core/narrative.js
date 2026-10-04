import { READINESS_GUIDANCE } from './fix-list.js';

/**
 * The words on a recommendation (MVP F7: "an LLM writes the narrative and the specific steps"; the table in §7.? says
 * "evidence passed in; never free-form facts"). Pure, with no network.
 *
 * The rule is: a narrative may say nothing about the customer that its evidence does not say. That is made checkable
 * by working from a closed set of FACTS:
 *
 *   factsFor(evidence)       the sentences the evidence supports, written by us. Every number, site name and quoted
 *                            phrase about the customer is in one of them.
 *   templateNarrative(...)   the narrative built from those facts and from fixed advice. It is stored the moment a
 *                            recommendation is raised, so no recommendation is ever without a why and the steps, and
 *                            it costs nothing. It is also the fallback when a model's text fails the check.
 *   findUnsupported(...)     the check: every number, site name, quoted phrase and proper name in a narrative must be
 *                            in the facts (or, for the steps, in the fixed advice). A model's text is stored only if
 *                            this finds nothing; `npm run eval:narrative` runs it over a corpus.
 *
 * Changing a template, a fact or the advice means bumping `TEMPLATE_VERSION`; a model-written narrative has its own
 * version, set in `src/llm/narrative.js`.
 */

export const TEMPLATE_VERSION = 't1';

/** One sentence about why this kind of fix matters. Advice, so it has no figures and names nobody. */
const CATEGORY_WHY = Object.freeze({
  crawler_access: 'If AI crawlers cannot read your site, engines have nothing of yours to quote.',
  renderability:
    'Many AI crawlers read only the page the server sends. Text that appears later is invisible to them.',
  structured_data:
    'Structured data tells engines exactly who you are and what each page is, in a form they do not have to guess.',
  entity:
    'Engines name businesses they can identify with confidence, so a clear, consistent identity matters.',
  content_new:
    'When an engine has no page of yours that answers a question, it answers from other sites and names them instead.',
  content_refresh: 'Engines quote pages that answer directly, are easy to scan and look current.',
  offsite_presence:
    'Engines lean on sites they already trust, so being present there shapes what they say about you.',
  reputation: 'How engines describe you affects whether they recommend you.',
  technical:
    'Basic technical health decides whether engines can reach and trust your pages at all.',
});

export const DEFAULT_ENGINE_LABELS = Object.freeze({
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  google_aio: 'Google AI Overviews',
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (items) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const fmt = (n) => String(Math.round(Number(n) * 100) / 100);

/**
 * The facts the evidence supports, as plain sentences.
 *
 * @param evidence  a recommendation's `evidence`
 * @param context   `{ brandName, domain, engineLabel }`
 * @returns `[{ id, text }]`; empty when the evidence is not one we know (then there is nothing to say)
 */
export function factsFor(evidence, { brandName, domain, engineLabel = (c) => c } = {}) {
  const facts = [];
  const add = (text) => facts.push({ id: `f${facts.length + 1}`, text });
  switch (evidence?.type) {
    case 'readiness': {
      const c = evidence.check;
      add(
        `Our latest scan of ${domain} looked at “${c.title}” (check ${c.code}) and it earned ${fmt(c.points)} of ${fmt(c.possible)} points.`,
      );
      if (c.summary) add(`What the scan saw: ${String(c.summary).replace(/[.\s]+$/, '')}.`);
      break;
    }
    case 'lost_prompt': {
      const engines = (evidence.engines ?? []).map(engineLabel);
      add(
        `For the question “${evidence.question}”, we read ${plural(evidence.answersRead, 'answer', 'answers')} from ${list(engines)}, and ${brandName} was not named in any of them.`,
      );
      const rivals = evidence.competitors ?? [];
      if (rivals.length) {
        add(
          `Named instead: ${list(rivals.map((r) => `${r.name} (${plural(r.k, 'time', 'times')})`))}.`,
        );
      }
      break;
    }
    case 'cited_source': {
      add(
        `${evidence.domain}${evidence.siteType ? ` (${String(evidence.siteType).toLowerCase()})` : ''} was cited ${plural(evidence.timesCited, 'time', 'times')}, in ${plural(evidence.answersCiting, 'answer', 'answers')}.`,
      );
      add(`In ${evidence.answersWithoutBrand} of those answers, ${brandName} was not named.`);
      break;
    }
    case 'sentiment': {
      add(
        `Across ${plural(evidence.answers, 'answer', 'answers')} that name ${brandName}, the average sentiment was ${fmt(evidence.average)} on a scale from -2 (very negative) to 2 (very positive).`,
      );
      break;
    }
    default:
      break;
  }
  return facts;
}

/** The fixed steps for a recommendation: advice that is true of every site, with no figures about this one. */
export function adviceSteps(ruleCode, evidence = {}) {
  const [family, rule] = String(ruleCode).split('.');
  let steps;
  if (family === 'readiness') {
    const guidance = READINESS_GUIDANCE[rule];
    steps = [
      guidance?.how ?? 'Fix the issue on your site.',
      'When the change is live, press “Mark as done”. We re-check your site straight away to confirm it.',
    ];
  } else if (rule === 'lost_prompt') {
    steps = [
      'Write a page that answers this question directly: a short, plain answer first, then the detail, with your name, what you do and who it is for.',
      'Say how you compare with the businesses named in the answers, where that is honest, and back each claim with a source.',
      'Publish it on your own site and link to it from a page people already visit. Then press “Mark as done”: we measure whether the engines start naming you.',
    ];
  } else if (rule === 'cited_source') {
    steps = [
      `Find out how businesses get listed, reviewed or quoted on ${evidence.domain ?? 'that site'}.`,
      'Create or claim your profile there, and keep your name, description and contact details identical to your own site.',
      'Press “Mark as done” once it is live. We cannot check an outside site automatically, so we measure the effect on your answers instead.',
    ];
  } else if (rule === 'hedged') {
    steps = [
      'Read the answers that describe you coolly, on the Answers page, and note the claim or gap each one points to.',
      'Fix it where it comes from: your own pages, and the profiles and listings that describe you.',
      'Publish a clear, factual page that addresses it. Then press “Mark as done” and we measure whether the tone changes.',
    ];
  } else {
    steps = ['Fix the issue, then press “Mark as done”.'];
  }
  return steps;
}

/** The numbers, in order, that the fixed advice itself contains (a step may say "60 words"). */
export const adviceTextFor = (ruleCode, evidence) => adviceSteps(ruleCode, evidence).join('\n');

/**
 * The narrative built from the facts and the fixed advice.
 * @returns `{ why, steps, version }`: `why` is paragraphs separated by a blank line, `steps` one step per line, each
 *          starting "1. ", "2. ", …
 */
export function templateNarrative({ ruleCode, category, evidence }, context) {
  const facts = factsFor(evidence, context);
  const why = [facts.map((f) => f.text).join(' '), CATEGORY_WHY[category] ?? '']
    .filter(Boolean)
    .join('\n\n');
  const steps = adviceSteps(ruleCode, evidence)
    .map((step, i) => `${i + 1}. ${step}`)
    .join('\n');
  return { why, steps, version: TEMPLATE_VERSION };
}

// --- The check ---------------------------------------------------------------------------------------------

/** Terms every narrative may use: products and standards the advice is about, not claims about the customer. */
const COMMON_TERMS = new Set(
  [
    'AI',
    'AIs',
    'Google',
    'ChatGPT',
    'Perplexity',
    'Gemini',
    'Claude',
    'OpenAI',
    'Bing',
    'Overviews',
    'Overview',
    'JSON-LD',
    'FAQ',
    'FAQs',
    'FAQPage',
    'HowTo',
    'Product',
    'Service',
    'Article',
    'Organization',
    'LocalBusiness',
    'WebSite',
    'BreadcrumbList',
    'WordPress',
    'Cloudflare',
    'HTML',
    'HTTPS',
    'URL',
    'URLs',
    'XML',
    'CDN',
    'SEO',
    'LinkedIn',
    'Wikipedia',
    'Wikidata',
    'Crunchbase',
    'G2',
    'Business',
    'Profile',
    'Profiles',
    'Answers',
    'Mark',
    'Named',
    'Our',
    'For',
    'The',
    'In',
    'If',
    'When',
    'Many',
    'Engines',
    'Basic',
    'How',
    'What',
    'Across',
    'Find',
    'Create',
    'Write',
    'Read',
    'Fix',
    'Publish',
    'Say',
    'Then',
    'Press',
    'Once',
    'Add',
    'Use',
    'Put',
    'Allow',
    'Stop',
    'Serve',
    'Give',
    'Make',
    'Link',
    'Show',
    'Open',
    'Move',
    'Pick',
    'Validate',
    'Mark',
    'Home',
    'About',
    'Updated',
    'Sitemap',
    'Organization',
    'Instead',
    'Check',
    'Structured',
    'Text',
  ].map((t) => t.toLowerCase()),
);

/** File names and standards written with a dot that are not website names. */
const COMMON_DOTTED = new Set([
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  'schema.org',
  'e.g',
  'i.e',
]);

const NUMBER = /(?<![\w.])-?\d+(?:[.,]\d+)?/g;
const DOTTED = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/gi;
const QUOTED = /[“"]([^”"]{1,400})[”"]/g;
const WORD = /[A-Za-z][A-Za-z0-9-]*/g;

const numbersIn = (text) =>
  new Set([...String(text).matchAll(NUMBER)].map((m) => Math.abs(Number(m[0].replace(',', '.')))));
const dottedIn = (text) =>
  new Set(
    [...String(text).matchAll(DOTTED)]
      .map((m) => m[0].toLowerCase().replace(/\.$/, ''))
      .filter((d) => !/^\d+(\.\d+)*$/.test(d)),
  );
const quotedIn = (text) => [...String(text).matchAll(QUOTED)].map((m) => m[1].trim());

/** Capitalized words that do not start a sentence: the shape of a name. */
function properNamesIn(text) {
  const names = [];
  const clean = String(text).replace(QUOTED, ' ');
  for (const line of clean.split(/\n+/)) {
    // Drop a list marker, then walk the words; a word after . ! ? : starts a sentence.
    const body = line.replace(/^\s*\d+\.\s*/, '');
    let atStart = true;
    let last = 0;
    for (const m of body.matchAll(WORD)) {
      const between = body.slice(last, m.index);
      if (/[.!?:]\s*$/.test(between) || last === 0) atStart = true;
      const word = m[0];
      if (!atStart && /^[A-Z]/.test(word)) names.push(word);
      atStart = false;
      last = m.index + word.length;
    }
  }
  return names;
}

const vocabulary = (texts) => {
  const all = texts.join('\n');
  return {
    numbers: numbersIn(all),
    dotted: dottedIn(all),
    quotes: texts.map((t) => t.toLowerCase()),
    words: new Set([...all.matchAll(WORD)].map((m) => m[0].toLowerCase())),
  };
};

/** "1. Do this" is a list marker, not a figure. */
const withoutMarkers = (text) => String(text).replace(/^[ \t]*\d+[.)][ \t]+/gm, '');

function checkText(text, vocab, where) {
  const problems = [];
  for (const n of numbersIn(withoutMarkers(text))) {
    if (!vocab.numbers.has(n)) problems.push({ kind: 'number', value: String(n), where });
  }
  for (const d of dottedIn(text)) {
    if (!vocab.dotted.has(d) && !COMMON_DOTTED.has(d))
      problems.push({ kind: 'site', value: d, where });
  }
  for (const q of quotedIn(text)) {
    const needle = q.toLowerCase();
    if (!vocab.quotes.some((t) => t.includes(needle)))
      problems.push({ kind: 'quote', value: q, where });
  }
  for (const w of properNamesIn(text)) {
    const lower = w.toLowerCase();
    if (!vocab.words.has(lower) && !COMMON_TERMS.has(lower))
      problems.push({ kind: 'name', value: w, where });
  }
  return problems;
}

/**
 * Everything in a narrative that its evidence does not support. Empty means the narrative is safe to show.
 *
 * @param narrative  `{ why, steps }` (strings)
 * @param facts      `factsFor(...)` of the recommendation's evidence
 * @param advice     the fixed advice text for the rule (`adviceTextFor`): the steps may use its words and figures; the
 *                   why may not (a "why" is about the customer)
 * @param context    `{ brandName, domain }`, which the text may always name
 */
export function findUnsupported({ why, steps }, facts, advice, { brandName, domain } = {}) {
  const base = [...facts.map((f) => f.text), brandName ?? '', domain ?? ''].filter(Boolean);
  const whyVocab = vocabulary([...base, ...Object.values(CATEGORY_WHY)]);
  const stepsVocab = vocabulary([...base, advice ?? '']);
  return [...checkText(why ?? '', whyVocab, 'why'), ...checkText(steps ?? '', stepsVocab, 'steps')];
}
