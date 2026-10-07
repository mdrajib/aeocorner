import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import request from 'supertest';
import { createSafeFetcher, FetchError } from '../../src/crawler/safe-fetch.js';
import { loadConfig } from '../../src/lib/config.js';
import { createToolRunner } from '../../src/lib/tool-runner.js';
import { createTurnstile } from '../../src/lib/turnstile.js';
import { createApp } from '../../src/web/app.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The robots.txt checker (Milestone 17, task 17.06) and the bot check in front of it (task 17.05), through the real
 * tool, the real runner and the real safe fetcher. Only the network is a stand-in: a name resolver that answers with a
 * public address, a transport that serves the files the tests plant, and Cloudflare's siteverify.
 */
const config = loadConfig({
  ...envs.production,
  POSTHOG_API_KEY: 'phc_test',
  POSTHOG_HOST: 'https://posthog.test',
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
});
const PATH = '/tools/robots-txt-checker';

/** A site: what its /robots.txt answers. `served` records every request that reached the "network". */
function network(files = {}) {
  const served = [];
  const transport = async ({ url, address }) => {
    served.push({ host: url.hostname, path: url.pathname, address });
    const file = files[url.hostname] ?? { status: 404, body: 'not found' };
    if (file.fail) throw new FetchError(file.fail, 'stand-in failure');
    return {
      status: file.status ?? 200,
      headers: { 'content-type': file.type ?? 'text/plain' },
      body: Buffer.from(file.body ?? ''),
      bodySkipped: false,
    };
  };
  const resolve = async (host) => [
    { address: host.startsWith('private') ? '10.1.2.3' : '93.184.216.34', family: 4 },
  ];
  return { served, fetcher: createSafeFetcher({ resolve, transport }) };
}

/** Cloudflare's siteverify as a stand-in. `answer` is the JSON it sends, or a function that throws. */
function siteverify(answer = { success: true, hostname: 'aeocorner.com' }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(init.body) });
    if (typeof answer === 'function') return answer();
    return { ok: true, json: async () => answer };
  };
  return {
    calls,
    turnstile: createTurnstile({
      secretKey: 'secret',
      expectedHostname: 'aeocorner.com',
      fetchImpl,
    }),
  };
}

function appFor({ files, verify = siteverify(), over = {} } = {}) {
  const net = network(files);
  const tools = {
    limiter: { admit: async () => ({ allowed: true }) },
    turnstile: verify.turnstile,
    runner: createToolRunner({ fetcher: net.fetcher }),
    ...over,
  };
  return { app: request(createApp({ config, logger: silentLogger, tools })), net, verify };
}
const run = (app, url, extra = {}) =>
  app
    .post(PATH)
    .type('form')
    .send({ url, 'cf-turnstile-response': 'token-1', ...extra });

