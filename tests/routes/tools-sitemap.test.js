import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import request from 'supertest';
import { createSafeFetcher, FetchError } from '../../src/crawler/safe-fetch.js';
import { loadConfig } from '../../src/lib/config.js';
import { createToolRunner } from '../../src/lib/tool-runner.js';
import { createApp } from '../../src/web/app.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The sitemap checker (Milestone 17, task 17.08) through the real tool, runner and safe fetcher: where it looks, how
 * much it may fetch, and what it says when it found a sitemap, found none, or could not look.
 */
const config = loadConfig({ ...envs.production, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' });
const PATH = '/tools/sitemap-checker';

const urlset = (locs, { lastmod = '2026-09-20' } = {}) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`)
    .join('')}</urlset>`;
const index = (locs) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join('')}</sitemapindex>`;
const xml = (body, over = {}) => ({ type: 'application/xml', body, ...over });

/** Sites: `{ [host]: { [path]: { status, type, body, fail } } }`. A path that is not planted is a 404. */
function network(sites = {}) {
  const served = [];
  const transport = async ({ url }) => {
    served.push(`${url.hostname}${url.pathname}`);
    const answer = sites[url.hostname]?.[url.pathname] ?? {
      status: 404,
      type: 'text/plain',
      body: 'not found',
    };
    if (answer.fail) throw new FetchError(answer.fail, 'stand-in failure');
    return {
      status: answer.status ?? 200,
      headers: { 'content-type': answer.type ?? 'text/plain' },
      body: Buffer.from(answer.body ?? ''),
      bodySkipped: false,
    };
  };
  return {
    served,
    fetcher: createSafeFetcher({
      resolve: async (h) => [
        { address: h.startsWith('private') ? '10.2.3.4' : '93.184.216.34', family: 4 },
      ],
      transport,
    }),
  };
}

function appFor(sites, over = {}) {
  const net = network(sites);
  const tools = {
    limiter: { admit: async () => ({ allowed: true }) },
    turnstile: { verify: async () => ({ ok: true }) },
    runner: createToolRunner({ fetcher: net.fetcher }),
    ...over,
  };
  return { app: request(createApp({ config, logger: silentLogger, tools })), net };
}
const check = (app, url) => app.post(PATH).type('form').send({ url, 'cf-turnstile-response': 't' });
const resultOf = (res) => {
  const start = res.text.indexOf('id="result"');
  const end = res.text.indexOf('aria-labelledby="cannot-see-heading"');
  return start < 0 ? '' : res.text.slice(start, end > start ? end : undefined);
};
const robots = (body) => ({ '/robots.txt': { type: 'text/plain', body } });

describe('finding the sitemap', () => {
  test('the one robots.txt names: found, pointed to, counted, and only two files were fetched', async () => {
    const { app, net } = appFor({
      'acme-test.com': {
        ...robots('User-agent: *\nAllow: /\nSitemap: https://acme-test.com/map.xml\n'),
        '/map.xml': xml(
          urlset(['https://acme-test.com/', 'https://acme-test.com/a', 'https://acme-test.com/b']),
        ),
      },
    });
    const res = await check(app, 'acme-test.com').expect(200);
    const result = resultOf(res);
    assert.match(
      result,
      /Your sitemap is at https:\/\/acme-test\.com\/map\.xml, and robots\.txt points to it/,
    );
    assert.match(result, /Addresses listed/);
    assert.match(result, /3 of 3/);
    assert.deepEqual(net.served, ['acme-test.com/robots.txt', 'acme-test.com/map.xml']);
  });

  test('no Sitemap line: the usual addresses are tried in order and it stops at the first real one', async () => {
    const { app, net } = appFor({
      'acme-test.com': {
        '/sitemap_index.xml': xml(urlset(['https://acme-test.com/'])),
        '/wp-sitemap.xml': xml(urlset(['https://acme-test.com/never-read'])),
      },
    });
    const res = await check(app, 'acme-test.com').expect(200);
    assert.match(
      resultOf(res),
      /Your sitemap is at https:\/\/acme-test\.com\/sitemap_index\.xml, but robots\.txt does not point to it/,
    );
    assert.match(resultOf(res), /Sitemap: https:\/\/acme-test\.com\/sitemap_index\.xml/);
    assert.deepEqual(net.served, [
      'acme-test.com/robots.txt',
      'acme-test.com/sitemap.xml',
      'acme-test.com/sitemap_index.xml',
    ]);
  });

  test('a sitemap address typed in is the one read, with robots.txt beside it', async () => {
    const { app, net } = appFor({
      'acme-test.com': {
        '/custom/my-sitemap.xml': xml(urlset(['https://acme-test.com/x'])),
        '/sitemap.xml': xml(urlset(['https://acme-test.com/other'])),
      },
    });
    const res = await check(app, 'https://acme-test.com/custom/my-sitemap.xml').expect(200);
    assert.match(
      resultOf(res),
      /Your sitemap is at https:\/\/acme-test\.com\/custom\/my-sitemap\.xml/,
    );
    assert.deepEqual(net.served, [
      'acme-test.com/robots.txt',
      'acme-test.com/custom/my-sitemap.xml',
    ]);
  });

  test('an index: it reads at most three of its sitemaps, inside five fetches in all, and says so', async () => {
    const kids = Array.from({ length: 8 }, (_, i) => `https://acme-test.com/s${i}.xml`);
    const sites = {
      'acme-test.com': {
        ...robots('Sitemap: https://acme-test.com/idx.xml'),
        '/idx.xml': xml(index(kids)),
      },
    };
    kids.forEach(
      (k, i) =>
        (sites['acme-test.com'][`/s${i}.xml`] = xml(
          urlset([`https://acme-test.com/p${i}a`, `https://acme-test.com/p${i}b`]),
        )),
    );
    const { app, net } = appFor(sites);
    const res = await check(app, 'acme-test.com').expect(200);
    const result = resultOf(res);
    assert.match(result, /Sitemaps in the index/);
    assert.match(result, /read 3 of them/);
    assert.match(result, /at least 6/);
    assert.equal(net.served.length, 5, 'robots.txt, the index and three sitemaps');
  });

  test('a text sitemap, one address a line, is read too', async () => {
    const { app } = appFor({
      'acme-test.com': {
        '/sitemap.xml': {
          type: 'text/plain',
          body: 'https://acme-test.com/\nhttps://acme-test.com/a\n',
        },
      },
    });
    assert.match(resultOf(await check(app, 'acme-test.com').expect(200)), /Text list/);
  });
});

