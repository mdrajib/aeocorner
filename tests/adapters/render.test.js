import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { extractPage } from '../../src/crawler/html.js';
import { BROWSER_ARGS, createRenderer } from '../../src/crawler/render.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';

/**
 * Contract tests for the headless-browser render (BUILD_PLAN Phase 4): "Playwright render matches raw HTML fetch
 * on a stable fixture page", and the rule that makes rendering safe at all: Chromium reaches only what the safe
 * fetcher lets it reach. Needs Chromium: `npx playwright install chromium`.
 */

const STABLE = `<!doctype html><html lang="en"><head><title>Stable fixture page</title>
<meta name="description" content="A page that never changes.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Widgets","url":"https://fixture.test/"}</script>
</head><body><header><nav><a href="/about">About</a> <a href="/pricing">Pricing</a></nav></header>
<main><h1>Stable fixture page</h1>
<h2>What is Acme?</h2><p>Acme Widgets makes durable industrial widgets for small factories, tested for ten thousand hours.</p>
<ul><li>Small</li><li>Medium</li><li>Large</li></ul></main>
<footer><a href="https://www.linkedin.com/company/acme">LinkedIn</a></footer></body></html>`;

const INJECTED = `<!doctype html><html><head><title>Script page</title></head><body>
<main><h1>Script page</h1><div id="app"></div></main>
<script>document.getElementById('app').innerHTML = '<h2>Added by JavaScript</h2><p>This sentence exists only after the script runs.</p>';</script>
</body></html>`;

let site;
let secret;
let fetcher;
let renderer;

before(async () => {
  secret = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    res.end('<h1>INTERNAL ADMIN</h1>');
  });
  const attack = () => `<!doctype html><html><head><title>Attack</title>
<link rel="stylesheet" href="http://127.0.0.1:${secret.port}/css">
<script src="http://127.0.0.1:${secret.port}/head-script.js"></script></head><body><main><h1>Attack page</h1>
<img src="http://127.0.0.1:${secret.port}/img"><iframe src="http://127.0.0.1:${secret.port}/frame"></iframe>
<form id="f" method="post" action="http://127.0.0.1:${secret.port}/form"><input name="a" value="1"></form>
<p>Ordinary visible text so the page is not empty, long enough to count as content for the comparison.</p></main>
<script>
const S = 'http://127.0.0.1:${secret.port}';
fetch(S + '/fetch', { mode: 'no-cors' }).catch(() => {});
const x = new XMLHttpRequest(); x.open('GET', S + '/xhr'); x.send();
try { new WebSocket('ws://127.0.0.1:${secret.port}/ws'); } catch (e) {}
try { navigator.sendBeacon(S + '/beacon', 'x'); } catch (e) {}
const i = new Image(); i.src = S + '/js-img';
const s = document.createElement('script'); s.src = S + '/js-script.js'; document.body.appendChild(s);
fetch('http://169.254.169.254/latest/meta-data/', { mode: 'no-cors' }).catch(() => {});
fetch('http://[::1]:${secret.port}/v6', { mode: 'no-cors' }).catch(() => {});
</script></body></html>`;

  site = await startServer((req, res) => {
    const html = (body, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    switch (req.url.split('?')[0]) {
      case '/stable':
        return html(STABLE);
      case '/injected':
        return html(INJECTED);
      case '/attack':
        return html(attack());
      case '/attack-form':
        return html(
          `<html><body><form id="f" method="post" action="http://127.0.0.1:${secret.port}/form"><input name="a" value="1"></form><form id="g" method="get" action="http://127.0.0.1:${secret.port}/get-form"></form><script>document.getElementById('f').submit();</script></body></html>`,
        );
      case '/refresh':
        return html(
          `<html><head><meta http-equiv="refresh" content="0;url=http://127.0.0.1:${secret.port}/refresh-target"></head><body>Redirecting</body></html>`,
        );
      case '/redirect-out':
        res.writeHead(302, { location: `http://127.0.0.1:${secret.port}/redirect-target` });
        return res.end();
      case '/old':
        res.writeHead(301, { location: '/stable' });
        return res.end();
      case '/loop':
        return html('<html><body><p>before</p><script>while (true) {}</script></body></html>');
      case '/flood':
        return html(
          `<html><body><p>flood</p><script>for (let i = 0; i < 400; i++) fetch('/data?n=' + i).catch(() => {});</script></body></html>`,
        );
      case '/data':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{}');
      case '/with-script':
        return html('<html><body><div id="x"></div><script src="/app.js"></script></body></html>');
      case '/app.js':
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end("document.getElementById('x').textContent = 'loaded from our own server';");
      case '/doc.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end('%PDF-1.4 not really');
      default:
        return html('<html><body>not found</body></html>', 404);
    }
  });
  fetcher = testFetcher({ ports: [site.port] }); // the secret server's port is deliberately NOT allowed
  renderer = createRenderer({ fetcher });
});

