import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { homeFaq } from '../../src/web/content/faq.js';
import { publicPages } from '../../src/web/pages.js';
import { appFor, BASE, canonicalOf, envs, metaOf, titleOf } from './helpers.js';

const app = appFor(envs.production);

describe('every public page', () => {
  const titles = new Set();
  const descriptions = new Set();

  for (const page of publicPages) {
    test(`${page.path} returns 200 with a unique title, a description and a canonical URL`, async () => {
      const res = await app.get(page.path).expect(200).expect('Content-Type', /html/);
      const title = titleOf(res.text);
      const description = metaOf(res.text, 'description');

      assert.ok(title && title.length > 10, 'has a title');
      assert.ok(title.length <= 70, `title is ${title.length} chars; keep it under 70`);
      assert.ok(description && description.length >= 50, 'has a meta description');
      assert.ok(
        description.length <= 170,
        `description is ${description.length} chars; keep it under 170`,
      );
      assert.equal(canonicalOf(res.text), `${BASE}${page.path === '/' ? '/' : page.path}`);
      assert.equal(res.text.match(/<h1[\s>]/g)?.length, 1, 'exactly one <h1>');
      assert.match(res.text, /<html lang="en">/);

      assert.ok(!titles.has(title), `duplicate title: ${title}`);
      assert.ok(!descriptions.has(description), `duplicate description: ${description}`);
      titles.add(title);
      descriptions.add(description);
    });

    test(`${page.path} has Open Graph tags and valid JSON-LD`, async () => {
      const res = await app.get(page.path).expect(200);
      assert.match(res.text, /<meta property="og:title"/);
      assert.match(res.text, new RegExp(`<meta property="og:image" content="${BASE}/img/og.png"`));
      const blocks = [
        ...res.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
      ];
      assert.ok(blocks.length >= 2, 'Organization and WebSite at least');
      for (const [, json] of blocks) assert.doesNotThrow(() => JSON.parse(json));
    });
  }
});

describe('raw HTML (no JavaScript run) carries the real content', () => {
  test('home: headline, audit form, how-it-works, honesty section and FAQ', async () => {
    const { text } = await app.get('/').expect(200);
    assert.match(text, /<h1[^>]*>Is AI sending your customers to your competitors\?<\/h1>/);
    assert.match(text, /<form method="post" action="\/audit"/);
    assert.match(text, /<input[^>]*name="url"/);
    assert.match(text, /<button[^>]*type="submit"[^>]*>[^<]*Run my free audit/);
    for (const heading of ['Measure', 'Diagnose', 'Fix', 'Prove'])
      assert.match(text, new RegExp(`${heading}</h3>`));
    assert.match(text, /ChatGPT/);
    assert.match(text, /Google AI Overviews/);
    for (const item of homeFaq)
      assert.ok(text.includes(item.q.replace(/’/g, '&#39;')) || text.includes(item.q), item.q);
  });

  test('home: the example report is labelled illustrative', async () => {
    const { text } = await app.get('/').expect(200);
    assert.match(text, /Illustrative — not real data/);
    assert.match(text, /data-state="unknown"/, 'the example shows a "Couldn’t check" cell');
  });

  test('home: FAQPage JSON-LD matches the visible FAQ', async () => {
    const { text } = await app.get('/').expect(200);
    const blocks = [
      ...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
    ].map((m) => JSON.parse(m[1]));
    const faq = blocks.find((b) => b['@type'] === 'FAQPage');
    assert.ok(faq);
    assert.deepEqual(
      faq.mainEntity.map((q) => q.name),
      homeFaq.map((i) => i.q),
    );
  });

  test('methodology: sections, formula inputs and the statistics rule', async () => {
    const { text } = await app.get('/methodology').expect(200);
    for (const heading of [
      'Principles',
      'Engines and how we collect answers',
      'Sampling and statistics',
      'Reading the answers',
      'What we measure',
      'The AI Visibility Score',
      'The AEO Readiness checklist',
      'What we will not do',
    ]) {
      assert.ok(text.includes(heading), heading);
    }
    assert.match(text, /0\.6 × Readiness \+ 0\.4 × Visibility/);
    assert.match(text, /p &lt; 0\.05/);
    assert.match(text, /at least 5 percentage points/);
    assert.match(text, /never counted as “not mentioned”/);
  });

  test('terms and privacy are served, flagged as drafts, and list subprocessors', async () => {
    const terms = await app.get('/terms').expect(200);
    assert.match(terms.text, /<h1[^>]*>Terms of Service<\/h1>/);
    assert.match(terms.text, /Draft — not yet reviewed by a lawyer/);
    const privacy = await app.get('/privacy').expect(200);
    assert.match(privacy.text, /<h1[^>]*>Privacy Policy<\/h1>/);
    assert.match(privacy.text, /id="subprocessors"/);
    for (const vendor of ['Anthropic', 'DigitalOcean', 'Clerk', 'Stripe', 'Resend', 'PostHog'])
      assert.ok(privacy.text.includes(vendor), vendor);
  });
});

describe('page chrome', () => {
  test('the home page has the audit form once; other pages get the audit call-to-action band', async () => {
    const home = (await app.get('/')).text;
    assert.equal(home.match(/<form method="post" action="\/audit"/g).length, 1);
    const method = (await app.get('/methodology')).text;
    assert.equal(method.match(/<form method="post" action="\/audit"/g).length, 1);
    assert.match(method, /See what AI says about your brand/);
  });

  test('form fields keep unique ids on a page (the band and the hero never collide)', async () => {
    for (const page of publicPages) {
      const { text } = await app.get(page.path);
      const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      assert.deepEqual(dupes, [], `${page.path} has duplicate ids`);
    }
  });

  test('header, footer and the skip link are present', async () => {
    const { text } = await app.get('/privacy').expect(200);
    assert.match(text, /class="skip-link" href="#main"/);
    assert.match(text, /<main id="main"/);
    assert.match(text, /href="\/terms"/);
    assert.match(text, /href="\/privacy"/);
  });
});

describe('CSP safety: nothing in the HTML needs unsafe-inline', () => {
  const pagesToCheck = [...publicPages.map((p) => p.path), '/this-does-not-exist'];
  for (const path of pagesToCheck) {
    test(`${path} has no inline scripts, handlers or style attributes`, async () => {
      const { text } = await app.get(path);
      assert.doesNotMatch(text, /\sstyle=/i, 'style attribute');
      assert.doesNotMatch(text, /\son[a-z]+\s*=/i, 'inline event handler');
      assert.doesNotMatch(text, /href="javascript:/i);
      const inline = [...text.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].filter(
        (m) => !/application\/ld\+json/.test(m[1]),
      );
      assert.equal(inline.length, 0, 'inline <script> blocks');
    });
  }
});
