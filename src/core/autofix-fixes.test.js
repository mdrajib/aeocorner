import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { evaluateRobots, parseRobots } from '../crawler/robots.js';
import { ANSWER_BOTS } from './ai-crawlers.js';
import {
  addressKey,
  buildFix,
  buildMetaFix,
  buildPageSchemaFix,
  buildRobotsFix,
  isRobotsLines,
  mergedPageDocument,
  mergeRobotsLines,
  nodesOfDocument,
  pluginAtLeast,
  payloadOf,
  payloadProblems,
  touchedBy,
} from './autofix-fixes.js';
import { fingerprint } from './autofix.js';
import { validateJsonLd } from './jsonld.js';

const brand = { name: 'Data Dental' };
const homeUrl = 'https://datadental.example/';

const c2 = (pages) => ({ pages });
const lacking = (url, pageType, basics = {}) => ({
  url,
  pageType,
  expected: ['x'],
  found: [],
  ok: false,
  onlyAfterJavaScript: false,
  basics: {
    url,
    pageType,
    title: '',
    description: '',
    name: '',
    lead: '',
    published: '',
    modified: '',
    ...basics,
  },
});

describe('page-type schema (C2)', () => {
  test('builds the type that fits each page, from what the page says, and nothing else', () => {
    const r = buildPageSchemaFix({
      brand,
      homeUrl,
      evidence: c2([
        lacking('https://datadental.example/blog/crown-cost', 'article', {
          name: 'How much does a crown cost?',
          lead: 'A crown costs between 800 and 1,500 dollars depending on the material and your dentist.',
          published: '2026-09-01',
          modified: '2026-10-01T09:00:00Z',
        }),
        lacking('https://datadental.example/services/whitening', 'service', {
          name: 'Teeth whitening',
          description: 'In-office whitening in one visit.',
        }),
        lacking('https://datadental.example/about', 'about', { name: 'About Data Dental' }),
        lacking('https://datadental.example/contact', 'contact', { name: 'Contact us' }),
      ]),
    });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(
      r.items.map((i) => i.type),
      ['Article', 'Service', 'AboutPage', 'ContactPage'],
    );
    const article = r.items[0].node;
    assert.equal(article.headline, 'How much does a crown cost?');
    assert.equal(article.datePublished, '2026-09-01');
    assert.ok(!('author' in article), 'no author is made up');
    assert.ok(!('aggregateRating' in article));
    assert.equal(r.items[1].node.provider.name, 'Data Dental');
    for (const i of r.items) {
      assert.equal(
        validateJsonLd({ '@context': 'https://schema.org', '@graph': [i.node] }).ok,
        true,
        i.type,
      );
    }
    assert.equal(r.kind, 'jsonld');
    assert.equal(r.scope, 'pages');
  });

  test('leaves out, and says why, a FAQ, a price page, a page without a headline and another site', () => {
    const r = buildPageSchemaFix({
      brand,
      homeUrl,
      evidence: c2([
        lacking('https://datadental.example/faq', 'faq', { name: 'FAQ' }),
        lacking('https://datadental.example/pricing', 'pricing', { name: 'Pricing' }),
        lacking('https://datadental.example/blog/x', 'article', { name: '' }),
        lacking('https://elsewhere.example/blog/y', 'article', { name: 'Y' }),
        lacking('https://datadental.example/blog/ok', 'article', {
          name: 'Fine',
          published: 'last Tuesday',
        }),
      ]),
    });
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 1);
    assert.ok(
      !('datePublished' in r.items[0].node),
      'a date that is not ISO is left out, not guessed',
    );
    assert.equal(r.notIncluded.length, 4);
    assert.match(r.notIncluded.join(' '), /FAQ/);
    assert.match(r.notIncluded.join(' '), /not on your connected site/);
  });

  test('skips pages that already pass or whose schema appears only after JavaScript; nothing to build is a reason, not an error', () => {
    const passing = { url: 'https://datadental.example/a', pageType: 'article', ok: true };
    const js = {
      ...lacking('https://datadental.example/b', 'article', { name: 'B' }),
      onlyAfterJavaScript: true,
    };
    const r = buildPageSchemaFix({ brand, homeUrl, evidence: c2([passing, js]) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no page we can describe/i);
  });

  test('only ten pages at a time', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      lacking(`https://datadental.example/blog/p${i}`, 'article', { name: `Post ${i}` }),
    );
    const r = buildPageSchemaFix({ brand, homeUrl, evidence: c2(many) });
    assert.equal(r.items.length, 10);
    assert.equal(r.notIncluded.length, 3);
  });
});

