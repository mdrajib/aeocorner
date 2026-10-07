import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectPlatform, extractPage, nestsDeeperThan, readJsonLdBlocks } from './html.js';

const URL_ = 'https://example.com/about';
const page = (head, body) =>
  `<!doctype html><html lang="en"><head>${head}</head><body>${body}</body></html>`;
const facts = (head, body) => extractPage(page(head, body), URL_);

describe('head facts', () => {
  test('title, description, canonical, language, robots', () => {
    const f = facts(
      `<title>  About   Acme | Acme Inc  </title>
       <meta name="description" content=" We build   widgets. ">
       <link rel="canonical" href="/about/">
       <meta name="robots" content="index, follow">`,
      '<p>x</p>',
    );
    assert.equal(f.title, 'About Acme | Acme Inc');
    assert.deepEqual(f.titleSegments, ['About Acme', 'Acme Inc']);
    assert.equal(f.metaDescription, 'We build widgets.');
    assert.equal(f.canonical, 'https://example.com/about/');
    assert.equal(f.lang, 'en');
    assert.equal(f.noindex, false);
  });

  test('noindex is found in the robots meta or the googlebot meta, in any case', () => {
    assert.equal(facts('<meta name="robots" content="NoIndex, follow">', '').noindex, true);
    assert.equal(facts('<meta name="googlebot" content="noindex">', '').noindex, true);
    assert.equal(facts('<meta name="robots" content="none">', '').noindex, true);
    assert.equal(facts('<meta name="robots" content="index,nofollow">', '').noindex, false);
    assert.equal(facts('', '').noindex, false);
  });

  test('title segments split on pipes, dashes and middots', () => {
    assert.deepEqual(facts('<title>Pricing – Acme · Plans</title>', '').titleSegments, [
      'Pricing',
      'Acme',
      'Plans',
    ]);
    assert.deepEqual(facts('<title>Acme</title>', '').titleSegments, ['Acme']);
    assert.deepEqual(facts('<title>Well-known brand</title>', '').titleSegments, [
      'Well-known brand',
    ]);
  });

  test('social and author metadata', () => {
    const f = facts(
      `<meta property="og:site_name" content="Acme"><meta property="og:title" content="About"><meta name="author" content="Jo Writer">`,
      '',
    );
    assert.equal(f.ogSiteName, 'Acme');
    assert.equal(f.ogTitle, 'About');
    assert.equal(f.metaAuthor, 'Jo Writer');
    assert.equal(f.authorSignals.meta, true);
  });
});

describe('structured data (JSON-LD)', () => {
  const ld = (json) => `<script type="application/ld+json">${json}</script>`;

  test('reads types from single objects, arrays and @graph, in any schema.org spelling', () => {
    const f = facts(
      ld(
        JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme' }),
      ) +
        ld(
          JSON.stringify([
            { '@type': 'WebSite' },
            { '@type': ['Product', 'https://schema.org/Thing'] },
          ]),
        ) +
        ld(
          JSON.stringify({
            '@graph': [{ '@type': 'BreadcrumbList' }, { '@id': '#x', name: 'no type' }],
          }),
        ),
      '',
    );
    assert.deepEqual(f.jsonLd.types.sort(), [
      'BreadcrumbList',
      'Organization',
      'Product',
      'Thing',
      'WebSite',
    ]);
    assert.equal(f.jsonLd.blocks, 3);
    assert.equal(f.jsonLd.parseErrors, 0);
    assert.equal(f.jsonLd.nodes.find((n) => n['@type'] === 'Organization').name, 'Acme');
  });

  test('broken JSON is counted, not fatal', () => {
    const f = facts(ld('{"@type": "Organization", name: oops}') + ld('{"@type":"WebSite"}'), '');
    assert.equal(f.jsonLd.blocks, 2);
    assert.equal(f.jsonLd.parseErrors, 1);
    assert.deepEqual(f.jsonLd.types, ['WebSite']);
  });

  test('wrapper comments some plugins add are tolerated', () => {
    assert.deepEqual(facts(ld('<!-- {"@type":"Organization"} -->'), '').jsonLd.types, [
      'Organization',
    ]);
  });

  test('other script types are not JSON-LD', () => {
    assert.equal(
      facts('<script type="application/json">{"@type":"X"}</script><script>var a=1</script>', '')
        .jsonLd.blocks,
      0,
    );
  });

  test('an enormous block is skipped rather than parsed', () => {
    const big = JSON.stringify({ '@type': 'Product', description: 'x'.repeat(300 * 1024) });
    const f = facts(ld(big), '');
    assert.equal(f.jsonLd.oversize, 1);
    assert.deepEqual(f.jsonLd.types, []);
  });
});

