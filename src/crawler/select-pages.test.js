import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyPage,
  isExcludedPage,
  MAX_KEY_PAGES,
  normalizePageUrl,
  pickRenderPages,
  sameSite,
  selectPages,
} from './select-pages.js';

const HOME = 'https://www.acme.com/';
const link = (path, text = '', area = 'nav') => ({ href: new URL(path, HOME).href, text, area });
const map = (...paths) => paths.map((p) => ({ loc: new URL(p, HOME).href }));
const urls = (selected) => selected.map((p) => new URL(p.url).pathname);

describe('one spelling per page', () => {
  test('fragments, tracking parameters and trailing slashes go; real parameters stay, sorted', () => {
    assert.equal(
      normalizePageUrl('https://Acme.com/About/?utm_source=x&b=2&a=1#team'),
      'https://acme.com/About?a=1&b=2',
    );
    assert.equal(normalizePageUrl('https://acme.com/?fbclid=abc'), 'https://acme.com/');
    assert.equal(normalizePageUrl('https://acme.com/a//b///c/'), 'https://acme.com/a/b/c');
    assert.equal(normalizePageUrl('https://acme.com/blog/index.html'), 'https://acme.com/blog');
    assert.equal(normalizePageUrl('/pricing', 'https://acme.com/x/y'), 'https://acme.com/pricing');
  });

  test('anything that is not a web page address is rejected', () => {
    for (const bad of [
      'mailto:a@b.c',
      'javascript:void(0)',
      'tel:123',
      'ftp://acme.com/x',
      '',
      'http://',
    ]) {
      assert.equal(normalizePageUrl(bad, 'https://acme.com/'), null, bad);
    }
  });

  test('www and the bare domain are the same site; a subdomain is not', () => {
    assert.equal(sameSite('www.acme.com', 'acme.com'), true);
    assert.equal(sameSite('ACME.com.', 'www.acme.com'), true);
    assert.equal(sameSite('blog.acme.com', 'acme.com'), false);
    assert.equal(sameSite('acme.com', 'acme.org'), false);
  });
});

describe('what is not a page about the business', () => {
  test('files, logins, carts, search, archives, feeds and legal pages are excluded', () => {
    for (const path of [
      '/brochure.pdf',
      '/logo.png',
      '/feed',
      '/wp-json/wp/v2/posts',
      '/login',
      '/cart',
      '/my-account/orders',
      '/search?q=x',
      '/?s=widgets',
      '/tag/news',
      '/category/updates',
      '/blog/page/2',
      '/news/page/10/',
      '/privacy-policy',
      '/terms',
      '/shop?orderby=price',
      '/cdn-cgi/l/email-protection',
      '/post?replytocom=5',
    ]) {
      assert.equal(isExcludedPage(new URL(path, HOME).href), true, path);
    }
  });

  test('ordinary pages are not', () => {
    for (const path of [
      '/about',
      '/pricing',
      '/products/widget',
      '/blog/how-to-choose',
      '/services/seo',
      '/?p=123',
      '/page',
      '/pages/about',
    ]) {
      assert.equal(isExcludedPage(new URL(path, HOME).href), false, path);
    }
  });
});

describe('what kind of page it is', () => {
  const cases = [
    ['/', 'home'],
    ['/about', 'about'],
    ['/about-us/', 'about'],
    ['/company/our-story', 'about'],
    ['/en/about', 'about'],
    ['/pricing', 'pricing'],
    ['/plans', 'pricing'],
    ['/faq', 'faq'],
    ['/help/getting-started', 'faq'],
    ['/contact-us', 'contact'],
    ['/products', 'product'],
    ['/products/widget-pro', 'product'],
    ['/features', 'product'],
    ['/services/web-design', 'service'],
    ['/solutions', 'service'],
    ['/blog/how-to-choose-a-widget', 'article'],
    ['/news/acme-raises-money', 'article'],
    ['/2026/09/our-news', 'article'],
    ['/blog', 'other'],
    ['/careers', 'other'],
    ['/about.html', 'about'],
  ];
  for (const [path, expected] of cases) {
    test(`${path} is ${expected}`, () =>
      assert.equal(classifyPage(new URL(path, HOME).href), expected));
  }

  test('the words of the link can decide when the address cannot', () => {
    assert.equal(classifyPage('https://acme.com/p/17', 'About us'), 'about');
    assert.equal(classifyPage('https://acme.com/p/18', 'Plans & Pricing'), 'pricing');
    assert.equal(classifyPage('https://acme.com/p/19', 'Careers'), 'other');
  });
});