describe('the checker, end to end', () => {
  test('a file that blocks one answer crawler: which one, the rule that did it, and the others allowed', async () => {
    const { app, net } = appFor({
      files: {
        'acme-test.com': {
          body: 'User-agent: OAI-SearchBot\nDisallow: /\n\nSitemap: https://acme-test.com/s.xml\n',
        },
      },
    });
    const res = await run(app, 'https://acme-test.com/about').expect(200);
    assert.match(res.text, /robots\.txt blocks 1 of \d+ answer and search crawlers: OAI-SearchBot/);
    assert.match(res.text, /Blocked by “Disallow: \/”/);
    assert.match(res.text, /User-agent: OAI-SearchBot/);
    assert.match(res.text, /PerplexityBot/);
    assert.match(res.text, /not a lock/);
    assert.deepEqual(
      net.served.map((s) => [s.host, s.path]),
      [['acme-test.com', '/robots.txt']],
      'one file, nothing else',
    );
  });

  test('no robots.txt is an answer, not an error', async () => {
    const { app } = appFor({ files: {} });
    const res = await run(app, 'acme-test.com').expect(200);
    assert.match(res.text, /no robots\.txt, so every AI crawler is allowed/);
    assert.doesNotMatch(res.text, /Couldn’t check/);
  });

  test('a page served where the file should be is "no robots.txt" too', async () => {
    const { app } = appFor({
      files: { 'acme-test.com': { type: 'text/html', body: '<html>Home</html>' } },
    });
    assert.match((await run(app, 'acme-test.com')).text, /no robots\.txt/);
  });

  for (const [name, file, words] of [
    ['a server error', { status: 503, body: 'down' }, /answered with an error \(HTTP 503\)/],
    ['too many requests', { status: 429, body: 'slow down' }, /turned the request away/],
    [
      'a firewall page',
      { status: 403, type: 'text/html', body: '<title>Just a moment...</title>' },
      /turned the request away/,
    ],
    ['a timeout', { fail: 'timeout' }, /took too long/],
    ['a failed connection', { fail: 'connect_failed' }, /could not connect/],
  ]) {
    test(`${name} is "couldn’t check", never "no robots.txt" and never "blocked"`, async () => {
      const { app } = appFor({ files: { 'acme-test.com': file } });
      const res = await run(app, 'acme-test.com').expect(200);
      // Only the result: the page's own FAQ talks about "no robots.txt" and what blocking means.
      const result = res.text.slice(
        res.text.indexOf('id="result"'),
        res.text.indexOf('</section>', res.text.indexOf('id="result"')),
      );
      assert.match(result, /Couldn’t check/);
      assert.match(result, words);
      assert.doesNotMatch(result, /no robots\.txt|Problem|Blocked|blocks \d/);
    });
  }

  test('a robots.txt full of markup is shown as text', async () => {
    const { app } = appFor({
      files: {
        'acme-test.com': {
          body: 'User-agent: GPTBot\nDisallow: /<script>alert(1)</script>"><img src=x onerror=alert(2)>\nDisallow: /\n',
        },
      },
    });
    const { text } = await run(app, 'acme-test.com').expect(200);
    assert.doesNotMatch(text, /<script>alert\(1\)|<img src=x/);
  });

  test('the answer carries findings only: no byte of the file beyond the lines it quotes', async () => {
    const secret = 'INTERNAL-NOTE-do-not-publish';
    const body = `# ${secret}\nUser-agent: GPTBot\nDisallow: /\n# ${secret}\n`;
    const { app } = appFor({ files: { 'acme-test.com': { body } } });
    const { text } = await run(app, 'acme-test.com').expect(200);
    assert.doesNotMatch(text, new RegExp(secret), 'comments in the file never come back');
  });

  test('an address that resolves to a private network is refused before any connection', async () => {
    const { app, net } = appFor({
      files: { 'private-host.com': { body: 'User-agent: *\nAllow: /' } },
    });
    const res = await run(app, 'private-host.com').expect(200);
    assert.match(res.text, /Couldn’t check/);
    assert.match(res.text, /only check public websites/);
    assert.doesNotMatch(res.text, /10\.1\.2\.3/);
    assert.equal(net.served.length, 0);
  });

  test('an IP address, a port and a login in the address are refused before anything runs', async () => {
    const { app, net } = appFor();
    for (const url of [
      'http://127.0.0.1',
      'http://169.254.169.254/',
      'https://acme-test.com:6379',
      'https://user:pw@acme-test.com',
      'file:///etc/passwd',
    ]) {
      await run(app, url).expect(422);
    }
    assert.equal(net.served.length, 0);
  });
});

