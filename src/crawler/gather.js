import { detectBotBlock } from './bot-block.js';
import { decodeBody } from './decode.js';
import { parseRobots, ROBOTS_MAX_BYTES } from './robots.js';
import { FetchError } from './safe-fetch.js';
import { inflateIfGzipped, parseSitemap, SITEMAP_LIMITS } from './sitemap.js';

/**
 * The three files a site publishes for crawlers: robots.txt, its sitemaps and llms.txt. The site scan reads them
 * (`runSiteScan`) and so do the free tools (ADR-0017), through these functions, so both say the same thing about the
 * same site. A function takes `get` (a fetch that reports failure as data, see `createGet`) and, if the caller keeps
 * raw files, `save(kind, res, body?)` returning `{ key }`. Without `save` nothing is stored and `key` is null.
 *
 * A thing we could not look at is never "not there": a firewall's answer, a server error and a timeout are
 * `unreachable` / `error`, and only what the site itself said is `missing`.
 */

export const PAGE_BODY_TYPES = [/html/i, /xml/i, /^text\//i];
export const TEXT_BODY_TYPES = [/^text\//i, /xml/i, /json/i, /octet-stream/i, /^$/];
export const SITEMAP_BODY_TYPES = [/xml/i, /^text\//i, /gzip/i, /octet-stream/i, /^$/];
export const DEFAULT_SITEMAPS = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];
export const SITEMAP_MAX_BYTES = 5 * 1024 * 1024;
export const LLMS_MAX_BYTES = 1024 * 1024;

/**
 * A fetch that reports failure as data: `{ ok: true, ...response }` or `{ ok: false, error: { code, message, guard } }`.
 * Every connection made is pushed onto `connections` (to show what a scan touched); anything that is not a
 * `FetchError` is a bug and is thrown.
 */
export function createGet({ fetcher, connections = [], log = () => {} }) {
  return async function get(url, options = {}) {
    try {
      const res = await fetcher.fetch(url, options);
      connections.push(...res.connections);
      return { ok: true, ...res };
    } catch (err) {
      if (!(err instanceof FetchError)) throw err;
      log('fetch_failed', { url, code: err.code });
      return {
        ok: false,
        error: { code: err.code, message: err.message, guard: err.code.startsWith('blocked_') },
      };
    }
  };
}

const keyOf = async (save, kind, res, body) =>
  save ? ((await save(kind, res, body))?.key ?? null) : null;

/**
 * robots.txt of one origin: `{ origin, status: 'ok' | 'missing' | 'unreachable', httpStatus, parsed, key, error, blocked? }`.
 * `missing` (no file, or a web page where the file should be) means nothing is off limits; `unreachable` means we
 * could not tell (a firewall, a 429 or 5xx, a failed connection), which is never "no rules".
 */
export async function fetchRobots(get, origin, { save } = {}) {
  const res = await get(`${origin}/robots.txt`, {
    maxBytes: ROBOTS_MAX_BYTES,
    bodyTypes: TEXT_BODY_TYPES,
  });
  const info = {
    origin,
    status: 'unreachable',
    httpStatus: res.ok ? res.status : null,
    parsed: null,
    key: null,
    error: res.ok ? null : res.error.code,
  };
  if (res.ok && detectBotBlock(res).blocked) {
    // A firewall answered instead of the site. We can't tell what robots.txt says; that is not "no rules".
    info.error = 'blocked_by_firewall';
    info.blocked = true;
  } else if (res.ok) {
    const text = decodeBody(res.body, res.contentType).text;
    if (res.status >= 200 && res.status < 300) {
      const looksLikeHtml = /html/i.test(res.contentType) || /^\s*</.test(text);
      if (looksLikeHtml || res.bodySkipped) {
        info.status = 'missing'; // a web page served where robots.txt should be: no rules
      } else {
        info.status = 'ok';
        info.parsed = parseRobots(text);
        info.key = await keyOf(save, 'robots', res);
      }
    } else if (res.status === 429 || res.status >= 500) {
      info.status = 'unreachable'; // RFC 9309: assume the worst
    } else {
      info.status = 'missing'; // 404 and the like: nothing is off limits
    }
  }
  return info;
}

/** The empty result `readSitemap` adds to. `referenced` is what robots.txt names. */
export const newSitemapState = (robots) => ({
  found: [],
  referenced: robots?.parsed?.sitemaps ?? [],
  lastmods: [],
  urls: [],
  blocked: false,
});

/** Where to look for sitemaps: the ones robots.txt names (at most 3), else the usual addresses. */
export function sitemapCandidates(robots, origin) {
  return robots?.parsed?.sitemaps.length
    ? robots.parsed.sitemaps.slice(0, 3)
    : DEFAULT_SITEMAPS.map((p) => `${origin}${p}`);
}

/**
 * Read one sitemap into `state` (and, for an index at depth 0, up to `maxChildren` of its children). Returns true if
 * the address held a sitemap. `stop()` is asked before each child. A firewall's answer sets `state.blocked`, which the
 * check must not report as "no sitemap".
 */
export async function readSitemap(
  get,
  url,
  state,
  {
    save,
    maxUrls = 10_000,
    maxChildren = SITEMAP_LIMITS.maxChildSitemaps,
    stop = () => false,
    depth = 0,
  } = {},
) {
  if (state.urls.length >= maxUrls) return false;
  const res = await get(url, { maxBytes: SITEMAP_MAX_BYTES, bodyTypes: SITEMAP_BODY_TYPES });
  if (res.ok && detectBotBlock(res).blocked) state.blocked = true;
  if (!res.ok || res.status < 200 || res.status >= 300) return false;
  let text;
  try {
    text = inflateIfGzipped(res.body, SITEMAP_MAX_BYTES);
  } catch {
    return false; // a compressed bomb or a damaged file
  }
  const parsed = parseSitemap(text, { maxUrls: maxUrls - state.urls.length });
  if (parsed.kind === 'unknown' || (parsed.urls.length === 0 && parsed.sitemaps.length === 0))
    return false;
  // The top-level file is kept as fetched (decompressed); a finding about it can point at the stored copy.
  const key = depth === 0 ? await keyOf(save, 'sitemap', res, Buffer.from(text)) : null;
  state.found.push({
    url: res.url,
    kind: parsed.kind,
    urlCount: parsed.urls.length,
    children: parsed.sitemaps.length,
    key,
  });
  for (const u of parsed.urls) {
    state.urls.push(u);
    if (u.lastmod) state.lastmods.push(u.lastmod);
  }
  if (parsed.kind === 'index' && depth === 0) {
    for (const child of parsed.sitemaps.slice(0, maxChildren)) {
      if (stop()) break;
      await readSitemap(get, child.loc, state, { save, maxUrls, maxChildren, stop, depth: 1 });
    }
  }
  return true;
}

/** llms.txt of one origin: `{ status: 'present' | 'missing' | 'error', httpStatus, key? }`. */
export async function fetchLlmsTxt(get, origin, { save } = {}) {
  const llms = await get(`${origin}/llms.txt`, {
    maxBytes: LLMS_MAX_BYTES,
    bodyTypes: TEXT_BODY_TYPES,
  });
  if (!llms.ok) return { status: 'error', httpStatus: null };
  const text = decodeBody(llms.body, llms.contentType).text.trim();
  const isFile =
    llms.status >= 200 &&
    llms.status < 300 &&
    text.length >= 10 &&
    !/html/i.test(llms.contentType) &&
    !text.startsWith('<');
  if (isFile) {
    return { status: 'present', httpStatus: llms.status, key: await keyOf(save, 'llms', llms) };
  }
  // A server failure, or a firewall in the way: we could not look, which is not the same as "not there".
  if (llms.status >= 500 || detectBotBlock(llms).blocked)
    return { status: 'error', httpStatus: llms.status };
  return { status: 'missing', httpStatus: llms.status };
}
