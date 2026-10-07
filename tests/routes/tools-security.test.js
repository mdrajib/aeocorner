import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { FINDINGS_LIMITS } from '../../src/core/tool-findings.js';
import { loadConfig } from '../../src/lib/config.js';
import { createToolRunner } from '../../src/lib/tool-runner.js';
import { createApp } from '../../src/web/app.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The free tools against hostile sites (Milestone 17, task 17.14, ADR-0017). Every fetching tool runs through the real
 * route, the real tool runner and the real safe fetcher, against a web server on this machine that behaves badly:
 * it redirects to this machine and to a cloud metadata address, sits behind a private address, never stops sending, sends
 * 20 MB, sends a gzip bomb, a million-line robots.txt and JSON-LD nested 10,000 deep. Each answer must be "Couldn't check"
 * (or a plain result, where reading a capped part is the right answer) inside the deadline, and the process must keep
 * serving. Then: a hostile robots.txt comes back escaped, and a result never carries a long stretch of the fetched file.
 */
const config = loadConfig({ ...envs.production, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' });
const DEADLINE_MS = 3_000;
const SLACK_MS = 4_000;
const COULDNT = 'Couldn’t check';

const TOOLS = [
  { slug: 'robots-txt-checker', field: 'url' },
  { slug: 'sitemap-checker', field: 'url' },
  { slug: 'structured-data-validator', field: 'url' },
];

const BIG = Buffer.alloc(20 * 1024 * 1024, 'a');
const BOMB = gzipSync(Buffer.alloc(100 * 1024 * 1024, '<'));
const MILLION_LINES = Buffer.from('User-agent: *\n' + 'Disallow: /private/x\n'.repeat(1_000_000));
const DEEP = `<html><head><script type="application/ld+json">${'['.repeat(10_000)}${']'.repeat(10_000)}</script></head><body><h1>x</h1></body></html>`;
const DEEP_JSON = `${'['.repeat(10_000)}${']'.repeat(10_000)}`;
const NESTED_DIVS = `<html><body>${'<div>'.repeat(20_000)}</body></html>`;

/** Long lines of unique text, to see whether any stretch of a fetched file is handed back as it was. */
const LONG_LINES = Array.from(
  { length: 40 },
  (_, i) => `Disallow: /${i}-${'x7Kq9ZpL'.repeat(150)}${i.toString(16).repeat(30)}`,
);

const hosts = {
  'endless.test': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => res.write('Disallow: /x\n'.repeat(500)), 5);
    res.on('close', () => clearInterval(timer));
  },
  'big.test': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(BIG);
  },
  'bomb.test': (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\nSitemap: https://bomb.test/sitemap.xml\n');
    }
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    return res.end(BOMB);
  },
  'bombgz.test': (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\nSitemap: https://bombgz.test/s.xml.gz\n');
    }
    res.writeHead(200, { 'content-type': 'application/gzip' });
    return res.end(BOMB);
  },
  'lines.test': (req, res) => {
    if (req.url !== '/robots.txt') return res.writeHead(404).end('no');
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(MILLION_LINES);
  },
  'deep.test': (req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\nSitemap: https://deep.test/sitemap.xml\n');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(req.url === '/sitemap.xml' ? NESTED_DIVS : DEEP);
  },
  'xss.test': (req, res) => {
    if (req.url !== '/robots.txt') return res.writeHead(404).end('no');
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(
      [
        'User-agent: <script>alert("ua")</script>',
        'Disallow: /<img src=x onerror=alert(1)>',
        'User-agent: GPTBot',
        'Disallow: /"><svg onload=alert(2)>',
        'Sitemap: https://xss.test/<script>alert(3)</script>',
        'Sitemap: javascript:alert(4)',
        '',
      ].join('\n'),
    );
  },
  'long.test': (req, res) => {
    if (req.url !== '/robots.txt') return res.writeHead(404).end('no');
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(`User-agent: GPTBot\n${LONG_LINES.join('\n')}\n`);
  },
};
for (const name of ['redirect', 'metadata', 'loop', 'ipv6']) {
  const to = {
    redirect: 'http://127.0.0.1/robots.txt',
    metadata: 'http://169.254.169.254/latest/meta-data/',
    ipv6: 'http://[::1]/robots.txt',
    loop: 'https://loop.test/robots.txt',
  }[name];
  hosts[`${name}.test`] = (req, res) => {
    res.writeHead(302, { location: to });
    res.end();
  };
}
hosts['private.test'] = (req, res) => res.writeHead(200).end('User-agent: *\nDisallow:\n');

