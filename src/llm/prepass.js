import { createHash } from 'node:crypto';
import { hostBelongsTo, normalizeDomain, normalizeName } from './names.js';

/**
 * The deterministic pre-pass (MVP §6.4 step 1): free, instant, and run on every answer before Claude sees it.
 *
 *   1. Which tracked brands does the answer name? Each alias is looked for case-insensitively, as a whole word
 *      ("Acme's" counts, "Acmeville" does not), and a brand's domain written in the text ("acme.com") counts as
 *      naming it. A "That's not us" rule (an `exclude` alias) removes the matches it covers.
 *   2. Which sources does it cite? The provider's own source list first, in its order, then any link written in
 *      the text that the list doesn't already have. Each gets its domain and, when the domain is a tracked
 *      brand's, that brand as its owner.
 *
 * Claude's reading is checked against step 1: where the two disagree about a tracked brand, the answer goes to
 * the review queue (§6.4 step 4).
 *
 * The text is someone else's words (an AI engine's answer, which can quote any website), so everything here is
 * linear in its length: plain `indexOf` scans and one regex with no nested repetition. Nothing is recursive.
 */

export const PREPASS_VERSION = 'p1';

/** Longer answers are cut here before scanning; the providers' answers are a few thousand characters. */
export const MAX_TEXT_CHARS = 200_000;
const MAX_TEXT_URLS = 100;
const EXCERPT_CHARS = 280;

const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** Every place `needle` occurs in `hay` as a whole word. Both are already lower-case. */
function wholeWordHits(hay, needle) {
  const hits = [];
  if (!needle) return hits;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    // A needle that starts or ends with punctuation ("monday.com", "C++") is bounded by it already.
    const startsWord = isWordChar(needle[0]);
    const endsWord = isWordChar(needle[needle.length - 1]);
    if (startsWord && isWordChar(hay[at - 1])) continue;
    if (endsWord && isWordChar(hay[at + needle.length])) continue;
    hits.push({ start: at, end: at + needle.length });
  }
  return hits;
}

const lower = (text) => text.toLowerCase();

/**
 * The words to look for, per entity. `entities` are tracked brands with their names, aliases, domains and
 * exclusions (see `entityShape` in extraction.js).
 */
function needlesOf(entities) {
  const needles = [];
  const excludes = [];
  for (const entity of entities) {
    const names = new Set(
      [entity.name, ...(entity.aliases ?? [])].map((n) => lower(String(n ?? '').trim())),
    );
    for (const name of names) {
      if (name.length >= 2) needles.push({ entity, text: name, via: 'name' });
    }
    for (const domain of new Set((entity.domains ?? []).map(normalizeDomain))) {
      if (domain) needles.push({ entity, text: domain, via: 'domain' });
    }
    for (const phrase of entity.excludes ?? []) {
      const text = lower(String(phrase ?? '').trim());
      if (text.length >= 2) excludes.push(text);
    }
  }
  return { needles, excludes };
}

/**
 * Find the tracked brands an answer names.
 *
 * @returns {Array<{ entity, count, firstIndex, via, nameAsWritten, excerpt, listItem }>} in the order they
 *   first appear
 */
export function findMentions(text, entities) {
  const source = String(text ?? '').slice(0, MAX_TEXT_CHARS);
  // Names inside links are where the answer cites, not what it says: blanked out, so they count as citations only.
  const hay = maskLinks(lower(source));
  // Lower-casing can change a string's length (a few non-English letters); positions are only reused on the
  // original text when it doesn't.
  const sameLength = hay.length === source.length;
  const { needles, excludes } = needlesOf(entities);

  const insideExclusion = overlapTest(excludes.flatMap((phrase) => wholeWordHits(hay, phrase)));

  // Every hit of every needle; where two overlap, the longer one wins ("HubSpot CRM" over "HubSpot"), so an
  // alias that is part of another brand's name can't claim it.
  const hits = [];
  for (const needle of needles) {
    for (const hit of wholeWordHits(hay, needle.text)) {
      if (!insideExclusion(hit)) hits.push({ ...hit, needle });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept = [];
  let coveredTo = -1;
  for (const hit of hits) {
    if (hit.start < coveredTo) continue;
    kept.push(hit);
    coveredTo = hit.end;
  }

  const lists = sameLength ? listItemIndex(source) : null;
  const byEntity = new Map();
  for (const hit of kept) {
    const { entity, via } = hit.needle;
    const found = byEntity.get(entity);
    if (found) {
      found.count += 1;
      continue;
    }
    byEntity.set(entity, {
      entity,
      count: 1,
      firstIndex: hit.start,
      via,
      nameAsWritten: (sameLength ? source : hay).slice(hit.start, hit.end),
      excerpt: excerptAround(sameLength ? source : hay, hit.start, hit.end),
      listItem: lists ? lists(hit.start) : null,
    });
  }
  return [...byEntity.values()].sort((a, b) => a.firstIndex - b.firstIndex);
}

/**
 * A test "does this span overlap any of these?" that stays fast with thousands of each: the spans are merged
 * into disjoint ones once, then each question is a binary search.
 */
function overlapTest(spans) {
  const merged = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ start: s.start, end: s.end });
  }
  return (hit) => {
    let lo = 0;
    let hi = merged.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = merged[mid];
      if (s.end <= hit.start) lo = mid + 1;
      else if (s.start >= hit.end) hi = mid - 1;
      else return true;
    }
    return false;
  };
}

