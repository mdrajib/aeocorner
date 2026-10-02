import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import zlib from 'node:zlib';
import { inflateIfGzipped, parseSitemap } from './sitemap.js';

const urlset = (...entries) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>`;

describe('a normal sitemap', () => {
  test('lists URLs with their last-modified date and priority', () => {
    const result = parseSitemap(
      urlset(
        '<url><loc>https://example.com/</loc><lastmod>2026-09-01</lastmod><priority>1.0</priority></url>',
        '<url><loc>https://example.com/about</loc><lastmod>2026-08-15T10:30:00+00:00</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>',
        '<url>\n  <loc>\n    https://example.com/pricing\n  </loc>\n</url>',
      ),
    );
    assert.equal(result.kind, 'urlset');
    assert.deepEqual(
      result.urls.map((u) => [u.loc, u.priority]),
      [
        ['https://example.com/', 1],
        ['https://example.com/about', 0.8],
        ['https://example.com/pricing', null],
      ],
    );
    assert.equal(result.urls[0].lastmod.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(result.urls[1].lastmod.toISOString(), '2026-08-15T10:30:00.000Z');
    assert.equal(result.urls[2].lastmod, null);
  });

  test('XML entities and CDATA in addresses are decoded', () => {
    const result = parseSitemap(
      urlset(
        '<url><loc>https://example.com/shop?a=1&amp;b=2</loc></url>',
        '<url><loc><![CDATA[https://example.com/cdata?x=1&y=2]]></loc></url>',
        '<url><loc>https://example.com/caf&#233;</loc></url>',
        '<url><loc>https://example.com/q&#x3f;z</loc></url>',
      ),
    );
    assert.deepEqual(
      result.urls.map((u) => u.loc),
      [
        'https://example.com/shop?a=1&b=2',
        'https://example.com/cdata?x=1&y=2',
        'https://example.com/café',
        'https://example.com/q?z',
      ],
    );
  });

  test('image and video extensions do not hide or replace the page address', () => {
    const result = parseSitemap(
      urlset(
        '<url><loc>https://example.com/gallery</loc><image:image><image:loc>https://cdn.example.com/a.jpg</image:loc></image:image></url>',
      ),
    );
    assert.deepEqual(
      result.urls.map((u) => u.loc),
      ['https://example.com/gallery'],
    );
  });

  test('entries without a usable address are skipped, not fatal', () => {
    const result = parseSitemap(
      urlset(
        '<url><lastmod>2026-01-01</lastmod></url>',
        '<url><loc>javascript:alert(1)</loc></url>',
        '<url><loc>/relative/path</loc></url>',
        `<url><loc>https://example.com/${'x'.repeat(2100)}</loc></url>`,
        '<url><loc>https://example.com/good</loc><lastmod>not a date</lastmod><priority>7</priority></url>',
      ),
    );
    assert.equal(result.urls.length, 1);
    assert.equal(result.urls[0].lastmod, null);
    assert.equal(result.urls[0].priority, null);
  });

  test('a namespace prefix on the root is tolerated', () => {
    const xml = `<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></sm:urlset>`;
    assert.equal(parseSitemap(xml).urls.length, 1);
  });

  test('a byte-order mark does not matter', () => {
    assert.equal(
      parseSitemap(`\uFEFF${urlset('<url><loc>https://example.com/a</loc></url>')}`).urls.length,
      1,
    );
  });
});