describe('text', () => {
  test('script, style and noscript are not text; block elements do not run words together', () => {
    const f = facts(
      '',
      '<script>var secret = 1</script><style>p{color:red}</style><noscript>Enable JS</noscript><div>one</div><div>two</div><p>three<br>four</p><span>five</span><span>six</span>',
    );
    assert.equal(f.text, 'one two three four fivesix');
    assert.equal(f.wordCount, 5);
  });

  test('hidden text is measured separately from visible text', () => {
    const f = facts(
      '',
      `<p>visible words here</p>
       <div hidden>hidden by attribute</div>
       <div aria-hidden="true">hidden for readers</div>
       <div style="display: none">hidden by style</div>
       <details><summary>Question?</summary><p>Answer inside a closed details</p></details>
       <details open><summary>Open</summary><p>Visible answer</p></details>`,
    );
    assert.match(f.text, /visible words here/);
    assert.match(f.text, /Question\?/);
    assert.doesNotMatch(f.text, /hidden by attribute/);
    assert.doesNotMatch(f.text, /closed details/);
    assert.match(f.text, /Visible answer/);
    assert.ok(f.hiddenTextChars > 60);
    assert.ok(f.textChars > f.visibleTextChars);
  });

  test('a page nested 100,000 levels deep is refused quickly instead of tying up the parser for minutes', () => {
    const started = Date.now();
    for (const tag of ['div', 'span', 'b', 'section']) {
      const deep = `<${tag}>`.repeat(100_000) + 'bottom' + `</${tag}>`.repeat(100_000);
      const f = extractPage(page('', deep), URL_);
      assert.equal(f.skipped, 'too_deeply_nested', tag);
      assert.equal(f.wordCount, 0);
    }
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
  });

  test('ordinary deep nesting is fine, and depth is measured by open elements, not by how many there are', () => {
    const nested = '<div>'.repeat(300) + 'bottom' + '</div>'.repeat(300);
    assert.equal(extractPage(page('', nested), URL_).skipped, null);
    assert.match(extractPage(page('', nested), URL_).text, /bottom/);
    assert.equal(nestsDeeperThan('<div>'.repeat(513)), true);
    assert.equal(nestsDeeperThan('<div>'.repeat(512)), false);
    assert.equal(nestsDeeperThan('<div></div>'.repeat(100_000)), false, 'siblings are not nesting');
    // Elements HTML closes for you, void elements and self-closing tags don't add depth.
    assert.equal(nestsDeeperThan('<ul>' + '<li>item'.repeat(5000) + '</ul>'), false);
    assert.equal(
      nestsDeeperThan('<p>para'.repeat(5000) + '<br>'.repeat(5000) + '<img src=x>'.repeat(5000)),
      false,
    );
    assert.equal(nestsDeeperThan('<div/>'.repeat(5000)), false);
    // Markup inside a script or a comment is not markup.
    assert.equal(
      nestsDeeperThan(`<script>${'<div>'.repeat(5000)}</script><!-- ${'<div>'.repeat(5000)} -->`),
      false,
    );
  });

  test('a page full of nesting tricks is read in linear time', () => {
    const attacks = [
      '<div '.repeat(500_000),
      '<div>'.repeat(300_000),
      '<script>'.repeat(200_000),
      '<!--'.repeat(500_000),
      '<p>x'.repeat(200_000),
      '<table>'.repeat(400),
      `<ul>${'<li><ul>'.repeat(400)}`,
    ];
    for (const attack of attacks) {
      const started = Date.now();
      extractPage(page('', attack), URL_);
      assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
    }
  });

  test('statistics, phone numbers and addresses are noticed', () => {
    const f = facts(
      '',
      `<main><p>We grew 45% last year to $2.5 million in sales, 3x faster.</p>
       <p>Call +1 415-555-0132 or (020) 7946 0958.</p>
       <address>1 Main St</address><a href="tel:+14155550132">Call</a></main>`,
    );
    assert.ok(f.statMentions >= 3);
    assert.ok(f.phoneNumbers.length >= 1);
    assert.deepEqual(f.telLinks, ['+14155550132']);
    assert.equal(f.hasAddressElement, true);
  });
});

