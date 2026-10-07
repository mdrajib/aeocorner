import * as cheerio from 'cheerio';

/**
 * Turn one page's HTML into the plain facts the readiness checks need (MVP §6.6), so a check never touches the
 * DOM: it reads `facts.title`, `facts.jsonLd.types`, `facts.blocks` and so on, and is easy to test with a
 * hand-made facts object.
 *
 * The HTML comes from a stranger's server and may be huge, malformed or built to hurt (100,000 nested elements,
 * JSON-LD that is a gigabyte long). So: input size is capped by the fetcher, text is walked WITHOUT recursion,
 * and every list we keep has a ceiling.
 */

const LIMITS = Object.freeze({
  headings: 300,
  links: 1500,
  blocks: 800,
  jsonLdBlocks: 50,
  jsonLdBlockChars: 256 * 1024,
  textKept: 200_000,
});

/** Browsers stop nesting at 512 levels (Chrome and Firefox both); a real page never needs more. */
export const MAX_NESTING_DEPTH = 512;

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
// Elements HTML closes by itself, so a missing end tag doesn't mean the next element is inside them.
const SELF_CLOSING_BY_PARSER = new Set([
  'html',
  'head',
  'body',
  'p',
  'li',
  'dt',
  'dd',
  'tr',
  'td',
  'th',
  'thead',
  'tbody',
  'tfoot',
  'option',
  'optgroup',
  'colgroup',
  'caption',
  'rt',
  'rp',
]);
const RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
]);

/**
 * Does the markup nest deeper than `limit`? The HTML parser we use takes time proportional to the SQUARE of the
 * depth (16,000 nested divs took 2 seconds, 50,000 took 30), so a page built to be deep could tie up a worker
 * for minutes. This reads the tags once, in time proportional to the page's length, without building anything,
 * and the page is refused before the parser ever sees it.
 */
export function nestsDeeperThan(html, limit = MAX_NESTING_DEPTH) {
  const text = String(html);
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) return false;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return false;
      i = end + 3;
      continue;
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) return false;
    i = gt + 1;
    const match = /^(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(text.slice(lt + 1, Math.min(gt, lt + 64)));
    if (!match) continue;
    const name = match[2].toLowerCase();
    if (match[1]) {
      if (!SELF_CLOSING_BY_PARSER.has(name) && depth > 0) depth -= 1;
      continue;
    }
    if (VOID_TAGS.has(name) || SELF_CLOSING_BY_PARSER.has(name) || text[gt - 1] === '/') continue;
    if (RAW_TEXT_TAGS.has(name)) {
      // What is inside <script> and <style> is not markup: skip to the end tag.
      const closer = new RegExp(`</${name}[\\s>]`, 'ig');
      closer.lastIndex = i;
      const found = closer.exec(text);
      if (!found) return false;
      i = found.index;
      continue;
    }
    depth += 1;
    if (depth > limit) return true;
  }
  return false;
}

const SKIPPED_TEXT = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'head',
  'title',
]);
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

const collapse = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const wordsIn = (s) => (s ? s.split(' ').length : 0);

/**
 * Text a person would see (script, style and `noscript` fallbacks excluded) and how much of it sits inside
 * something hidden: a closed `<details>`, `hidden`, `aria-hidden`, or an inline `display:none`. Walks the tree
 * with an explicit stack, so a page nested 100,000 deep can't overflow ours.
 */
