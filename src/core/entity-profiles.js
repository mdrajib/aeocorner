/**
 * The places a business has a public profile, and what we do with an address a customer types (Milestone 12, MVP F2
 * "entity"). Pure: no network. The Brand Kit stores `{ platform, url }` pairs; the platform is worked out from the
 * address, never asked for, so a customer pastes links and cannot mislabel one.
 *
 * Engines treat these profiles as independent proof that a business is who it says it is, so each platform here is one
 * we can describe: how to recognise its address, what it is called, and (in `entity-guidance.js`) how to fill it in.
 */

/** Platform codes in the order the screen lists them. `other` is any profile on a site we do not know. */
export const PLATFORMS = Object.freeze({
  google_business: {
    label: 'Google Business Profile',
    match: (u) =>
      /(^|\.)(g\.page|business\.google\.com|maps\.app\.goo\.gl)$/.test(u.hostname) ||
      (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && /^\/(maps|business)\b/.test(u.pathname)),
  },
  linkedin: { label: 'LinkedIn', match: (u) => /(^|\.)linkedin\.com$/.test(u.hostname) },
  crunchbase: { label: 'Crunchbase', match: (u) => /(^|\.)crunchbase\.com$/.test(u.hostname) },
  wikipedia: { label: 'Wikipedia', match: (u) => /(^|\.)wikipedia\.org$/.test(u.hostname) },
  facebook: {
    label: 'Facebook',
    match: (u) => /(^|\.)(facebook\.com|fb\.com)$/.test(u.hostname),
  },
  x: { label: 'X', match: (u) => /(^|\.)(x\.com|twitter\.com)$/.test(u.hostname) },
  youtube: { label: 'YouTube', match: (u) => /(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname) },
  instagram: { label: 'Instagram', match: (u) => /(^|\.)instagram\.com$/.test(u.hostname) },
  g2: { label: 'G2', match: (u) => /(^|\.)g2\.com$/.test(u.hostname) },
  trustpilot: { label: 'Trustpilot', match: (u) => /(^|\.)trustpilot\.com$/.test(u.hostname) },
  other: { label: 'Other profile or directory', match: () => true },
});

export const PLATFORM_CODES = Object.freeze(Object.keys(PLATFORMS));
export const platformLabel = (code) => PLATFORMS[code]?.label ?? PLATFORMS.other.label;

export const MAX_PROFILES = 12;

/** A plain `https://` address with a real host and no user name, or null. */
export function httpsUrl(value) {
  try {
    const u = new URL(String(value ?? '').trim());
    return u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password
      ? u
      : null;
  } catch {
    return null;
  }
}

/** The platform an address belongs to. Wikidata is not a profile (it has its own check), so its pages are `other`. */
export function platformOfUrl(value) {
  const url = value instanceof URL ? value : httpsUrl(value);
  if (!url) return null;
  for (const [code, def] of Object.entries(PLATFORMS)) {
    if (code !== 'other' && def.match(url)) return code;
  }
  return 'other';
}

/** The address as it is stored and compared: no fragment, no tracking tail, no trailing slash on a path. */
export function normalizeProfileUrl(value) {
  const url = httpsUrl(value);
  if (!url) return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|igshid$|mc_)/i.test(key)) url.searchParams.delete(key);
  }
  let text = url.toString();
  if (url.pathname !== '/' && text.endsWith('/') && !url.search) text = text.slice(0, -1);
  return text;
}

/** A Wikidata item number in any of the forms a person pastes: `Q123`, `q123`, or a wikidata.org address. */
export function parseWikidataId(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const bare = /^[Qq](\d{1,12})$/.exec(text);
  if (bare) return `Q${bare[1]}`;
  const url = httpsUrl(text);
  if (url && /(^|\.)wikidata\.org$/.test(url.hostname)) {
    const match = /\/(?:wiki|entity)\/[Qq](\d{1,12})(?:$|[/?#])/.exec(url.pathname);
    if (match) return `Q${match[1]}`;
  }
  return null;
}

/**
 * Profile addresses as typed, one per line. A line that is not a full https:// address is refused with its own message
 * (never dropped quietly); a repeat is kept once; a Wikidata address is not a profile and is returned as `wikidataId`.
 *
 * @returns {{ ok: true, profiles: {platform, url}[], wikidataId: string }
 *          | { ok: false, error: string }}
 */
export function parseProfileLines(lines) {
  const profiles = [];
  const seen = new Set();
  let wikidataId = '';
  for (const raw of lines) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    const url = normalizeProfileUrl(line);
    if (!url) return { ok: false, error: `“${line.slice(0, 60)}” is not a full https:// address.` };
    const qid = parseWikidataId(url);
    if (qid) {
      wikidataId ||= qid;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    profiles.push({ platform: platformOfUrl(url), url });
  }
  if (profiles.length > MAX_PROFILES) {
    return { ok: false, error: `Add at most ${MAX_PROFILES} profile links.` };
  }
  return { ok: true, profiles, wikidataId };
}

/** The same host as the project's domain, or one of its sub-domains (so `www.` and `blog.` count). */
export function isOwnHost(host, domain) {
  const h = String(host ?? '').toLowerCase();
  const d = String(domain ?? '')
    .toLowerCase()
    .replace(/^www\./, '');
  return Boolean(d) && (h === d || h === `www.${d}` || h.endsWith(`.${d}`));
}
