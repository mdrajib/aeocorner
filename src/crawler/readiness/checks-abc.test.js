import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  context,
  GOOD_ORG,
  goodHome,
  html,
  ld,
  page,
  robots,
  run,
  words,
} from '../../../tests/helpers/readiness.js';

const probe = (agent, blocked, extra = {}) => ({
  agent,
  status: blocked ? 403 : 200,
  blocked,
  vendor: null,
  reason: '',
  ...extra,
});
const status = (code, ctx) => run(code, ctx).status;

describe('A1 answer and search crawlers are allowed', () => {
  test('PASS: no robots.txt means nothing is blocked', () => {
    const r = run('A1', context({ pages: [page({ html: goodHome() })] }));
    assert.equal(r.status, 'pass');
    assert.equal(r.points, 8);
  });

  test('PASS: a robots.txt that blocks only unrelated paths', () => {
    const r = run(
      'A1',
      context({
        robots: robots('User-agent: *\nDisallow: /admin/\n'),
        pages: [page({ html: goodHome() })],
      }),
    );
    assert.equal(r.status, 'pass');
  });

  test('FAIL: Disallow: / for everyone blocks all eight', () => {
    const r = run(
      'A1',
      context({
        robots: robots('User-agent: *\nDisallow: /\n'),
        pages: [page({ html: goodHome() })],
      }),
    );
    assert.equal(r.status, 'fail');
    assert.equal(r.points, 0);
    assert.match(r.summary, /OAI-SearchBot/);
    assert.equal(r.evidence.bots.filter((b) => b.verdict === 'blocked').length, 8);
  });

  test('PARTIAL: one named crawler blocked, and the evidence quotes the rule', () => {
    const r = run(
      'A1',
      context({
        robots: robots('User-agent: PerplexityBot\nDisallow: /\n'),
        pages: [page({ html: goodHome() })],
      }),
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 7);
    const bot = r.evidence.bots.find((b) => b.agent === 'PerplexityBot');
    assert.deepEqual([bot.verdict, bot.rule], ['blocked', 'Disallow: /']);
  });

  test('PARTIAL: a crawler allowed on the home page but shut out of key pages counts as half', () => {
    const pricing = page({ url: 'https://acme.com/pricing', html: goodHome() });
    const r = run(
      'A1',
      context({
        robots: robots('User-agent: Googlebot\nDisallow: /pricing\n'),
        pages: [page({ html: goodHome() }), pricing],
      }),
    );
    const bot = r.evidence.bots.find((b) => b.agent === 'Googlebot');
    assert.equal(bot.verdict, 'partly');
    assert.deepEqual(bot.blockedPaths, ['/pricing']);
    assert.equal(r.points, 7.5);
  });

  test('a crawler named in its own group is not bound by the * group', () => {
    const file =
      'User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nUser-agent: ChatGPT-User\nAllow: /\n';
    const r = run('A1', context({ robots: robots(file), pages: [page({ html: goodHome() })] }));
    assert.equal(r.evidence.bots.find((b) => b.agent === 'OAI-SearchBot').verdict, 'allowed');
    assert.equal(r.evidence.bots.find((b) => b.agent === 'Bingbot').verdict, 'blocked');
  });

  test('ERROR, not fail: a robots.txt we could not fetch is unknown', () => {
    assert.equal(status('A1', context({ robots: robots('unreachable') })), 'error');
  });
});

describe('A2 training-crawler policy', () => {
  test('PASS: the file names a training crawler, whichever way it goes', () => {
    const r = run('A2', context({ robots: robots('User-agent: GPTBot\nDisallow: /\n') }));
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.informational, true);
  });

  test('PARTIAL: a robots.txt that does not mention any', () => {
    const r = run('A2', context({ robots: robots('User-agent: *\nDisallow: /admin\n') }));
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 1);
  });

  test('FAIL: no robots.txt, so no stated policy', () => {
    assert.equal(status('A2', context()), 'fail');
  });

  test('ERROR: unreachable robots.txt', () => {
    assert.equal(status('A2', context({ robots: robots('unreachable') })), 'error');
  });
});

