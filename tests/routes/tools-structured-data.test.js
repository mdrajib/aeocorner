import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import request from 'supertest';
import { createSafeFetcher, FetchError } from '../../src/crawler/safe-fetch.js';
import { loadConfig } from '../../src/lib/config.js';
import { createToolRunner } from '../../src/lib/tool-runner.js';
import { createApp } from '../../src/web/app.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The structured data validator (Milestone 17, task 17.07) through the real tool, runner and safe fetcher. It has two
 * ways in: pasted code (no request leaves us, no bot check, the cheaper limit) and a page address (one page, robots.txt
 * obeyed, bot check, the stricter limits).
 */
const config = loadConfig({
  ...envs.production,
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
});
const PATH = '/tools/structured-data-validator';

const org = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Acme',
  url: 'https://acme-test.com',
  logo: 'https://acme-test.com/logo.png',
  sameAs: ['https://www.linkedin.com/company/acme'],
};
const script = (json) => `<script type="application/ld+json">${json}</script>`;
const html = (head = '', body = '<h1>Acme</h1>') =>
  `<!doctype html><html><head><title>Acme</title>${head}</head><body>${body}</body></html>`;

/** Sites: `{ [host]: { robots?, pages: { [path]: { status, type, body, location } } } }`. */
function network(sites = {}) {
  const served = [];
  const transport = async ({ url }) => {
    served.push(`${url.hostname}${url.pathname}`);
    const site = sites[url.hostname] ?? {};
    const answer =
      url.pathname === '/robots.txt'
        ? (site.robots ?? { status: 404, body: 'nope' })
        : (site.pages?.[url.pathname] ?? { status: 404, type: 'text/html', body: 'not found' });
    if (answer.fail) throw new FetchError(answer.fail, 'stand-in failure');
    return {
      status: answer.status ?? 200,
      headers: {
        'content-type':
          answer.type ??
          (url.pathname === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8'),
        ...(answer.location ? { location: answer.location } : {}),
      },
      body: Buffer.from(answer.body ?? ''),
      bodySkipped: false,
    };
  };
  return {
    served,
    fetcher: createSafeFetcher({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport,
    }),
  };
}

function appFor(sites, over = {}) {
  const net = network(sites);
  const admitted = [];
  const verified = [];
  const tools = {
    limiter: { admit: async (a) => (admitted.push(a), { allowed: true }) },
    turnstile: { verify: async (a) => (verified.push(a), { ok: true }) },
    runner: createToolRunner({ fetcher: net.fetcher }),
    ...over,
  };
  return {
    app: request(createApp({ config, logger: silentLogger, tools })),
    net,
    admitted,
    verified,
  };
}
const send = (app, body) => app.post(PATH).type('form').send(body);
// The result runs up to the "what this tool cannot tell you" section; that text and the FAQ are not part of it.
const resultOf = (res) => {
  const start = res.text.indexOf('id="result"');
  const end = res.text.indexOf('aria-labelledby="cannot-see-heading"');
  return start < 0 ? '' : res.text.slice(start, end > start ? end : undefined);
};

describe('pasted code: nothing leaves us', () => {
  test('a valid block, as JSON, is checked with no request, no bot check and the cheaper kind of run', async () => {
    const { app, net, admitted, verified } = appFor();
    const res = await send(app, { code: JSON.stringify(org) }).expect(200);
    assert.match(res.text, /1 block of structured data, no errors found/);
    assert.match(res.text, /Types we checked/);
    assert.deepEqual(net.served, []);
    assert.deepEqual(verified, []);
    assert.deepEqual(
      admitted.map((a) => [a.kind, a.domain]),
      [['generate', undefined]],
    );
  });

  test('the whole <script> block pasted from a page works too, with every block checked', async () => {
    const { app } = appFor();
    const pasted = `${script(JSON.stringify(org))}\n${script('{"@context":"https://schema.org","@type":"WebSite","name":"Acme","url":"https://acme-test.com"}')}`;
    const res = await send(app, { code: pasted }).expect(200);
    assert.match(res.text, /2 blocks of structured data, no errors found/);
    assert.match(res.text, /Block 2/);
  });

  test('a wrong value is named with its path, and the fix is in plain words', async () => {
    const { app } = appFor();
    const res = await send(app, { code: JSON.stringify({ ...org, url: 'acme-test.com' }) }).expect(
      200,
    );
    const result = resultOf(res);
    assert.match(result, /1 problem in 1 block/);
    assert.match(result, /\$\.url/);
    assert.match(result, /full web address starting with https/);
  });

  test('code that is not JSON is a problem, not a crash', async () => {
    const { app } = appFor();
    const res = await send(app, { code: '{ "@type": "Organization", ' }).expect(200);
    assert.match(resultOf(res), /Not valid JSON/);
  });

  test('a type we do not know is "not checked", and says that is not the same as wrong', async () => {
    const { app } = appFor();
    const res = await send(app, {
      code: '{"@context":"https://schema.org","@type":"Recipe","name":"Pancakes"}',
    }).expect(200);
    assert.match(resultOf(res), /Not checked/);
    assert.match(resultOf(res), /does not mean they are wrong/);
  });

  test('markup inside the code comes back as text', async () => {
    const { app } = appFor();
    const evil = {
      ...org,
      name: '</script><script>alert(1)</script>',
      description: '"><img src=x onerror=alert(2)>',
    };
    const res = await send(app, { code: JSON.stringify(evil) }).expect(200);
    assert.doesNotMatch(res.text, /<script>alert\(1\)|<img src=x/);
  });

  test('hostile code: nesting by the tens of thousands, a huge list, and a page nested 5,000 deep all end quickly', async () => {
    const { app } = appFor();
    const started = Date.now();
    const deepJson = `${'['.repeat(30_000)}${']'.repeat(30_000)}`;
    const manyItems = `[${Array(30_000).fill('{"@type":"Thing"}').join(',')}]`;
    const deepHtml = `${'<div>'.repeat(5_000)}${script(JSON.stringify(org))}`;
    for (const code of [deepJson, manyItems.slice(0, 120_000), deepHtml]) {
      const res = await send(app, { code }).expect(200);
      assert.match(res.text, /id="result"/);
    }
    assert.ok(Date.now() - started < 30_000, 'a loose bound');
  });

  test('over 200 KB is refused with a message, not read', async () => {
    const { app, admitted } = appFor();
    const res = await send(app, { code: 'x'.repeat(200_001) }).expect(422);
    assert.match(res.text, /too long to check here/);
    assert.equal(admitted.length, 0);
  });
});

describe('the form', () => {
  test('neither field, or both, is a 422 with a message by the field and nothing is run', async () => {
    const { app, admitted, verified } = appFor();
    const none = await send(app, { url: '', code: '  ' }).expect(422);
    assert.match(none.text, /Enter a page address, or paste your structured data/);
    const both = await send(app, { url: 'acme-test.com', code: '{}' }).expect(422);
    assert.match(both.text, /Use one or the other/);
    assert.deepEqual([admitted.length, verified.length], [0, 0]);
  });

  test('a bad page address is the usual message', async () => {
    const { app } = appFor();
    assert.match(
      (await send(app, { url: 'not a website' }).expect(422)).text,
      /doesn’t look like a website address/,
    );
  });

  test('the page has both fields, the widget, and says what it cannot see', async () => {
    const { app } = appFor();
    const { text } = await app.get(PATH).expect(200);
    assert.match(text, /name="url"/);
    assert.match(text, /<textarea[^>]*name="code"/);
    assert.match(text, /class="cf-turnstile"/);
    assert.match(text, /does not run JavaScript/);
    assert.match(text, /"@type":"FAQPage"/);
  });
});

describe('a page address: one page, read politely', () => {
  const sites = {
    'acme-test.com': {
      robots: { body: 'User-agent: *\nDisallow: /private\n' },
      pages: {
        '/about': { body: html(script(JSON.stringify(org))) },
        '/plain': { body: html('', '<p>nothing</p>') },
        '/private': { body: html(script(JSON.stringify(org))) },
        '/json': { type: 'application/json', body: '{}' },
        '/missing-page': { status: 404, body: 'gone' },
        '/walled': { status: 403, type: 'text/html', body: '<title>Just a moment...</title>' },
        '/broken': { status: 500, body: 'oops' },
        '/deep': { body: `${'<div>'.repeat(5000)}${script(JSON.stringify(org))}` },
        '/moved': { status: 302, location: 'https://elsewhere-test.com/page' },
      },
    },
    'elsewhere-test.com': {
      robots: { body: 'User-agent: AEOCornerBot\nDisallow: /\n' },
      pages: { '/page': { body: html(script(JSON.stringify(org))) } },
    },
  };

  test('it needs a person (the bot check), is counted as a fetch for that site, and reads exactly two files', async () => {
    const { app, net, admitted, verified } = appFor(sites);
    const res = await send(app, {
      url: 'https://acme-test.com/about',
      'cf-turnstile-response': 'tok',
    }).expect(200);
    assert.match(resultOf(res), /1 block of structured data, no errors found/);
    assert.match(resultOf(res), /https:\/\/acme-test\.com\/about/);
    assert.deepEqual(
      verified.map((v) => v.token),
      ['tok'],
    );
    assert.deepEqual(
      admitted.map((a) => [a.kind, a.domain]),
      [['fetch', 'acme-test.com']],
    );
    assert.deepEqual(net.served.filter((s) => !s.endsWith('/robots.txt')).length, 1);
    assert.ok(net.served.length <= 2, 'robots.txt, then the page');
  });

  test('without a passing bot check, the page is never read', async () => {
    const { app, net } = appFor(sites, {
      turnstile: { verify: async () => ({ ok: false, reason: 'rejected' }) },
    });
    await send(app, { url: 'acme-test.com/about' }).expect(422);
    assert.equal(net.served.length, 0);
  });

  test('a page the site’s robots.txt keeps our crawler away from is not read', async () => {
    const { app, net } = appFor(sites);
    const res = await send(app, {
      url: 'acme-test.com/private',
      'cf-turnstile-response': 't',
    }).expect(200);
    assert.match(resultOf(res), /Couldn’t check/);
    assert.match(resultOf(res), /robots\.txt asks our crawler/);
    assert.ok(!net.served.includes('acme-test.com/private'));
  });

  test('a redirect to another site is that site’s page, and that site’s robots.txt speaks for it', async () => {
    const { app, net } = appFor(sites);
    const res = await send(app, {
      url: 'acme-test.com/moved',
      'cf-turnstile-response': 't',
    }).expect(200);
    assert.match(resultOf(res), /Couldn’t check/);
    assert.match(resultOf(res), /robots\.txt asks our crawler/);
    assert.ok(net.served.includes('elsewhere-test.com/robots.txt'));
  });

  test('a page with no structured data is an answer, and says why that may be', async () => {
    const { app } = appFor(sites);
    const res = await send(app, {
      url: 'acme-test.com/plain',
      'cf-turnstile-response': 't',
    }).expect(200);
    assert.match(resultOf(res), /no structured data in the page’s HTML/);
    assert.match(resultOf(res), /add structured data with JavaScript/);
    assert.doesNotMatch(resultOf(res), /Couldn’t check/);
  });

  for (const [name, path, words] of [
    ['a page that is not found', '/missing-page', /answered “not found” \(HTTP 404\)/],
    ['a server error', '/broken', /answered with an error \(HTTP 500\)/],
    ['a firewall page', '/walled', /turned the request away/],
    ['something that is not HTML', '/json', /did not send HTML/],
    ['a page nested absurdly deep', '/deep', /nested too deeply/],
  ]) {
    test(`${name} is "couldn’t check", never "no structured data"`, async () => {
      const { app } = appFor(sites);
      const res = await send(app, {
        url: `acme-test.com${path}`,
        'cf-turnstile-response': 't',
      }).expect(200);
      assert.match(resultOf(res), /Couldn’t check/);
      assert.match(resultOf(res), words);
      assert.doesNotMatch(resultOf(res), /no structured data/);
    });
  }

  test('a site that does not answer is "couldn’t check" with its own words', async () => {
    const { app } = appFor({ 'down-test.com': { robots: { fail: 'timeout' } } });
    const res = await send(app, { url: 'down-test.com/x', 'cf-turnstile-response': 't' }).expect(
      200,
    );
    assert.match(resultOf(res), /Couldn’t check/);
    assert.match(resultOf(res), /could not read the site’s robots\.txt/);
  });

  test('a name that resolves to a private network is refused before any connection', async () => {
    const net = network({});
    const fetcher = createSafeFetcher({
      resolve: async () => [{ address: '10.0.0.7', family: 4 }],
      transport: async () => {
        throw new Error('a connection was opened');
      },
    });
    const { app } = appFor({}, { runner: createToolRunner({ fetcher }) });
    const res = await send(app, {
      url: 'internal-test.com/x',
      'cf-turnstile-response': 't',
    }).expect(200);
    assert.match(resultOf(res), /Couldn’t check/);
    assert.doesNotMatch(res.text, /10\.0\.0\.7|a connection was opened/);
    assert.ok(net);
  });

  test('a fetch tool with no Turnstile is closed for a page address, while pasting still works', async () => {
    const { app } = appFor(sites, { turnstile: null });
    await send(app, { url: 'acme-test.com/about' }).expect(503);
    await send(app, { code: JSON.stringify(org) }).expect(200);
  });
});
