import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import request from 'supertest';
import { validateJsonLd } from '../../src/core/jsonld.js';
import { loadConfig } from '../../src/lib/config.js';
import { createApp } from '../../src/web/app.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The schema markup generator (Milestone 17, task 17.10) through the real tool: what the form offers, what each type
 * writes, what is refused with a message by the field, that nothing is invented, and that no markup comes out of anything
 * that does not validate. A `generate` run: no request leaves the server and there is no bot check.
 */
const config = loadConfig({ ...envs.production, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' });
const PATH = '/tools/schema-markup-generator';

function appFor(over = {}) {
  const log = { admit: [], verified: [] };
  const tools = {
    limiter: { admit: async (a) => (log.admit.push(a), { allowed: true }) },
    turnstile: { verify: async (a) => (log.verified.push(a), { ok: true }) },
    runner: {
      inFlight: () => 0,
      limits: { inFlight: 4 },
      run: async (tool, input) => ({ status: 'ok', result: await tool({}, input), fetches: 0 }),
    },
    ...over,
  };
  return { app: request(createApp({ config, logger: silentLogger, tools })), log };
}
const make = (app, body) => app.post(PATH).type('form').send(body);
const unescape = (s) =>
  s
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
const fileOf = (res) => {
  const m = /<textarea[^>]*id="tool-output"[^>]*readonly>([\s\S]*?)<\/textarea>/.exec(res.text);
  return m ? unescape(m[1]) : null;
};
const docOf = (res) => {
  const file = fileOf(res);
  return file ? JSON.parse(file.replace(/^<script[^>]*>/, '').replace(/<\/script>\s*$/, '')) : null;
};
const resultOf = (res) => {
  const start = res.text.indexOf('id="result"');
  const end = res.text.indexOf('aria-labelledby="cannot-see-heading"');
  return start < 0 ? '' : res.text.slice(start, end > start ? end : undefined);
};

describe('the page', () => {
  test('one form with the type first and the fields in labelled groups, all visible, and no bot check', async () => {
    const { app } = appFor();
    const { text } = await app.get(PATH).expect(200);
    assert.match(text, /<select[^>]*name="type"/);
    for (const legend of [
      'What do you want to mark up?',
      'About the business',
      'Address',
      'Questions and answers',
      'The article',
    ])
      assert.match(text, new RegExp(`<legend[^>]*>${legend}`));
    assert.equal(
      (text.match(/<fieldset/g) ?? []).length,
      (text.match(/<\/fieldset>/g) ?? []).length,
      'every group is closed',
    );
    for (const name of [
      'name',
      'url',
      'logo',
      'sameAs',
      'foundingYear',
      'street',
      'faq',
      'headline',
      'published',
    ])
      assert.match(text, new RegExp(`name="${name}"`));
    assert.doesNotMatch(text, /class="cf-turnstile"/);
    assert.match(text, /It writes only what you type/);
    assert.match(text, /"@type":"FAQPage"/);
  });
});

describe('what each type writes', () => {
  test('Organization: valid markup from what was typed, nothing more, and the same check as the validator', async () => {
    const { app, log } = appFor();
    const res = await make(app, {
      type: 'Organization',
      name: 'Acme Ltd',
      url: 'acme-test.com',
      description: 'We make anvils.',
      sameAs: 'https://www.linkedin.com/company/acme\nfacebook.com/acme',
      foundingYear: '2014',
      street: '1 High St',
      city: 'Leeds',
    }).expect(200);
    const doc = docOf(res);
    assert.deepEqual(doc, {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Acme Ltd',
      url: 'https://acme-test.com/',
      description: 'We make anvils.',
      sameAs: ['https://www.linkedin.com/company/acme', 'https://facebook.com/acme'],
      foundingDate: '2014',
      address: { '@type': 'PostalAddress', streetAddress: '1 High St', addressLocality: 'Leeds' },
    });
    assert.equal(validateJsonLd(doc).ok, true);
    assert.match(resultOf(res), /Your Organization markup is ready, with no errors found/);
    assert.match(
      resultOf(res),
      /Add it above if it applies/,
      'a missing logo is a suggestion, not an error',
    );
    assert.deepEqual(log.verified, []);
    assert.deepEqual(
      log.admit.map((a) => [a.kind, a.domain]),
      [['generate', undefined]],
    );
  });

  test('LocalBusiness, FAQPage and Article each write their own markup', async () => {
    const { app } = appFor();
    const biz = docOf(
      await make(app, {
        type: 'LocalBusiness',
        name: 'Acme Dental',
        telephone: '+44 113 000 0000',
        hours: 'Mo-Fr 09:00-17:00',
        priceRange: '$$',
        city: 'Leeds',
      }).expect(200),
    );
    assert.equal(biz['@type'], 'LocalBusiness');
    assert.equal(biz.openingHours, 'Mo-Fr 09:00-17:00');

    const faq = docOf(
      await make(app, {
        type: 'FAQPage',
        faq: 'How long?\n45 minutes.\n\nQ: Walk-ins?\nA: Yes, until 4pm.',
        url: 'https://acme-test.com/faq',
      }).expect(200),
    );
    assert.equal(faq['@type'], 'FAQPage');
    assert.equal(faq.mainEntity.length, 2);
    assert.equal(faq.mainEntity[1].name, 'Walk-ins?');
    assert.equal(faq.mainEntity[1].acceptedAnswer.text, 'Yes, until 4pm.');

    const article = docOf(
      await make(app, {
        type: 'Article',
        headline: 'How crowns are made',
        author: 'Dr Ana Ruiz',
        published: '2026-10-01',
        modified: '2026-10-05',
        url: 'acme-test.com/crowns',
        publisher: 'Acme Dental',
      }).expect(200),
    );
    assert.equal(article['@type'], 'Article');
    assert.deepEqual(article.author, { '@type': 'Person', name: 'Dr Ana Ruiz' });
    assert.equal(article.datePublished, '2026-10-01');
    assert.equal(article.mainEntityOfPage, 'https://acme-test.com/crowns');
    for (const d of [biz, faq, article]) assert.equal(validateJsonLd(d).ok, true);
  });

  test('nothing is invented: a name alone is a name alone', async () => {
    const { app } = appFor();
    const doc = docOf(await make(app, { type: 'Organization', name: 'Acme' }).expect(200));
    assert.deepEqual(Object.keys(doc), ['@context', '@type', 'name']);
  });

  test('a field for another type is left out and named, and its format is not checked', async () => {
    const { app } = appFor();
    const res = await make(app, {
      type: 'FAQPage',
      faq: 'q?\na one',
      logo: 'not an address',
      name: 'Acme',
    }).expect(200);
    assert.equal(docOf(res).logo, undefined);
    assert.match(resultOf(res), /Left out/);
    assert.match(resultOf(res), /Name, Logo/);
  });

  test('values with & and angle brackets are written as escapes, so nothing can close the script', async () => {
    const { app } = appFor();
    const res = await make(app, { type: 'Organization', name: 'Tom & Jerry <Ltd>' }).expect(200);
    const file = fileOf(res);
    assert.ok(!file.includes('<Ltd>'));
    assert.match(file, /Tom \\u0026 Jerry \\u003cLtd\\u003e/);
    assert.equal(docOf(res).name, 'Tom & Jerry <Ltd>');
  });
});

describe('what is refused, with a message by the field', () => {
  const refuse = async (body, field, words) => {
    const { app, log } = appFor();
    const res = await make(app, body).expect(422);
    assert.match(res.text, words);
    assert.match(res.text, new RegExp(`id="tool-${field}-error"`));
    assert.equal(log.admit.length, 0, 'a mistake costs no check');
    assert.equal(fileOf(res), null, 'and no markup');
  };

  test('the required field of each type', async () => {
    await refuse({ type: 'Organization' }, 'name', /Enter the name of the business/);
    await refuse(
      { type: 'LocalBusiness', url: 'acme-test.com' },
      'name',
      /Enter the name of the business/,
    );
    await refuse({ type: 'FAQPage' }, 'faq', /Add at least one question and its answer/);
    await refuse({ type: 'Article', author: 'A' }, 'headline', /Enter the headline of the article/);
  });

  test('formats: addresses, email, year, dates, and the profile link by its line', async () => {
    await refuse(
      { type: 'Organization', name: 'A', url: 'not an address' },
      'url',
      /full web address/,
    );
    await refuse(
      { type: 'Organization', name: 'A', logo: 'localhost' },
      'logo',
      /full web address/,
    );
    await refuse(
      { type: 'Organization', name: 'A', email: 'nobody' },
      'email',
      /Enter an email address/,
    );
    await refuse(
      { type: 'Organization', name: 'A', foundingYear: '14' },
      'foundingYear',
      /four-digit year/,
    );
    await refuse(
      { type: 'Article', headline: 'H', published: '2026-02-31' },
      'published',
      /Use a date like 2026-10-06/,
    );
    await refuse(
      { type: 'Article', headline: 'H', modified: 'yesterday' },
      'modified',
      /Use a date like/,
    );
    await refuse(
      { type: 'Organization', name: 'A', sameAs: 'https://x.test/a\nnot a link' },
      'sameAs',
      /Line 2:/,
    );
  });

  test('markup in a text field, a pair without an answer, and too much of anything', async () => {
    await refuse(
      { type: 'Organization', name: '</script><script>alert(1)</script>' },
      'name',
      /Remove the markup/,
    );
    await refuse(
      { type: 'FAQPage', faq: 'Only a question' },
      'faq',
      /Pair 1: put the question on the first line/,
    );
    await refuse({ type: 'Organization', name: 'x'.repeat(201) }, 'name', /under 200 characters/);
    await refuse(
      {
        type: 'Organization',
        name: 'A',
        sameAs: Array.from({ length: 11 }, (_, i) => `https://x.test/${i}`).join('\n'),
      },
      'sameAs',
      /at most 10 links/,
    );
  });

  test('a type that is not one of the four, and a repeated field', async () => {
    const { app } = appFor();
    assert.match(
      (await make(app, { type: 'Recipe', name: 'A' }).expect(422)).text,
      /Choose a type of markup/,
    );
    await app.post(PATH).type('form').send('type=Organization&name=A&name=B').expect(422);
  });

  test('what was typed is shown again beside the message, escaped', async () => {
    const { app } = appFor();
    const res = await make(app, { type: 'Organization', name: 'Acme', url: '"><b>x</b>' }).expect(
      422,
    );
    assert.doesNotMatch(res.text, /"><b>x<\/b>/);
    assert.match(res.text, /value="&#34;&gt;&lt;b&gt;x&lt;\/b&gt;"/);
  });
});

describe('the download', () => {
  test('the file that comes is the one that was shown, as plain text', async () => {
    const { app } = appFor();
    const body = {
      type: 'Organization',
      name: 'Acme',
      url: 'acme-test.com',
      sameAs: 'facebook.com/acme',
    };
    const shown = await make(app, body).expect(200);
    assert.match(shown.text, /action="\/tools\/schema-markup-generator\/download"/);
    assert.match(shown.text, /Download structured-data\.html/);
    const res = await app.post(`${PATH}/download`).type('form').send(body).expect(200);
    assert.equal(res.text, fileOf(shown));
    assert.equal(res.headers['content-disposition'], 'attachment; filename="structured-data.html"');
    assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('a form that does not validate is the page with the message, never a file', async () => {
    const { app } = appFor();
    const res = await app
      .post(`${PATH}/download`)
      .type('form')
      .send({ type: 'Organization' })
      .expect(422);
    assert.match(res.headers['content-type'], /html/);
  });
});
