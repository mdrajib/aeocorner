import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { normalizeDomain, normalizeName } from './names.js';
import {
  collectCitations,
  findMentions,
  maskLinks,
  normalizeCitedUrl,
  prepassRecord,
  runPrepass,
  urlsInText,
} from './prepass.js';

/**
 * The deterministic pre-pass on its own, no LLM (BUILD_PLAN Phase 6): which tracked brands an answer names, and
 * which sources it cites.
 */

const acme = {
  id: 1n,
  ref: 'E1',
  kind: 'brand',
  name: 'Acme CRM',
  aliases: ['Acme'],
  domains: ['acme.com'],
  excludes: ['Acme Bricks'],
};
const rival = {
  id: 2n,
  ref: 'E2',
  kind: 'competitor',
  name: 'RivalCRM',
  aliases: [],
  domains: ['rival.io'],
};
const hub = {
  id: 3n,
  ref: 'E3',
  kind: 'competitor',
  name: 'HubSpot',
  aliases: ['HubSpot CRM'],
  domains: ['hubspot.com'],
};
const monday = {
  id: 4n,
  ref: 'E4',
  kind: 'competitor',
  name: 'monday.com',
  aliases: ['Monday'],
  domains: [],
};
const entities = [acme, rival, hub, monday];

const found = (text, list = entities) => findMentions(text, list).map((m) => m.entity.ref);