describe('A3 no firewall block for AI crawlers', () => {
  const clean = {
    control: probe('AEOCornerBot', false),
    bots: ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot'].map((a) =>
      probe(a, false),
    ),
  };

  test('PASS: every crawler look-alike gets the page', () => {
    assert.equal(status('A3', context({ botProbes: clean })), 'pass');
  });

  test('PARTIAL: a firewall turns away some, and the summary names it', () => {
    const probes = {
      control: probe('AEOCornerBot', false),
      bots: [
        probe('OAI-SearchBot', true, { vendor: 'Cloudflare' }),
        probe('ChatGPT-User', true, { vendor: 'Cloudflare' }),
        probe('PerplexityBot', false),
        probe('Claude-SearchBot', false),
      ],
    };
    const r = run('A3', context({ botProbes: probes }));
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 3);
    assert.match(r.summary, /Cloudflare/);
    assert.equal(r.evidence.scope, 'ai_crawlers');
    assert.match(r.evidence.caveat, /look-alike/);
  });

  test('FAIL: everything automated is turned away, including our own crawler', () => {
    const probes = {
      control: probe('AEOCornerBot', true),
      bots: clean.bots.map((b) => probe(b.agent, true)),
    };
    const r = run('A3', context({ botProbes: probes }));
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.scope, 'all_automated');
  });

  test('ERROR: not probed, or no probe got any answer', () => {
    assert.equal(status('A3', context({ botProbes: null })), 'error');
    const silent = {
      control: probe('AEOCornerBot', null),
      bots: clean.bots.map((b) => probe(b.agent, null, { status: null })),
    };
    assert.equal(status('A3', context({ botProbes: silent })), 'error');
  });

  test('a probe that got no answer is left out, not counted as a block', () => {
    const probes = {
      control: probe('AEOCornerBot', false),
      bots: [probe('OAI-SearchBot', null, { status: null }), probe('PerplexityBot', false)],
    };
    assert.equal(status('A3', context({ botProbes: probes })), 'pass');
  });
});

describe('A4 sitemap', () => {
  const sitemap = { url: 'https://acme.com/sitemap.xml', kind: 'urlset', urlCount: 40 };

  test('PASS: it exists and robots.txt points to it', () => {
    const r = run(
      'A4',
      context({
        robots: robots('Sitemap: https://acme.com/sitemap.xml'),
        sitemaps: { found: [sitemap], referenced: [sitemap.url] },
      }),
    );
    assert.equal(r.status, 'pass');
  });

  test('PARTIAL: it exists but robots.txt is silent', () => {
    const r = run(
      'A4',
      context({ robots: robots('User-agent: *\nDisallow:'), sitemaps: { found: [sitemap] } }),
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 2);
    assert.match(r.summary, /Sitemap:/);
  });

  test('PARTIAL: robots.txt points to a sitemap that cannot be read', () => {
    const r = run(
      'A4',
      context({
        robots: robots('Sitemap: https://acme.com/gone.xml'),
        sitemaps: { referenced: ['https://acme.com/gone.xml'] },
      }),
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 1);
  });

  test('FAIL: no sitemap anywhere', () => {
    assert.equal(status('A4', context()), 'fail');
  });

  test('ERROR: a firewall turned us away from the sitemap, so "none" would be a guess', () => {
    const r = run(
      'A4',
      context({ robots: robots('User-agent: *\nDisallow:'), sitemaps: { blocked: true } }),
    );
    assert.equal(r.status, 'error');
    assert.match(r.summary, /firewall/);
  });

  test('a sitemap that WAS read still counts even if another address was blocked', () => {
    const r = run(
      'A4',
      context({
        robots: robots('Sitemap: https://acme.com/sitemap.xml'),
        sitemaps: { blocked: true, found: [sitemap], referenced: [sitemap.url] },
      }),
    );
    assert.equal(r.status, 'pass');
  });

  test('ERROR: robots.txt unreachable and no sitemap found', () => {
    assert.equal(status('A4', context({ robots: robots('unreachable') })), 'error');
  });
});

// --- B -------------------------------------------------------------------------------------------------------

const article = (n) => html({ body: `<main><h1>Title</h1><p>${words(n)}</p></main>` });
const spaShell = html({ body: '<div id="root"></div><script src="/app.js"></script>' });

describe('B1 main content is in the raw HTML', () => {
  test('PASS: the raw HTML has the text the browser ends up showing', () => {
    const r = run('B1', context({ pages: [page({ html: article(400), rendered: article(410) })] }));
    assert.equal(r.status, 'pass');
    assert.equal(r.points, 7);
  });

  test('the line is 80%: 85% of the rendered text in the raw HTML passes, 70% does not', () => {
    // 1,000 words rendered; the raw HTML carries 850 of them, or 700 of them.
    const onePage = (rawWords) =>
      run('B1', context({ pages: [page({ html: article(rawWords), rendered: article(1000) })] }));
    assert.equal(onePage(850).status, 'pass');
    const short = onePage(700);
    assert.equal(short.status, 'fail');
    assert.match(short.summary, /Only 7\d% of the text/);
  });

  test('FAIL: a client-rendered app whose raw HTML is an empty shell', () => {
    const r = run('B1', context({ pages: [page({ html: spaShell, rendered: article(500) })] }));
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /JavaScript/);
    assert.equal(r.evidence.pages[0].platform, 'client-rendered-app');
  });

  test('PARTIAL: one page fine, one not', () => {
    const r = run(
      'B1',
      context({
        pages: [
          page({ html: article(400), rendered: article(400) }),
          page({ url: 'https://acme.com/pricing', html: article(40), rendered: article(500) }),
        ],
      }),
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 3.5);
  });

  test('ERROR: nothing was rendered, so we cannot compare', () => {
    const r = run('B1', context({ pages: [page({ html: article(400) })] }));
    assert.equal(r.status, 'error');
  });

  test('NOT APPLICABLE: pages with almost no text', () => {
    assert.equal(
      status('B1', context({ pages: [page({ html: article(10), rendered: article(12) })] })),
      'not_applicable',
    );
  });

  test('ERROR: no page could be read at all', () => {
    assert.equal(status('B1', context({ pages: [page({ fetchFailed: true })] })), 'error');
  });
});

