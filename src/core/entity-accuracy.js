import { normalizeEntityName } from './project-rules.js';

/**
 * Entity accuracy (Milestone 12, task 12.04): what the AI engines say about the brand, compared with what the customer
 * has told us in the Brand Kit. Pure and deterministic. The input is the `claims` rows extraction already wrote for the
 * brand, in answers to the brand-intent questions; nothing here calls a model.
 *
 * Only three facts are checked, because they are the ones a customer states precisely and an engine states plainly:
 *
 *   founded         the year the business began   (entity.foundingYear)
 *   headquarters    where it is based             (entity.headquarters)
 *   price           what it costs                 (the dollar amounts in the offerings' prices)
 *
 * A fact is only compared if the customer stated it. For each, a claim is `right` (it agrees), `wrong` (it says something
 * that does not), or not about that fact at all. The rules lean AWAY from accusing an engine: a claim with two amounts is
 * right if either matches, a place is right if it shares any word with the customer's, and anything we cannot read is
 * simply not counted. **A wrong fact is the finding**; "not mentioned" is not one, and with no readable brand answers at
 * all, nothing is "not mentioned" either: it is `unknown`.
 */

export const FACTS = Object.freeze({
  founded: 'Year founded',
  headquarters: 'Where you are based',
  price: 'Price',
});

const EXAMPLES_PER_FACT = 3;
const clip = (text, max) => {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

// --- founded -------------------------------------------------------------------------------------------------

// The words around a year are bounded (at most 40 characters between them), so a hostile sentence cannot make this slow.
const FOUNDED =
  /\b(?:founded|established|est\.?|started|launched|incorporated|opened|formed|in business since|operating since|since)\b[^.\d]{0,40}?\b(1[89]\d{2}|20\d{2})\b/i;

function foundedVerdict(value, expected) {
  const year = FOUNDED.exec(value)?.[1];
  if (!year) return null;
  return year === expected ? 'right' : 'wrong';
}

// --- headquarters --------------------------------------------------------------------------------------------

const BASED =
  /\b(?:based|headquartered|located|situated|headquarters)\s+(?:out of|in|at)\s+([^,.;()\d]{2,50})(?:,\s*([^,.;()\d]{2,30}))?/i;
const PLACE_STOP = new Set([
  'the',
  'and',
  'area',
  'greater',
  'city',
  'county',
  'state',
  'region',
  'metro',
  'united',
  'states',
  'usa',
  'north',
  'south',
  'east',
  'west',
]);
const placeWords = (text) =>
  new Set(
    normalizeEntityName(text)
      .split(' ')
      .filter((w) => w.length >= 3 && !PLACE_STOP.has(w)),
  );

function headquartersVerdict(value, expected) {
  const m = BASED.exec(value);
  if (!m) return null;
  const said = placeWords(`${m[1]} ${m[2] ?? ''}`);
  const ours = placeWords(expected);
  if (said.size === 0 || ours.size === 0) return null;
  for (const w of said) if (ours.has(w)) return 'right';
  return 'wrong';
}

// --- price ---------------------------------------------------------------------------------------------------

const AMOUNT = /(?:[$£€]|\b(?:USD|GBP|EUR)\s?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi;

/** The money amounts written in a text, as numbers (`$1,299.50` is 1299.5). A bounded scan of one short string. */
export function amountsIn(text) {
  const out = [];
  for (const m of String(text ?? '')
    .slice(0, 600)
    .matchAll(AMOUNT)) {
    out.push(Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`));
  }
  return out;
}

function priceVerdict(value, expectedAmounts) {
  const said = amountsIn(value);
  if (said.length === 0) return null;
  return said.some((a) => expectedAmounts.has(a)) ? 'right' : 'wrong';
}

// --- the comparison ------------------------------------------------------------------------------------------

/** What the customer has stated that we can check, as `{ founded?, headquarters?, price? }` (a missing key is not checked). */
export function statedFacts(kit) {
  const out = {};
  const year = kit?.entity?.foundingYear;
  if (/^\d{4}$/.test(year ?? '')) out.founded = year;
  const place = kit?.entity?.headquarters?.trim();
  if (place && placeWords(place).size > 0) out.headquarters = place;
  const amounts = new Set((kit?.offerings?.items ?? []).flatMap((o) => amountsIn(o.price)));
  if (amounts.size > 0) out.price = amounts;
  return out;
}

/** The customer's value for a fact, for display. */
export function expectedText(key, stated) {
  if (key === 'price') {
    return [...stated.price]
      .sort((a, b) => a - b)
      .map((n) => `$${n.toLocaleString('en-US')}`)
      .join(', ');
  }
  return String(stated[key]);
}

/**
 * @param {object} p
 * @param {object} p.kit            the current Brand Kit
 * @param {{ id, engineCode, attribute, value }[]} p.claims   the brand's claims in readable brand-intent answers
 * @param {number} p.answersRead    how many such answers were read (0: nothing can be "not mentioned")
 * @returns {{ answersRead, facts: { key, label, expected, status, right, wrong, engines, examples }[] }}
 *   `status` is `wrong` (at least one claim contradicts it), `right`, `not_mentioned` or `unknown`.
 */
export function checkFacts({ kit, claims, answersRead }) {
  const stated = statedFacts(kit);
  const facts = [];
  for (const key of Object.keys(FACTS)) {
    if (!(key in stated)) continue;
    let right = 0;
    let wrong = 0;
    const engines = {};
    const examples = [];
    const seen = new Set();
    for (const claim of claims) {
      const value = String(claim.value ?? '');
      let verdict = null;
      if (key === 'founded') verdict = foundedVerdict(value, stated.founded);
      else if (key === 'headquarters') verdict = headquartersVerdict(value, stated.headquarters);
      else if (/^(pricing|price)$/i.test(claim.attribute ?? '')) {
        verdict = priceVerdict(value, stated.price);
      }
      if (!verdict) continue;
      if (verdict === 'right') right += 1;
      else wrong += 1;
      const e = (engines[claim.engineCode] ??= { right: 0, wrong: 0 });
      e[verdict] += 1;
      if (verdict === 'wrong') {
        const said = clip(value, 200);
        const id = `${claim.engineCode}|${said}`;
        if (!seen.has(id)) {
          seen.add(id);
          examples.push({ engine: claim.engineCode, said });
        }
      }
    }
    // Sorted before they are cut, so the same claims always give the same three, whatever order they arrived in.
    examples.sort((a, b) => a.engine.localeCompare(b.engine) || a.said.localeCompare(b.said));
    examples.length = Math.min(examples.length, EXAMPLES_PER_FACT);
    facts.push({
      key,
      label: FACTS[key],
      expected: expectedText(key, stated),
      status:
        wrong > 0 ? 'wrong' : right > 0 ? 'right' : answersRead > 0 ? 'not_mentioned' : 'unknown',
      right,
      wrong,
      engines,
      examples,
    });
  }
  return { answersRead, facts };
}