/** A sentence-sized piece of text around a match, on word boundaries, for staff and the review queue. */
function excerptAround(text, start, end) {
  const room = Math.max(0, EXCERPT_CHARS - (end - start));
  let from = Math.max(0, start - Math.floor(room / 2));
  let to = Math.min(text.length, end + Math.ceil(room / 2));
  const lineStart = text.lastIndexOf('\n', start);
  if (lineStart >= from) from = lineStart + 1;
  const lineEnd = text.indexOf('\n', end);
  if (lineEnd !== -1 && lineEnd < to) to = lineEnd;
  return text.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
}

/**
 * A function giving, for a position in the text, which item of the answer's first numbered list it falls in
 * (1-based), or null when it isn't inside one. A hint only: Claude decides the rank; this lets the eval and the
 * review queue see where the rule-based reading put it.
 */
function listItemIndex(text) {
  const items = [];
  let offset = 0;
  let inList = false;
  let ended = false;
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(\d{1,2})[.)]\s+\S/.exec(line);
    if (marker && !ended) {
      inList = true;
      items.push({ start: offset, end: offset + line.length, n: items.length + 1 });
    } else if (inList && items.length) {
      const last = items[items.length - 1];
      // Indented continuation and blank lines belong to the item above; a new heading or paragraph ends the list.
      if (line.trim() === '' || /^\s{2,}\S/.test(line) || /^\s*[-*+]\s/.test(line)) {
        last.end = offset + line.length;
      } else {
        ended = true;
        inList = false;
      }
    }
    offset += line.length + 1;
  }
  return (position) => items.find((i) => position >= i.start && position <= i.end)?.n ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Citations

const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]{}"'`|\\^]+/g;
const LINK_TEXT = /\[([^\]\n]{1,300})\]\(/g;

/**
 * The text with every URL, and every link whose visible text is just a domain ("[www.acme.com](…)", the way
 * ChatGPT and Gemini show a source), replaced by spaces of the same length. Positions stay where they were, so
 * matches still point into the original text. A domain written in a sentence ("visit acme.com") is untouched.
 */
export function maskLinks(text) {
  const spans = [];
  for (const m of text.matchAll(URL_IN_TEXT)) spans.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(LINK_TEXT)) {
    const inner = m[1].trim();
    if (!/\s/.test(inner) && normalizeDomain(inner)) {
      spans.push([m.index + 1, m.index + 1 + m[1].length]);
    }
  }
  if (spans.length === 0) return text;
  // One pass over the spans in order, so a text full of links still costs time in proportion to its length.
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [start, end] of spans) {
    if (end <= pos) continue;
    const from = Math.max(start, pos);
    out += text.slice(pos, from) + ' '.repeat(end - from);
    pos = end;
  }
  return out + text.slice(pos);
}

/** Links written in the text, in order, without trailing punctuation. */
export function urlsInText(text) {
  const out = [];
  const source = String(text ?? '').slice(0, MAX_TEXT_CHARS);
  for (const match of source.matchAll(URL_IN_TEXT)) {
    if (match[0].length > 2048) continue;
    const url = match[0].replace(/[.,;:!?*_~]+$/, '');
    out.push(url);
    if (out.length >= MAX_TEXT_URLS) break;
  }
  return out;
}

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|ref_src)$/i;

/**
 * The form of a cited URL we store and compare: scheme and host lower-case, no default port, no fragment (engines
 * add `#:~:text=` highlights), no tracking parameters (ChatGPT adds `utm_source=chatgpt.com`). Null for anything
 * that isn't an http(s) URL.
 */
export function normalizeCitedUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
  }
  const text = parsed.toString().replace(/\?$/, '');
  return text.length <= 2048 ? text : null;
}

export const urlHash = (normalizedUrl) => createHash('sha256').update(normalizedUrl).digest();

/**
 * The sources an answer cites, numbered 1..n: the provider's list in its own order, then links from the text
 * that the list didn't have. Each carries its domain and the tracked brand that owns that domain, if any.
 */
export function collectCitations(sources, text, entities) {
  const seen = new Set();
  const out = [];
  const add = (rawUrl, { title = null, origin }) => {
    const url = normalizeCitedUrl(rawUrl);
    if (!url || seen.has(url)) return;
    const domain = normalizeDomain(url);
    if (!domain) return;
    seen.add(url);
    const owner = ownerOf(domain, entities);
    out.push({
      position: out.length + 1,
      url,
      domain,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 512) : null,
      owner,
      origin,
    });
  };
  for (const s of [...(sources ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    add(s.url, { title: s.title, origin: 'provider' });
  }
  for (const url of urlsInText(text)) add(url, { origin: 'text' });
  return out;
}

/** The tracked brand whose domain this is (the longest matching domain wins), or null. */
function ownerOf(host, entities) {
  let best = null;
  let bestLength = 0;
  for (const entity of entities) {
    for (const d of entity.domains ?? []) {
      const domain = normalizeDomain(d);
      if (domain && hostBelongsTo(host, domain) && domain.length > bestLength) {
        best = entity;
        bestLength = domain.length;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * The whole pre-pass for one answer.
 *
 * @param {{ text: string, sources: Array }} answer   the normalized answer (src/engines/contract.js)
 * @param {Array} entities   tracked brands: { id, ref, kind, name, aliases, domains, excludes }
 */
export function runPrepass(answer, entities) {
  const mentions = findMentions(answer.text, entities);
  const citations = collectCitations(answer.sources, answer.text, entities);
  return { version: PREPASS_VERSION, mentions, citations };
}

/** What `answer_snapshots.prepass` keeps: which tracked entities the pre-pass found, and how. */
export function prepassRecord(prepass) {
  return {
    v: prepass.version,
    found: prepass.mentions.map((m) => ({
      entityId: String(m.entity.id),
      count: m.count,
      via: m.via,
      ...(m.listItem ? { listItem: m.listItem } : {}),
    })),
    citations: prepass.citations.length,
  };
}

export { normalizeName };
