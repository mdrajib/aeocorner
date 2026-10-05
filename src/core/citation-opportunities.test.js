import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildOutreachNote,
  CITATION_LIMITS,
  dominantFormat,
  findUnsupportedInNote,
  ownPageRows,
  rankOpportunities,
  uncitedKeyPages,
  weeklyCitationShare,
  weekStart,
} from './citation-opportunities.js';

const row = (over) => ({
  promptId: '1',
  text: 'best crm for dentists',
  domain: 'g2.com',
  timesCited: 4,
  answersCiting: 4,
  answersWithBrand: 0,
  answersInQuestion: 8,
  pages: [{ url: 'https://g2.com/best-crm', title: 'Best CRM', timesCited: 4, format: 'list' }],
  ...over,
});

describe('ownPageRows', () => {
  test('merges engines per page, most cited first, ties by address', () => {
    const rows = ownPageRows([
      {
        url: 'https://a.com/b',
        title: null,
        engineCode: 'perplexity',
        timesCited: 2,
        answersCiting: 2,
      },
      { url: 'https://a.com/b', title: 'B', engineCode: 'gemini', timesCited: 1, answersCiting: 1 },
      { url: 'https://a.com/a', title: 'A', engineCode: 'gemini', timesCited: 3, answersCiting: 3 },
      { url: 'https://a.com/c', title: 'C', engineCode: 'gemini', timesCited: 3, answersCiting: 3 },
    ]);
    assert.deepEqual(
      rows.map((r) => [r.url, r.timesCited, r.engines, r.title]),
      [
        ['https://a.com/a', 3, ['gemini'], 'A'],
        ['https://a.com/b', 3, ['gemini', 'perplexity'], 'B'],
        ['https://a.com/c', 3, ['gemini'], 'C'],
      ],
    );
  });
});

describe('uncitedKeyPages', () => {
  const keyPages = [
    { url: 'https://acme.com/' },
    { url: 'https://acme.com/pricing' },
    { url: 'https://www.acme.com/guide/?utm=x' },
    { url: 'https://acme.com/about' },
  ];
  const cited = [{ url: 'https://acme.com/pricing/', timesCited: 3 }];

  test('names the key pages no engine cited, never the home page', () => {
    const out = uncitedKeyPages({
      keyPages,
      cited,
      ownCitations: 12,
      homeUrl: 'https://acme.com/',
    });
    assert.deepEqual(
      out.map((p) => p.url),
      ['https://www.acme.com/guide/?utm=x', 'https://acme.com/about'],
    );
  });

  test('says nothing when the site was hardly cited at all: "never" would mean nothing', () => {
    assert.deepEqual(
      uncitedKeyPages({ keyPages, cited: [], ownCitations: CITATION_LIMITS.minOwnCitations - 1 }),
      [],
    );
  });
});

describe('dominantFormat', () => {
  test('the most cited format wins; "other" only when nothing else is known; unread pages are ignored', () => {
    assert.equal(
      dominantFormat([
        { format: 'list', timesCited: 2 },
        { format: 'guide', timesCited: 1 },
      ]),
      'list',
    );
    assert.equal(
      dominantFormat([
        { format: 'other', timesCited: 5 },
        { format: 'guide', timesCited: 1 },
      ]),
      'guide',
    );
    assert.equal(dominantFormat([{ format: 'other', timesCited: 5 }]), 'other');
    assert.equal(dominantFormat([{ format: null, timesCited: 5 }]), null);
    assert.equal(dominantFormat([]), null);
  });
});

describe('rankOpportunities', () => {
  const rows = [
    row(),
    row({
      promptId: '2',
      text: 'dental crm pricing',
      timesCited: 2,
      answersCiting: 2,
      answersInQuestion: 4,
    }),
    row({
      promptId: '1',
      domain: 'reddit.com',
      timesCited: 3,
      answersCiting: 3,
      answersWithBrand: 1,
      pages: [{ url: 'https://reddit.com/r/x', title: 'Thread', timesCited: 3, format: 'other' }],
    }),
    row({ domain: 'acme.com', timesCited: 9, answersCiting: 9 }),
    row({ domain: 'sure.com', answersCiting: 5, answersWithBrand: 5 }),
    row({
      domain: 'rival.io',
      timesCited: 3,
      answersCiting: 3,
      pages: [
        {
          url: 'https://rival.io/compare',
          title: 'Us vs them',
          timesCited: 3,
          format: 'comparison',
        },
      ],
    }),
  ];
  const ctx = { ownDomains: ['acme.com'], rivalDomains: ['rival.io'] };

  test('leaves out the brand’s own site and sources that also named the brand', () => {
    const { bySite } = rankOpportunities(rows, ctx);
    assert.ok(!bySite.some((s) => s.domain === 'acme.com' || s.domain === 'sure.com'));
  });

  test('ranks sites by the answers that missed the brand, then by times cited, then by name', () => {
    const { bySite } = rankOpportunities(rows, ctx);
    assert.deepEqual(
      bySite.map((s) => [s.domain, s.answersWithoutBrand]),
      [
        ['g2.com', 6],
        ['rival.io', 3],
        ['reddit.com', 2],
      ],
    );
    assert.deepEqual(rankOpportunities([...rows].reverse(), ctx).bySite, bySite);
  });

  test('each site carries its type, dominant format, questions and pages', () => {
    const g2 = rankOpportunities(rows, ctx).bySite.find((s) => s.domain === 'g2.com');
    assert.equal(g2.type, 'review');
    assert.equal(g2.format, 'list');
    assert.equal(g2.formatLabel, 'List or roundup');
    assert.deepEqual(g2.promptIds, ['1', '2']);
    assert.equal(g2.questions[0].text, 'best crm for dentists');
    assert.equal(g2.pages[0].url, 'https://g2.com/best-crm');
  });

  test('a competitor’s page in a format we write is a content path; a review site is a get-listed path', () => {
    const { bySite } = rankOpportunities(rows, ctx);
    const rival = bySite.find((s) => s.domain === 'rival.io');
    assert.equal(rival.type, 'competitor');
    assert.equal(rival.path, 'content');
    assert.equal(rival.contentFormat, 'comparison');
    const g2 = bySite.find((s) => s.domain === 'g2.com');
    assert.equal(g2.path, 'guidance');
    assert.equal(g2.contentFormat, null);
  });

  test('a site cited in fewer answers than the minimum is not an opportunity, though it shows under its question', () => {
    const thin = [row({ domain: 'tiny.example', timesCited: 1, answersCiting: 1, pages: [] })];
    const out = rankOpportunities(thin, ctx);
    assert.deepEqual(out.bySite, []);
    assert.equal(out.byQuestion[0].sites[0].domain, 'tiny.example');
    assert.equal(out.byQuestion[0].sites[0].format, null);
  });

  test('per question: the share of that question’s answers the site was cited in without the brand', () => {
    const { byQuestion } = rankOpportunities(rows, ctx);
    const first = byQuestion.find((q) => q.promptId === '1');
    assert.equal(first.answers, 8);
    assert.deepEqual(
      first.sites.map((s) => [s.domain, s.answersWithoutBrand, s.share]),
      [
        ['g2.com', 4, 0.5],
        ['rival.io', 3, 0.375],
        ['reddit.com', 2, 0.25],
      ],
    );
    assert.equal(byQuestion[0].promptId, '1');
  });

  test('a question with no readable answers has no share, not 0', () => {
    const { byQuestion } = rankOpportunities([row({ answersInQuestion: 0 })], ctx);
    assert.equal(byQuestion[0].sites[0].share, null);
  });
});