describe('pre-pass: finding tracked brands', () => {
  test('case-insensitive, whole words only', () => {
    assert.deepEqual(found('We like ACME crm and rivalcrm.'), ['E1', 'E2']);
    assert.deepEqual(found('Acmeville is a town; RivalCRMs are not a thing.'), []);
    assert.deepEqual(found('Try the acme_crm package'), [], 'an underscore joins words');
  });

  test('possessives, markdown and punctuation around the name still count', () => {
    assert.deepEqual(found("Acme's pricing is fair."), ['E1']);
    assert.deepEqual(found('Acme’s pricing is fair.'), ['E1'], 'curly apostrophe');
    assert.deepEqual(found('1. **RivalCRM** – fast'), ['E2']);
    assert.deepEqual(found('(see [HubSpot](https://hubspot.com))'), ['E3']);
  });

  test('a domain written in the text counts as naming the brand', () => {
    const [m] = findMentions('Pricing is on acme.com/pricing.', entities);
    assert.equal(m.entity.ref, 'E1');
    assert.equal(m.via, 'domain');
    assert.deepEqual(found('Visit www.acme.com today'), ['E1']);
    assert.deepEqual(found('notacme.com is unrelated'), []);
  });

  test('a name only inside a link is a citation, not a mention; a domain in a sentence is a mention', () => {
    assert.deepEqual(
      found('Pricing compared. [www.acme.com](https://www.acme.com/pricing?utm_source=x)'),
      [],
    );
    assert.deepEqual(found('See https://hubspot.com/crm and https://rival.io for details.'), []);
    assert.deepEqual(
      found('[Acme pricing](https://acme.com/pricing)'),
      ['E1'],
      'the link text says the name',
    );
    assert.deepEqual(found('For a quote, acme.com lists a free trial.'), ['E1']);
    const text = 'Use RivalCRM. [rival.io](https://rival.io) RivalCRM again.';
    const [m] = findMentions(text, entities);
    assert.equal(m.count, 2, 'only the two names in the prose');
    assert.equal(m.excerpt.includes('[rival.io]'), true, 'excerpts come from the original text');
  });

  test('maskLinks keeps every position', () => {
    const text = 'a https://x.test/p b [www.y.test](https://y.test) c [Words here](https://z.test)';
    const masked = maskLinks(text);
    assert.equal(masked.length, text.length);
    assert.equal(masked.replace(/ +/g, ' '), 'a b [ ]( ) c [Words here]( )');
  });

  test('a "That\'s not us" exclusion removes only the matches it covers', () => {
    assert.deepEqual(found('Acme Bricks makes bricks.'), []);
    const [m] = findMentions('Acme Bricks makes bricks. Acme CRM makes software.', entities);
    assert.equal(m.entity.ref, 'E1');
    assert.equal(m.count, 1);
    assert.equal(m.nameAsWritten, 'Acme CRM');
  });

  test('where two names overlap, the longer one wins', () => {
    const [m] = findMentions('HubSpot CRM is free to start.', entities);
    assert.equal(m.nameAsWritten, 'HubSpot CRM');
    assert.equal(m.count, 1);
  });

  test('names with punctuation of their own: "monday.com" and the bare word', () => {
    assert.deepEqual(found('Teams use monday.com for this.'), ['E4']);
    assert.deepEqual(
      found('See you on Monday.'),
      ['E4'],
      'a common-word alias matches: the LLM cross-check catches it',
    );
  });

  test('order of first appearance, counts, the words as written and an excerpt', () => {
    const text =
      'Top picks:\n\n1. RivalCRM – quick.\n2. Acme CRM – solid. Acme also has an app.\n\nSome teams prefer HubSpot.';
    const ms = findMentions(text, entities);
    assert.deepEqual(
      ms.map((m) => [m.entity.ref, m.count, m.nameAsWritten, m.listItem]),
      [
        ['E2', 1, 'RivalCRM', 1],
        ['E1', 2, 'Acme CRM', 2],
        ['E3', 1, 'HubSpot', null],
      ],
    );
    assert.equal(ms[1].excerpt, '2. Acme CRM – solid. Acme also has an app.');
  });

  test('list items: continuation lines belong to the item above, a new paragraph ends the list', () => {
    const text =
      '1. RivalCRM\n   Fast and cheap.\n   - Works with Acme\n2. HubSpot\n\nLater, Acme CRM came up.';
    const ms = findMentions(text, entities);
    assert.deepEqual(
      ms.map((m) => [m.entity.ref, m.listItem]),
      [
        ['E2', 1],
        ['E1', 1],
        ['E3', 2],
      ],
    );
  });

  test('nothing to find: empty text, no entities, one-letter aliases are ignored', () => {
    assert.deepEqual(found(''), []);
    assert.deepEqual(found(null), []);
    assert.deepEqual(found('Acme CRM', []), []);
    assert.deepEqual(
      found('A is for apple', [{ ...acme, name: 'A', aliases: [], domains: [] }]),
      [],
    );
  });

  test('non-English letters are word characters', () => {
    const e = {
      id: 9n,
      ref: 'E9',
      kind: 'brand',
      name: 'Zahnärzte Plus',
      aliases: ['Plus'],
      domains: [],
    };
    assert.deepEqual(found('Die Zahnärzte Plus Praxis', [e]), ['E9']);
    assert.deepEqual(found('Plusminus', [e]), []);
    assert.deepEqual(found('Ärzte-Plus', [e]), ['E9'], 'a hyphen is a word boundary');
  });
});

