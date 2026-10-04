import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { createProfileChecker } from '../../src/crawler/profile.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';

/** Looking at a profile page over real sockets (Milestone 12, task 12.02). */
const servers = [];
after(() => Promise.all(servers.map((s) => s.close())));

const body =
  'We are a family practice that cares for patients of every age and every background. '.repeat(8);
const named = `<html><head><title>Acme Dental | Directory</title></head><body><h1>Acme Dental</h1><p>${body}</p><a href="https://acmedental.com/">Website</a></body></html>`;
const unnamed = `<html><head><title>Best Dentists</title></head><body><h1>Dentists</h1><p>${body}</p></body></html>`;

async function checkerFor(routes) {
  const site = await startServer(
    (req, res) => {
      const route = routes[req.url] ?? routes.default;
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
  const checker = createProfileChecker({ fetcher: testFetcher({ ports: [site.port] }) });
  const url = (path) => `https://fixture.test:${site.port}${path}`;
  const run = (path, names = ['Acme Dental']) =>
    checker.check({ url: url(path), brandNames: names, domain: 'acmedental.com' });
  return { site, run };
}

describe('a profile page', () => {
  test('that names the business passes, and is read after robots.txt', async () => {
    const { site, run } = await checkerFor({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nAllow: /\n' },
      '/acme': { body: named },
    });
    const r = await run('/acme');
    assert.deepEqual([r.status, r.finding, r.linksBack], ['passed', 'names_brand', true]);
    assert.deepEqual(
      site.requests.map((q) => q.url),
      ['/robots.txt', '/acme'],
    );
    assert.match(site.requests[1].headers['user-agent'], /AEOCornerBot/);
  });

  test('that does not name the business fails; one that is gone fails for that reason', async () => {
    const { run } = await checkerFor({
      '/a': { body: unnamed },
      '/gone': { status: 404, body: 'x' },
    });
    const a = await run('/a');
    assert.deepEqual([a.status, a.finding], ['failed', 'brand_not_named']);
    const gone = await run('/gone');
    assert.deepEqual([gone.status, gone.finding], ['failed', 'not_found']);
  });
});

describe('when we could not look, the answer is "couldn\'t check"', () => {
  test('robots.txt that shuts our crawler out: the page is never requested', async () => {
    const { site, run } = await checkerFor({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: AEOCornerBot\nDisallow: /\n' },
      '/acme': { body: named },
    });
    const r = await run('/acme');
    assert.deepEqual([r.status, r.finding], ['error', 'robots']);
    assert.ok(!site.requests.some((q) => q.url === '/acme'), 'the page must not be fetched');
  });

  test('a robots.txt that errors out is not read as permission', async () => {
    const { site, run } = await checkerFor({
      '/robots.txt': { status: 503, type: 'text/plain', body: 'down' },
      '/acme': { body: named },
    });
    const r = await run('/acme');
    assert.deepEqual([r.status, r.finding], ['error', 'unavailable']);
    assert.ok(!site.requests.some((q) => q.url === '/acme'));
  });

  test('a firewall (403), a sign-in page and a non-page answer', async () => {
    const { run } = await checkerFor({
      '/blocked': { status: 403, body: 'denied' },
      '/login': {
        body: `<html><head><title>Sign in</title></head><body><h1>Sign in</h1><p>${body}</p></body></html>`,
      },
      '/image': { type: 'image/png', body: 'PNG' },
    });
    assert.equal((await run('/blocked')).finding, 'blocked');
    assert.equal((await run('/login')).finding, 'needs_login');
    const image = await run('/image');
    assert.deepEqual([image.status, image.finding], ['error', 'unreadable']);
    for (const r of [await run('/blocked'), await run('/login'), image]) {
      assert.equal(r.status, 'error');
    }
  });

  test('a site we cannot reach, or the guard refuses, is not a failure', async () => {
    const checker = createProfileChecker({
      fetcher: testFetcher({ dns: { 'internal.test': ['10.0.0.5'] } }),
    });
    const r = await checker.check({
      url: 'https://internal.test/acme',
      brandNames: ['Acme Dental'],
      domain: 'acmedental.com',
    });
    assert.deepEqual([r.status, r.finding], ['error', 'fetch_failed']);
  });
});
