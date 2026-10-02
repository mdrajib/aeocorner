import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ejs from 'ejs';

/**
 * Component helpers for EJS views: `<%- ui.badge({ text: 'New', tone: 'brand' }) %>`.
 *
 * Why helpers instead of `include()`: EJS leaks the parent template's variables into an included
 * partial, so a component that forgets a prop silently picks up a parent's `title`. Here every
 * component receives only the props it was called with.
 *
 * Escaping rule: props named `text`, `label`, `title`, `value`… are escaped by the component.
 * Props named `html` or ending in `Html` are trusted, already-rendered markup — only pass strings
 * produced by another `ui.*` call or a template, never raw user input.
 */
export function createUi({ viewsDir, cache }) {
  const compiled = new Map();

  function load(file) {
    const mtime = cache ? 0 : statSync(file).mtimeMs;
    const hit = compiled.get(file);
    if (hit && hit.mtime === mtime) return hit.fn;
    const fn = ejs.compile(readFileSync(file, 'utf8'), { filename: file, views: [viewsDir] });
    compiled.set(file, { mtime, fn });
    return fn;
  }

  const ui = {};

  /** Render components/<name>.ejs with the given props. */
  ui.render = (name, props = {}) =>
    load(join(viewsDir, 'components', `${name}.ejs`))({ ...props, ui });

  /** Render any view file (relative to views/, no extension) to a string — for slot content. */
  ui.fragment = (view, data = {}) => load(join(viewsDir, `${view}.ejs`))({ ...data, ui });

  for (const name of [
    'badge',
    'banner',
    'button',
    'card',
    'checkbox',
    'excerpt',
    'field',
    'icon',
    'logo',
    'meter',
    'modal',
    'stat',
    'state',
    'stepper',
    'table',
    'tabs',
    'audit-form',
  ]) {
    ui[camel(name)] = (props) => ui.render(name, props);
  }

  ui.resultCell = (props) => ui.render('result-cell', resolveResultCell(props));
  ui.attrs = attrs;
  ui.esc = escapeHtml;
  ui.highlight = highlight;
  return ui;
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Turn { 'data-x': 'a', disabled: true, hidden: false } into ` data-x="a" disabled`. Values escaped. */
export function attrs(obj = {}) {
  let out = '';
  for (const [key, value] of Object.entries(obj)) {
    if (!/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(key))
      throw new Error(`Invalid attribute name: ${key}`);
    if (/^on/i.test(key)) throw new Error(`Inline event handlers are blocked by CSP: ${key}`);
    if (value === false || value == null) continue;
    out += value === true ? ` ${key}` : ` ${key}="${escapeHtml(value)}"`;
  }
  return out;
}

/**
 * Decide what a result cell shows. This encodes the product rule from CLAUDE.md / CUSTOMER_JOURNEY
 * principle 6: only a collection that actually succeeded can be "not mentioned". Anything else
 * (failed, pending, missing) is "couldn't check" — never zero, never "not mentioned".
 *
 *   status 'ok'          + mentioned: true   -> mentioned
 *   status 'ok'          + mentioned: false  -> absent ("Not mentioned")
 *   status 'no_overview'                      -> the search showed no AI Overview (not a miss)
 *   status 'pending'                          -> still collecting
 *   anything else ('failed', undefined, …)    -> unknown ("Couldn’t check")
 */
export function resolveResultCell({ status, mentioned, detail } = {}) {
  if (status === 'ok') {
    if (typeof mentioned !== 'boolean') {
      throw new TypeError("resultCell: status 'ok' requires a boolean `mentioned`");
    }
    return { state: mentioned ? 'mentioned' : 'absent', detail };
  }
  if (status === 'no_overview') return { state: 'no_overview', detail };
  if (status === 'pending') return { state: 'pending', detail };
  return { state: 'unknown', detail };
}

/**
 * Escape `text`, then wrap occurrences of each term in <mark>. Longest terms win so "Acme CRM Pro"
 * is not split by a shorter "Acme". Case-insensitive; terms are matched as plain text, not regex.
 */
export function highlight(text, highlights = []) {
  const terms = highlights
    .filter((h) => h && typeof h.term === 'string' && h.term.trim())
    .sort((a, b) => b.term.length - a.term.length);
  if (!terms.length) return escapeHtml(text);

  const kindOf = new Map(
    terms.map((h) => [h.term.toLowerCase(), h.kind === 'brand' ? 'brand' : 'competitor']),
  );
  const pattern = new RegExp(`(${terms.map((h) => escapeRegExp(h.term)).join('|')})`, 'gi');

  return String(text)
    .split(pattern)
    .map((part, i) => {
      // split() with one capture group puts matches at odd indexes
      if (i % 2 === 0) return escapeHtml(part);
      const kind = kindOf.get(part.toLowerCase()) ?? 'competitor';
      return `<mark class="mark-${kind}" data-entity="${kind}">${escapeHtml(part)}</mark>`;
    })
    .join('');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
