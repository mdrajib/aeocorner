import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createSpacesStore, sha256Hex } from '../../src/integrations/spaces.js';
import { createHostPacer } from '../../src/crawler/pacer.js';
import { createRenderer } from '../../src/crawler/render.js';
import { runSiteScan } from '../../src/crawler/scan.js';
import {
  closedSite,
  firewalledSite,
  goodSite,
  hostileSite,
  route,
  serveRoutes,
  spaSite,
} from '../helpers/fixture-sites.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';
import { startS3Stub } from '../helpers/s3-stub.js';

/**
 * A whole scan against fixture websites, with the raw pages landing in an S3-compatible bucket (BUILD_PLAN
 * Phase 4: "fetching a fixture site produces the expected raw payload in the test Spaces bucket"), and the exit
 * criteria's three kinds of site: WordPress-style, single-page app, and one that blocks bots.
 */

const NOW = new Date('2026-10-02T12:00:00Z');
const state = {};
const servers = [];
let stub;
let store;
let fetcher;
let renderer;
let secret;

const host = (name) => `${name}.test`;
/** Start a fixture server whose routes may refer to its own address, which is only known once it is listening. */
async function site(name, build, options) {
  const holder = { routes: {} };
  const server = await startServer((req, res) => serveRoutes(holder.routes)(req, res), options);
  holder.routes = build(server.origin(host(name)), server);
  servers.push(server);
  return { ...server, routes: holder.routes, holder, name, origin: server.origin(host(name)) };
}

before(async () => {
  stub = await startS3Stub();
  store = createSpacesStore({
    endpoint: stub.endpoint,
    region: stub.region,
    bucket: stub.bucket,
    accessKeyId: stub.accessKeyId,
    secretAccessKey: stub.secretAccessKey,
    prefix: 'test/',
  });

  secret = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>INTERNAL</h1>');
  });
  servers.push(secret);

  state.good = await site('good.fixture', goodSite, { secure: true }); // the test certificate covers *.fixture.test
  state.spa = await site('spa', () => spaSite());
  state.firewalled = await site('firewalled', firewalledSite);
  state.lockedDown = await site('lockeddown', (origin) =>
    firewalledSite(origin, { blockEverything: true }),
  );
  state.lockedDownRobots = await site('lockedrobots', (origin) =>
    firewalledSite(origin, { blockEverything: true, blockRobots: true }),
  );
  state.closed = await site('closed', closedSite);
  state.hostile = await site('hostile', (origin) =>
    hostileSite(origin, secret.origin('secret.test')),
  );
  state.target = await site('www-target', goodSite);
  state.apex = await site('apex', (origin) => ({
    ...goodSite(origin),
    '/': { status: 301, headers: { location: `${state.target.origin}/` }, body: Buffer.alloc(0) },
  }));
  state.flaky = await site('flaky', (origin) => ({
    ...goodSite(origin),
    '/robots.txt': route('server error', { status: 503, type: 'text/plain' }),
  }));

  const ports = servers.filter((s) => s !== secret).map((s) => s.port);
  fetcher = testFetcher({ ports, pacer: createHostPacer({ minGapMs: 0 }) }); // fast; the pacer has its own tests
  renderer = createRenderer({ fetcher });
  state.allowedPorts = new Set(ports);
});

after(async () => {
  await renderer?.close();
  store?.close();
  await stub?.close();
  await Promise.all(servers.map((s) => s.close()));
});

const scan = (s, options = {}) =>
  runSiteScan(s.origin, { fetcher, renderer, store, now: () => NOW, ...options });
const check = (result, code) => result.checks.find((c) => c.code === code);
const served = (s, path) => s.routes[path].body;

