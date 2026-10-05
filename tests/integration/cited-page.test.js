import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { createCitedPageReader } from '../../src/crawler/cited-page.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';

/** Reading a page an engine cited, over real sockets (Milestone 13, task 13.03). */
const servers = [];
after(() => Promise.all(servers.map((s) => s.close())));

const filler =
  'Dentists in Austin differ in price, location and the way they treat nervous patients. '.repeat(
    6,
  );
const listPage = `<html><head><title>Top 10 dentists in Austin</title><meta name="author" content="Dr Lee"></head><body><h1>Top 10 dentists in Austin</h1><p>${filler} Prices rose 12% last year.</p><time datetime="2026-09-01">1 Sep</time><a href="https://who.int/x">WHO</a><a href="https://cdc.gov/y">CDC</a></body></html>`;

async function readerFor(routes) {
  const site = await startServer(
    (req, res) => {
      const route = routes[req.url];
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(route.status ?? 200, {
        'content-type': route.type ?? 'text/html; charset=utf-8',
      });
      res.end(route.body ?? '');
    },
    { secure: true },
  );
  servers.push(site);
  const reader = createCitedPageReader({ fetcher: testFetcher({ ports: [site.port] }) });
  const url = (path) => `https://fixture.test:${site.port}${path}`;
  return { site, read: (path) => reader.read(url(path)) };
}

describe('a cited page', () => {
  test('is read after robots.txt: its format, and what makes it easy to cite', async () => {
    const { site, read } = await readerFor({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
      '/top': { body: listPage },
    });
    const r = await read('/top');
    assert.equal(r.format, 'list');
    assert.equal(r.finding, null);
    assert.deepEqual(r.signals, { author: true, dated: true, sourcesLinked: 2, figures: 1 });
    assert.deepEqual(
      site.requests.map((q) => q.url),
      ['/robots.txt', '/top'],
    );
    assert.match(site.requests[1].headers['user-agent'], /AEOCornerBot/);
  });

  test('a page with no sign of any format is "other": it was read', async () => {
    const { read } = await readerFor({
      '/about': {
        body: `<html><head><title>Our story</title></head><body><h1>Our story</h1><p>${filler}</p></body></html>`,
      },
    });
    const r = await read('/about');
    assert.equal(r.format, 'other');
  });
});

describe('when we could not look, there is no format at all', () => {
  test('robots.txt that shuts our crawler out: the page is never requested', async () => {
    const { site, read } = await readerFor({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: AEOCornerBot\nDisallow: /\n' },
      '/top': { body: listPage },
    });
    const r = await read('/top');
    assert.deepEqual([r.format, r.finding, r.signals], [null, 'robots', null]);
    assert.ok(!site.requests.some((q) => q.url === '/top'));
  });

  test('a robots.txt that errors out is not read as permission', async () => {
    const { site, read } = await readerFor({
      '/robots.txt': { status: 503, type: 'text/plain', body: 'down' },
      '/top': { body: listPage },
    });
    const r = await read('/top');
    assert.deepEqual([r.format, r.finding], [null, 'unavailable']);
    assert.ok(!site.requests.some((q) => q.url === '/top'));
  });

  test('a page that is gone, down, not a web page, or empty is a finding, not "other"', async () => {
    const { read } = await readerFor({
      '/gone': { status: 404, body: 'x' },
      '/down': { status: 502, body: 'x' },
      '/file': { type: 'application/pdf', body: '%PDF' },
      '/empty': { body: '<html><body></body></html>' },
    });
    assert.deepEqual((await read('/gone')).finding, 'not_found');
    assert.deepEqual((await read('/down')).finding, 'unavailable');
    assert.equal((await read('/file')).format, null);
    const empty = await read('/empty');
    assert.deepEqual([empty.format, empty.finding], [null, 'unreadable']);
  });

  test('a page nested 100,000 levels deep is unreadable, quickly, and does not hang the reader', async () => {
    const { read } = await readerFor({
      '/deep': {
        body: `<html><head><title>x</title></head><body>${'<div>'.repeat(100_000)}</body></html>`,
      },
    });
    const t = Date.now();
    const r = await read('/deep');
    assert.equal(r.format, null);
    assert.ok(Date.now() - t < 30_000);
  });
});