describe('structure', () => {
  test('headings keep their level and order', () => {
    const f = facts('', '<h1>Title</h1><h2>First</h2><h3>Sub</h3><h2>Second</h2><h4>ignored</h4>');
    assert.deepEqual(
      f.headings.map((h) => [h.level, h.text]),
      [
        [1, 'Title'],
        [2, 'First'],
        [3, 'Sub'],
        [2, 'Second'],
      ],
    );
    assert.equal(f.h1Count, 1);
  });

  test('blocks cover the main content, in order, and leave menus and footers out', () => {
    const f = facts(
      '',
      `<header><nav><ul><li>Home</li><li>About</li></ul></nav></header>
       <main>
         <h2>What is Acme?</h2>
         <p>Acme is a widget maker based in Ohio.</p>
         <ul><li>a</li><li>b</li><li>c</li></ul>
         <table><tr><td>1</td></tr><tr><td>2</td></tr></table>
         <details><summary>Is it safe?</summary><p>Yes.</p></details>
       </main>
       <footer><p>Footer text</p></footer>`,
    );
    assert.deepEqual(
      f.blocks.map((b) => b.type),
      ['h2', 'p', 'list', 'table', 'details', 'p'],
    );
    assert.equal(f.blocks[2].items, 3);
    assert.equal(f.blocks[3].rows, 2);
    assert.equal(f.blocks[1].words, 8);
    assert.ok(!f.blocks.some((b) => /Footer/.test(b.text ?? '')));
  });

  test('without <main>, a #content area or the body stands in', () => {
    const f = facts(
      '',
      '<div id="content"><h2>Hello</h2><p>World</p></div><footer><p>skip</p></footer>',
    );
    assert.deepEqual(
      f.blocks.map((b) => b.text),
      ['Hello', 'World'],
    );
  });
});

describe('links', () => {
  test('resolved against the page, labelled by where they sit, fragments dropped, non-web links skipped', () => {
    const f = facts(
      '',
      `<nav><a href="/pricing">Pricing</a></nav>
       <main><a href="team#bio">Team</a> <a href="https://other.org/x" rel="nofollow">Elsewhere</a>
       <a href="mailto:a@b.c">mail</a> <a href="javascript:void(0)">js</a> <a href="tel:123">call</a></main>
       <footer><a href="https://www.linkedin.com/company/acme">LinkedIn</a></footer>`,
    );
    assert.deepEqual(
      f.links.map((l) => [l.href, l.area]),
      [
        ['https://example.com/pricing', 'nav'],
        ['https://example.com/team', 'body'],
        ['https://other.org/x', 'body'],
        ['https://www.linkedin.com/company/acme', 'footer'],
      ],
    );
    assert.equal(f.links[2].rel, 'nofollow');
  });
});

describe('dates and authorship', () => {
  test('time elements, article meta, schema dates and "last updated" text', () => {
    const f = facts(
      `<meta property="article:modified_time" content="2026-09-01T10:00:00Z">
       <script type="application/ld+json">{"@type":"Article","datePublished":"2026-01-02","dateModified":"2026-08-30","author":{"@type":"Person","name":"Jo"}}</script>`,
      '<main><time datetime="2026-09-01">1 Sep</time><p>Last updated September 1, 2026</p></main>',
    );
    assert.deepEqual(f.dates.timeElements, ['2026-09-01']);
    assert.equal(f.dates.metaModified, '2026-09-01T10:00:00Z');
    assert.equal(f.dates.jsonLdModified, '2026-08-30');
    assert.equal(f.dates.jsonLdPublished, '2026-01-02');
    assert.equal(f.dates.updatedText, true);
    assert.equal(f.authorSignals.schema, true);
  });

  test('a date written in the text after "last updated" is read', () => {
    const dateOf = (text) => facts('', `<main><p>${text}</p></main>`).dates.updatedTextDate;
    assert.equal(dateOf('Last updated September 15, 2026').slice(0, 10), '2026-09-15');
    assert.equal(dateOf('Updated: 2026-03-04').slice(0, 10), '2026-03-04');
    assert.equal(dateOf('Modified on 3rd March 2025').slice(0, 10), '2025-03-03');
    assert.equal(dateOf('Last reviewed Dec 1st, 2025').slice(0, 10), '2025-12-01');
    assert.equal(dateOf('We updated our approach recently'), '');
    assert.equal(dateOf('No date here'), '');
  });

  test('bylines are recognised by class or rel', () => {
    assert.equal(facts('', '<p class="byline">By Jo</p>').authorSignals.byline, true);
    assert.equal(facts('', '<a rel="author" href="/jo">Jo</a>').authorSignals.relAuthor, true);
    assert.equal(facts('', '<p>No byline</p>').authorSignals.byline, false);
  });
});