after(async () => {
  await renderer?.close();
  await site?.close();
  await secret?.close();
});

const url = (path) => `http://fixture.test:${site.port}${path}`;
const rawOf = async (path) => (await fetcher.fetch(url(path))).body.toString();

describe('the render matches the raw fetch where it should', () => {
  test('a static page: same text, same title, same structured data, same links', async () => {
    const raw = extractPage(await rawOf('/stable'), url('/stable'));
    const rendered = await renderer.render(url('/stable'));
    assert.equal(rendered.ok, true, rendered.error);
    assert.equal(rendered.status, 200);
    const browser = extractPage(rendered.html, url('/stable'));

    assert.equal(browser.text, raw.text);
    assert.equal(browser.title, raw.title);
    assert.equal(browser.metaDescription, raw.metaDescription);
    assert.deepEqual(browser.jsonLd.types, raw.jsonLd.types);
    assert.deepEqual(
      browser.links.map((l) => l.href),
      raw.links.map((l) => l.href),
    );
    assert.deepEqual(browser.blocks, raw.blocks);
    assert.equal(browser.visibleTextChars, raw.visibleTextChars, 'so B1 would see a ratio of 1');
  });

  test('a page whose content is added by JavaScript: the render has it, the raw HTML does not', async () => {
    const raw = extractPage(await rawOf('/injected'), url('/injected'));
    const rendered = await renderer.render(url('/injected'));
    assert.equal(rendered.ok, true);
    const browser = extractPage(rendered.html, url('/injected'));
    assert.doesNotMatch(raw.text, /only after the script runs/);
    assert.match(browser.text, /only after the script runs/);
    assert.ok(browser.visibleTextChars > raw.visibleTextChars);
  });

  test('scripts the page loads from its own server run', async () => {
    const rendered = await renderer.render(url('/with-script'));
    assert.match(
      extractPage(rendered.html, url('/with-script')).text,
      /loaded from our own server/,
    );
  });

  test('a redirect is followed, and the final address is reported', async () => {
    const rendered = await renderer.render(url('/old'));
    assert.equal(rendered.ok, true);
    assert.equal(rendered.finalUrl, url('/stable'));
    assert.match(rendered.html, /Stable fixture page/);
  });

  test('an error page is reported with its status', async () => {
    const rendered = await renderer.render(url('/missing'));
    assert.equal(rendered.ok, true);
    assert.equal(rendered.status, 404);
  });
});

