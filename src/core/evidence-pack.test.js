import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvidencePack,
  buildCheckPack,
  formatOfPage,
  formatFromQuestion,
  packUrls,
  FORMATS,
  FORMAT_LABELS,
  SCHEMA_FOR_FORMAT,
  PACK_LIMITS,
} from './evidence-pack.js';

const snap = (engineCode, over = {}) => ({
  engineCode,
  read: true,
  textExcerpt: 'Smile Austin and Bright Dental are popular choices.',
  mentions: [
    { name: 'Smile Austin', kind: 'competitor' },
    { name: 'Bright Dental', kind: 'competitor' },
  ],
  citations: [],
  ...over,
});
const cite = (url, title, domain, over = {}) => ({ url, title, domain, isOwn: false, ...over });

test('formats of cited pages are read from the title and the path', () => {
  assert.equal(
    formatOfPage({
      url: 'https://a.com/blog/best-dentists-in-austin',
      title: 'Best dentists in Austin',
    }),
    'best_of',
  );
  assert.equal(
    formatOfPage({ url: 'https://a.com/x', title: 'Invisalign vs braces: which is better?' }),
    'comparison',
  );
  assert.equal(formatOfPage({ url: 'https://a.com/how-to-floss', title: null }), 'how_to');
  assert.equal(formatOfPage({ url: 'https://a.com/faq', title: 'Dental FAQ' }), 'faq');
  assert.equal(formatOfPage({ url: 'https://a.com/x', title: 'What is a crown?' }), 'glossary');
  assert.equal(
    formatOfPage({ url: 'https://a.com/x', title: 'Crown cost in Austin' }),
    'facts_page',
  );
  assert.equal(formatOfPage({ url: 'https://a.com/', title: 'Home' }), null);
  assert.equal(formatOfPage({ url: 'not a url', title: 'Top 10 dentists' }), 'best_of');
  assert.equal(formatOfPage(), null);
});

test('formats of questions: a plain question falls back to FAQ', () => {
  assert.equal(formatFromQuestion('Who is the best family dentist in Austin?'), 'best_of');
  assert.equal(formatFromQuestion('How do I whiten teeth safely?'), 'how_to');
  assert.equal(formatFromQuestion('Invisalign or braces for adults?'), 'faq');
  assert.equal(formatFromQuestion('How much does a crown cost?'), 'facts_page');
  assert.equal(formatFromQuestion(''), 'faq');
});

test('the pack groups answers by engine, counts what was read and who was named', () => {
  const pack = buildEvidencePack({
    question: 'Who is the best family dentist in Austin?',
    brandName: 'Data Dental',
    brandDomains: ['datadental.com'],
    snapshots: [
      snap('chatgpt'),
      snap('chatgpt', {
        mentions: [
          { name: 'Smile Austin', kind: 'competitor' },
          { name: 'Data Dental', kind: 'brand' },
        ],
      }),
      snap('perplexity', {
        textExcerpt: 'x '.repeat(500),
        citations: [
          cite(
            'https://reviews.com/best-dentists-austin',
            'Best dentists in Austin',
            'reviews.com',
          ),
        ],
      }),
      snap('gemini', { read: false, textExcerpt: 'unread', status: 'failed' }),
    ],
    competitors: [
      { name: 'Smile Austin', k: 5 },
      { name: 'Bright Dental', k: 3 },
    ],
  });
  assert.deepEqual(
    pack.engines.map((e) => [e.engineCode, e.answers, e.readable]),
    [
      ['chatgpt', 2, 2],
      ['gemini', 1, 0],
      ['perplexity', 1, 1],
    ],
  );
  assert.equal(pack.answersRead, 3);
  assert.equal(pack.answersThatNamedBrand, 1);
  assert.deepEqual(pack.engines[0].named[0], { name: 'Smile Austin', count: 2 });
  assert.equal(pack.engines[1].excerpt, null, 'an unread answer is never quoted');
  assert.ok(pack.engines[2].excerpt.length <= PACK_LIMITS.excerpt);
  assert.deepEqual(pack.competitors, [
    { name: 'Smile Austin', k: 5 },
    { name: 'Bright Dental', k: 3 },
  ]);
});