describe('what it says about the sitemap', () => {
  test('addresses on another site, and no dates, are named', async () => {
    const { app } = appFor({
      'acme-test.com': {
        ...robots('Sitemap: https://acme-test.com/m.xml'),
        '/m.xml': xml(
          urlset(['https://acme-test.com/', 'https://old-domain.test/a'], { lastmod: null }),
        ),
      },
    });
    const result = resultOf(await check(app, 'acme-test.com').expect(200));
    assert.match(result, /Addresses on another site/);
    assert.match(result, /No address has a date/);
  });

  test('the addresses quoted come back as text', async () => {
    const { app } = appFor({
      'acme-test.com': {
        ...robots('Sitemap: https://acme-test.com/m.xml'),
        '/m.xml': xml(urlset(['https://acme-test.com/&lt;script&gt;alert(1)&lt;/script&gt;'])),
      },
    });
    const { text } = await check(app, 'acme-test.com').expect(200);
    assert.doesNotMatch(text, /<script>alert\(1\)/);
  });

  test('a hostile sitemap (60,000 long addresses) is counted and cut, quickly', async () => {
    const locs = Array.from(
      { length: 60_000 },
      (_, i) => `https://acme-test.com/${'a'.repeat(40)}${i}`,
    );
    const { app } = appFor({
      'acme-test.com': {
        ...robots('Sitemap: https://acme-test.com/m.xml'),
        '/m.xml': xml(urlset(locs)),
      },
    });
    const started = Date.now();
    const res = await check(app, 'acme-test.com').expect(200);
    assert.ok(Date.now() - started < 30_000, 'a loose bound');
    assert.match(resultOf(res), /Addresses listed/);
    assert.ok(res.text.length < 400_000, 'the answer does not carry the file');
  });
});