function measureText(root) {
  const parts = [];
  let hiddenChars = 0;
  let totalChars = 0;
  const stack = [{ node: root, hidden: false }];

  while (stack.length) {
    const { node, hidden } = stack.pop();
    if (node.type === 'end-of-block') {
      parts.push(' '); // text on either side of a block element must not run together
      continue;
    }
    if (node.type === 'text') {
      const text = collapse(node.data);
      if (text) {
        totalChars += text.length;
        if (hidden) hiddenChars += text.length;
        else parts.push(node.data);
      }
      continue;
    }
    if (node.type !== 'tag' && node.type !== 'root') continue;
    if (node.type === 'tag' && SKIPPED_TEXT.has(node.name)) continue;

    let childHidden = hidden;
    if (node.type === 'tag') {
      const a = node.attribs ?? {};
      childHidden =
        hidden ||
        a.hidden !== undefined ||
        a['aria-hidden'] === 'true' ||
        /display\s*:\s*none|visibility\s*:\s*hidden/i.test(a.style ?? '') ||
        (node.name === 'details' && a.open === undefined) ||
        (node.name === 'input' && a.type === 'hidden');
    }
    const block = node.type === 'tag' && BLOCK_TAGS.has(node.name);
    if (block) {
      parts.push(' ');
      stack.push({ node: { type: 'end-of-block' }, hidden });
    }
    // Children are pushed in reverse so they are popped in document order.
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      // <summary> stays visible inside a closed <details>: it is the part shown.
      const summary = node.name === 'details' && children[i].name === 'summary';
      stack.push({ node: children[i], hidden: summary ? hidden : childHidden });
    }
  }
  const text = collapse(parts.join(''));
  return { text, visibleChars: text.length, hiddenChars, totalChars };
}

