import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeFindings } from './tool-findings.js';
import { sitemapFindings } from './tool-sitemap.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const site = { origin: 'https://acme.test', domain: 'acme.test' };
const robotsOk = { status: 'ok', parsed: { groups: [], sitemaps: [] } };
const url = (path, lastmod = '2026-09-20', host = 'acme.test') => ({
  loc: `https://${host}${path}`,
  lastmod: lastmod ? new Date(lastmod) : null,
});
const found = (over = {}) => ({
  url: 'https://acme.test/sitemap.xml',
  kind: 'urlset',
  urlCount: 3,
  children: 0,
  ...over,
});
const run = (over = {}) =>
  normalizeFindings(
    sitemapFindings({
      site,
      robots: robotsOk,
      sitemaps: {
        found: [found()],
        referenced: ['https://acme.test/sitemap.xml'],
        urls: [url('/'), url('/a'), url('/b')],
        lastmods: [],
      },
      now: NOW,
      ...over,
    }),
  );
const rows = (f) => f.sections.flatMap((s) => s.rows);
const row = (f, label) => rows(f).find((r) => r.label === label);

describe('a sitemap that is found', () => {
  test('found and pointed to by robots.txt: the headline says so, and the counts and dates are right', () => {
    const f = run();
    assert.match(
      f.headline,
      /Your sitemap is at https:\/\/acme\.test\/sitemap\.xml, and robots\.txt points to it/,
    );
    assert.equal(row(f, 'Sitemap found').state, 'good');
    assert.equal(row(f, 'robots.txt points to it').state, 'good');
    assert.equal(row(f, 'Addresses listed').value, '3');
    assert.equal(row(f, 'Last-modified dates').value, '3 of 3');
    assert.equal(row(f, 'Last-modified dates').state, 'good');
    assert.match(row(f, 'Last-modified dates').detail, /newest is 2026-09-20 \(16 days ago\)/);
  });

  test('found but not named in robots.txt: a warning with the exact line to add', () => {
    const f = run({
      sitemaps: { found: [found()], referenced: [], urls: [url('/')], lastmods: [] },
    });
    assert.match(f.headline, /robots\.txt does not point to it/);
    const r = row(f, 'robots.txt points to it');
    assert.equal(r.state, 'warn');
    assert.match(r.detail, /Sitemap: https:\/\/acme\.test\/sitemap\.xml/);
  });

  test('robots.txt that could not be read is "couldn’t check" for that row, not a "no"', () => {
    const f = run({ robots: { status: 'unreachable', parsed: null } });
    assert.equal(row(f, 'robots.txt points to it').state, 'unknown');
  });

  test('dates: none is a warning, a year-old newest date is a warning, and a few dated pages is a warning', () => {
    const none = run({
      sitemaps: {
        found: [found()],
        referenced: ['x'],
        urls: [url('/', null), url('/a', null)],
        lastmods: [],
      },
    });
    assert.equal(row(none, 'Last-modified dates').state, 'warn');
    assert.equal(row(none, 'Last-modified dates').value, 'None');
    const stale = run({
      sitemaps: {
        found: [found()],
        referenced: ['x'],
        urls: [url('/', '2024-01-01')],
        lastmods: [],
      },
    });
    assert.equal(row(stale, 'Last-modified dates').state, 'warn');
    assert.match(row(stale, 'Last-modified dates').detail, /over a year old/);
    const few = run({
      sitemaps: {
        found: [found()],
        referenced: ['x'],
        urls: [url('/'), url('/a', null), url('/b', null), url('/c', null)],
        lastmods: [],
      },
    });
    assert.equal(row(few, 'Last-modified dates').state, 'warn');
  });

  test('addresses on another site and http addresses on an https site are named by count', () => {
    const f = run({
      sitemaps: {
        found: [found()],
        referenced: ['x'],
        urls: [
          url('/'),
          url('/a', '2026-09-01', 'old-domain.test'),
          { loc: 'http://acme.test/b', lastmod: null },
          url('/blog', '2026-09-01', 'blog.acme.test'),
        ],
        lastmods: [],
      },
    });
    assert.equal(row(f, 'Addresses on another site').value, '1', 'a subdomain is still the site');
    assert.equal(row(f, 'Addresses without https').value, '1');
  });

  test('an index says how many sitemaps it lists and how many were read, and the count is "at least" if not all', () => {
    const f = run({
      sitemaps: {
        found: [found({ kind: 'index', children: 8 }), found({ url: 'https://acme.test/a.xml' })],
        referenced: ['x'],
        urls: [url('/')],
        lastmods: [],
      },
      childrenRead: 3,
    });
    assert.equal(row(f, 'Sitemaps in the index').value, '8');
    assert.match(row(f, 'Sitemaps in the index').detail, /read 3 of them/);
    assert.match(row(f, 'Addresses listed').value, /^at least /);
    const all = run({
      sitemaps: {
        found: [found({ kind: 'index', children: 2 })],
        referenced: ['x'],
        urls: [url('/')],
        lastmods: [],
      },
      childrenRead: 2,
    });
    assert.ok(!/at least/.test(row(all, 'Addresses listed').value));
  });

  test('only a few addresses are quoted, and the rest are counted', () => {
    const urls = Array.from({ length: 5000 }, (_, i) => url(`/p${i}`));
    const f = run({ sitemaps: { found: [found()], referenced: ['x'], urls, lastmods: [] } });
    assert.equal(f.lines.items.length, 10);
    assert.equal(f.lines.more, 4990);
    assert.equal(row(f, 'Addresses listed').value, '5,000');
  });

  test('an empty sitemap is a warning, not a pass', () => {
    const f = run({
      sitemaps: { found: [found({ urlCount: 0 })], referenced: ['x'], urls: [], lastmods: [] },
    });
    assert.equal(row(f, 'Addresses listed').state, 'warn');
  });
});

describe('a site with no sitemap', () => {
  const none = { found: [], referenced: [], urls: [], lastmods: [] };

  test('no sitemap anywhere is a warning that says a sitemap is optional', () => {
    const f = run({ sitemaps: none });
    assert.match(f.headline, /found no sitemap at the usual addresses/);
    assert.equal(row(f, 'Sitemap found').state, 'warn');
    assert.match(row(f, 'Sitemap found').detail, /optional/);
    assert.equal(f.lines, undefined);
  });

  test('robots.txt names one we could not read as a sitemap: said as it is', () => {
    const f = run({ sitemaps: { ...none, referenced: ['https://acme.test/gone.xml'] } });
    assert.match(f.headline, /points to a sitemap, but we could not read it as one/);
    assert.match(row(f, 'Sitemap found').detail, /did not give us a valid one/);
  });
});

test('the notes say what a sitemap does not do', () => {
  assert.ok(
    run().notes.some((n) => /does not make a search or AI engine fetch or use a page/.test(n)),
  );
});

test('hostile addresses in a sitemap come out cut, as text, and 50,000 of them are fine', () => {
  const urls = Array.from({ length: 50_000 }, (_, i) => ({
    loc: `https://acme.test/${'a'.repeat(2000)}<script>${i}`,
    lastmod: new Date('2026-01-01'),
  }));
  const started = Date.now();
  const f = run({ sitemaps: { found: [found()], referenced: ['x'], urls, lastmods: [] } });
  assert.ok(Date.now() - started < 10_000, 'a loose bound');
  assert.ok(f.lines.items.every((l) => l.length <= 300));
  assert.ok(JSON.stringify(f).length < 100_000);
});