describe('a site with no sitemap, and a site we could not look at', () => {
  test('a site that answered “not found” everywhere has no sitemap: that is an answer, and a gentle one', async () => {
    const { app, net } = appFor({ 'acme-test.com': {} });
    const result = resultOf(await check(app, 'acme-test.com').expect(200));
    assert.match(result, /found no sitemap at the usual addresses/);
    assert.match(result, /optional/);
    assert.doesNotMatch(result, /Couldn’t check/);
    assert.equal(net.served.length, 4, 'robots.txt and the three usual addresses');
  });

  for (const [name, planted, words] of [
    ['a timeout on one address', { '/sitemap.xml': { fail: 'timeout' } }, /took too long/],
    [
      'a server error on one address',
      { '/sitemap.xml': { status: 503, body: 'down' } },
      /gave an error/,
    ],
    ['a rate limit', { '/sitemap.xml': { status: 429, body: 'slow' } }, /turned our request away/],
    [
      'a firewall page',
      {
        '/sitemap.xml': { status: 403, type: 'text/html', body: '<title>Just a moment...</title>' },
      },
      /turned our request away/,
    ],
    [
      'robots.txt that cannot be read',
      { '/robots.txt': { status: 503, body: 'down' } },
      /gave an error|took too long/,
    ],
  ]) {
    test(`${name}, and no sitemap found anywhere, is “couldn’t check” and never “no sitemap”`, async () => {
      const { app } = appFor({ 'acme-test.com': planted });
      const result = resultOf(await check(app, 'acme-test.com').expect(200));
      assert.match(result, /Couldn’t check/);
      assert.match(result, words);
      assert.doesNotMatch(result, /found no sitemap/);
    });
  }

  test('trouble with one address does not hide a sitemap found at another', async () => {
    const { app } = appFor({
      'acme-test.com': {
        '/sitemap.xml': { fail: 'timeout' },
        '/sitemap_index.xml': xml(urlset(['https://acme-test.com/'])),
      },
    });
    assert.match(
      resultOf(await check(app, 'acme-test.com').expect(200)),
      /Your sitemap is at https:\/\/acme-test\.com\/sitemap_index\.xml/,
    );
  });

  test('a name that resolves to a private network is refused before any connection', async () => {
    const { app, net } = appFor({
      'private-host.com': { '/sitemap.xml': xml(urlset(['https://private-host.com/'])) },
    });
    const res = await check(app, 'private-host.com').expect(200);
    assert.match(resultOf(res), /only check public websites/);
    assert.doesNotMatch(res.text, /10\.2\.3\.4/);
    assert.equal(net.served.length, 0);
  });
});

describe('the run', () => {
  test('it needs a person (the bot check): without one nothing is fetched', async () => {
    const { app, net } = appFor(
      { 'acme-test.com': {} },
      { turnstile: { verify: async () => ({ ok: false, reason: 'rejected' }) } },
    );
    await app.post(PATH).type('form').send({ url: 'acme-test.com' }).expect(422);
    assert.equal(net.served.length, 0);
  });

  test('a bad address is the usual message, and the page says what it cannot tell you', async () => {
    const { app } = appFor({});
    assert.match(
      (await check(app, 'not a website').expect(422)).text,
      /doesn’t look like a website address/,
    );
    const page = await app.get(PATH).expect(200);
    assert.match(page.text, /cannot tell you whether search or AI engines have fetched/);
    assert.match(page.text, /"@type":"FAQPage"/);
  });
});