const schemaType = (t) =>
  String(t)
    .replace(/^https?:\/\/schema\.org\//i, '')
    .trim();

/**
 * The JSON-LD blocks of a page. With `keep` the parsed blocks (`docs`) and what was wrong with the others (`problems`)
 * are returned too, for the free structured-data tool; a scan does not keep them, so stored page facts stay small.
 */
function readJsonLd($, { keep = false } = {}) {
  const out = { blocks: 0, parseErrors: 0, oversize: 0, nodes: [], types: [] };
  if (keep) Object.assign(out, { docs: [], problems: [] });
  const seenTypes = new Set();
  $('script[type]').each((_, el) => {
    if (!/^application\/ld\+json\b/i.test(el.attribs.type ?? '')) return;
    if (out.blocks >= LIMITS.jsonLdBlocks) return;
    out.blocks += 1;
    const raw = $(el).text().trim();
    if (raw.length > LIMITS.jsonLdBlockChars) {
      out.oversize += 1;
      if (keep) out.problems.push({ block: out.blocks, problem: 'too_large' });
      return;
    }
    let data;
    try {
      data = JSON.parse(
        raw
          .replace(/^\s*<!--/, '')
          .replace(/-->\s*$/, '')
          .replace(/^\s*\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>\s*$/g, ''),
      );
    } catch {
      out.parseErrors += 1;
      if (keep) out.problems.push({ block: out.blocks, problem: 'invalid_json' });
      return;
    }
    if (keep) out.docs.push({ block: out.blocks, data });
    // Flatten arrays and @graph into one list of nodes (iteratively; the data is untrusted).
    const pending = [data];
    while (pending.length) {
      const item = pending.pop();
      if (Array.isArray(item)) pending.push(...item);
      else if (item && typeof item === 'object') {
        if (Array.isArray(item['@graph'])) pending.push(...item['@graph']);
        if (item['@type']) {
          out.nodes.push(item);
          for (const t of [item['@type']].flat()) {
            const type = schemaType(t);
            if (type && !seenTypes.has(type)) {
              seenTypes.add(type);
              out.types.push(type);
            }
          }
        }
      }
    }
  });
  return out;
}

/**
 * Every JSON-LD block in some HTML, parsed, with the same limits as a scan (blocks, size, nesting). For the free
 * structured-data tool: `{ blocks, docs: [{ block, data }], problems: [{ block, problem }], tooDeep }`.
 */
export function readJsonLdBlocks(html) {
  const tooDeep = nestsDeeperThan(html);
  const $ = cheerio.load(tooDeep ? '' : String(html));
  const { blocks, docs, problems } = readJsonLd($, { keep: true });
  return { blocks, docs, problems, tooDeep };
}

function resolveHref(href, base) {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function linkArea($, el) {
  const a = $(el);
  if (a.closest('nav, [role="navigation"]').length) return 'nav';
  if (a.closest('footer, [role="contentinfo"]').length) return 'footer';
  if (a.closest('header, [role="banner"]').length) return 'header';
  return 'body';
}

const MAIN_ROOTS = [
  'main',
  '[role="main"]',
  '#main-content',
  '#main',
  '#content',
  '.entry-content',
  'article',
];

/** The part of the page that is the page, as opposed to its menus, footer and sidebars. */
function mainRoot($) {
  for (const selector of MAIN_ROOTS) {
    const found = $(selector).first();
    if (found.length) return found;
  }
  const body = $('body').first();
  return body.length ? body : $.root();
}

// Parts of a page that are not its content: menus, banners, footers, sidebars, and anything not rendered.
const CHROME_TAGS = new Set([
  'nav',
  'header',
  'footer',
  'aside',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
]);
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary']);

/** The text under one element, collected without recursion and without building more than `maxChars`. */
function elementText(node, maxChars) {
  const parts = [];
  let length = 0;
  const stack = [node];
  while (stack.length && length < maxChars) {
    const current = stack.pop();
    if (current.type === 'text') {
      parts.push(current.data);
      length += current.data.length;
    } else if (current.type === 'tag' && !SKIPPED_TEXT.has(current.name)) {
      if (current.name === 'br') parts.push(' ');
      const children = current.children ?? [];
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }
  return collapse(parts.join(''));
}

const directChildren = (node, name) =>
  (node.children ?? []).filter((c) => c.type === 'tag' && c.name === name);

/**
 * The page's content as a flat list in reading order: headings, paragraphs, lists, tables, FAQ-style `details`.
 * Done with our own walk, not cheerio's `find`, which takes time proportional to the square of the number of
 * elements on a page with hundreds of thousands of siblings. Stops at `LIMITS.blocks`.
 */
function collectBlocks(rootNode) {
  const blocks = [];
  const stack = [rootNode];
  while (stack.length && blocks.length < LIMITS.blocks) {
    const node = stack.pop();
    if (node.type !== 'tag' && node.type !== 'root') continue;

    if (node.type === 'tag') {
      const a = node.attribs ?? {};
      const hiddenOrChrome =
        (node !== rootNode && CHROME_TAGS.has(node.name)) ||
        CHROME_ROLES.has(a.role) ||
        a.hidden !== undefined ||
        a['aria-hidden'] === 'true';
      if (hiddenOrChrome) continue;

      if (/^h[1-4]$/.test(node.name)) {
        const text = elementText(node, 400);
        if (text) blocks.push({ type: node.name, text: clip(text, 300) });
        continue;
      }
      if (node.name === 'p') {
        const text = elementText(node, 800);
        if (text) blocks.push({ type: 'p', text: clip(text, 600), words: wordsIn(text) });
        continue;
      }
      if (node.name === 'ul' || node.name === 'ol') {
        const items = directChildren(node, 'li').length;
        if (items) blocks.push({ type: 'list', items });
      } else if (node.name === 'dl') {
        const items = directChildren(node, 'dt').length;
        if (items) blocks.push({ type: 'list', items });
        continue;
      } else if (node.name === 'table') {
        // Count rows without recursion, up to a ceiling.
        let rows = 0;
        const inner = [node];
        while (inner.length && rows < 1000) {
          const n = inner.pop();
          if (n.type === 'tag' && n.name === 'tr') rows += 1;
          for (const c of n.children ?? []) if (c.type === 'tag') inner.push(c);
        }
        blocks.push({ type: 'table', rows });
        continue;
      } else if (node.name === 'details') {
        const summary = directChildren(node, 'summary')[0];
        blocks.push({ type: 'details', text: summary ? clip(elementText(summary, 400), 300) : '' });
      }
    }
    // Children are pushed in reverse so they are popped in reading order.
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return blocks;
}

const STAT =
  /\b\d[\d,.]*\s?(%|percent|million|billion|thousand|x\b|times\b)|\$\s?\d[\d,.]*\s?(k|m|b|million|billion)?\b/gi;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}/g;
const UPDATED_TEXT =
  /\b(last\s+(updated|modified|reviewed)|updated\s+(on|:)|updated\s+\w+\s+\d{1,2}|modified\s+on)\b/i;

// "Last updated September 15, 2026", "Updated: 2026-09-15", "Modified on 15 Sep 2026" -> the date, if there is one.
const UPDATED_DATE =
  /(?:last\s+(?:updated|modified|reviewed)|updated(?:\s+on)?|modified(?:\s+on)?)\s?:?\s?(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s\d{1,2}(?:st|nd|rd|th)?,?\s\d{4}|\d{1,2}(?:st|nd|rd|th)?\s[A-Za-z]{3,9}\.?,?\s\d{4})/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The date as UTC midnight, so the answer doesn't depend on the time zone of the machine that scanned. */
function updatedTextDate(text) {
  const found = UPDATED_DATE.exec(text)?.[1];
  if (!found) return '';
  let year;
  let month;
  let day;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(found);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
  } else {
    const parts = /([A-Za-z]{3,9})/.exec(found)?.[1];
    const numbers = found.match(/\d+/g)?.map(Number) ?? [];
    month = MONTHS.indexOf(parts?.slice(0, 3).toLowerCase());
    day = numbers.find((n) => n <= 31);
    year = numbers.find((n) => n >= 1000);
  }
  if (month < 0 || !day || !year) return '';
  const date = new Date(Date.UTC(year, month, day));
  // Reject "February 31": UTC arithmetic would quietly roll it into March.
  return date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString() : '';
}

/** Which site builder made this page, as far as the HTML and headers give away. Evidence only; no check relies on it. */
export function detectPlatform(html, headers = {}, { generator = '', appRootEmpty = false } = {}) {
  // Plain substring checks only: this runs on text a stranger wrote, and a pattern with an open-ended
  // `[^>]+` can take time proportional to the square of the page's length.
  const h = String(html);
  const powered = String(headers['x-powered-by'] ?? '');
  if (/wordpress/i.test(generator) || h.includes('/wp-content/') || h.includes('/wp-includes/'))
    return 'wordpress';
  if (h.includes('cdn.shopify.com') || h.includes('Shopify.theme')) return 'shopify';
  if (
    headers['x-wix-request-id'] ||
    h.includes('static.parastorage.com') ||
    h.includes('static.wixstatic.com')
  ) {
    return 'wix';
  }
  if (/squarespace/i.test(generator) || h.includes('static1.squarespace.com')) return 'squarespace';
  if (/webflow/i.test(generator) || h.includes('data-wf-site') || h.includes('data-wf-page'))
    return 'webflow';
  if (h.includes('__NEXT_DATA__') || h.includes('/_next/static/') || /next\.js/i.test(powered))
    return 'nextjs';
  if (h.includes('__NUXT__') || h.includes('/_nuxt/')) return 'nuxt';
  if (appRootEmpty) return 'client-rendered-app';
  return generator ? generator.split(/[\s/]/)[0].toLowerCase() : 'unknown';
}

/**
 * @param {string} html
 * @param {string} pageUrl   where it came from, for resolving relative links
 * @param {{ headers?: object }} [options]   the response headers, if known (they help recognise the platform)
 */
export function extractPage(html, pageUrl, { headers = {} } = {}) {
  // A page built to be absurdly deep gets empty facts and a flag instead of a parse that could take minutes.
  const tooDeep = nestsDeeperThan(html);
  const $ = cheerio.load(tooDeep ? '' : String(html));
  const meta = (selector) => collapse($(selector).first().attr('content'));

  const title = collapse($('head title').first().text() || $('title').first().text());
  const robotsMeta = [meta('meta[name="robots" i]'), meta('meta[name="googlebot" i]')]
    .join(',')
    .toLowerCase();
  const canonicalHref = $('link[rel~="canonical" i]').first().attr('href');
  const body = $('body').first().length ? $('body').first()[0] : $.root()[0];
  const measured = measureText(body);

  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    if (headings.length >= LIMITS.headings) return false;
    const text = collapse($(el).text());
    if (text) headings.push({ level: Number(el.name[1]), text: clip(text, 200) });
  });

  const links = [];
  $('a[href]').each((_, el) => {
    if (links.length >= LIMITS.links) return false;
    const href = resolveHref(el.attribs.href, pageUrl);
    if (!href) return;
    links.push({
      href,
      text: clip(collapse($(el).text()), 120),
      area: linkArea($, el),
      rel: el.attribs.rel ?? '',
    });
  });

  const root = mainRoot($);
  const rootText = collapse(root.text());
  const jsonLd = readJsonLd($);
  const timeValues = $('time[datetime]')
    .map((_, el) => el.attribs.datetime)
    .get()
    .slice(0, 20);
  const authorNode = (n) => n.author ?? n.creator;

  return {
    /** Set when the page could not be read at all; the checks treat it as "couldn't check", not as a failure. */
    skipped: tooDeep ? 'too_deeply_nested' : null,
    title,
    titleSegments: title
      .split(/\s+[|–—·:•-]\s+|\s*\|\s*/)
      .map(collapse)
      .filter(Boolean),
    metaDescription: meta('meta[name="description" i]'),
    canonical: canonicalHref ? resolveHref(canonicalHref, pageUrl) : null,
    lang: collapse($('html').first().attr('lang')),
    robotsMeta,
    noindex: /\b(noindex|none)\b/.test(robotsMeta),
    ogSiteName: meta('meta[property="og:site_name" i]'),
    ogTitle: meta('meta[property="og:title" i]'),
    ogType: meta('meta[property="og:type" i]'),
    metaAuthor: meta('meta[name="author" i]'),
    generator: meta('meta[name="generator" i]'),
    headings,
    h1Count: headings.filter((h) => h.level === 1).length,
    jsonLd,
    links,
    iframes: $('iframe')
      .map((_, el) => el.attribs.src ?? '')
      .get()
      .slice(0, 20),
    text: clip(measured.text, LIMITS.textKept),
    textChars: measured.totalChars,
    visibleTextChars: measured.visibleChars,
    hiddenTextChars: measured.hiddenChars,
    wordCount: wordsIn(measured.text),
    mainTextChars: rootText.length,
    blocks: collectBlocks(root[0] ?? body),
    dates: {
      timeElements: timeValues,
      metaModified:
        meta('meta[property="article:modified_time" i]') ||
        meta('meta[property="og:updated_time" i]'),
      metaPublished: meta('meta[property="article:published_time" i]'),
      jsonLdModified: jsonLd.nodes.map((n) => n.dateModified).find(Boolean) ?? '',
      jsonLdPublished: jsonLd.nodes.map((n) => n.datePublished).find(Boolean) ?? '',
      updatedText: UPDATED_TEXT.test(rootText),
      updatedTextDate: updatedTextDate(rootText.slice(0, LIMITS.textKept)),
    },
    authorSignals: {
      meta: Boolean(meta('meta[name="author" i]')),
      relAuthor: $('a[rel~="author"], [itemprop="author"], [rel="author"]').length > 0,
      byline:
        $('.byline, .author, .post-author, [class*="author-name"], [class*="byline"]').length > 0,
      schema: jsonLd.nodes.some((n) => Boolean(authorNode(n))),
    },
    statMentions: (rootText.match(STAT) ?? []).length,
    phoneNumbers: [...new Set((measured.text.match(PHONE) ?? []).map(collapse))].slice(0, 10),
    telLinks: $('a[href^="tel:" i]')
      .map((_, el) => collapse(el.attribs.href.slice(4)))
      .get()
      .slice(0, 10),
    hasAddressElement:
      $('address, [itemprop="streetAddress"], [itemtype*="PostalAddress" i]').length > 0,
    platform: detectPlatform(html, headers, {
      generator: meta('meta[name="generator" i]'),
      appRootEmpty: (() => {
        const appRoot = $('#root, #app, #__next').first();
        return appRoot.length > 0 && appRoot.children().length === 0 && !collapse(appRoot.text());
      })(),
    }),
  };
}
