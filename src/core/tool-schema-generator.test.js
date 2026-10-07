import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateJsonLd } from './jsonld.js';
import { normalizeFindings } from './tool-findings.js';
import {
  buildSchemaDocument,
  FIELD_LABELS,
  hasMarkup,
  MAX_FAQ_PAIRS,
  parseFaqPairs,
  SCHEMA_TYPES,
  schemaGeneratorFindings,
  TYPE_FIELDS,
} from './tool-schema-generator.js';

const make = (type, fields) => {
  const built = buildSchemaDocument(type, fields);
  return { ...built, ...schemaGeneratorFindings({ type, ...built }) };
};
const rows = (f) => f.sections.flatMap((s) => s.rows);
const row = (f, label) => rows(f).find((r) => r.label === label);

describe('questions and answers from a box of text', () => {
  test('a blank line between pairs, the question first, an optional Q: and A:', () => {
    const { pairs } = parseFaqPairs(
      'Q: How long?\nA: About 45 minutes.\n\nDo you take walk-ins?\nYes, until 4pm.\nCall first.\n',
    );
    assert.deepEqual(pairs, [
      { question: 'How long?', answer: 'About 45 minutes.' },
      { question: 'Do you take walk-ins?', answer: 'Yes, until 4pm. Call first.' },
    ]);
    assert.deepEqual(parseFaqPairs('').pairs, []);
  });

  test('a pair without an answer, an over-long one, markup and too many are refused, with the pair named', () => {
    assert.match(
      parseFaqPairs('Only a question').error,
      /^Pair 1: put the question on the first line/,
    );
    assert.match(parseFaqPairs('Fine?\nYes.\n\nNo answer here').error, /^Pair 2:/);
    assert.match(
      parseFaqPairs(`${'q'.repeat(301)}\nanswer`).error,
      /Pair 1: the question is longer than 300/,
    );
    assert.match(parseFaqPairs(`q?\n${'a'.repeat(2001)}`).error, /the answer is longer than 2,000/);
    assert.match(parseFaqPairs('q?\n</script><script>x()').error, /remove the markup/);
    const many = Array.from({ length: MAX_FAQ_PAIRS + 1 }, (_, i) => `q${i}?\na${i}`).join('\n\n');
    assert.match(parseFaqPairs(many).error, /at most 20 questions/);
  });
});

describe('the document, for each type', () => {
  test('Organization: only what was typed, in the right places', () => {
    const { doc, used, ignored } = buildSchemaDocument('Organization', {
      name: 'Acme',
      url: 'https://acme.test/',
      sameAs: ['https://www.linkedin.com/company/acme'],
      foundingYear: '2014',
      street: '1 High St',
      city: 'Leeds',
    });
    assert.deepEqual(doc, {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Acme',
      url: 'https://acme.test/',
      sameAs: ['https://www.linkedin.com/company/acme'],
      foundingDate: '2014',
      address: { '@type': 'PostalAddress', streetAddress: '1 High St', addressLocality: 'Leeds' },
    });
    assert.deepEqual(used, ['name', 'url', 'sameAs', 'foundingYear', 'street', 'city']);
    assert.deepEqual(ignored, []);
  });

  test('nothing is invented: no field typed means no key, no address, no empty list', () => {
    const { doc } = buildSchemaDocument('Organization', { name: 'Acme' });
    assert.deepEqual(doc, {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Acme',
    });
    const empty = buildSchemaDocument('LocalBusiness', { name: 'Acme', sameAs: [], street: '' });
    assert.deepEqual(Object.keys(empty.doc), ['@context', '@type', 'name']);
  });

  test('LocalBusiness adds hours and a price range, and has no founding year', () => {
    const { doc, ignored } = buildSchemaDocument('LocalBusiness', {
      name: 'Acme Dental',
      hours: 'Mo-Fr 09:00-17:00',
      priceRange: '$$',
      foundingYear: '2014',
    });
    assert.equal(doc.openingHours, 'Mo-Fr 09:00-17:00');
    assert.equal(doc.priceRange, '$$');
    assert.equal(doc.foundingDate, undefined);
    assert.deepEqual(ignored, ['foundingYear']);
  });

  test('FAQPage is a list of questions with accepted answers', () => {
    const { doc } = buildSchemaDocument('FAQPage', {
      faq: [{ question: 'How long?', answer: '45 minutes.' }],
      url: 'https://acme.test/faq',
    });
    assert.equal(doc.mainEntity[0]['@type'], 'Question');
    assert.deepEqual(doc.mainEntity[0].acceptedAnswer, { '@type': 'Answer', text: '45 minutes.' });
    assert.equal(doc.url, 'https://acme.test/faq');
  });

  test('Article: the author is a person and the publisher an organization, only if typed', () => {
    const { doc } = buildSchemaDocument('Article', {
      headline: 'How crowns are made',
      author: 'Dr Ana Ruiz',
      published: '2026-10-01',
      url: 'https://acme.test/crowns',
    });
    assert.deepEqual(doc.author, { '@type': 'Person', name: 'Dr Ana Ruiz' });
    assert.equal(doc.publisher, undefined);
    assert.equal(doc.mainEntityOfPage, 'https://acme.test/crowns');
    assert.equal(doc.dateModified, undefined, 'a date is never filled in from the other');
  });

  test('a field typed for another type is left out and named, and an unknown type is a bug', () => {
    const { doc, ignored } = buildSchemaDocument('FAQPage', {
      faq: [{ question: 'q?', answer: 'a' }],
      logo: 'https://acme.test/l.png',
      name: 'Acme',
    });
    assert.equal(doc.logo, undefined);
    assert.deepEqual(ignored, ['name', 'logo']);
    assert.throws(() => buildSchemaDocument('Recipe', {}), /Unknown schema type/);
  });

  test('every field the types use has a label, and every type is a type the validator writes', () => {
    for (const type of SCHEMA_TYPES) {
      for (const key of TYPE_FIELDS[type])
        assert.ok(FIELD_LABELS[key], `${type}.${key} needs a label`);
    }
    assert.ok(
      Object.keys(FIELD_LABELS).every((k) => SCHEMA_TYPES.some((t) => TYPE_FIELDS[t].includes(k))),
    );
  });
});

