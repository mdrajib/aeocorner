import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBody } from './content-html.js';
import { buildJsonLd, howToSteps } from './content-schema.js';
import { validateJsonLd } from './jsonld.js';
import { scoreDraft } from './content-qc.js';

const body = (html) => sanitizeBody(html).html;
const faqBody = body(
  '<p>Intro.</p><h2>How long does a crown take?</h2><p>About two hours for same-day crowns.</p><h2>Does it hurt?</h2><p>No, we numb the area first.</p><h2>Our approach</h2><p>We care.</p>',
);
const base = {
  title: 'Dental crowns in Austin',
  metaDescription: 'What to know about crowns.',
  brand: { name: 'Data Dental', domain: 'datadental.com' },
  modifiedAt: '2026-10-04T10:00:00Z',
  publishedAt: null,
  url: null,
};

test('an article is always produced, valid, with the brand as author when there is no persona', () => {
  const r = buildJsonLd({ ...base, bodyHtml: faqBody, schemaType: 'Article' });
  assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors));
  assert.deepEqual(r.types.sort(), ['Article', 'Organization']);
  const article = r.jsonld['@graph'][0];
  assert.equal(article.author['@type'], 'Organization');
  assert.equal(article.publisher.url, 'https://datadental.com');
  assert.equal(article.datePublished, '2026-10-04');
  assert.equal(article.dateModified, '2026-10-04');
  assert.ok(article.wordCount > 10);
  assert.equal(article.mainEntityOfPage, undefined);
  assert.equal(r.downgraded, null);
});

test('a persona is the author; the address and dates are used when known', () => {
  const r = buildJsonLd({
    ...base,
    bodyHtml: faqBody,
    author: { name: 'Dr Ana Ruiz', jobTitle: 'Dentist' },
    publishedAt: '2026-09-01',
    url: 'https://datadental.com/crowns',
  });
  const article = r.jsonld['@graph'][0];
  assert.deepEqual(article.author, { '@type': 'Person', name: 'Dr Ana Ruiz', jobTitle: 'Dentist' });
  assert.equal(article.datePublished, '2026-09-01');
  assert.equal(article.dateModified, '2026-10-04');
  assert.equal(article.url, 'https://datadental.com/crowns');
  assert.equal(r.validation.ok, true);
});

test('a FAQPage is built from the question headings and the paragraph under each, and QC agrees with the page', () => {
  const r = buildJsonLd({ ...base, bodyHtml: faqBody, schemaType: 'FAQPage' });
  const faq = r.jsonld['@graph'][0];
  assert.equal(faq['@type'], 'FAQPage');
  assert.deepEqual(
    faq.mainEntity.map((q) => q.name),
    ['How long does a crown take?', 'Does it hurt?'],
  );
  assert.equal(faq.mainEntity[1].acceptedAnswer.text, 'No, we numb the area first.');
  assert.deepEqual(r.types.sort(), ['Answer', 'Article', 'FAQPage', 'Organization', 'Question']);
  const qc = scoreDraft({ bodyHtml: faqBody, jsonld: r.jsonld });
  assert.equal(qc.checks.find((c) => c.code === 'schema_valid').blocking, false);
});

test('a FAQPage with fewer than two pairs falls back to an article and says so', () => {
  const r = buildJsonLd({
    ...base,
    bodyHtml: body('<h2>Is it safe?</h2><p>Yes.</p><h2>Our story</h2><p>Long.</p>'),
    schemaType: 'FAQPage',
  });
  assert.equal(r.jsonld['@graph'].length, 1);
  assert.equal(r.jsonld['@graph'][0]['@type'], 'Article');
  assert.match(r.downgraded, /fewer than two question-and-answer pairs/);
});

test('a HowTo takes its steps from the first numbered list, else from the sections', () => {
  const listed = body(
    '<h2>Steps</h2><ol><li>Brush the area gently.</li><li>Floss once a day.</li><li>Visit us twice a year.</li></ol>',
  );
  assert.deepEqual(
    howToSteps(listed).map((s) => s.text),
    ['Brush the area gently.', 'Floss once a day.', 'Visit us twice a year.'],
  );
  const r = buildJsonLd({ ...base, bodyHtml: listed, schemaType: 'HowTo' });
  const howto = r.jsonld['@graph'][0];
  assert.equal(howto['@type'], 'HowTo');
  assert.deepEqual(
    howto.step.map((s) => s.position),
    [1, 2, 3],
  );
  assert.equal(r.validation.ok, true, JSON.stringify(r.validation.errors));
  const bySection = howToSteps(faqBody);
  assert.equal(bySection.length, 3);
  assert.equal(bySection[0].name, 'How long does a crown take?');
  const one = buildJsonLd({
    ...base,
    bodyHtml: body('<h2>Only one</h2><p>Step.</p>'),
    schemaType: 'HowTo',
  });
  assert.match(one.downgraded, /fewer than two steps/);
});

test('long titles are cut, and what is produced always validates even for odd input', () => {
  const r = buildJsonLd({
    ...base,
    title: 'T'.repeat(300),
    metaDescription: '',
    bodyHtml: faqBody,
  });
  assert.ok(r.jsonld['@graph'][0].headline.length <= 110);
  assert.equal(r.jsonld['@graph'][0].description, undefined);
  assert.equal(validateJsonLd(r.jsonld).ok, true);
  const noDomain = buildJsonLd({ ...base, brand: { name: 'B' }, bodyHtml: faqBody });
  assert.equal(noDomain.validation.ok, true);
  assert.equal(noDomain.jsonld['@graph'][0].publisher.url, undefined);
});

test('hostile text in the page cannot break out of the markup it ends up in', () => {
  const evil = body(
    '<h2>Is it </script><script>alert(1)</script> safe?</h2><p>No &lt;/script&gt; way.</p><h2>Why?</h2><p>Because.</p>',
  );
  const r = buildJsonLd({ ...base, bodyHtml: evil, schemaType: 'FAQPage' });
  assert.ok(!/<\/script/i.test(JSON.stringify(r.jsonld)), 'no script end tag reaches the markup');
  assert.equal(r.jsonld['@graph'].length, 1, 'the FAQ with the dangerous answer is dropped');
  assert.equal(r.validation.ok, true);
});