describe('choosing the pages', () => {
  test('the home page is first, and the pages that define the business come before the rest', () => {
    const selected = selectPages({
      home: HOME,
      links: [
        link('/careers', 'Careers'),
        link('/about', 'About'),
        link('/pricing', 'Pricing'),
        link('/products', 'Products'),
      ],
      sitemapUrls: map('/about', '/pricing', '/products', '/blog/post-one', '/careers'),
    });
    assert.equal(selected[0].pageType, 'home');
    assert.equal(selected[0].url, 'https://www.acme.com/');
    const order = urls(selected);
    assert.ok(order.indexOf('/about') < order.indexOf('/careers'));
    assert.ok(order.indexOf('/pricing') < order.indexOf('/careers'));
    assert.deepEqual(
      new Set(order),
      new Set(['/', '/about', '/pricing', '/products', '/careers', '/blog/post-one']),
    );
  });

  test('never more than the limit, even with a huge sitemap', () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `/section-${i}/topic`);
    const selected = selectPages({ home: HOME, sitemapUrls: map(...paths) });
    assert.equal(selected.length, MAX_KEY_PAGES);
  });

  test('a blog with hundreds of posts does not crowd out the business pages', () => {
    const posts = Array.from({ length: 300 }, (_, i) => `/blog/post-${i}`);
    // The business pages are only in the sitemap, listed after 300 posts, and the limit is small.
    const selected = selectPages({
      home: HOME,
      links: [link('/about'), link('/pricing'), link('/services')],
      sitemapUrls: map(...posts, '/about', '/pricing', '/services'),
      limit: 8,
    });
    for (const path of ['/about', '/pricing', '/services'])
      assert.ok(urls(selected).includes(path), path);
    assert.equal(selected.length, 8);
    assert.ok(
      selected.filter((p) => p.pageType === 'article').length <= 4,
      'room is capped at four articles',
    );
  });

  test('when pages are left over, more of the same kind fill the places', () => {
    const posts = Array.from({ length: 40 }, (_, i) => `/blog/post-${i}`);
    const selected = selectPages({
      home: HOME,
      links: [link('/about')],
      sitemapUrls: map(...posts),
    });
    assert.equal(selected.length, MAX_KEY_PAGES);
    const order = urls(selected);
    assert.equal(order[0], '/');
    assert.equal(order[1], '/about', 'the real business page still comes before the extra posts');
  });

  test('recent articles beat old ones', () => {
    const day = 86_400_000;
    const sitemapUrls = [
      { loc: `${HOME}blog/old-1`, lastmod: new Date(Date.now() - 900 * day) },
      { loc: `${HOME}blog/old-2`, lastmod: new Date(Date.now() - 800 * day) },
      { loc: `${HOME}blog/new-1`, lastmod: new Date(Date.now() - 5 * day) },
      { loc: `${HOME}blog/new-2`, lastmod: new Date(Date.now() - 9 * day) },
      { loc: `${HOME}blog/new-3`, lastmod: new Date(Date.now() - 12 * day) },
      { loc: `${HOME}blog/new-4`, lastmod: new Date(Date.now() - 20 * day) },
    ];
    const chosen = urls(selectPages({ home: HOME, sitemapUrls }));
    const position = (name) => chosen.indexOf(`/blog/${name}`);
    for (const fresh of ['new-1', 'new-2', 'new-3', 'new-4']) {
      for (const stale of ['old-1', 'old-2'])
        assert.ok(position(fresh) < position(stale), `${fresh} before ${stale}`);
    }
    // With a smaller limit, the old ones are the ones left out.
    const tight = urls(selectPages({ home: HOME, sitemapUrls, limit: 5 }));
    assert.deepEqual(tight.slice(1).sort(), [
      '/blog/new-1',
      '/blog/new-2',
      '/blog/new-3',
      '/blog/new-4',
    ]);
  });

  test('other sites, other subdomains, and excluded pages never appear', () => {
    const selected = selectPages({
      home: HOME,
      links: [
        { href: 'https://other.com/about', text: 'About', area: 'nav' },
        { href: 'https://blog.acme.com/', text: 'Blog', area: 'nav' },
        link('/login', 'Log in'),
        link('/brochure.pdf', 'Brochure'),
        link('/about', 'About'),
      ],
    });
    assert.deepEqual(urls(selected), ['/', '/about']);
  });

  test('the same page reached by different spellings is one page', () => {
    const selected = selectPages({
      home: HOME,
      links: [link('/about/'), link('/about?utm_source=nav'), link('/about#team')],
      sitemapUrls: map('/about'),
    });
    assert.equal(urls(selected).filter((p) => p === '/about').length, 1);
    assert.equal(selected.length, 2);
  });

  test('links to the home page itself, and the home page reached via www or not, are not duplicates', () => {
    const selected = selectPages({
      home: 'https://acme.com/',
      links: [{ href: 'https://acme.com/', text: 'Home', area: 'nav' }, link('/about')],
    });
    assert.equal(selected.filter((p) => p.pageType === 'home').length, 1);
    assert.equal(selected.length, 2);
  });

  test('the answer does not depend on the order links were found in', () => {
    const links = [
      link('/about'),
      link('/pricing'),
      link('/products'),
      link('/faq'),
      link('/contact'),
      link('/careers'),
    ];
    const a = selectPages({ home: HOME, links });
    const b = selectPages({ home: HOME, links: [...links].reverse() });
    assert.deepEqual(urls(a), urls(b));
  });

  test('a site with no links and no sitemap still yields its home page', () => {
    assert.deepEqual(urls(selectPages({ home: HOME })), ['/']);
  });

  test('a menu link counts for more than a link in the page body', () => {
    const selected = selectPages({
      home: HOME,
      links: [link('/careers', 'Careers', 'nav'), link('/partners', 'Partners', 'body')],
    });
    const order = urls(selected);
    assert.ok(order.indexOf('/careers') < order.indexOf('/partners'));
  });

  test('an unusable home address gives nothing', () => {
    assert.deepEqual(selectPages({ home: 'not a url' }), []);
  });
});