describe('the outreach note', () => {
  const facts = {
    brandName: 'Acme Dental CRM',
    brandDomain: 'acme.com',
    summary: 'Acme makes scheduling software for dental practices',
    site: {
      domain: 'g2.com',
      pages: [
        { url: 'https://g2.com/best-crm', title: 'Best CRM' },
        { url: 'https://g2.com/x' },
        { url: 'https://g2.com/y' },
      ],
      questions: ['best crm for dentists', 'dental crm pricing', 'a third question'],
    },
  };

  test('is built from the facts, names at most two pages and two questions, and says nothing else', () => {
    const note = buildOutreachNote(facts);
    assert.equal(note.subject, 'Could Acme Dental CRM be included on g2.com?');
    assert.match(
      note.body,
      /Acme Dental CRM \(acme\.com\)\. Acme makes scheduling software for dental practices\./,
    );
    assert.match(note.body, /“best crm for dentists” or “dental crm pricing”/);
    assert.match(note.body, /https:\/\/g2\.com\/best-crm/);
    assert.ok(!note.body.includes('a third question'));
    assert.ok(!note.body.includes('https://g2.com/y'));
    assert.deepEqual(findUnsupportedInNote(note, facts), []);
  });

  test('contains no number the facts do not hold, and no promise or result', () => {
    const note = buildOutreachNote({ ...facts, summary: '' });
    // The only digits allowed are inside the site's own name and addresses.
    const text = note.body.replace(/https?:\/\/\S+/g, '').replaceAll('g2.com', '');
    assert.deepEqual(text.match(/\d+/g) ?? [], []);
    assert.doesNotMatch(note.body, /guarantee|rank|traffic|customers/i);
    assert.deepEqual(findUnsupportedInNote(note, { ...facts, summary: '' }), []);
  });

  test('works with no pages and no questions', () => {
    const bare = { ...facts, summary: '', site: { domain: 'g2.com', pages: [], questions: [] } };
    const note = buildOutreachNote(bare);
    assert.match(note.body, /about our field/);
    assert.deepEqual(findUnsupportedInNote(note, bare), []);
  });

  test('the check catches an invented address, quotation or number', () => {
    const note = buildOutreachNote(facts);
    const fake = {
      ...note,
      body: `${note.body}\nSee https://evil.example/x, “we are the best”, 500 clients.`,
    };
    const bad = findUnsupportedInNote(fake, facts);
    assert.ok(
      bad.includes('https://evil.example/x,') ||
        bad.some((b) => b.startsWith('https://evil.example')),
    );
    assert.ok(bad.includes('“we are the best”'));
    assert.ok(bad.includes('500'));
  });
});

describe('weeklyCitationShare', () => {
  test('adds the sums first and divides once; an empty week is a gap, never 0%', () => {
    const out = weeklyCitationShare(
      [
        { date: '2026-09-28', own: 1, total: 4 },
        { date: '2026-10-01', own: 3, total: 4 },
        { date: '2026-10-12', own: 0, total: 5 },
      ],
      { from: '2026-09-28', to: '2026-10-13' },
    );
    assert.deepEqual(out.labels, ['2026-09-28', '2026-10-05', '2026-10-12']);
    assert.deepEqual(out.values, [50, null, 0]);
    assert.equal(out.own, 4);
    assert.equal(out.total, 13);
  });

  test('a week starts on Monday, including a Sunday that belongs to the week before', () => {
    assert.equal(weekStart('2026-10-04'), '2026-09-28');
    assert.equal(weekStart('2026-10-05'), '2026-10-05');
  });

  test('no data at all gives only gaps', () => {
    const out = weeklyCitationShare([], { from: '2026-09-28', to: '2026-10-05' });
    assert.deepEqual(out.values, [null, null]);
  });
});
