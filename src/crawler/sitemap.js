import zlib from 'node:zlib';

/**
 * Sitemaps (sitemaps.org): an XML list of a site's pages, or an index that lists other sitemaps.
 *
 * This reads them with a small hand-written scanner instead of an XML parser, on purpose. The file comes from a
 * stranger's server, and a real XML parser can be tricked into reading local files or expanding a few kilobytes
 * into gigabytes (external entities, "billion laughs"). The scanner has no such features to abuse: it walks the
 * text once, left to right, and only ever pulls out the few tags we need. It never backtracks, so a file made of
 * unclosed tags can't make it slow (regular expressions with lazy matches can be). It is lenient, as search
 * engines are, because real sitemaps are often sloppy.
 */

export const SITEMAP_LIMITS = Object.freeze({
  /** The protocol allows 50,000 URLs per file; page selection needs far fewer. */
  maxUrls: 50_000,
  /** Child sitemaps we are willing to open from one index. */
  maxChildSitemaps: 5,
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** No field we read is longer than a URL (2048); stop collecting text well past that. */
const MAX_FIELD_CHARS = 4096;

function decode(text) {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()];
      const code =
        name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .trim();
}

/**
 * Walk the document once and call `on(event)` for each piece: `{type: 'open', name}`, `{type: 'close', name}` or
 * `{type: 'text', text}` (character data, with CDATA unwrapped). Comments, processing instructions and the
 * DOCTYPE are skipped. Each character is looked at a bounded number of times, whatever the input.
 */
function scan(text, on) {
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      on({ type: 'text', text: text.slice(i) });
      return;
    }
    if (lt > i) on({ type: 'text', text: text.slice(i, lt) });

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return;
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) return;
      on({ type: 'text', text: text.slice(lt + 9, end), cdata: true });
      i = end + 3;
    } else {
      const gt = text.indexOf('>', lt + 1);
      if (gt === -1) return;
      const inner = text.slice(lt + 1, gt);
      i = gt + 1;
      if (inner[0] === '!' || inner[0] === '?') continue;
      const closing = inner[0] === '/';
      const name = /^\/?\s*([^\s/>]+)/.exec(inner)?.[1];
      if (!name) continue;
      on({ type: closing ? 'close' : 'open', name, selfClosing: inner.endsWith('/') });
    }
  }
}

function toDate(text) {
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toPriority(text) {
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

const isPageUrl = (loc) =>
  typeof loc === 'string' && loc.length <= 2048 && /^https?:\/\//i.test(loc);

/**
 * Sitemaps are often served gzipped as `sitemap.xml.gz` (not as a transfer encoding), so the bytes themselves
 * may be compressed. Output is capped, so a compressed bomb is an error rather than a memory problem.
 */
export function inflateIfGzipped(bytes, maxBytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return zlib.gunzipSync(buffer, { maxOutputLength: maxBytes }).toString('utf8');
  }
  return buffer.toString('utf8');
}

/**
 * @returns {{
 *   kind: 'urlset' | 'index' | 'text' | 'unknown',
 *   urls: { loc: string, lastmod: Date | null, priority: number | null }[],
 *   sitemaps: { loc: string, lastmod: Date | null }[],
 *   truncated: boolean }}
 */
export function parseSitemap(input, { maxUrls = SITEMAP_LIMITS.maxUrls } = {}) {
  const text = String(input).replace(/^\uFEFF/, '');
  const result = { kind: 'unknown', urls: [], sitemaps: [], truncated: false };

  // The root element tells us what this is. It may carry a namespace prefix ("sm:urlset"); if so, the same
  // prefix is on the other structural tags, and we ignore it. Other prefixes ("image:loc") stay different.
  const root = /<([\w-]+:)?(urlset|sitemapindex)[\s>]/.exec(text);
  if (!root) {
    // The plain-text format: one URL per line, nothing else.
    if (!text.includes('<') && /^https?:\/\//im.test(text)) {
      result.kind = 'text';
      for (const line of text.split(/\r\n|\r|\n/)) {
        const loc = line.trim();
        if (!isPageUrl(loc)) continue;
        if (result.urls.length >= maxUrls) {
          result.truncated = true;
          break;
        }
        result.urls.push({ loc, lastmod: null, priority: null });
      }
    }
    return result;
  }

  const isIndex = root[2] === 'sitemapindex';
  const item = isIndex ? 'sitemap' : 'url';
  result.kind = isIndex ? 'index' : 'urlset';
  const prefix = root[1] ?? '';
  const local = (name) => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name);

  let entry = null; // the <url> or <sitemap> being read
  let field = null; // which child of it we are inside: loc, lastmod or priority
  let buffer = '';
  let full = false;

  scan(text, (event) => {
    if (full) return;
    if (event.type === 'text') {
      if (field && buffer.length < MAX_FIELD_CHARS) buffer += event.text;
      return;
    }
    const name = local(event.name);
    if (event.type === 'open') {
      if (name === item && !event.selfClosing) {
        entry = { loc: null, lastmod: null, priority: null };
      } else if (
        entry &&
        !event.selfClosing &&
        (name === 'loc' || name === 'lastmod' || name === 'priority')
      ) {
        field = name;
        buffer = '';
      }
      return;
    }
    // A closing tag.
    if (field && name === field) {
      entry[field] = decode(buffer);
      field = null;
    } else if (entry && name === item) {
      if (isPageUrl(entry.loc)) {
        if (isIndex) {
          result.sitemaps.push({ loc: entry.loc, lastmod: toDate(entry.lastmod) });
        } else if (result.urls.length >= maxUrls) {
          result.truncated = true;
          full = true;
        } else {
          result.urls.push({
            loc: entry.loc,
            lastmod: toDate(entry.lastmod),
            priority: toPriority(entry.priority),
          });
        }
      }
      entry = null;
      field = null;
    }
  });
  return result;
}
