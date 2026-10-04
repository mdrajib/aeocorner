import { load } from 'cheerio';

/**
 * The HTML a draft is written in (MVP F8): a small allow-list, because the same markup is shown in our editor, kept in
 * `content_revisions` and sent to a customer's WordPress. Everything a model or an editor produces goes through
 * `sanitizeBody` first, so what is stored is only ever these tags and these attributes.
 *
 * Allowed: h2 h3 h4, p, ul ol li, table thead tbody tr th td, blockquote, a (http, https, mailto or a path), strong, em,
 * code, br. `h1` becomes `h2` (the title is the page's one h1), `h5`/`h6` become `h4`, `b`/`i` become `strong`/`em`.
 * Scripts, styles, frames, forms, images and anything else with a body are dropped with their content; an unknown
 * wrapper (`div`, `span`, `section`) is unwrapped. No attribute survives except `href` on a link and `scope` on a
 * header cell, and a link to `javascript:` or `data:` loses its address.
 *
 * Pages and drafts are hostile input in the same way a customer's website is: this walks the tree with a stack, never
 * recursion, and cuts nesting at 64.
 */

const MAX_DEPTH = 64;
const MAX_BYTES = 400_000;

const KEEP = new Set([
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'blockquote',
  'a',
  'strong',
  'em',
  'code',
  'br',
]);
const RENAME = { h1: 'h2', h5: 'h4', h6: 'h4', b: 'strong', i: 'em' };
const DROP = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'svg',
  'math',
  'noscript',
  'template',
  'head',
  'title',
  'meta',
  'link',
  'base',
  'video',
  'audio',
  'canvas',
  'img',
  'picture',
  'source',
  'track',
  'dialog',
]);
const VOID = new Set(['br']);
/** Unwrapped elements that still end a line of text, so neighbouring words don't run together. */
const SEPARATING = new Set([
  'div',
  'section',
  'article',
  'main',
  'figure',
  'header',
  'footer',
  'aside',
  'nav',
  'center',
]);

const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

function safeHref(raw) {
  const href = String(raw ?? '')
    .replace(/[\s\p{Cc}]+/gu, '')
    .slice(0, 2048);
  if (!href) return null;
  if (/^(?:https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^[/#?]/.test(href) && !href.startsWith('//')) return href;
  return null;
}

/**
 * @returns {{ html: string, dropped: string[] }} the clean markup, and the names of tags that were removed with their
 *   content (so a screen can say "3 images were removed")
 */
export function sanitizeBody(input) {
  const source = String(input ?? '').slice(0, MAX_BYTES);
  const $ = load(source, null, false);
  const dropped = [];
  const out = [];
  const root = $.root().get(0);
  const stack = [{ node: root, depth: 0, phase: 'enter' }];
  while (stack.length > 0) {
    const frame = stack.pop();
    const { node } = frame;
    if (frame.phase === 'exit') {
      if (frame.tag) out.push(`</${frame.tag}>`);
      else out.push(' ');
      continue;
    }
    if (node.type === 'text') {
      out.push(escapeText(node.data));
      continue;
    }
    if (node.type === 'script' || node.type === 'style') {
      dropped.push(node.type);
      continue;
    }
    if (node.type !== 'tag' && node.type !== 'root') continue; // comments, directives, CDATA
    let tag = null;
    if (node.type === 'tag') {
      const name = String(node.name).toLowerCase();
      if (DROP.has(name)) {
        dropped.push(name);
        continue;
      }
      const mapped = RENAME[name] ?? name;
      if (KEEP.has(mapped)) tag = mapped;
      if (frame.depth >= MAX_DEPTH) {
        dropped.push('too-deep');
        continue;
      }
    }
    if (tag) {
      if (tag === 'a') {
        const href = safeHref(node.attribs?.href);
        out.push(href ? `<a href="${escapeAttr(href)}">` : '<a>');
      } else if (tag === 'th') {
        const scope = node.attribs?.scope;
        out.push(scope === 'col' || scope === 'row' ? `<th scope="${scope}">` : '<th>');
      } else {
        out.push(`<${tag}>`);
      }
      if (VOID.has(tag)) continue;
      stack.push({ node, phase: 'exit', tag, depth: frame.depth });
    } else if (node.type === 'tag' && SEPARATING.has(String(node.name).toLowerCase())) {
      out.push(' ');
      stack.push({ node, phase: 'exit', tag: null, depth: frame.depth });
    }
    const children = node.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: children[i], depth: frame.depth + 1, phase: 'enter' });
    }
  }
  return { html: tidy(out.join('')), dropped };
}

