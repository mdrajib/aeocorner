import { detectBotBlock } from '../crawler/bot-block.js';
import { normalizeEntityName } from './project-rules.js';
import { isOwnHost } from './entity-profiles.js';

/**
 * Entity checks (Milestone 12, tasks 12.02 and 12.03): does a profile the customer listed really describe this
 * business, and does Wikidata know it? Pure judgement over what was fetched; the fetching is in
 * `src/crawler/profile.js` and `src/integrations/wikidata.js`.
 *
 * One vocabulary for both: `status` is `passed`, `failed` or `error`, and `finding` says which kind in a word code can
 * branch on. The rule that matters most is the one the rest of the product keeps: **"we could not look" is `error`, never
 * `failed`.** A platform that blocks us, asks us to sign in, needs JavaScript, or a lookup that timed out says nothing
 * about the customer's profile, so it is never a recommendation and never counts against them. Only a page we could
 * read and that does not name the business, or one that is plainly gone (404, 410), is `failed`.
 */

export const STATUSES = Object.freeze(['passed', 'failed', 'error']);

/** What each finding means, in words a customer reads. */
export const FINDINGS = Object.freeze({
  // profile, passed
  names_brand: 'The page names your business.',
  // profile, failed
  not_found: 'The page does not exist any more (it answered “not found”).',
  brand_not_named: 'The page loads, but it does not mention your business by name.',
  // profile, error (could not look)
  robots: 'The site’s robots.txt does not let our crawler read this page.',
  blocked: 'The site turned our crawler away.',
  needs_login: 'The site asks visitors to sign in before it shows the page.',
  needs_javascript: 'The page builds itself in the browser, so there was nothing for us to read.',
  unavailable: 'The site did not answer properly just now.',
  unexpected_status: 'The site answered in a way we could not use.',
  unreadable: 'We could not read the page.',
  fetch_failed: 'We could not reach the site just now.',
  // wikidata
  found: 'Wikidata has an item for your business.',
  confirmed: 'The Wikidata item you gave matches your business.',
  mismatch: 'The Wikidata item you gave does not look like your business.',
  ambiguous: 'Wikidata has items with your name, but we cannot tell which one is yours.',
  not_in_wikidata: 'Wikidata has no item for your business.',
  lookup_failed: 'We could not reach Wikidata just now.',
});

const BLOCKING = new Set([401, 403, 406, 429, 451, 999]);
const LOGIN_WORDS =
  /^(?:log ?in|sign ?in|sign ?up|join|create an account|authwall)\b|\b(?:authwall|sign in to continue|log in to continue)\b/i;
const MIN_WORDS_TO_JUDGE = 40;
const TEXT_SCAN_CHARS = 20_000;

/** Is this business named in this text? Whole words only, after both are folded to plain lower case. */
export function namesAnyOf(text, names) {
  const haystack = ` ${normalizeEntityName(String(text ?? '').slice(0, TEXT_SCAN_CHARS))} `;
  return names.some((name) => {
    const needle = normalizeEntityName(name);
    return needle.length >= 3 && haystack.includes(` ${needle} `);
  });
}

/**
 * Judge one profile page.
 *
 * @param {object} p
 * @param {number} p.status          the HTTP status of the final response
 * @param {object} [p.headers]       its headers
 * @param {Buffer|string} [p.body]   the start of its body (for firewall pages)
 * @param {object|null} p.facts      `extractPage()` of the body, or null when it was not a page
 * @param {string[]} p.brandNames    the brand's name and aliases
 * @param {string} p.domain          the project's own domain, for "links back"
 * @returns {{ status, finding, httpStatus, reachable, namesBrand, linksBack }}
 *   `reachable`, `namesBrand` and `linksBack` are `true`, `false` or `null` (null = we could not tell)
 */