let fixture;
let fetcher;
let app;
const rewrite = (url) => {
  const u = new URL(url);
  return u.hostname.endsWith('.test')
    ? `http://${u.hostname}:${fixture.port}${u.pathname}${u.search}`
    : url;
};

before(async () => {
  fixture = await startServer((req, res) => {
    const host = String(req.headers.host ?? '').split(':')[0];
    (hosts[host] ?? ((rq, rs) => rs.writeHead(404).end('no')))(req, res);
  });
  const inner = testFetcher({
    ports: [fixture.port],
    dns: { 'private.test': ['10.1.2.3'], 'ipv6.test': ['127.0.0.1'] },
  });
  // The form takes no port number, so the stand-in turns "https://x.test/..." into this fixture's port. Redirects
  // are followed by the real fetcher with the real guard, which is the point.
  fetcher = { fetch: (url, options) => inner.fetch(rewrite(url), options) };
  const tools = {
    limiter: { admit: async () => ({ allowed: true }) },
    turnstile: { verify: async () => ({ ok: true }) },
    runner: createToolRunner({ fetcher, limits: { deadlineMs: DEADLINE_MS } }),
  };
  app = request(createApp({ config, logger: silentLogger, tools }));
});
after(async () => {
  await fixture.close();
});

const run = (slug, url) =>
  app.post(`/tools/${slug}`).type('form').send({ url, 'cf-turnstile-response': 't' });
const resultOf = (res) => {
  const start = res.text.indexOf('id="result"');
  const end = res.text.indexOf('aria-labelledby="cannot-see-heading"');
  return start < 0 ? '' : res.text.slice(start, end > start ? end : undefined);
};
/** One timed run: the answer must be a page, not an error, and must come back inside the deadline. */
async function timed(slug, host) {
  const started = Date.now();
  const res = await run(slug, host);
  const took = Date.now() - started;
  assert.equal(res.status, 200, `${slug} on ${host}: ${res.status}`);
  assert.ok(took < DEADLINE_MS + SLACK_MS, `${slug} on ${host} took ${took} ms`);
  return res;
}
async function stillServing() {
  const res = await app.get('/tools/robots-txt-checker');
  assert.equal(res.status, 200);
}

describe('a site that tries to reach our network', () => {
  for (const host of ['redirect.test', 'metadata.test', 'ipv6.test', 'private.test']) {
    for (const { slug } of TOOLS) {
      test(`${slug} on ${host}: "Couldn’t check", in plain words, and nothing of ours is touched`, async () => {
        const before = fixture.requests.length;
        const res = await timed(slug, host);
        const result = resultOf(res);
        assert.ok(result.includes(COULDNT), `${slug} on ${host}: ${result.slice(0, 300)}`);
        // The page-reading tool asks robots.txt first, so it words a refused address as a robots.txt it could not read.
        assert.match(result, /only check public websites|could not read the site’s robots.txt/);
        assert.doesNotMatch(result, /127\.0\.0\.1|169\.254|10\.1\.2\.3|::1/);
        if (host === 'private.test')
          assert.equal(fixture.requests.length, before, 'a private address is never connected to');
      });
    }
  }

  test('a redirect loop is given up on, not followed for ever', async () => {
    const res = await timed('robots-txt-checker', 'loop.test');
    assert.ok(resultOf(res).includes(COULDNT));
    assert.match(resultOf(res), /round in circles|took too long|could not/i);
  });
});

