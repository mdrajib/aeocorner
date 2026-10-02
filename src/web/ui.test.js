import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attrs, createUi, escapeHtml, highlight, resolveResultCell } from './ui.js';

const viewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
const ui = createUi({ viewsDir, cache: false });

test('a failed or missing collection can never become "not mentioned"', () => {
  for (const status of ['failed', 'error', 'timeout', undefined, null, '', 'ok-ish']) {
    for (const mentioned of [true, false, undefined]) {
      assert.equal(
        resolveResultCell({ status, mentioned }).state,
        'unknown',
        `${status}/${mentioned}`,
      );
    }
  }
  assert.equal(resolveResultCell().state, 'unknown');
});

test('only a successful collection is mentioned or not mentioned', () => {
  assert.equal(resolveResultCell({ status: 'ok', mentioned: true }).state, 'mentioned');
  assert.equal(resolveResultCell({ status: 'ok', mentioned: false }).state, 'absent');
  assert.throws(() => resolveResultCell({ status: 'ok' }), TypeError);
  assert.throws(() => resolveResultCell({ status: 'ok', mentioned: 'no' }), TypeError);
});

test('pending and "no AI Overview" are their own states', () => {
  assert.equal(resolveResultCell({ status: 'pending' }).state, 'pending');
  assert.equal(resolveResultCell({ status: 'no_overview' }).state, 'no_overview');
});

test('result cell markup: failed collections say "Couldn’t check" and never "Not mentioned"', () => {
  const failed = ui.resultCell({ status: 'failed', mentioned: false });
  assert.match(failed, /Couldn’t check/);
  assert.doesNotMatch(failed, /Not mentioned/);
  assert.match(failed, /data-state="unknown"/);
  assert.match(ui.resultCell({ status: 'ok', mentioned: false }), /Not mentioned/);
  assert.match(ui.resultCell({ status: 'ok', mentioned: true }), />\s*Mentioned/);
});

test('an unknown stat tile shows a dash and "Couldn’t check", never a number', () => {
  const html = ui.stat({ label: 'Gemini mention rate', state: 'unknown', value: '0%' });
  assert.match(html, /Couldn’t check/);
  assert.doesNotMatch(html, /0%/);
  assert.match(html, /stat-unknown/);
});

test('stat deltas are only coloured when the change is significant', () => {
  const noisy = ui.stat({
    label: 'x',
    value: '1',
    delta: { direction: 'down', text: '−3', significant: false },
  });
  assert.match(noisy, /delta-flat/);
  assert.doesNotMatch(noisy, /delta-down/);
  const unspecified = ui.stat({ label: 'x', value: '1', delta: { direction: 'up', text: '+3' } });
  assert.match(unspecified, /delta-flat/);
  const real = ui.stat({
    label: 'x',
    value: '1',
    delta: { direction: 'up', text: '+9', significant: true },
  });
  assert.match(real, /delta-up/);
});

test('highlight escapes the text and marks brand and competitor terms', () => {
  const html = highlight('<script>x</script> Acme and RIVAL co', [
    { term: 'Acme', kind: 'brand' },
    { term: 'Rival Co', kind: 'competitor' },
  ]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<mark class="mark-brand" data-entity="brand">Acme<\/mark>/);
  assert.match(html, /<mark class="mark-competitor" data-entity="competitor">RIVAL co<\/mark>/);
});

test('highlight treats terms as plain text, prefers the longest match, and survives odd input', () => {
  const longest = highlight('Acme CRM Pro is great', [
    { term: 'Acme', kind: 'brand' },
    { term: 'Acme CRM Pro', kind: 'brand' },
  ]);
  assert.match(longest, /<mark[^>]*>Acme CRM Pro<\/mark> is great/);
  assert.doesNotThrow(() =>
    highlight('a (b) c', [{ term: '(b)', kind: 'competitor' }, { term: '.*' }, { term: '' }]),
  );
  assert.equal(highlight('plain', []), 'plain');
  assert.equal(highlight('<b>', undefined), '&lt;b&gt;');
});

test('attrs escapes values, drops empty ones and refuses inline event handlers', () => {
  assert.equal(
    attrs({ 'data-x': 'a"b', disabled: true, hidden: false, nothing: null }),
    ' data-x="a&quot;b" disabled',
  );
  assert.throws(() => attrs({ onclick: 'alert(1)' }), /CSP/);
  assert.throws(() => attrs({ 'bad name': 'x' }), /Invalid attribute name/);
});

test('escapeHtml covers the five dangerous characters', () => {
  assert.equal(
    escapeHtml(`<a href="x">'&'</a>`),
    '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
  );
  assert.equal(escapeHtml(undefined), '');
});

test('components escape their text props', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const outputs = [
    ui.badge({ text: evil }),
    ui.button({ label: evil }),
    ui.banner({ title: evil, text: evil }),
    ui.field({ name: 'a', label: evil, hint: evil, error: evil, value: evil }),
    ui.checkbox({ name: 'a', label: evil, error: evil }),
    ui.card({ title: evil }),
    ui.stat({ label: evil, value: evil, note: evil }),
    ui.state({ title: evil, text: evil }),
    ui.table({ caption: evil, columns: [{ key: 'a', label: evil }], rows: [{ a: evil }] }),
    ui.modal({ id: 'm', title: evil }),
    ui.excerpt({ engine: evil, question: evil, text: evil }),
    ui.meter({ id: 'm', label: evil, value: 1, max: 2 }),
    ui.stepper({ steps: [evil], current: 0 }),
  ];
  for (const html of outputs) assert.doesNotMatch(html, /<img/, html.slice(0, 80));
});

test('components use no inline style attributes or event handlers (the CSP forbids them)', () => {
  const html = [
    ui.meter({ id: 'm', label: 'Q', value: 38, max: 50 }),
    ui.button({ label: 'Go', busy: true }),
    ui.tabs({
      id: 't',
      label: 'T',
      tabs: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    }),
    ui.banner({ tone: 'info', text: 'x', dismissible: true }),
    ui.modal({ id: 'm', title: 'T' }),
    ui.stepper({ steps: ['a', 'b'], current: 1 }),
  ].join('');
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

test('field wires label, hint and error to the input for assistive tech', () => {
  const html = ui.field({
    id: 'site',
    name: 'site',
    label: 'Website',
    hint: 'Just the address',
    error: 'Required',
    required: true,
  });
  assert.match(html, /<label class="label" for="site">/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="site-hint site-error"/);
  assert.match(html, /id="site-hint"/);
  assert.match(html, /id="site-error"/);
  assert.doesNotMatch(html, /\(optional\)/);
});

test('buttons render as links when given an href, and busy buttons say so', () => {
  assert.match(ui.button({ label: 'Go', href: '/x' }), /^<a href="\/x"/);
  assert.match(ui.button({ label: 'Go', busy: true }), /aria-busy="true"/);
  assert.match(ui.button({ label: 'Go', disabled: true, href: '/x' }), /<button[^>]* disabled/);
});

test('meter clamps its value', () => {
  assert.match(ui.meter({ id: 'm', label: 'Q', value: 99, max: 50 }), /value="50"/);
  assert.match(ui.meter({ id: 'm', label: 'Q', value: -4, max: 50 }), /value="0"/);
});

test('an unknown icon fails loudly', () => {
  assert.throws(() => ui.icon({ name: 'does-not-exist' }), /Unknown icon/);
});