describe('a well-built WordPress-style site', () => {
  let result;
  before(async () => {
    result = await scan(state.good);
  });

  test('is read completely and scores high, with every check answered', () => {
    assert.equal(result.status, 'complete', JSON.stringify(result.notes));
    assert.equal(
      result.counts.error,
      0,
      JSON.stringify(result.checks.filter((c) => c.status === 'error')),
    );
    assert.ok(
      result.readinessScore >= 80,
      `score ${result.readinessScore}: ${result.checks.filter((c) => c.status !== 'pass').map((c) => `${c.code} ${c.points}/${c.possible}`)}`,
    );
    assert.equal(result.rubricVersion, 'v0.1');
    assert.equal(result.site.platform, 'wordpress');
  });

  test('chooses the pages that define the business and leaves out logins and carts', () => {
    const paths = result.pages.map((p) => new URL(p.url).pathname);
    for (const wanted of ['/', '/about', '/pricing', '/faq', '/products/widget-pro', '/contact']) {
      assert.ok(paths.includes(wanted), `${wanted} was chosen`);
    }
    assert.ok(!paths.includes('/wp-login.php') && !paths.includes('/cart'));
    assert.ok(
      result.pages.every((p) => p.status === 200),
      JSON.stringify(result.pages.map((p) => [p.url, p.status, p.error])),
    );
    assert.equal(result.pagesFetched, result.pages.length);
  });

  test('the RAW HTML of every page is in the bucket, byte for byte', async () => {
    for (const page of result.pages) {
      const path = new URL(page.url).pathname;
      assert.ok(page.rawKey, `${path} was stored`);
      assert.match(page.rawKey, /^test\/crawl\/2026\/10\/[0-9a-f]{64}\.html$/);
      const object = await store.get(page.rawKey);
      assert.deepEqual(
        object.body,
        served(state.good, path),
        `${path} is exactly what the server sent`,
      );
      assert.equal(object.metadata['source-url'], page.finalUrl);
      assert.equal(object.metadata['http-status'], '200');
      assert.equal(page.sha256, sha256Hex(served(state.good, path)));
    }
  });

  test('robots.txt, the sitemap and llms.txt are kept too', async () => {
    const keys = [...stub.objects.keys()];
    assert.ok(keys.some((k) => k.endsWith('.robots.txt')));
    assert.ok(keys.some((k) => k.endsWith('.sitemap.xml')));
    assert.ok(keys.some((k) => k.endsWith('.llms.txt')));
    assert.ok(result.robots.key);
    assert.deepEqual((await store.get(result.robots.key)).body, served(state.good, '/robots.txt'));
  });

  test('the headless-browser render of five pages is kept next to the raw HTML', async () => {
    const rendered = result.pages.filter((p) => p.renderedKey);
    assert.equal(rendered.length, 5);
    for (const page of rendered) {
      const object = await store.get(page.renderedKey);
      assert.match(page.renderedKey, /\.rendered\.html$/);
      assert.match(object.body.toString(), /<title>/);
      assert.ok(page.renderedTextChars > 0 && page.rawTextChars > 0);
    }
  });

  test('the sitemap and robots.txt were read and understood', () => {
    assert.equal(result.robots.status, 'ok');
    assert.equal(result.sitemaps.found.length, 1);
    assert.equal(result.sitemaps.found[0].urlCount, 7);
    assert.equal(check(result, 'A4').status, 'pass');
    assert.equal(check(result, 'F4').status, 'pass');
  });

  test('every connection was to the fixture servers and nothing else', () => {
    assert.ok(result.connections.length > 10);
    for (const c of result.connections) {
      assert.equal(c.address, '127.0.0.1');
      assert.ok(state.allowedPorts.has(c.port), `port ${c.port}`);
    }
  });

  test('a second scan writes nothing new: the same bytes land on the same keys', async () => {
    const before = new Set(stub.objects.keys());
    const again = await scan(state.good);
    assert.deepEqual(
      again.pages.map((p) => p.rawKey),
      result.pages.map((p) => p.rawKey),
    );
    assert.deepEqual(
      [...stub.objects.keys()].filter((k) => !before.has(k)),
      [],
    );
    assert.equal(again.readinessScore, result.readinessScore);
  });
});

