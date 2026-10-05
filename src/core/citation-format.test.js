import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractPage } from '../crawler/html.js';
import {
  CONTENT_FORMAT_FOR,
  citableSignals,
  contentFormatFor,
  PAGE_FORMATS,
  readPageFormat,
  summarizeSignals,
} from './citation-format.js';
import { FORMATS } from './evidence-pack.js';

const facts = (over = {}) => ({
  skipped: null,
  title: 'A page',
  headings: [],
  jsonLd: { types: [], nodes: [] },
  links: [],
  dates: {},
  text: '',
  ...over,
});
const h = (level, text) => ({ level, text });

describe('readPageFormat', () => {
  const read = (over, url = 'https://example.com/a') => readPageFormat(facts(over), url).format;

  test('each format from its own signs', () => {
    assert.equal(read({ title: 'HubSpot vs Salesforce for small teams' }), 'comparison');
    assert.equal(read({ title: 'Top 10 CRMs for dentists' }), 'list');
    assert.equal(read({ title: 'The best CRM tools' }), 'list');
    assert.equal(read({ title: 'How to choose a CRM' }), 'guide');
    assert.equal(read({ title: 'Acme CRM review' }), 'review');
    assert.equal(read({ title: 'CRM FAQ' }), 'faq');
    assert.equal(
      read({ title: 'API', jsonLd: { types: ['TechArticle'], nodes: [] } }),
      'documentation',
    );
    assert.equal(read({ title: 'Setup' }, 'https://example.com/docs/setup'), 'documentation');
    assert.equal(read({ title: 'Setup' }, 'https://docs.example.com/setup'), 'documentation');
  });

  test('markup and headings count when the title is silent', () => {
    assert.equal(read({ title: 'Home', jsonLd: { types: ['FAQPage'], nodes: [] } }), 'faq');
    assert.equal(read({ title: 'Home', jsonLd: { types: ['ItemList'], nodes: [] } }), 'list');
    assert.equal(
      read({
        title: 'Tools',
        headings: [h(2, '1. One'), h(2, '2. Two'), h(2, '3. Three'), h(2, '4. Four')],
      }),
      'list',
    );
    assert.equal(
      read({ title: 'Help', headings: [h(2, 'Why?'), h(2, 'How?'), h(2, 'When?'), h(2, 'Who?')] }),
      'faq',
    );
  });

  test('a page that gives no sign is "other"; one we could not read has no format at all', () => {
    assert.equal(read({ title: 'Our story' }), 'other');
    assert.deepEqual(readPageFormat(null, 'https://x.com'), {
      format: null,
      finding: 'unreadable',
      signals: [],
    });
    assert.equal(
      readPageFormat(facts({ skipped: 'too_deeply_nested' }), 'https://x.com').format,
      null,
    );
    assert.equal(readPageFormat(facts({ title: '', headings: [] }), 'https://x.com').format, null);
  });

  test('only formats we write map to a Content Studio format, and every mapping is a real one', () => {
    assert.deepEqual(Object.keys(CONTENT_FORMAT_FOR).sort(), [...PAGE_FORMATS].sort());
    for (const f of Object.values(CONTENT_FORMAT_FOR)) if (f) assert.ok(FORMATS.includes(f));
    assert.equal(contentFormatFor('list'), 'best_of');
    assert.equal(contentFormatFor('review'), null);
    assert.equal(contentFormatFor('nonsense'), null);
  });
});

describe('citableSignals', () => {
  test('counts an author, a date, outside sources and figures from the page', () => {
    const s = citableSignals(
      facts({
        metaAuthor: 'Dr Lee',
        dates: { metaPublished: '2026-01-01' },
        links: [
          { href: 'https://example.com/other' },
          { href: 'https://who.int/x' },
          { href: 'https://who.int/y' },
          { href: 'https://cdc.gov/z' },
        ],
        text: 'Prices rose 12% to $450 last year, up from 8%.',
      }),
      'https://example.com/a',
    );
    assert.deepEqual(s, { author: true, dated: true, sourcesLinked: 2, figures: 3 });
  });

  test('an author in the structured data counts; a bare page has nothing', () => {
    assert.equal(
      citableSignals(
        facts({ jsonLd: { types: ['Article'], nodes: [{ author: { name: 'A B' } }] } }),
        'https://x.com/',
      ).author,
      true,
    );
    assert.deepEqual(citableSignals(facts(), 'https://x.com/'), {
      author: false,
      dated: false,
      sourcesLinked: 0,
      figures: 0,
    });
    assert.equal(citableSignals(facts({ skipped: 'too_deeply_nested' }), 'https://x.com/'), null);
  });

  test('summarizeSignals leaves out unread pages and says how many', () => {
    const s = summarizeSignals([
      { signals: { author: true, dated: true, sourcesLinked: 0, figures: 2 } },
      { signals: { author: false, dated: true, sourcesLinked: 1, figures: 0 } },
      { signals: null },
    ]);
    assert.deepEqual(s, {
      pages: 2,
      unread: 1,
      withAuthor: 1,
      dated: 2,
      withSources: 1,
      withFigures: 1,
    });
  });
});

describe('hostile pages', () => {
  const timed = (fn) => {
    const t = Date.now();
    const out = fn();
    return [out, Date.now() - t];
  };
  const both = (html) => {
    const f = extractPage(html, 'https://evil.example/');
    return [readPageFormat(f, 'https://evil.example/'), citableSignals(f, 'https://evil.example/')];
  };

  test('a page nested 100,000 levels deep is unreadable, quickly', () => {
    const html = `<html><head><title>x</title></head><body>${'<div>'.repeat(100_000)}</body></html>`;
    const [out, ms] = timed(() => both(html));
    assert.equal(out[0].format, null);
    assert.equal(out[1], null);
    assert.ok(ms < 20_000, `${ms} ms`);
  });

  test('a megabyte of one word, and thousands of links and headings, read in linear time', () => {
    const word = 'a'.repeat(1_000_000);
    const links = Array.from(
      { length: 5000 },
      (_, i) => `<a href="https://s${i}.example/">x</a>`,
    ).join('');
    const heads = Array.from({ length: 5000 }, (_, i) => `<h2>${i}. item?</h2>`).join('');
    const html = `<html><head><title>Top 10 things</title></head><body><p>${word}</p>${links}${heads}</body></html>`;
    const [out, ms] = timed(() => both(html));
    assert.equal(out[0].format, 'list');
    assert.ok(out[1].sourcesLinked <= 1500);
    assert.ok(ms < 20_000, `${ms} ms`);
  });

  test('a long title with repeated trigger words does not blow up the patterns', () => {
    const title = 'best '.repeat(50_000);
    const [, ms] = timed(() =>
      readPageFormat(facts({ title }), `https://x.com/${'vs-'.repeat(20_000)}`),
    );
    assert.ok(ms < 20_000, `${ms} ms`);
  });
});