describe('which platform built the page', () => {
  const cases = [
    [
      'wordpress',
      '<meta name="generator" content="WordPress 6.6"><link href="/wp-content/themes/x/style.css">',
    ],
    ['shopify', '<script src="https://cdn.shopify.com/s/files/x.js"></script>'],
    ['squarespace', '<img src="https://static1.squarespace.com/a.png">'],
    ['webflow', '<html data-wf-site="123">'],
    ['nextjs', '<script id="__NEXT_DATA__" type="application/json">{}</script>'],
    ['client-rendered-app', '<body><div id="root"></div><script src="/app.js"></script>'],
    ['unknown', '<html><body><p>plain</p></body></html>'],
  ];
  for (const [expected, html] of cases) {
    test(`recognises ${expected}`, () => assert.equal(extractPage(html, URL_).platform, expected));
  }
  test('headers can give it away too', () => {
    assert.equal(detectPlatform('<html></html>', { 'x-wix-request-id': 'abc' }), 'wix');
    assert.equal(detectPlatform('<html></html>', { 'x-powered-by': 'Next.js' }), 'nextjs');
    assert.equal(
      extractPage('<html></html>', URL_, { headers: { 'x-wix-request-id': 'abc' } }).platform,
      'wix',
    );
  });
});

describe('hostile and broken pages', () => {
  test('unclosed tags and garbage still produce facts', () => {
    const f = extractPage(
      '<html><head><title>Broken</title><body><div><p>Text<h2>Head<a href=/x>link',
      URL_,
    );
    assert.match(f.text, /Text/);
    assert.ok(f.links.length >= 1);
  });

  test('an empty document', () => {
    const f = extractPage('', URL_);
    assert.equal(f.title, '');
    assert.equal(f.wordCount, 0);
    assert.deepEqual(f.blocks, []);
  });

  test('a page with a hundred thousand links keeps a bounded list', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => `<a href="/p${i}">x</a>`).join('');
    const f = extractPage(page('', many), URL_);
    assert.ok(f.links.length <= 1500);
  });
});

describe('readJsonLdBlocks (the free structured-data tool)', () => {
  const block = (json) => `<script type="application/ld+json">${json}</script>`;

  test('returns every block parsed, in order, and says what was wrong with the others', () => {
    const html = page(
      block('{"@type":"Organization","name":"Acme"}') +
        block('{not json') +
        block('[{"@type":"WebSite"}]'),
      '<p>hi</p>',
    );
    const r = readJsonLdBlocks(html);
    assert.equal(r.blocks, 3);
    assert.deepEqual(
      r.docs.map((d) => d.block),
      [1, 3],
    );
    assert.deepEqual(r.problems, [{ block: 2, problem: 'invalid_json' }]);
    assert.equal(r.tooDeep, false);
  });

  test('a block over the size limit is "too_large", not parsed', () => {
    const big = `{"@type":"Thing","name":"${'x'.repeat(300 * 1024)}"}`;
    const r = readJsonLdBlocks(page(block(big), ''));
    assert.deepEqual(r.problems, [{ block: 1, problem: 'too_large' }]);
    assert.equal(r.docs.length, 0);
  });

  test('a scan does not keep the parsed blocks: stored page facts stay small', () => {
    const f = extractPage(page(block('{"@type":"Organization","name":"Acme"}'), ''), URL_);
    assert.equal(f.jsonLd.docs, undefined);
    assert.equal(f.jsonLd.problems, undefined);
    assert.equal(f.jsonLd.blocks, 1);
  });

  test('a page nested absurdly deep is flagged, not parsed', () => {
    const r = readJsonLdBlocks(`${'<div>'.repeat(5000)}${block('{"@type":"Thing"}')}`);
    assert.equal(r.tooDeep, true);
    assert.equal(r.blocks, 0);
  });

  test('no more than the first 50 blocks are read', () => {
    const r = readJsonLdBlocks(page(Array(80).fill(block('{"@type":"Thing"}')).join(''), ''));
    assert.equal(r.blocks, 50);
  });
});