describe('a single-page app', () => {
  test('the raw HTML is an empty shell, the render is not, and the readiness check says so', async () => {
    const result = await scan(state.spa);
    const home = result.pages[0];
    assert.equal(result.site.platform, 'client-rendered-app');
    assert.ok(home.rawTextChars < 20, `raw text: ${home.rawTextChars}`);
    assert.ok(home.renderedTextChars > 200, `rendered text: ${home.renderedTextChars}`);
    assert.equal(check(result, 'B1').status, 'fail');
    assert.match(check(result, 'B1').summary, /JavaScript/);
    // The menu is built by the script, so the raw home page links to nothing: only the home page is chosen.
    assert.equal(result.pages.length, 1);
    assert.ok(result.readinessScore !== null);
    // Both versions are kept.
    assert.match((await store.get(home.rawKey)).body.toString(), /<div id="root"><\/div>/);
    assert.match((await store.get(home.renderedKey)).body.toString(), /What is Acme App/);
  });
});

describe('sites that block bots', () => {
  test('a firewall that turns away AI crawlers by name: found by the look-alike requests', async () => {
    const result = await scan(state.firewalled);
    const a3 = check(result, 'A3');
    assert.equal(a3.status, 'fail');
    assert.equal(a3.evidence.scope, 'ai_crawlers');
    assert.match(a3.summary, /Cloudflare/);
    assert.ok(a3.evidence.bots.every((b) => b.blocked === true && b.vendor === 'Cloudflare'));
    assert.equal(a3.evidence.control.blocked, false, 'our own crawler got through');
    assert.equal(result.status, 'complete', 'and the rest of the site was read normally');
    assert.ok(check(result, 'C1').status !== 'error');
  });

  test('a firewall that turns away every bot, ours included: "couldn’t check", never a score of zero', async () => {
    const result = await scan(state.lockedDown);
    assert.equal(result.status, 'failed');
    assert.equal(result.readinessScore, null);
    assert.equal(result.pages[0].error, 'blocked_by_firewall');
    assert.equal(result.pages[0].blocked.vendor, 'Cloudflare');
    assert.equal(result.counts.fail <= 1, true, 'at most the firewall check itself fails');
    assert.equal(check(result, 'C1').status, 'error');
    assert.equal(check(result, 'A3').status, 'fail');
    assert.equal(check(result, 'A3').evidence.scope, 'all_automated');
    assert.equal(
      result.pages[0].rawKey,
      null,
      'a challenge page is not stored as if it were the site',
    );
  });
});

describe('a firewall in the way of robots.txt, the sitemap and llms.txt', () => {
  test('is "couldn’t check" for each of them, never "there is none"', async () => {
    const result = await scan(state.lockedDownRobots);
    assert.equal(result.robots.status, 'unreachable');
    for (const code of ['A1', 'A2', 'A4', 'F4']) {
      assert.equal(check(result, code).status, 'error', code);
    }
    assert.equal(result.counts.fail, 1, 'only the firewall check itself fails');
    assert.equal(check(result, 'A3').status, 'fail');
    assert.equal(result.pages[0].error, 'blocked_by_firewall');
    assert.equal(result.readinessScore, null);
  });
});

describe('robots.txt is obeyed', () => {
  test('a site that disallows everything is not read at all', async () => {
    const before = state.closed.requests.length;
    const result = await scan(state.closed);
    const seen = state.closed.requests.slice(before).map((r) => r.url);
    assert.deepEqual(seen, ['/robots.txt'], 'nothing but robots.txt was requested');
    assert.equal(result.status, 'failed');
    assert.equal(result.readinessScore, null);
    assert.equal(result.pages[0].error, 'disallowed_by_robots');
    assert.match(result.notes[0], /AEOCornerBot/);
    assert.equal(check(result, 'A1').status, 'fail', 'what robots.txt says is still reported');
  });

  test('a robots.txt that errors (503) means the crawler stays away, as the standard says', async () => {
    const before = state.flaky.requests.length;
    const result = await scan(state.flaky);
    const seen = state.flaky.requests.slice(before).map((r) => r.url);
    assert.deepEqual(seen, ['/robots.txt']);
    assert.equal(result.status, 'failed');
    assert.equal(result.pages[0].error, 'robots_unreachable');
    assert.equal(check(result, 'A1').status, 'error', 'unknown, not blocked');
  });
});

