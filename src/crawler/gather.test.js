import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  fetchLlmsTxt,
  fetchRobots,
  newSitemapState,
  readSitemap,
  sitemapCandidates,
} from './gather.js';

const answer = (status, text, over = {}) => ({
  ok: true,
  url: 'https://acme.test/x',
  status,
  headers: {},
  body: Buffer.from(text),
  bodySkipped: false,
  contentType: 'text/plain',
  ...over,
});
const failed = (code) => ({ ok: false, error: { code, message: 'detail', guard: false } });
/** A `get` that answers by address, and remembers what was asked. */
const site = (routes) => {
  const asked = [];
  const get = async (url) => {
    asked.push(url);
    return routes[url] ?? answer(404, 'not found');
  };
  get.asked = asked;
  return get;
};

const FIREWALL = answer(403, '<html><title>Just a moment...</title></html>', {
  contentType: 'text/html',
});

describe('fetchRobots: three states, and "couldn\'t look" is never "no rules"', () => {
  const origin = 'https://acme.test';
  const robots = (res) => fetchRobots(async () => res, origin);

  test('a file: ok, parsed', async () => {
    const r = await robots(
      answer(200, 'User-agent: *\nDisallow: /private\nSitemap: https://acme.test/s.xml'),
    );
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.parsed.sitemaps, ['https://acme.test/s.xml']);
    assert.equal(r.key, null, 'nothing is stored without a save');
  });

  test('no file (404), or a web page where the file should be: missing, so nothing is off limits', async () => {
    assert.equal((await robots(answer(404, 'nope'))).status, 'missing');
    assert.equal(
      (await robots(answer(200, '<html>Home</html>', { contentType: 'text/html' }))).status,
      'missing',
    );
  });

  test('a server error, a 429, a failed connection and a firewall page are all unreachable', async () => {
    assert.equal((await robots(answer(503, 'down'))).status, 'unreachable');
    assert.equal((await robots(answer(429, 'slow down'))).status, 'unreachable');
    const down = await robots(failed('timeout'));
    assert.equal(down.status, 'unreachable');
    assert.equal(down.error, 'timeout');
    const walled = await robots(FIREWALL);
    assert.equal(walled.status, 'unreachable');
    assert.equal(walled.blocked, true);
  });

  test('a save callback is given the file and its key is kept', async () => {
    const saved = [];
    const r = await fetchRobots(async () => answer(200, 'User-agent: *\nAllow: /'), origin, {
      save: async (kind) => (saved.push(kind), { key: 'k1' }),
    });
    assert.equal(r.key, 'k1');
    assert.deepEqual(saved, ['robots']);
  });
});

describe('fetchLlmsTxt', () => {
  const llms = (res) => fetchLlmsTxt(async () => res, 'https://acme.test');

  test('present, missing and error stay apart', async () => {
    assert.equal((await llms(answer(200, '# Acme\n> Plumbing in Leeds'))).status, 'present');
    assert.equal((await llms(answer(404, 'no'))).status, 'missing');
    assert.equal(
      (await llms(answer(200, '<html>Home</html>', { contentType: 'text/html' }))).status,
      'missing',
    );
    assert.equal((await llms(answer(500, 'oops'))).status, 'error');
    assert.equal((await llms(FIREWALL)).status, 'error');
    assert.deepEqual(await llms(failed('dns_failed')), { status: 'error', httpStatus: null });
  });
});

describe('readSitemap', () => {
  const urlset = (n) =>
    `<?xml version="1.0"?><urlset>${Array.from({ length: n }, (_, i) => `<url><loc>https://acme.test/p${i}</loc><lastmod>2026-09-01</lastmod></url>`).join('')}</urlset>`;
  const index = (...locs) =>
    `<sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;
  const xml = (text) => answer(200, text, { contentType: 'application/xml' });

  test('reads a file, with lastmods', async () => {
    const get = site({ 'https://acme.test/sitemap.xml': xml(urlset(3)) });
    const state = newSitemapState(null);
    assert.equal(await readSitemap(get, 'https://acme.test/sitemap.xml', state), true);
    assert.equal(state.urls.length, 3);
    assert.equal(state.lastmods.length, 3);
    assert.equal(state.found[0].kind, 'urlset');
  });

  test('an index is followed one level and at most `maxChildren` deep', async () => {
    const children = Array.from({ length: 6 }, (_, i) => `https://acme.test/c${i}.xml`);
    const routes = { 'https://acme.test/sitemap.xml': xml(index(...children)) };
    for (const c of children) routes[c] = xml(urlset(2));
    const get = site(routes);
    const state = newSitemapState(null);
    await readSitemap(get, 'https://acme.test/sitemap.xml', state, { maxChildren: 3 });
    assert.equal(get.asked.length, 4, 'the index and three children');
    assert.equal(state.urls.length, 6);
  });

  test('stop() ends the children early', async () => {
    const routes = {
      'https://acme.test/sitemap.xml': xml(
        index('https://acme.test/a.xml', 'https://acme.test/b.xml'),
      ),
      'https://acme.test/a.xml': xml(urlset(1)),
      'https://acme.test/b.xml': xml(urlset(1)),
    };
    const get = site(routes);
    const state = newSitemapState(null);
    await readSitemap(get, 'https://acme.test/sitemap.xml', state, { stop: () => true });
    assert.equal(get.asked.length, 1);
  });

  test('a firewall page is a sitemap we could not look at, not a missing one', async () => {
    const state = newSitemapState(null);
    const found = await readSitemap(
      site({ 'https://acme.test/sitemap.xml': FIREWALL }),
      'https://acme.test/sitemap.xml',
      state,
    );
    assert.equal(found, false);
    assert.equal(state.blocked, true);
  });

  test('a page that is not a sitemap, a 404 and a failed fetch all say "no sitemap here"', async () => {
    const url = 'https://acme.test/sitemap.xml';
    for (const res of [answer(200, '<html>hello</html>'), answer(404, 'no'), failed('timeout')]) {
      const state = newSitemapState(null);
      assert.equal(await readSitemap(async () => res, url, state), false);
      assert.equal(state.found.length, 0);
    }
  });

  test('the cap on addresses is kept', async () => {
    const get = site({ 'https://acme.test/sitemap.xml': xml(urlset(50)) });
    const state = newSitemapState(null);
    await readSitemap(get, 'https://acme.test/sitemap.xml', state, { maxUrls: 10 });
    assert.ok(state.urls.length <= 10);
  });
});

describe('sitemapCandidates', () => {
  test('what robots.txt names (at most three), else the usual places', () => {
    const named = { parsed: { sitemaps: ['a', 'b', 'c', 'd'] } };
    assert.deepEqual(sitemapCandidates(named, 'https://acme.test'), ['a', 'b', 'c']);
    assert.deepEqual(sitemapCandidates({ parsed: { sitemaps: [] } }, 'https://acme.test'), [
      'https://acme.test/sitemap.xml',
      'https://acme.test/sitemap_index.xml',
      'https://acme.test/wp-sitemap.xml',
    ]);
    assert.equal(sitemapCandidates(null, 'https://acme.test').length, 3);
  });
});