export function judgeProfile({ status, headers = {}, body = '', facts, brandNames, domain }) {
  const base = { httpStatus: status ?? null, reachable: null, namesBrand: null, linksBack: null };
  const done = (state, finding, extra = {}) => ({ status: state, finding, ...base, ...extra });

  if (status === 404 || status === 410) return done('failed', 'not_found', { reachable: false });
  if (BLOCKING.has(status) || detectBotBlock({ status, headers, body }).blocked) {
    return done('error', 'blocked');
  }
  if (status >= 500) return done('error', 'unavailable');
  if (!(status >= 200 && status < 300)) return done('error', 'unexpected_status');
  if (!facts || facts.skipped) return done('error', 'unreadable');

  const headingTexts = facts.headings.map((h) => h.text);
  const jsonLdNames = facts.jsonLd.nodes.flatMap((n) => [n.name, n.legalName, n.alternateName]);
  const where = [
    facts.title,
    facts.ogTitle,
    facts.ogSiteName,
    ...headingTexts,
    ...jsonLdNames.flat().filter((v) => typeof v === 'string'),
  ];
  const named = namesAnyOf(where.join(' \n '), brandNames) || namesAnyOf(facts.text, brandNames);
  const linksBack = facts.links.some((l) => {
    try {
      return isOwnHost(new URL(l.href).hostname, domain);
    } catch {
      return false;
    }
  });
  const read = { reachable: true, namesBrand: named, linksBack };

  if (named) return done('passed', 'names_brand', read);
  // The brand is not named. That is only the customer's problem if we were really shown their page.
  const front = `${facts.title} ${headingTexts[0] ?? ''}`;
  if (LOGIN_WORDS.test(front.trim())) {
    return done('error', 'needs_login', { reachable: true, namesBrand: null, linksBack: null });
  }
  if (facts.wordCount < MIN_WORDS_TO_JUDGE) {
    return done('error', 'needs_javascript', {
      reachable: true,
      namesBrand: null,
      linksBack: null,
    });
  }
  return done('failed', 'brand_not_named', read);
}

// --- Wikidata -----------------------------------------------------------------------------------------------

const WEBSITE = 'P856';

/** Every name an item is known by, as plain strings (labels and aliases, any language). */
function namesOf(item) {
  const out = [];
  for (const l of Object.values(item?.labels ?? {})) out.push(l?.value);
  for (const list of Object.values(item?.aliases ?? {}))
    for (const a of list ?? []) out.push(a?.value);
  return out.filter((v) => typeof v === 'string');
}

/** The hosts of the item's "official website" statements. */
function websiteHosts(item) {
  const claims = item?.claims?.[WEBSITE] ?? [];
  const hosts = [];
  for (const c of claims) {
    const value = c?.mainsnak?.datavalue?.value;
    if (typeof value !== 'string') continue;
    try {
      hosts.push(new URL(value).hostname.toLowerCase());
    } catch {
      // A website statement that is not an address says nothing.
    }
  }
  return hosts;
}

const summarize = (item) => ({
  id: item.id,
  label: item.labels?.en?.value ?? Object.values(item.labels ?? {})[0]?.value ?? '',
  description:
    item.descriptions?.en?.value ?? Object.values(item.descriptions ?? {})[0]?.value ?? '',
});

/**
 * Judge the Wikidata lookup.
 *
 * @param {object} p
 * @param {string[]} p.brandNames
 * @param {string} p.domain
 * @param {string} [p.givenId]       the item the customer named, if any
 * @param {object[]} p.items         full items (`labels`, `aliases`, `descriptions`, `claims`): the one given, or the
 *                                   candidates the name search found
 * @returns {{ status, finding, item: {id,label,description}|null, candidates: number }}
 *
 * An item is "yours" with certainty only if its official website is your domain. A name match alone is not enough (many
 * businesses share a name): one name match is `ambiguous` unless the customer named the item themselves.
 */
export function judgeWikidata({ brandNames, domain, givenId = '', items }) {
  const wanted = brandNames.map(normalizeEntityName).filter((n) => n.length >= 3);
  const nameMatches = (item) => namesOf(item).some((n) => wanted.includes(normalizeEntityName(n)));
  const websiteMatches = (item) => websiteHosts(item).some((h) => isOwnHost(h, domain));

  if (givenId) {
    const item = items.find((i) => i.id === givenId);
    if (!item || item.missing !== undefined) {
      return { status: 'failed', finding: 'not_in_wikidata', item: null, candidates: 0 };
    }
    return nameMatches(item) || websiteMatches(item)
      ? { status: 'passed', finding: 'confirmed', item: summarize(item), candidates: 1 }
      : { status: 'failed', finding: 'mismatch', item: summarize(item), candidates: 1 };
  }

  const byWebsite = items.filter(websiteMatches);
  if (byWebsite.length === 1) {
    return { status: 'passed', finding: 'found', item: summarize(byWebsite[0]), candidates: 1 };
  }
  if (byWebsite.length > 1) {
    return { status: 'failed', finding: 'ambiguous', item: null, candidates: byWebsite.length };
  }
  const byName = items.filter(nameMatches);
  if (byName.length > 0) {
    return { status: 'failed', finding: 'ambiguous', item: null, candidates: byName.length };
  }
  return { status: 'failed', finding: 'not_in_wikidata', item: null, candidates: 0 };
}

// --- What the rest of the product reads -----------------------------------------------------------------------

/** The profile addresses that passed their check: the only ones that may go into a site's `sameAs`. */
export const verifiedProfileUrls = (checks) =>
  checks.filter((c) => c.kind === 'profile' && c.status === 'passed').map((c) => c.subject);