describe('a site that sends too much, or never stops', () => {
  for (const host of ['endless.test', 'big.test']) {
    for (const { slug } of TOOLS) {
      test(`${slug} on ${host}: "Couldn’t check" inside the deadline`, async () => {
        const res = await timed(slug, host);
        assert.ok(resultOf(res).includes(COULDNT), `${slug} on ${host}`);
      });
    }
  }

  test('the process is still serving after all of that', async () => {
    await stillServing();
  });
});

describe('a file packed to blow up', () => {
  for (const host of ['bomb.test', 'bombgz.test']) {
    for (const { slug } of TOOLS) {
      test(`${slug} on ${host}: a bounded answer, never a crash`, async () => {
        const res = await timed(slug, host);
        const result = resultOf(res);
        assert.ok(result.length > 0, 'the page has an answer in it');
        assert.doesNotMatch(result, /Something went wrong on our side/);
        // Never "no sitemap" for a file we could not read.
        if (slug === 'sitemap-checker')
          assert.match(
            result,
            /Couldn’t check|could not read it as one|could not tell/,
            result.slice(0, 300),
          );
        if (slug === 'sitemap-checker') assert.doesNotMatch(result, /no sitemap/i);
      });
    }
  }

  test('a million-line robots.txt and a deeply nested page are bounded too', async () => {
    for (const { slug } of TOOLS) {
      await timed(slug, 'lines.test');
      await timed(slug, 'deep.test');
    }
    await stillServing();
  });

  test('pasted JSON nested 10,000 deep is answered, not crashed on', async () => {
    const started = Date.now();
    const res = await app
      .post('/tools/structured-data-validator')
      .type('form')
      .send({ code: DEEP_JSON });
    assert.ok([200, 422].includes(res.status), String(res.status));
    assert.ok(Date.now() - started < DEADLINE_MS + SLACK_MS);
    await stillServing();
  });
});

describe('what a hostile file says is only text', () => {
  test('a robots.txt with script and event handlers comes back escaped, on every fetching tool', async () => {
    for (const { slug } of TOOLS) {
      const res = await timed(slug, 'xss.test');
      assert.doesNotMatch(res.text, /<script>alert/, slug);
      assert.doesNotMatch(res.text, /<img src=x onerror/, slug);
      assert.doesNotMatch(res.text, /<svg onload/, slug);
      assert.doesNotMatch(res.text, /href="javascript:/i, slug);
    }
    const shown = resultOf(await timed('robots-txt-checker', 'xss.test'));
    assert.doesNotMatch(shown, /onerror=alert\(1\)>(?!&)/);
  });

  test('the address typed is shown escaped when it is refused', async () => {
    const res = await run('robots-txt-checker', '"><script>alert(5)</script>.com').expect(422);
    assert.doesNotMatch(res.text, /<script>alert\(5\)/);
  });
});

describe('the tool is not a proxy for the file it fetched', () => {
  test('no stretch of the fetched file longer than a line cap comes back', async () => {
    const cap = FINDINGS_LIMITS.lineChars;
    const file = `User-agent: GPTBot\n${LONG_LINES.join('\n')}\n`;
    for (const { slug } of TOOLS) {
      const res = await timed(slug, 'long.test');
      // Whatever the page shows of the file, no window longer than the cap appears in it, so the page cannot be used to
      // read a file through us. Windows are taken with a stride of 50 over the whole file.
      for (let at = 0; at + cap + 1 <= file.length; at += 50) {
        const window = file.slice(at, at + cap + 1);
        if (/^[x7Kq9ZpL]{20}/.test(window) || window.includes('Disallow: /'))
          assert.ok(
            !res.text.includes(window),
            `${slug}: ${cap + 1} characters of the file came back`,
          );
      }
    }
  });
});
