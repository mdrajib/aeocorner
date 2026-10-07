import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import request from 'supertest';
import { evaluateRobots, parseRobots } from '../../src/crawler/robots.js';
import { loadConfig } from '../../src/lib/config.js';
import { createApp } from '../../src/web/app.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The robots.txt generator (Milestone 17, task 17.09) through the real tool: what the page offers, what the file says
 * for each choice, what is refused, and the download. It is a `generate` run, so there is no bot check and no request
 * leaves the server.
 */
const config = loadConfig({ ...envs.production, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' });
const PATH = '/tools/robots-txt-generator';

function appFor(over = {}) {
  const log = { admit: [], verified: [], ran: 0 };
  const tools = {
    limiter: { admit: async (a) => (log.admit.push(a), { allowed: true }) },
    turnstile: { verify: async (a) => (log.verified.push(a), { ok: true }) },
    runner: {
      inFlight: () => 0,
      limits: { inFlight: 4 },
      run: async (tool, input) => {
        log.ran += 1;
        return { status: 'ok', result: await tool({}, input), fetches: 0 };
      },
    },
    ...over,
  };
  return { app: request(createApp({ config, logger: silentLogger, tools })), log };
}
const make = (app, body = {}) =>
  app
    .post(PATH)
    .type('form')
    .send({ answer: 'allow', training: 'allow', other: 'allow', ...body });
const fileOf = (res) => {
  const m = /<textarea[^>]*id="tool-output"[^>]*readonly>([\s\S]*?)<\/textarea>/.exec(res.text);
  return m
    ? m[1]
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
    : null;
};
const allowed = (text, agent, path = '/') => evaluateRobots(parseRobots(text), agent, path).allowed;

describe('the page', () => {
  test('it offers the three groups, the paths and the sitemap, with the answer crawlers’ risk said up front', async () => {
    const { app } = appFor();
    const { text } = await app.get(PATH).expect(200);
    for (const name of ['answer', 'training', 'other'])
      assert.match(text, new RegExp(`<select[^>]*name="${name}"`));
    assert.match(text, /<textarea[^>]*name="disallow"/);
    assert.match(text, /name="sitemap"/);
    assert.match(text, /Blocking them can keep you out of those answers/);
    assert.match(text, /never blocks Googlebot, Bingbot or Applebot/);
    assert.doesNotMatch(text, /class="cf-turnstile"/, 'a generator needs no bot check');
    assert.match(text, /"@type":"FAQPage"/);
  });

  test('the dropdowns start on Allow, so a visitor who changes nothing blocks nothing', async () => {
    const { app } = appFor();
    const { text } = await app.get(PATH);
    assert.equal((text.match(/<option value="allow" selected>/g) ?? []).length, 3);
  });
});

describe('the file', () => {
  test('everything allowed: a file that allows everyone, with no request made and no bot check', async () => {
    const { app, log } = appFor();
    const res = await make(app).expect(200);
    const file = fileOf(res);
    assert.match(file, /User-agent: \*\nAllow: \//);
    assert.match(res.text, /Your robots\.txt allows every crawler/);
    assert.deepEqual(log.verified, []);
    assert.deepEqual(
      log.admit.map((a) => [a.kind, a.domain]),
      [['generate', undefined]],
    );
  });

  test('blocking the training crawlers: they are blocked, the answer crawlers and search engines are not', async () => {
    const { app } = appFor();
    const file = fileOf(await make(app, { training: 'block' }).expect(200));
    assert.equal(allowed(file, 'GPTBot'), false);
    assert.equal(allowed(file, 'ClaudeBot'), false);
    assert.equal(allowed(file, 'OAI-SearchBot'), true);
    assert.equal(allowed(file, 'Googlebot'), true);
  });

  test('blocking the answer crawlers is a warning that says why, and still leaves Google, Bing and Apple alone', async () => {
    const { app } = appFor();
    const res = await make(app, { answer: 'block' }).expect(200);
    const file = fileOf(res);
    assert.equal(allowed(file, 'PerplexityBot'), false);
    assert.equal(allowed(file, 'Googlebot'), true);
    assert.equal(allowed(file, 'Bingbot'), true);
    assert.equal(allowed(file, 'Applebot'), true);
    assert.match(res.text, /keep your pages out of those answers/);
  });

  test('paths and a sitemap: every crawler is kept out of the paths, and the sitemap is the normalized address', async () => {
    const { app } = appFor();
    const file = fileOf(
      await make(app, {
        answer: 'block',
        disallow: '/admin/\n/cart',
        sitemap: 'https://Acme-Test.com/sitemap.xml',
      }).expect(200),
    );
    assert.equal(allowed(file, 'Googlebot', '/admin/x'), false);
    assert.equal(allowed(file, 'Googlebot', '/pricing'), true);
    assert.equal(allowed(file, 'SomeOtherBot', '/cart'), false);
    assert.deepEqual(parseRobots(file).sitemaps, ['https://acme-test.com/sitemap.xml']);
  });

  test('a sitemap typed without https:// is made into a full address', async () => {
    const { app } = appFor();
    const file = fileOf(await make(app, { sitemap: 'acme-test.com/sitemap.xml' }).expect(200));
    assert.deepEqual(parseRobots(file).sitemaps, ['https://acme-test.com/sitemap.xml']);
  });

  test('what was typed comes back escaped, in the form and in the file box', async () => {
    const { app } = appFor();
    const res = await make(app, { disallow: '/<script>alert(1)</script>' }).expect(200);
    assert.doesNotMatch(res.text, /<script>alert\(1\)/);
    assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

describe('what is refused, with a message by the field', () => {
  test('a path of just / is refused because it would block search engines too', async () => {
    const { app, log } = appFor();
    const res = await make(app, { disallow: '/admin/\n/' }).expect(422);
    assert.match(res.text, /Line 2: a path of just \//);
    assert.match(res.text, /aria-invalid="true"/);
    assert.equal(log.admit.length, 0);
  });

  test('a path without a leading slash, with a space, or with text after # is refused', async () => {
    const { app } = appFor();
    for (const bad of ['admin', '/a b', '/a#b', 'https://acme-test.com/x'])
      assert.match(
        (await make(app, { disallow: bad }).expect(422)).text,
        /Line 1: start each path with \//,
        bad,
      );
  });

  test('more than 30 paths, or an over-long box, is refused', async () => {
    const { app } = appFor();
    const thirtyOne = Array.from({ length: 31 }, (_, i) => `/p${i}`).join('\n');
    assert.match((await make(app, { disallow: thirtyOne }).expect(422)).text, /at most 30 paths/);
    assert.match((await make(app, { disallow: 'x'.repeat(10_001) }).expect(422)).text, /too long/);
  });

  test('a sitemap that is not an address is refused, and a choice other than allow or block is refused', async () => {
    const { app } = appFor();
    assert.match(
      (await make(app, { sitemap: 'not an address' }).expect(422)).text,
      /full address of your sitemap/,
    );
    assert.match((await make(app, { answer: 'maybe' }).expect(422)).text, /Choose allow or block/);
    await make(app, { training: ['allow', 'block'] }).expect(422);
  });
});

describe('the download', () => {
  test('the answer offers it with the same choices, and the file that comes is the one that was shown', async () => {
    const { app } = appFor();
    const body = {
      answer: 'allow',
      training: 'block',
      other: 'allow',
      disallow: '/admin/',
      sitemap: 'acme-test.com/sitemap.xml',
    };
    const shown = await make(app, body).expect(200);
    assert.match(
      shown.text,
      /<form method="post" action="\/tools\/robots-txt-generator\/download">/,
    );
    assert.match(shown.text, /Download robots\.txt/);
    const res = await app.post(`${PATH}/download`).type('form').send(body).expect(200);
    assert.equal(res.text, fileOf(shown));
    assert.equal(res.headers['content-disposition'], 'attachment; filename="robots.txt"');
    assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('a path with markup in it is still only text when downloaded: plain text, never sniffed', async () => {
    const { app } = appFor();
    const res = await app
      .post(`${PATH}/download`)
      .type('form')
      .send({
        answer: 'allow',
        training: 'allow',
        other: 'allow',
        disallow: '/<script>alert(1)</script>',
      })
      .expect(200);
    assert.match(res.headers['content-type'], /^text\/plain/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.text, /Disallow: \/<script>alert\(1\)<\/script>/);
  });

  test('a bad form is the page with the message, not a file', async () => {
    const { app } = appFor();
    const res = await app
      .post(`${PATH}/download`)
      .type('form')
      .send({ answer: 'allow', training: 'allow', other: 'allow', disallow: '/' })
      .expect(422);
    assert.match(res.headers['content-type'], /html/);
  });
});

describe('the limits', () => {
  test('a refusal by the limiter is a refusal, and nothing is made', async () => {
    const { app, log } = appFor({
      limiter: {
        admit: async () => ({ allowed: false, reason: 'ip_minute', retryAfterMs: 20_000 }),
      },
    });
    await make(app).expect(429);
    assert.equal(log.ran, 0);
  });

  test('with Redis down the generator is closed too', async () => {
    const { app } = appFor({
      limiter: {
        admit: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    await make(app).expect(503);
  });
});