describe('pre-pass: citations', () => {
  test('provider sources first in their order, then links from the text that the list lacks', () => {
    const sources = [
      { url: 'https://www.g2.com/x', title: 'G2', position: 2 },
      { url: 'https://acme.com/pricing#:~:text=price', title: 'Acme pricing', position: 1 },
    ];
    const text =
      'See [Acme](https://acme.com/pricing) and https://blog.rival.io/post?utm_source=chatgpt.com.';
    const cs = collectCitations(sources, text, entities);
    assert.deepEqual(
      cs.map((c) => [c.position, c.url, c.domain, c.owner?.ref ?? null, c.origin]),
      [
        [1, 'https://acme.com/pricing', 'acme.com', 'E1', 'provider'],
        [2, 'https://www.g2.com/x', 'g2.com', null, 'provider'],
        [3, 'https://blog.rival.io/post', 'blog.rival.io', 'E2', 'text'],
      ],
    );
  });

  test('normalizeCitedUrl drops fragments and tracking parameters, refuses non-web links', () => {
    assert.equal(
      normalizeCitedUrl('HTTPS://Example.COM:443/a?utm_source=chatgpt.com&id=7#top'),
      'https://example.com/a?id=7',
    );
    assert.equal(normalizeCitedUrl('https://example.com/a?utm_medium=x'), 'https://example.com/a');
    assert.equal(normalizeCitedUrl('javascript:alert(1)'), null);
    assert.equal(normalizeCitedUrl('https://user:pw@example.com/'), null);
    assert.equal(normalizeCitedUrl('not a url'), null);
  });

  test('urlsInText trims trailing punctuation and markdown', () => {
    assert.deepEqual(
      urlsInText('(https://a.test/x), **https://b.test/y**. https://c.test/z?q=1!'),
      ['https://a.test/x', 'https://b.test/y', 'https://c.test/z?q=1'],
    );
  });

  test('a subdomain belongs to its brand; the longest matching domain wins', () => {
    const parent = {
      id: 5n,
      ref: 'E5',
      kind: 'competitor',
      name: 'Google',
      domains: ['google.com'],
    };
    const child = {
      id: 6n,
      ref: 'E6',
      kind: 'competitor',
      name: 'Google Cloud',
      domains: ['cloud.google.com'],
    };
    const cs = collectCitations(
      [
        { url: 'https://cloud.google.com/x', position: 1 },
        { url: 'https://maps.google.com/y', position: 2 },
      ],
      '',
      [parent, child],
    );
    assert.deepEqual(
      cs.map((c) => c.owner.ref),
      ['E6', 'E5'],
    );
  });
});

describe('pre-pass: the whole run and what is stored', () => {
  test('runPrepass + prepassRecord', () => {
    const p = runPrepass(
      {
        text: 'Acme CRM and RivalCRM. Acme again.',
        sources: [{ url: 'https://rival.io', position: 1 }],
      },
      entities,
    );
    assert.deepEqual(prepassRecord(p), {
      v: 'p1',
      found: [
        { entityId: '1', count: 2, via: 'name' },
        { entityId: '2', count: 1, via: 'name' },
      ],
      citations: 1,
    });
  });
});

describe('pre-pass: hostile input stays linear', () => {
  // Deliberately loose bounds (CLAUDE.md): a busy machine must not fail these, a quadratic one must.
  test('a 200,000-character answer made of nothing but near-matches', () => {
    const text = 'acme acmeb '.repeat(18_000);
    const started = performance.now();
    const ms = findMentions(text, entities);
    assert.equal(ms[0].count, 18_000);
    assert.ok(performance.now() - started < 3_000);
  });

  test('thousands of matches inside thousands of exclusions', () => {
    const text = 'Acme Bricks '.repeat(16_000);
    const started = performance.now();
    assert.deepEqual(findMentions(text, entities), []);
    assert.ok(performance.now() - started < 3_000);
  });

  test('a text made of tens of thousands of links', () => {
    const text = '[acme.com](https://acme.com/x) Acme '.repeat(5_000);
    const started = performance.now();
    const [m] = findMentions(text, entities);
    assert.equal(m.count, 5_000, 'the names in the prose, none in the links');
    assert.ok(performance.now() - started < 3_000);
  });

  test('a text of URLs and punctuation', () => {
    const text = `${'https://a.test/'.padEnd(3000, '.')} `.repeat(60) + 'x'.repeat(100_000);
    const started = performance.now();
    assert.equal(urlsInText(text).length, 0, 'over-long links are skipped');
    collectCitations([], text, entities);
    assert.ok(performance.now() - started < 3_000);
  });
});

describe('names', () => {
  test('normalizeName', () => {
    assert.equal(normalizeName('  Acme CRM, Inc.™ '), 'acme crm');
    assert.equal(normalizeName('ACME LLC'), 'acme');
    assert.equal(normalizeName('“Acme”'), 'acme');
    assert.equal(normalizeName('Acme’s'), "acme's");
    assert.equal(normalizeName('---'), '');
    assert.equal(normalizeName(null), '');
  });

  test('normalizeDomain', () => {
    assert.equal(normalizeDomain('https://WWW.Acme.com/x'), 'acme.com');
    assert.equal(normalizeDomain('acme.com.'), 'acme.com');
    assert.equal(normalizeDomain('acme'), null);
    assert.equal(normalizeDomain(''), null);
  });
});