describe('the browser reaches nothing the safe fetcher would refuse', () => {
  test('a page that tries every way to call a service on this machine, and the cloud metadata address', async () => {
    const rendered = await renderer.render(url('/attack'));
    assert.equal(rendered.ok, true, `${rendered.error} ${rendered.detail}`);
    assert.match(extractPage(rendered.html, url('/attack')).text, /Ordinary visible text/);

    assert.deepEqual(
      secret.requests.map((r) => r.url),
      [],
      'the internal service received no request at all',
    );
    const refused = rendered.blocked.filter((b) => b.guard).map((b) => b.url);
    assert.ok(
      refused.some((u) => u.includes('/head-script.js')),
      'scripts were refused by the guard',
    );
    assert.ok(
      refused.some((u) => u.includes('/fetch')),
      'fetch() was refused by the guard',
    );
    assert.ok(
      refused.some((u) => u.includes('/xhr')),
      'XMLHttpRequest was refused by the guard',
    );
    assert.ok(
      refused.some((u) => u.includes('169.254.169.254')),
      'the metadata address was refused',
    );
    assert.ok(
      rendered.blocked.some((b) => b.code === 'websocket'),
      'WebSockets are refused',
    );
  });

  test('a form that submits itself to an internal address goes nowhere', async () => {
    await renderer.render(url('/attack-form'));
    assert.deepEqual(secret.requests, []);
  });

  test('a meta refresh to an internal address goes nowhere', async () => {
    await renderer.render(url('/refresh'));
    assert.deepEqual(secret.requests, []);
  });

  test('a redirect to an internal address goes nowhere', async () => {
    const rendered = await renderer.render(url('/redirect-out'));
    assert.deepEqual(secret.requests, []);
    assert.equal(rendered.ok === true ? rendered.blocked.some((b) => b.guard) : true, true);
  });

  test('the browser itself cannot resolve names, as a second wall', async () => {
    const { chromium } = await import('playwright');
    // Interception is OFF in this test, so only the launch flags stand between the page and the network. The
    // control proves the page is reachable by name when the flag is absent; `localhost` always resolves.
    const load = async (args) => {
      const bare = await chromium.launch({ args });
      try {
        const page = await bare.newPage();
        return await page.goto(`http://localhost:${site.port}/stable`, { timeout: 5000 }).then(
          () => 'loaded',
          (err) => err.message.split('\n')[0],
        );
      } finally {
        await bare.close();
      }
    };
    assert.equal(await load([]), 'loaded', 'control: without the flag the name resolves');
    assert.match(
      await load([...BROWSER_ARGS]),
      /ERR_NAME_NOT_RESOLVED/,
      'with the renderer’s flags it does not',
    );
  });
});

describe('a page that misbehaves cannot hurt the worker', () => {
  test('an endless loop ends in a timeout, and the next render still works', async () => {
    const started = Date.now();
    const looped = await renderer.render(url('/loop'), { timeoutMs: 3000 });
    assert.equal(looped.ok, false);
    assert.equal(looped.error, 'timeout');
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);

    const after = await renderer.render(url('/stable'));
    assert.equal(after.ok, true);
  });

  test('a page that fires hundreds of requests is cut off at the cap', async () => {
    const limited = createRenderer({ fetcher, limits: { maxRequests: 40 } });
    try {
      const flood = await limited.render(url('/flood'));
      assert.equal(flood.ok, true);
      assert.ok(flood.fetched <= 40, `${flood.fetched} requests were actually made`);
      const reached = site.requests.filter((r) => r.url.startsWith('/data')).length;
      assert.ok(reached <= 40, `${reached} reached the server`);
      assert.ok(flood.blocked.some((b) => b.code === 'too_many_requests'));
    } finally {
      await limited.close();
    }
  });

  test('something that is not a web page is reported, not parsed', async () => {
    const pdf = await renderer.render(url('/doc.pdf'));
    assert.equal(pdf.ok, false);
    assert.ok(['not_html', 'render_failed'].includes(pdf.error), pdf.error);
  });
});

describe('when there is no browser', () => {
  test('a missing Chromium is a result, not a crash, and is remembered', async () => {
    let launches = 0;
    const none = createRenderer({
      fetcher,
      launch: async () => {
        launches += 1;
        throw new Error('Executable doesn’t exist');
      },
    });
    const first = await none.render(url('/stable'));
    assert.deepEqual([first.ok, first.error], [false, 'browser_unavailable']);
    const second = await none.render(url('/stable'));
    assert.equal(second.error, 'browser_unavailable');
    assert.equal(launches, 1, 'it does not keep trying to start it');
    assert.equal(none.isUnavailable(), true);
    await none.close();
  });
});