test('sources are counted per address, sorted, own pages marked, and the winning format is chosen', () => {
  const pack = buildEvidencePack({
    question: 'Who is the best family dentist in Austin?',
    brandName: 'Data Dental',
    brandDomains: ['datadental.com'],
    snapshots: [
      snap('chatgpt', {
        citations: [
          cite(
            'https://reviews.com/best-dentists-austin',
            'Best dentists in Austin',
            'reviews.com',
          ),
          cite('https://www.datadental.com/about', 'About us', 'www.datadental.com'),
        ],
      }),
      snap('perplexity', {
        citations: [
          cite('https://reviews.com/best-dentists-austin', null, 'reviews.com'),
          cite('https://forum.com/t/1', 'Dentist recs?', 'forum.com'),
          cite('https://blog.datadental.com/p', null, 'blog.datadental.com'),
        ],
      }),
      snap('gemini', {
        citations: [
          cite('https://x.com/top-10-dentists', 'Top 10 dentists', 'x.com'),
          cite(null, 'broken', null),
        ],
      }),
    ],
  });
  assert.equal(pack.sources[0].url, 'https://reviews.com/best-dentists-austin');
  assert.equal(pack.sources[0].timesCited, 2);
  assert.deepEqual(pack.sources[0].engines, ['chatgpt', 'perplexity']);
  assert.equal(pack.sources.find((s) => s.url.includes('www.datadental')).isOwn, true);
  assert.equal(
    pack.sources.find((s) => s.url.includes('blog.datadental')).isOwn,
    true,
    'a subdomain of the brand is its own',
  );
  assert.equal(pack.sources.find((s) => s.url.includes('forum')).isOwn, false);
  assert.equal(pack.ownPagesCited.length, 2);
  assert.equal(pack.format.recommended, 'best_of');
  assert.match(pack.format.basis, /3 of 6 citations are best-of list pages/);
});

test('with no cited pages the question decides the format; nothing is invented from nothing', () => {
  const pack = buildEvidencePack({
    question: 'How do I whiten my teeth?',
    brandName: 'B',
    snapshots: [],
  });
  assert.equal(pack.format.recommended, 'how_to');
  assert.equal(pack.format.basis, 'the way the question is asked');
  assert.deepEqual([pack.engines, pack.sources, pack.answersRead], [[], [], 0]);
});

test('the pack is capped so it can travel in a prompt', () => {
  const citations = Array.from({ length: 60 }, (_, i) =>
    cite(`https://s${i}.com/p`, `Page ${i}`, `s${i}.com`),
  );
  const pack = buildEvidencePack({
    question: 'q'.repeat(1_000),
    brandName: 'B',
    snapshots: [snap('chatgpt', { citations })],
    competitors: Array.from({ length: 30 }, (_, i) => ({ name: `C${i}`, k: 1 })),
  });
  assert.equal(pack.sources.length, PACK_LIMITS.sources);
  assert.equal(pack.competitors.length, PACK_LIMITS.competitors);
  assert.ok(pack.question.length <= 300);
  assert.ok(JSON.stringify(pack).length < 12_000);
});

test('a check pack carries the evidence as stored and picks a format from the rule', () => {
  const pack = buildCheckPack({
    ruleCode: 'readiness.E4',
    title: 'Add FAQ sections',
    evidence: { type: 'readiness', pages: ['https://a.com/p'], note: 'n'.repeat(900) },
    targetUrls: ['https://a.com/p', 'https://a.com/q'],
    brandName: 'B',
  });
  assert.equal(pack.format.recommended, 'faq');
  assert.equal(pack.question, null);
  assert.ok(pack.evidence.note.length <= 400);
  assert.deepEqual(packUrls(pack), ['https://a.com/p', 'https://a.com/q']);
  assert.equal(
    buildCheckPack({ ruleCode: 'readiness.E3', title: 't', evidence: {}, brandName: 'B' }).format
      .recommended,
    'comparison',
  );
  assert.equal(
    buildCheckPack({ ruleCode: 'readiness.D2', title: 't', evidence: null, brandName: 'B' }).format
      .recommended,
    'other',
  );
});

test('every format has a label and a schema type', () => {
  for (const f of FORMATS) {
    assert.ok(FORMAT_LABELS[f], f);
    assert.ok(SCHEMA_FOR_FORMAT[f], f);
  }
});
