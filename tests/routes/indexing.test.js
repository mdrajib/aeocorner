import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AI_CRAWLERS } from '../../src/core/ai-crawlers.js';
import { publicPages } from '../../src/web/pages.js';
import { appFor, envs, metaOf } from './helpers.js';

describe('staging and development are never indexed', () => {
  for (const name of ['staging', 'development']) {
    const app = appFor(envs[name]);

    test(`${name}: every page says noindex in the header and in the HTML`, async () => {
      for (const page of publicPages) {
        const res = await app.get(page.path).expect(200);
        assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow', page.path);
        assert.equal(metaOf(res.text, 'robots'), 'noindex, nofollow', page.path);
      }
    });

    test(`${name}: static files are noindex too`, async () => {
      const res = await app.get('/img/og.png').expect(200);
      assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    });

    test(`${name}: robots.txt disallows everything and there is no sitemap`, async () => {
      const robots = await app
        .get('/robots.txt')
        .expect(200)
        .expect('Content-Type', /text\/plain/);
      assert.equal(robots.text, 'User-agent: *\nDisallow: /\n');
      await app.get('/sitemap.xml').expect(404);
    });
  }
});

describe('production is indexable', () => {
  const app = appFor(envs.production);

  test('pages carry no X-Robots-Tag and say "index, follow"', async () => {
    for (const page of publicPages) {
      const res = await app.get(page.path).expect(200);
      assert.equal(res.headers['x-robots-tag'], undefined, page.path);
      assert.match(metaOf(res.text, 'robots'), /^index, follow/, page.path);
    }
  });

  test('robots.txt allows every AI crawler by name and points to the sitemap', async () => {
    const { text } = await app.get('/robots.txt').expect(200);
    for (const crawler of AI_CRAWLERS)
      assert.match(text, new RegExp(`^User-agent: ${crawler.agent}$`, 'm'), crawler.agent);
    for (const answerBot of [
      'OAI-SearchBot',
      'ChatGPT-User',
      'PerplexityBot',
      'Claude-SearchBot',
      'Googlebot',
      'Bingbot',
    ]) {
      assert.match(text, new RegExp(`User-agent: ${answerBot}\\n`), answerBot);
    }
    assert.doesNotMatch(text, /^Disallow: \/$/m, 'must not block the whole site');
    assert.match(text, /^Disallow: \/_styleguide$/m);
    assert.match(text, /^Sitemap: https:\/\/aeocorner\.com\/sitemap\.xml$/m);
  });

  test('every AI crawler group allows the site and repeats the Disallow lines', async () => {
    const { text } = await app.get('/robots.txt').expect(200);
    const groups = text.split(/\n\n+/).filter((g) => g.includes('User-agent:'));
    for (const group of groups) {
      assert.match(group, /^Allow: \/$/m);
      assert.match(group, /^Disallow: \/_styleguide$/m);
    }
  });

  test('sitemap.xml lists every public page with absolute production URLs', async () => {
    const res = await app.get('/sitemap.xml').expect(200).expect('Content-Type', /xml/);
    const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(
      locs,
      publicPages.map((p) => `https://aeocorner.com${p.path === '/' ? '/' : p.path}`),
    );
    assert.match(res.text, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    assert.doesNotMatch(res.text, /_styleguide|\/audit/);
  });
});

describe('the styleguide is development-only', () => {
  test('/_styleguide renders in development', async () => {
    const res = await appFor(envs.development).get('/_styleguide').expect(200);
    assert.match(res.text, /Component styleguide/);
    assert.equal(metaOf(res.text, 'robots'), 'noindex, nofollow');
  });

  for (const name of ['production', 'staging']) {
    test(`/_styleguide and its sub-pages are 404 when NODE_ENV=production (${name})`, async () => {
      const app = appFor(envs[name]);
      for (const path of [
        '/_styleguide',
        '/_styleguide/app-shell',
        '/_styleguide/email/verification-code',
        '/_styleguide/error',
      ]) {
        await app.get(path).expect(404);
      }
    });
  }
});

describe('canonical URLs use the configured base URL', () => {
  test('staging canonicals point at staging, production at production', async () => {
    const staging = (await appFor(envs.staging).get('/methodology?utm=x')).text;
    assert.match(staging, /rel="canonical" href="https:\/\/staging\.aeocorner\.com\/methodology"/);
    const prod = (await appFor(envs.production).get('/methodology/?utm=x')).text;
    assert.match(prod, /rel="canonical" href="https:\/\/aeocorner\.com\/methodology"/);
  });
});