const f3page = (url, over = {}) => ({
  url,
  pageType: 'service',
  title: '',
  description: '',
  name: 'Teeth whitening',
  lead: 'Our in-office whitening takes about an hour and lightens teeth several shades in one visit.',
  problems: ['no_title', 'no_description'],
  ...over,
});

describe('titles and descriptions (F3)', () => {
  test('a title from the headline with the brand after it, a description from the first paragraph', () => {
    const r = buildMetaFix({
      brand,
      homeUrl,
      evidence: { pages: [f3page('https://datadental.example/whitening')] },
    });
    assert.equal(r.ok, true);
    const [item] = r.items;
    assert.equal(item.title, 'Teeth whitening | Data Dental');
    assert.ok(item.description.length <= 155 && item.description.length >= 40);
    assert.match(item.description, /whitening takes about an hour/);
  });

  test('only the missing or shared part is proposed; a good title is never replaced', () => {
    const r = buildMetaFix({
      brand,
      homeUrl,
      evidence: {
        pages: [
          f3page('https://datadental.example/a', {
            title: 'Whitening in Austin',
            problems: ['no_description'],
          }),
        ],
      },
    });
    assert.equal(r.items[0].title, null);
    assert.ok(r.items[0].description);
  });

  test('titles stay within 60 characters and end on a whole word', () => {
    const r = buildMetaFix({
      brand,
      homeUrl,
      evidence: {
        pages: [
          f3page('https://datadental.example/a', {
            name: 'The complete and very detailed guide to everything about modern teeth whitening options',
            problems: ['no_title'],
          }),
        ],
      },
    });
    assert.ok(r.items[0].title.length <= 60, r.items[0].title);
    assert.match(r.items[0].title, /…$/);
  });

  test('two pages never get the same proposal, and a page whose headline is its title already is said', () => {
    const r = buildMetaFix({
      brand,
      homeUrl,
      evidence: {
        pages: [
          f3page('https://datadental.example/a', { problems: ['no_title'] }),
          f3page('https://datadental.example/b', { problems: ['no_title'] }),
          f3page('https://datadental.example/c', {
            title: 'Teeth whitening | Data Dental',
            problems: ['duplicate_title'],
          }),
        ],
      },
    });
    assert.equal(r.items.length, 1);
    assert.equal(r.notIncluded.length, 2);
    assert.match(r.notIncluded.join(' '), /another page has the same headline/);
    assert.match(r.notIncluded.join(' '), /already has/);
  });

  test('a page with nothing to build from is left out with the reason', () => {
    const r = buildMetaFix({
      brand,
      homeUrl,
      evidence: { pages: [f3page('https://datadental.example/a', { name: '', lead: '' })] },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no headline/);
  });
});

const robotsEvidence = (bots) => ({ robotsFile: true, bots });

describe('robots.txt (A1)', () => {
  test('allows exactly the crawlers blocked from the whole site, and says what it leaves to the customer', () => {
    const r = buildRobotsFix({
      homeUrl,
      evidence: robotsEvidence([
        { agent: 'OAI-SearchBot', verdict: 'blocked' },
        { agent: 'PerplexityBot', verdict: 'blocked' },
        { agent: 'Googlebot', verdict: 'partly', rule: 'Disallow: /private/' },
        { agent: 'Bingbot', verdict: 'allowed' },
      ]),
    });
    assert.equal(r.ok, true);
    assert.equal(
      r.lines,
      'User-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /',
    );
    assert.equal(r.notIncluded.length, 1);
    assert.match(r.notIncluded[0], /Googlebot is blocked from only part/);
    assert.equal(isRobotsLines(r.lines), true);
  });

  test('the lines really unblock the crawler under our own robots.txt reader, whether * or the crawler blocks it', () => {
    const lines = buildRobotsFix({
      homeUrl,
      evidence: robotsEvidence(ANSWER_BOTS.map((agent) => ({ agent, verdict: 'blocked' }))),
    }).lines;
    for (const original of [
      'User-agent: *\nDisallow: /\n',
      'User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n',
    ]) {
      const before = parseRobots(original);
      const after = parseRobots(`${original}\n${lines}\n`);
      assert.equal(evaluateRobots(before, 'OAI-SearchBot', '/').allowed, false, original);
      assert.equal(evaluateRobots(after, 'OAI-SearchBot', '/').allowed, true, original);
    }
  });

  test('refuses when nothing is blocked from the whole site, with the reason', () => {
    assert.equal(
      buildRobotsFix({
        homeUrl,
        evidence: robotsEvidence([{ agent: 'Bingbot', verdict: 'allowed' }]),
      }).ok,
      false,
    );
    assert.match(
      buildRobotsFix({
        homeUrl,
        evidence: robotsEvidence([{ agent: 'Bingbot', verdict: 'partly' }]),
      }).reason,
      /only from parts/,
    );
    assert.match(
      buildRobotsFix({ homeUrl, evidence: { robotsFile: false } }).reason,
      /no robots\.txt/,
    );
  });

  test('only plain Allow groups are ever accepted as robots lines', () => {
    assert.equal(isRobotsLines('User-agent: GPTBot\nAllow: /'), true);
    for (const bad of [
      'User-agent: *\nAllow: /',
      'User-agent: GPTBot\nDisallow: /',
      'User-agent: GPTBot\nAllow: /\nSitemap: https://x.example/s.xml',
      'User-agent: A\nAllow: /\n\n\nUser-agent: B\nAllow: /',
      '',
      null,
    ])
      assert.equal(isRobotsLines(bad), false, String(bad));
  });
});

describe('the stored data and what the worker checks', () => {
  const built = buildMetaFix({
    brand,
    homeUrl,
    evidence: { pages: [f3page('https://datadental.example/whitening')] },
  });

  test('payloadOf stores only what was shown, with its fingerprint, and the worker finds no problem', () => {
    const payload = payloadOf('readiness.F3', built);
    assert.deepEqual(Object.keys(payload).sort(), ['hash', 'items', 'ruleCode']);
    assert.deepEqual(Object.keys(payload.items[0]).sort(), ['description', 'title', 'url']);
    assert.deepEqual(payloadProblems('meta', payload), []);
  });

  test('a changed value, a wrong hash or another kind is caught', () => {
    const payload = payloadOf('readiness.F3', built);
    payload.items[0].title = 'Something else';
    assert.deepEqual(payloadProblems('meta', payload), ['hash']);
    assert.deepEqual(payloadProblems('post_update', payload), ['kind']);
    assert.deepEqual(payloadProblems('meta', null), ['missing']);
  });

  test('page schema and robots payloads round-trip', () => {
    const schema = buildPageSchemaFix({
      brand,
      homeUrl,
      evidence: c2([lacking('https://datadental.example/about', 'about', { name: 'About' })]),
    });
    assert.deepEqual(payloadProblems('jsonld', payloadOf('readiness.C2', schema)), []);
    const robots = buildRobotsFix({
      homeUrl,
      evidence: robotsEvidence([{ agent: 'OAI-SearchBot', verdict: 'blocked' }]),
    });
    const payload = payloadOf('readiness.A1', robots);
    assert.deepEqual(payloadProblems('robots_txt', payload), []);
    assert.deepEqual(
      payloadProblems('robots_txt', { ...payload, lines: `${payload.lines}\nDisallow: /` }),
      ['hash', 'invalid'],
    );
  });

  test('a home-page graph payload is checked as before', () => {
    const jsonld = {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebSite', name: 'X', url: 'https://x.example/' }],
    };
    const payload = { ruleCode: 'readiness.C4', hash: fingerprint(jsonld), jsonld };
    assert.deepEqual(payloadProblems('jsonld', payload), []);
    assert.deepEqual(payloadProblems('jsonld', { ...payload, hash: 'x' }), ['hash']);
  });
});

describe('what a change touches (decides which one can be undone)', () => {
  test('addresses are compared without the scheme, "www." and a trailing slash', () => {
    assert.equal(addressKey('https://www.Example.com/a/b/'), 'example.com/a/b');
    assert.equal(addressKey('http://example.com/a/b'), 'example.com/a/b');
    assert.equal(addressKey('nonsense'), '');
  });

  test('each kind names its family and its addresses', () => {
    assert.deepEqual(
      touchedBy({ kind: 'jsonld', targetUrl: 'https://x.example/', payload: { jsonld: {} } }),
      { family: 'schema', keys: ['x.example'] },
    );
    assert.deepEqual(
      touchedBy({ kind: 'jsonld', payload: { items: [{ url: 'https://x.example/a' }] } }),
      { family: 'schema', keys: ['x.example/a'] },
    );
    assert.deepEqual(
      touchedBy({ kind: 'meta', payload: { items: [{ url: 'https://x.example/a' }] } }),
      {
        family: 'meta',
        keys: ['x.example/a'],
      },
    );
    assert.deepEqual(touchedBy({ kind: 'robots_txt', payload: {} }), {
      family: 'robots',
      keys: ['robots.txt'],
    });
  });

  test('buildFix chooses the builder from the rule and refuses the rest', () => {
    assert.equal(buildFix({ ruleCode: 'readiness.A4', evidence: {}, brand, homeUrl }).ok, false);
    assert.equal(
      buildFix({ ruleCode: 'readiness.F3', evidence: { pages: [] }, brand, homeUrl }).ok,
      false,
    );
  });
});

describe('what a page already holds, and the plugin version', () => {
  test('a stored document is read as nodes, whether it is one node or a graph', () => {
    assert.deepEqual(nodesOfDocument(null), []);
    assert.deepEqual(
      nodesOfDocument({ '@context': 'https://schema.org', '@type': 'WebPage', name: 'A' }),
      [{ '@type': 'WebPage', name: 'A' }],
    );
    assert.equal(
      nodesOfDocument({ '@context': 'https://schema.org', '@graph': [{ '@type': 'A' }, 5, null] })
        .length,
      1,
    );
  });

  test('our node replaces the same type and keeps every other, so a retry writes the same thing', () => {
    const existing = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Old' },
        { '@type': 'AboutPage', name: 'Older' },
      ],
    };
    const ours = { '@type': 'AboutPage', name: 'About' };
    const once = mergedPageDocument(existing, ours);
    assert.deepEqual(
      once['@graph'].map((n) => [n['@type'], n.name]),
      [
        ['WebPage', 'Old'],
        ['AboutPage', 'About'],
      ],
    );
    assert.deepEqual(mergedPageDocument(once, ours), once);
    assert.deepEqual(mergedPageDocument(null, ours)['@graph'], [ours]);
  });

  test('robots groups saved before and added now: one per crawler, the saved one kept', () => {
    const merged = mergeRobotsLines(
      'User-agent: PerplexityBot\nAllow: /',
      'User-agent: perplexitybot\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /',
    );
    assert.equal(
      merged,
      'User-agent: PerplexityBot\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /',
    );
    assert.equal(isRobotsLines(merged), true);
    assert.equal(mergeRobotsLines(null, null), '');
  });

  test('a plugin version is compared as numbers, and an unknown one is not new enough', () => {
    for (const [version, ok] of [
      ['1.1.0', true],
      ['1.1.3', true],
      ['1.10.0', true],
      ['2.0.0', true],
      ['1.0.9', false],
      ['0.9.9', false],
      [null, false],
      ['dev', false],
    ])
      assert.equal(pluginAtLeast(version, '1.1.0'), ok, String(version));
    assert.equal(
      pluginAtLeast('1.1.0'),
      true,
      'the default is the first version with these routes',
    );
  });
});