describe('an index of sitemaps', () => {
  test('lists the child sitemaps', () => {
    const result = parseSitemap(
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/post-sitemap.xml</loc><lastmod>2026-09-20</lastmod></sitemap>
        <sitemap><loc>https://example.com/page-sitemap.xml</loc></sitemap>
      </sitemapindex>`,
    );
    assert.equal(result.kind, 'index');
    assert.deepEqual(
      result.sitemaps.map((s) => s.loc),
      ['https://example.com/post-sitemap.xml', 'https://example.com/page-sitemap.xml'],
    );
    assert.equal(result.urls.length, 0);
  });
});

describe('the plain-text format', () => {
  test('one address per line', () => {
    const result = parseSitemap(
      'https://example.com/a\r\nhttps://example.com/b\n\nnot a url\n  https://example.com/c  ',
    );
    assert.equal(result.kind, 'text');
    assert.equal(result.urls.length, 3);
  });
});

describe('things that are not sitemaps', () => {
  test('an HTML error page is recognised as nothing', () => {
    const result = parseSitemap('<html><body><h1>404 Not Found</h1></body></html>');
    assert.equal(result.kind, 'unknown');
    assert.equal(result.urls.length, 0);
  });

  test('empty and junk input', () => {
    assert.equal(parseSitemap('').kind, 'unknown');
    assert.equal(parseSitemap('just some words').kind, 'unknown');
  });
});

describe('hostile files', () => {
  test('entity-expansion and external-entity tricks do nothing, because nothing is expanded', () => {
    const xml = `<?xml version="1.0"?>
      <!DOCTYPE urlset [ <!ENTITY a "AAAAAAAAAA"> <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"> <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
      <urlset><url><loc>https://example.com/&xxe;/&b;</loc></url><url><loc>https://example.com/ok</loc></url></urlset>`;
    const result = parseSitemap(xml);
    assert.equal(result.urls[1].loc, 'https://example.com/ok');
    assert.ok(!result.urls[0].loc.includes('passwd'));
    assert.ok(result.urls[0].loc.length < 100);
  });

  test('more URLs than we want are cut off and the result says so', () => {
    const many = urlset(
      ...Array.from({ length: 60 }, (_, i) => `<url><loc>https://example.com/${i}</loc></url>`),
    );
    const result = parseSitemap(many, { maxUrls: 50 });
    assert.equal(result.urls.length, 50);
    assert.equal(result.truncated, true);
    assert.equal(parseSitemap(many).truncated, false);
  });

  // The time limits in these "linear time" tests are loose on purpose: a pattern that backtracks takes minutes or
  // hours on these inputs, so a bound of seconds still catches it, and a busy machine (the whole suite runs at once)
  // cannot trip it.
  test('a 5 MB file made of unclosed tags is read in linear time (no pattern that backtracks)', () => {
    const attacks = [
      `<urlset>${'<url><loc>'.repeat(500_000)}https://example.com/`,
      `<urlset>${'<url '.repeat(1_000_000)}`,
      `<urlset>${'<url><loc>https://example.com/a'.repeat(200_000)}`,
      `<urlset><url><loc>${'x'.repeat(5 * 1024 * 1024)}</loc></url></urlset>`,
      `<urlset>${'<!-- '.repeat(1_000_000)}`,
      `<urlset>${'<![CDATA['.repeat(500_000)}`,
    ];
    for (const attack of attacks) {
      const started = Date.now();
      parseSitemap(attack);
      assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
    }
  });

  test('a comment can hide a URL from us the way it hides it from search engines', () => {
    const xml = urlset(
      '<!-- <url><loc>https://example.com/commented-out</loc></url> -->',
      '<url><loc>https://example.com/real</loc></url>',
    );
    assert.deepEqual(
      parseSitemap(xml).urls.map((u) => u.loc),
      ['https://example.com/real'],
    );
  });
});

describe('compressed sitemaps', () => {
  test('a .xml.gz file is inflated', () => {
    const xml = urlset('<url><loc>https://example.com/zipped</loc></url>');
    const text = inflateIfGzipped(zlib.gzipSync(xml), 5 * 1024 * 1024);
    assert.equal(parseSitemap(text).urls[0].loc, 'https://example.com/zipped');
  });

  test('plain bytes pass through', () => {
    assert.equal(inflateIfGzipped(Buffer.from('plain'), 100), 'plain');
  });

  test('a compressed bomb is an error, not an out-of-memory crash', () => {
    const bomb = zlib.gzipSync(Buffer.alloc(100 * 1024 * 1024));
    assert.throws(
      () => inflateIfGzipped(bomb, 5 * 1024 * 1024),
      /larger than|ERR_BUFFER_TOO_LARGE|RangeError/i,
    );
  });
});