describe('the findings and the markup', () => {
  test('a valid document becomes a script block, written out over lines, with suggestions for what is missing', () => {
    const r = make('Organization', { name: 'Acme', url: 'https://acme.test/' });
    assert.equal(r.ok, true);
    const f = normalizeFindings(r.findings);
    assert.match(f.headline, /Your Organization markup is ready, with no errors found/);
    assert.match(
      f.output.text,
      /^<script type="application\/ld\+json">\{\n {2}"@context": "https:\/\/schema\.org"/,
    );
    assert.ok(f.output.text.trimEnd().endsWith('</script>'));
    assert.equal(f.output.filename, 'structured-data.html');
    assert.equal(row(f, 'Checked').state, 'good');
    const suggestions = rows(f)
      .filter((x) => x.state === 'warn')
      .map((x) => x.label);
    assert.deepEqual(suggestions.sort(), ['logo', 'sameAs']);
  });

  test('the markup is the validator’s own: it parses back to the same document and passes', () => {
    const r = make('LocalBusiness', {
      name: 'Acme',
      telephone: '+44 113 000 0000',
      street: '1 High St',
      city: 'Leeds',
      hours: 'Mo-Fr 09:00-17:00',
    });
    const f = normalizeFindings(r.findings);
    const json = f.output.text.replace(/^<script[^>]*>/, '').replace(/<\/script>\s*$/, '');
    assert.deepEqual(JSON.parse(json), r.doc);
    assert.equal(validateJsonLd(JSON.parse(json)).ok, true);
  });

  test('text that could close the script is written as an escape, so no value can break out', () => {
    const r = make('Organization', { name: 'Tom & Jerry <Ltd>' });
    const f = normalizeFindings(r.findings);
    assert.ok(!f.output.text.includes('<Ltd>'));
    assert.match(f.output.text, /Tom \\u0026 Jerry \\u003cLtd\\u003e/);
  });

  test('a document that does not validate gives no markup, only the problems', () => {
    const r = make('Organization', { name: 'Acme', url: 'acme.test' });
    assert.equal(r.ok, false);
    const f = normalizeFindings(r.findings);
    assert.equal(f.output, undefined);
    assert.match(f.headline, /1 problem, so no markup was made/);
    assert.ok(rows(f).some((x) => x.label === 'url' && x.state === 'bad'));
    assert.match(f.notes[0], /never produce markup that does not validate/);
  });

  test('left-out fields are said, and the placement advice follows the type', () => {
    const r = make('FAQPage', {
      faq: [{ question: 'q?', answer: 'a' }],
      logo: 'https://acme.test/l.png',
    });
    const f = normalizeFindings(r.findings);
    assert.match(row(f, 'Left out').detail, /Logo.*a FAQPage does not use/);
    assert.ok(
      f.notes.some((n) => /only put FAQ markup on a page that shows these same questions/i.test(n)),
    );
    const art = normalizeFindings(make('Article', { headline: 'H' }).findings);
    assert.ok(art.notes.some((n) => /article’s own page/.test(n)));
  });

  test('the notes promise nothing about search or AI results', () => {
    const f = normalizeFindings(make('Organization', { name: 'Acme' }).findings);
    assert.ok(
      f.notes.some((n) => /does not promise a search result or a mention in an AI answer/.test(n)),
    );
  });

  test('hasMarkup finds what the validator refuses', () => {
    for (const bad of ['<script>', 'a </script> b', '<!-- x', '<SCRIPT src=x>'])
      assert.equal(hasMarkup(bad), true, bad);
    for (const ok of ['Tom & Jerry', 'a < b', '5 > 3', 'Acme <Ltd>'])
      assert.equal(hasMarkup(ok), false, ok);
  });
});