describe('the bot check (17.05)', () => {
  test('the page shows the widget and loads Cloudflare’s script, and the policy allows it', async () => {
    const { app } = appFor();
    const res = await app.get(PATH).expect(200);
    assert.match(res.text, /class="cf-turnstile" data-sitekey="1x00000000000000000000AA"/);
    assert.match(
      res.text,
      /<script src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async defer>/,
    );
    assert.match(
      res.headers['content-security-policy'],
      /script-src[^;]*challenges\.cloudflare\.com/,
    );
    assert.match(
      res.headers['content-security-policy'],
      /frame-src[^;]*challenges\.cloudflare\.com/,
    );
  });

  test('the hub does not load the script: only a page with the widget does', async () => {
    const { app } = appFor();
    assert.doesNotMatch(
      (await app.get('/tools').expect(200)).text,
      /challenges\.cloudflare\.com\/turnstile/,
    );
  });

  test('a passing token runs the tool; Cloudflare is asked with the secret, the token and the visitor’s address', async () => {
    const { app, verify } = appFor();
    await run(app, 'acme-test.com', { 'cf-turnstile-response': 'good-token' }).expect(200);
    assert.equal(verify.calls.length, 1);
    assert.equal(verify.calls[0].body.secret, 'secret');
    assert.equal(verify.calls[0].body.response, 'good-token');
    assert.ok(verify.calls[0].body.remoteip);
  });

  test('the token is not handed on to the tool', async () => {
    let seen;
    const { definitions } = await import('../../src/web/tools/index.js').then((m) => ({
      definitions: m.toolDefinitions,
    }));
    const spy = {
      ...definitions[0],
      run: async (ctx, input) => ((seen = input), { headline: 'x', sections: [] }),
    };
    const { app } = appFor({ over: { definitions: [spy] } });
    await run(app, 'acme-test.com').expect(200);
    assert.deepEqual(Object.keys(seen), ['url']);
  });

  for (const [name, answer, status, words] of [
    [
      'Cloudflare says no',
      { success: false, 'error-codes': ['invalid-input-response'] },
      422,
      /couldn’t confirm you’re a person/,
    ],
    ['a token for another site', { success: true, hostname: 'evil.test' }, 422, /reload the page/],
    [
      'Cloudflare’s own trouble',
      { success: false, 'error-codes': ['internal-error'] },
      503,
      /isn’t reachable/,
    ],
    ['an answer that is not the shape', { nope: true }, 503, /isn’t reachable/],
  ]) {
    test(`${name}: ${status}, nothing fetched, nothing counted`, async () => {
      let admitted = 0;
      const { app, net } = appFor({
        verify: siteverify(answer),
        over: { limiter: { admit: async () => (admitted++, { allowed: true }) } },
      });
      const res = await run(app, 'acme-test.com').expect(status);
      assert.match(res.text, words);
      assert.equal(net.served.length, 0);
      assert.equal(admitted, 0);
      assert.match(
        res.text,
        /class="cf-turnstile"/,
        'a fresh widget, because a token is good for one try',
      );
    });
  }

  test('Cloudflare unreachable (the request itself fails) is a 503, not a pass', async () => {
    const { app, net } = appFor({
      verify: siteverify(() => {
        throw new Error('ENETUNREACH');
      }),
    });
    await run(app, 'acme-test.com').expect(503);
    assert.equal(net.served.length, 0);
  });

  test('no token, or one that is far too long, is refused without asking Cloudflare', async () => {
    const { app, verify } = appFor();
    await app.post(PATH).type('form').send({ url: 'acme-test.com' }).expect(422);
    await run(app, 'acme-test.com', { 'cf-turnstile-response': 'x'.repeat(5000) }).expect(422);
    assert.equal(verify.calls.length, 0);
  });

  test('a typo in the address costs no token: the form is checked before the bot check', async () => {
    const { app, verify } = appFor();
    await run(app, 'not a website').expect(422);
    assert.equal(verify.calls.length, 0);
  });

  test('a server with no Turnstile secret keeps the checker closed, and says so without detail', async () => {
    const { app, net } = appFor({ over: { turnstile: null } });
    const res = await run(app, 'acme-test.com').expect(503);
    assert.match(res.text, /opens soon/);
    assert.equal(net.served.length, 0);
  });
});