describe('B2 content is not hidden behind interactions or frames', () => {
  test('PASS: ordinary visible content', () => {
    assert.equal(status('B2', context({ pages: [page({ html: article(300) })] })), 'pass');
  });

  test('FAIL: the page is a frame around content that lives elsewhere', () => {
    const framed = html({
      body: '<main><h1>Plans</h1><iframe src="https://widgets.example.net/plans"></iframe></main>',
    });
    const r = run('B2', context({ pages: [page({ html: framed })] }));
    assert.equal(r.status, 'fail');
    assert.match(r.evidence.flagged[0].reasons[0], /frame/);
  });

  test('FAIL: most of the text sits in collapsed accordions', () => {
    const items = Array.from(
      { length: 6 },
      (_, i) => `<details><summary>Q${i}</summary><p>${words(120)}</p></details>`,
    ).join('');
    const hidden = html({ body: `<main><h1>Help</h1><p>${words(40)}</p>${items}</main>` });
    const r = run('B2', context({ pages: [page({ html: hidden })] }));
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /hidden or embedded/);
  });

  test('the rendered page is judged when we have it', () => {
    const raw = article(300);
    const renderedHidden = html({
      body: `<main><div hidden>${words(900)}</div><p>${words(50)}</p></main>`,
    });
    assert.equal(
      status('B2', context({ pages: [page({ html: raw, rendered: renderedHidden })] })),
      'fail',
    );
  });
});

// --- C -------------------------------------------------------------------------------------------------------

describe('C1 Organization schema', () => {
  test('PASS: name, logo, url and sameAs', () => {
    assert.equal(status('C1', context({ pages: [page({ html: goodHome() })] })), 'pass');
  });

  test('PARTIAL: a quarter of the points per missing field', () => {
    const thin = html({
      head: ld({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Acme',
        url: 'https://acme.com/',
      }),
    });
    const r = run('C1', context({ pages: [page({ html: thin })] }));
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 3);
    assert.match(r.summary, /missing logo, sameAs/);
  });

  test('a LocalBusiness subtype counts as an organization', () => {
    const dentist = html({
      head: ld({
        '@type': 'Dentist',
        name: 'Smile',
        url: 'https://smile.example/',
        image: 'https://smile.example/a.jpg',
        sameAs: ['https://www.linkedin.com/company/smile'],
      }),
    });
    assert.equal(status('C1', context({ pages: [page({ html: dentist })] })), 'pass');
  });

  test('FAIL: none at all', () => {
    const r = run('C1', context({ pages: [page({ html: article(200) })] }));
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.onlyAddedByJavaScript, false);
  });

  test('FAIL: it exists only after JavaScript runs, and the result says so', () => {
    const r = run('C1', context({ pages: [page({ html: article(200), rendered: goodHome() })] }));
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.onlyAddedByJavaScript, true);
  });
});