describe('a project owner can ask for robots.txt not to stop the scan', () => {
  test('a site that disallows everything is read, the note says why, and A1 still reports what robots.txt says', async () => {
    const before = state.closed.requests.length;
    const result = await scan(state.closed, { respectRobots: false });
    const seen = state.closed.requests.slice(before).map((r) => r.url);
    assert.ok(seen.includes('/about') && seen.includes('/pricing'), `pages were fetched: ${seen}`);
    assert.equal(result.robotsOverridden, true);
    assert.match(result.notes.join(' '), /project owner asked/);
    assert.ok(result.pages.every((p) => p.error !== 'disallowed_by_robots'));
    assert.ok(result.readinessScore !== null, 'and the site gets a real score');
    assert.equal(check(result, 'A1').status, 'fail', 'robots.txt is still reported honestly');
    assert.ok(
      result.pages.every((p) => p.rawKey),
      'every page was stored',
    );
  });

  test('a robots.txt that errors (503) no longer stops it either', async () => {
    const result = await scan(state.flaky, { respectRobots: false });
    assert.equal(result.robotsOverridden, true);
    assert.match(result.notes.join(' '), /could not be fetched/);
    assert.equal(result.pages[0].status, 200);
  });

  test('a site whose robots.txt allows us is untouched by the option', async () => {
    const result = await scan(state.good, { respectRobots: false });
    assert.equal(result.robotsOverridden, false);
    assert.equal(result.notes.length, 0);
  });

  test('the SSRF guard and the politeness limits are NOT switched off by it', async () => {
    const before = secret.requests.length;
    const result = await scan(state.hostile, { respectRobots: false });
    assert.equal(secret.requests.length, before, 'the internal service still saw nothing');
    for (const c of result.connections) assert.ok(state.allowedPorts.has(c.port));
  });
});

describe('a site that redirects to another address', () => {
  test('the new address is the one scanned, and its own robots.txt is read', async () => {
    const before = state.target.requests.length;
    const result = await scan(state.apex);
    assert.equal(result.site.origin, state.target.origin);
    assert.ok(state.target.requests.slice(before).some((r) => r.url === '/robots.txt'));
    assert.equal(result.pages[0].redirectCount, 1);
    assert.equal(result.status, 'complete');
  });
});

describe('a site that tries to make the crawler visit private addresses', () => {
  test('links, a sitemap and a robots.txt that point inward are all ignored, and nothing inward is touched', async () => {
    const result = await scan(state.hostile);

    assert.deepEqual(secret.requests, [], 'the service on this machine saw no request');
    for (const c of result.connections) {
      assert.equal(c.address, '127.0.0.1');
      assert.ok(state.allowedPorts.has(c.port), `connected to port ${c.port}`);
    }
    const paths = result.pages.map((p) => p.url);
    assert.ok(
      paths.every((u) => u.startsWith(state.hostile.origin)),
      `pages: ${paths}`,
    );
    assert.ok(paths.some((u) => u.endsWith('/about')));
    // The page's own script and image were also pointed at the secret; the browser is held to the same rule.
    assert.deepEqual(secret.requests, []);
    assert.equal(result.status === 'complete' || result.status === 'partial', true);
  });
});

describe('degraded runs', () => {
  test('without a browser the scan still finishes, and the render check says it could not look', async () => {
    const result = await scan(state.good, { renderer: null });
    assert.equal(check(result, 'B1').status, 'error');
    assert.match(result.notes.join(' '), /headless browser/);
    assert.equal(result.status, 'partial');
    assert.ok(result.readinessScore !== null);
  });

  test('a scan that runs out of time reports what it finished, not a failure', async () => {
    const result = await scan(state.good, { limits: { maxDurationMs: 0 } });
    assert.ok(result.pages.some((p) => p.error === 'scan_time_limit'));
    assert.equal(result.pages[0].status, 200, 'the home page was still read');
    assert.equal(result.status, 'partial');
  });

  test('a domain with no website at all is a failed scan, not a crash', async () => {
    const result = await runSiteScan('no-such-site.test:1', {
      fetcher,
      renderer,
      store,
      now: () => NOW,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.readinessScore, null);
  });
});