describe('choosing the pages to render in a browser', () => {
  const selected = [
    { url: 'https://acme.com/', pageType: 'home' },
    { url: 'https://acme.com/about', pageType: 'about' },
    { url: 'https://acme.com/team', pageType: 'about' },
    { url: 'https://acme.com/pricing', pageType: 'pricing' },
    { url: 'https://acme.com/products', pageType: 'product' },
    { url: 'https://acme.com/services', pageType: 'service' },
    { url: 'https://acme.com/faq', pageType: 'faq' },
  ];

  test('the home page, then one of each kind', () => {
    assert.deepEqual(pickRenderPages(selected), [
      'https://acme.com/',
      'https://acme.com/about',
      'https://acme.com/pricing',
      'https://acme.com/products',
      'https://acme.com/services',
    ]);
  });

  test('when kinds run out, the best of the rest fills the places', () => {
    const few = [
      { url: 'https://acme.com/', pageType: 'home' },
      { url: 'https://acme.com/a', pageType: 'article' },
      { url: 'https://acme.com/b', pageType: 'article' },
      { url: 'https://acme.com/c', pageType: 'article' },
      { url: 'https://acme.com/d', pageType: 'article' },
      { url: 'https://acme.com/e', pageType: 'article' },
    ];
    assert.deepEqual(
      pickRenderPages(few),
      ['/', '/a', '/b', '/c', '/d'].map((p) => `https://acme.com${p}`),
    );
  });

  test('if there are few pages, all of them', () => {
    assert.equal(pickRenderPages(selected.slice(0, 3)).length, 3);
  });
});