describe('C2 page-type schema on key pages', () => {
  const productHtml = (withSchema) =>
    html({
      head: withSchema
        ? ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'Widget Pro' })
        : '',
      body: '<main><h1>Widget Pro</h1></main>',
    });

  test('PASS: a product page with Product schema', () => {
    const r = run(
      'C2',
      context({
        pages: [
          page({
            url: 'https://acme.com/products/widget-pro',
            type: 'product',
            html: productHtml(true),
          }),
        ],
      }),
    );
    assert.equal(r.status, 'pass');
  });

  test('a page that lacks its schema carries what Auto-fix may build it from, and a passing page does not', () => {
    const lacking = page({
      url: 'https://acme.com/blog/widgets',
      type: 'article',
      html: html({
        head: '<title>Widgets | Acme</title><meta name="description" content="All about widgets.">',
        body: `<main><h1>All about widgets</h1><p>${words(12)}</p></main>`,
      }),
    });
    const passing = page({
      url: 'https://acme.com/products/widget-pro',
      type: 'product',
      html: productHtml(true),
    });
    const r = run('C2', context({ pages: [lacking, passing] }));
    const [bad, good] = r.evidence.pages;
    assert.equal(bad.ok, false);
    assert.equal(bad.basics.name, 'All about widgets');
    assert.equal(bad.basics.description, 'All about widgets.');
    assert.match(bad.basics.lead, /^word0 word1/);
    assert.equal(good.ok, true);
    assert.ok(!('basics' in good), 'a passing page needs no fix, so nothing extra is kept');
  });

  test('FAIL: a product page without it', () => {
    const r = run(
      'C2',
      context({
        pages: [
          page({
            url: 'https://acme.com/products/widget-pro',
            type: 'product',
            html: productHtml(false),
          }),
        ],
      }),
    );
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /product page/);
  });

  test('PARTIAL: half the applicable pages', () => {
    const r = run(
      'C2',
      context({
        pages: [
          page({ url: 'https://acme.com/products/a', type: 'product', html: productHtml(true) }),
          page({ url: 'https://acme.com/products/b', type: 'product', html: productHtml(false) }),
        ],
      }),
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 4);
  });

  test('FAQ pages want FAQPage; articles want an Article type', () => {
    const faq = page({
      url: 'https://acme.com/faq',
      type: 'faq',
      html: html({ head: ld({ '@type': 'FAQPage', mainEntity: [] }) }),
    });
    const post = page({
      url: 'https://acme.com/blog/hello',
      type: 'article',
      html: html({ head: ld({ '@type': 'BlogPosting', headline: 'Hello' }) }),
    });
    assert.equal(status('C2', context({ pages: [faq, post] })), 'pass');
    const bare = page({ url: 'https://acme.com/blog/hello', type: 'article', html: article(100) });
    assert.equal(status('C2', context({ pages: [bare] })), 'fail');
  });

  test('NOT APPLICABLE: only a home page and unclassified pages', () => {
    assert.equal(
      status(
        'C2',
        context({
          pages: [
            page({ html: goodHome() }),
            page({ url: 'https://acme.com/careers', type: 'other', html: article(100) }),
          ],
        }),
      ),
      'not_applicable',
    );
  });

  test('schema that only JavaScript adds is flagged in the evidence', () => {
    const r = run(
      'C2',
      context({
        pages: [
          page({
            url: 'https://acme.com/products/a',
            type: 'product',
            html: productHtml(false),
            rendered: productHtml(true),
          }),
        ],
      }),
    );
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.pages[0].onlyAfterJavaScript, true);
  });
});

describe('C3 JSON-LD valid and server-rendered', () => {
  test('PASS: valid blocks in the HTML', () => {
    assert.equal(status('C3', context({ pages: [page({ html: goodHome() })] })), 'pass');
  });

  test('PARTIAL: one of two blocks is broken', () => {
    const mixed = html({
      head: `${ld({ '@type': 'WebSite' })}<script type="application/ld+json">{ not json </script>`,
    });
    const r = run('C3', context({ pages: [page({ html: mixed })] }));
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 1.5);
  });

  test('FAIL: no structured data', () => {
    assert.equal(status('C3', context({ pages: [page({ html: article(100) })] })), 'fail');
  });

  test('FAIL: added by JavaScript only', () => {
    const r = run('C3', context({ pages: [page({ html: article(100), rendered: goodHome() })] }));
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /JavaScript/);
  });
});

describe('C4 WebSite and BreadcrumbList', () => {
  const crumbs = html({ head: ld({ '@type': 'BreadcrumbList', itemListElement: [] }) });

  test('PASS: WebSite on the home page and breadcrumbs on inner pages', () => {
    const r = run(
      'C4',
      context({
        pages: [page({ html: goodHome() }), page({ url: 'https://acme.com/about', html: crumbs })],
      }),
    );
    assert.equal(r.status, 'pass');
  });

  test('PARTIAL: WebSite but no breadcrumbs', () => {
    const r = run(
      'C4',
      context({
        pages: [
          page({ html: goodHome() }),
          page({ url: 'https://acme.com/about', html: article(100) }),
        ],
      }),
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 1.5);
  });

  test('FAIL: neither', () => {
    const r = run(
      'C4',
      context({
        pages: [
          page({ html: article(100) }),
          page({ url: 'https://acme.com/about', html: article(100) }),
        ],
      }),
    );
    assert.equal(r.status, 'fail');
  });

  test('a site with only a home page is judged on WebSite alone', () => {
    assert.equal(status('C4', context({ pages: [page({ html: goodHome() })] })), 'pass');
  });
});

void GOOD_ORG;