/** Bare text at the top level becomes a paragraph; empty blocks and runs of blank space go. */
function tidy(html) {
  const $ = load(html, null, false);
  const blocks = [];
  let loose = '';
  const flush = () => {
    const text = loose.replace(/\s+/g, ' ').trim();
    if (text) blocks.push(`<p>${text}</p>`);
    loose = '';
  };
  const inline = new Set(['a', 'strong', 'em', 'code', 'br']);
  for (const node of $.root().contents().toArray()) {
    if (node.type === 'text') {
      loose += escapeText(node.data);
    } else if (node.type === 'tag' && inline.has(node.name)) {
      loose += $.html(node);
    } else if (node.type === 'tag') {
      flush();
      const text = $(node).text().replace(/\s+/g, ' ').trim();
      if (text || node.name === 'table') blocks.push($.html(node));
    }
  }
  flush();
  return blocks.join('\n');
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** Words in a piece of text: letters, digits and apostrophes, so "don't" is one and "4,000" is one. */
export const wordsOf = (text) => String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’,.-]*/gu) ?? [];

/**
 * What a draft is made of, read from clean markup (`sanitizeBody`'s output).
 *
 * @returns {{
 *   blocks: {type, level?, text, html}[], headings: {level, text, index, answer: string|null, answerWords: number}[],
 *   paragraphs: string[], text: string, words: number, links: {href: string|null, text: string}[], lists: number,
 *   tables: number
 * }}
 */
export function analyzeBody(html) {
  const $ = load(String(html ?? ''), null, false);
  const blocks = [];
  const links = [];
  let lists = 0;
  let tables = 0;
  for (const node of $.root().children().toArray()) {
    const el = $(node);
    const name = node.name;
    const text = squash(el.text());
    if (name === 'ul' || name === 'ol') lists += 1;
    if (name === 'table') tables += 1;
    el.find('a').each((_, a) => {
      links.push({ href: a.attribs?.href ?? null, text: squash($(a).text()) });
    });
    if (/^h[2-4]$/.test(name))
      blocks.push({ type: 'heading', level: Number(name[1]), text, html: $.html(node) });
    else blocks.push({ type: name === 'p' ? 'paragraph' : name, text, html: $.html(node) });
  }
  const headings = [];
  blocks.forEach((block, index) => {
    if (block.type !== 'heading') return;
    const next = blocks[index + 1];
    const answer = next?.type === 'paragraph' ? next.text : null;
    headings.push({
      level: block.level,
      text: block.text,
      index,
      answer,
      answerWords: answer ? wordsOf(answer).length : 0,
    });
  });
  const paragraphs = blocks.filter((b) => b.type === 'paragraph').map((b) => b.text);
  const text = blocks.map((b) => b.text).join('\n');
  return { blocks, headings, paragraphs, text, words: wordsOf(text).length, links, lists, tables };
}

/** A heading that is a question a buyer would ask: it ends with "?" or starts with a question word. */
export const isQuestionHeading = (text) =>
  /\?\s*$/.test(text) ||
  /^(?:what|why|how|when|where|who|which|can|do|does|is|are|should|will|would|could)\b/i.test(
    text.trim(),
  );

/** Question and answer pairs from the markup: a question heading and the paragraph straight under it. */
export const faqPairs = (analysis) =>
  analysis.headings
    .filter((h) => h.answer && isQuestionHeading(h.text))
    .map((h) => ({ question: h.text, answer: h.answer }));
