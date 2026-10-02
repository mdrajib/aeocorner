import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { context, goodHome, html, ld, page, run, words } from '../../../tests/helpers/readiness.js';

const status = (code, ctx) => run(code, ctx).status;
const home = (opts) => page({ html: goodHome(opts) });

// --- D -------------------------------------------------------------------------------------------------------

describe('D1 consistent brand name', () => {
  const named = ({ title, og, schema }) =>
    page({
      html: html({
        head: `<title>${title}</title>${og ? `<meta property="og:site_name" content="${og}">` : ''}${schema ? ld({ '@type': 'Organization', name: schema }) : ''}`,
        body: '<p>x</p>',
      }),
    });

  test('PASS: title, og:site_name and schema all say Acme Widgets (legal suffixes ignored)', () => {
    const r = run(
      'D1',
      context({
        pages: [
          named({ title: 'Home | Acme Widgets', og: 'Acme Widgets', schema: 'Acme Widgets, Inc.' }),
        ],
      }),
    );
    assert.equal(r.status, 'pass');
  });

  test('FAIL: the schema and og:site_name disagree', () => {
    const r = run(
      'D1',
      context({
        pages: [named({ title: 'Acme', og: 'Acme Widgets', schema: 'Globex Corporation' })],
      }),
    );
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /two different names/);
  });

  test('PARTIAL: the title does not carry the name the schema gives', () => {
    const r = run(
      'D1',
      context({
        pages: [
          named({ title: 'Best widgets in town', og: 'Acme Widgets', schema: 'Acme Widgets' }),
        ],
      }),
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 3);
  });

  test('PARTIAL: only the title, with nothing to cross-check', () => {
    const r = run('D1', context({ pages: [named({ title: 'Acme Widgets' })] }));
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 1);
  });

  test('FAIL: no name anywhere', () => {
    const r = run('D1', context({ pages: [page({ html: html({ body: '<p>x</p>' }) })] }));
    assert.equal(r.status, 'fail');
  });
});

describe('D2 About page', () => {
  const aboutPage = (body) =>
    page({
      url: 'https://acme.com/about',
      html: html({ body: `<main><h1>About</h1>${body}</main>` }),
    });

  test('PASS: says what it is, where it is, and who it serves', () => {
    const r = run(
      'D2',
      context({
        pages: [
          aboutPage(
            `<p>Acme Widgets is a manufacturer of industrial widgets, based in Columbus, Ohio, serving small factories across the Midwest since 1998. ${words(30)}</p>`,
          ),
        ],
      }),
    );
    assert.equal(r.status, 'pass');
  });

  test('PARTIAL: an About page with little in it', () => {
    const r = run('D2', context({ pages: [aboutPage('<p>Welcome. Please look around.</p>')] }));
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 1);
    assert.match(r.summary, /missing/);
  });

  test('FAIL: there is no About page among the key pages', () => {
    const r = run('D2', context({ pages: [home()] }));
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.found, false);
  });

  test('ERROR, not fail: the About page exists but would not load', () => {
    const broken = page({ url: 'https://acme.com/about', fetchFailed: true });
    assert.equal(status('D2', context({ pages: [home(), broken] })), 'error');
    const gone = page({ url: 'https://acme.com/about', html: '<p>x</p>', status: 500 });
    assert.equal(status('D2', context({ pages: [gone] })), 'error');
  });
});

describe('D3 sameAs to authoritative profiles', () => {
  test('PASS: three authoritative profiles in the Organization schema', () => {
    assert.equal(status('D3', context({ pages: [home()] })), 'pass');
  });

  test('PARTIAL: a profile linked in the footer but absent from the schema counts for less', () => {
    const footerOnly = html({
      head: ld({ '@type': 'Organization', name: 'Acme' }),
      body: '<footer><a href="https://www.linkedin.com/company/acme">LinkedIn</a></footer>',
    });
    const r = run('D3', context({ pages: [page({ html: footerOnly })] }));
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.evidence.onPageOnly, ['LinkedIn']);
    assert.match(r.summary, /does not list them/);
  });

  test('PARTIAL: one in the schema', () => {
    const one = html({
      head: ld({
        '@type': 'Organization',
        name: 'Acme',
        sameAs: ['https://www.linkedin.com/company/acme'],
      }),
    });
    assert.equal(run('D3', context({ pages: [page({ html: one })] })).points, 1.3);
  });

  test('FAIL: social links do not count, only authoritative profiles', () => {
    const socialOnly = html({
      head: ld({
        '@type': 'Organization',
        name: 'Acme',
        sameAs: ['https://twitter.com/acme', 'https://www.facebook.com/acme'],
      }),
    });
    assert.equal(status('D3', context({ pages: [page({ html: socialOnly })] })), 'fail');
  });

  test('a Google Business Profile and Wikipedia are recognised', () => {
    const profiles = html({
      head: ld({
        '@type': 'Organization',
        name: 'Acme',
        sameAs: [
          'https://en.wikipedia.org/wiki/Acme',
          'https://g.page/acme',
          'https://www.g2.com/products/acme',
        ],
      }),
    });
    assert.equal(status('D3', context({ pages: [page({ html: profiles })] })), 'pass');
  });
});

describe('D4 name, address and phone consistency', () => {
  const local = ({
    phone = '+1 614-555-0100',
    street = '12 Main Street',
    bodyPhone = '(614) 555-0100',
    bodyStreet = '12 Main Street, Columbus',
  } = {}) =>
    page({
      html: html({
        head: ld({
          '@type': 'LocalBusiness',
          name: 'Acme',
          telephone: phone,
          address: { '@type': 'PostalAddress', streetAddress: street },
        }),
        body: `<main><p>Visit us at ${bodyStreet}. Call ${bodyPhone}.</p></main>`,
      }),
    });

  test('PASS: the schema matches the page', () => {
    assert.equal(status('D4', context({ pages: [local()] })), 'pass');
  });

  test('PARTIAL: the phone number on the page is not the one in the schema', () => {
    const r = run('D4', context({ pages: [local({ bodyPhone: '(614) 555-9999' })] }));
    assert.notEqual(r.status, 'pass');
    assert.match(r.summary, /phone/);
  });

  test('FAIL: neither the address nor the phone is on the page', () => {
    const r = run(
      'D4',
      context({ pages: [local({ bodyPhone: 'ask us', bodyStreet: 'somewhere' })] }),
    );
    assert.equal(r.status, 'partial');
    assert.ok(r.points <= 1);
  });

  test('NOT APPLICABLE: an online company with no local-business schema', () => {
    assert.equal(status('D4', context({ pages: [home()] })), 'not_applicable');
  });
});

// --- E -------------------------------------------------------------------------------------------------------

const qa = (n, answerWords = 20) =>
  Array.from(
    { length: n },
    (_, i) => `<h2>What is thing ${i}?</h2><p>${words(answerWords, `a${i}_`)}</p>`,
  ).join('');
const content = (body, head = '') =>
  page({ html: html({ head, body: `<main><h1>Guide</h1>${body}</main>` }) });

describe('E1 question headings', () => {
  test('PASS: plenty of question subheadings', () => {
    assert.equal(status('E1', context({ pages: [content(qa(4))] })), 'pass');
  });

  test('FAIL: subheadings, none of them questions', () => {
    const r = run(
      'E1',
      context({
        pages: [
          content('<h2>Overview</h2><p>x</p><h2>Features</h2><p>x</p><h2>Pricing</h2><p>x</p>'),
        ],
      }),
    );
    assert.equal(r.status, 'fail');
  });

  test('PARTIAL: a few questions among many headings', () => {
    const r = run(
      'E1',
      context({
        pages: [
          content(
            `${qa(1)}<h2>Overview</h2><h2>Team</h2><h2>Work</h2><h2>News</h2><h2>Careers</h2><h2>Press</h2>`,
          ),
        ],
      }),
    );
    assert.equal(r.status, 'partial');
  });

  test('FAIL: no subheadings at all', () => {
    assert.equal(status('E1', context({ pages: [content(`<p>${words(100)}</p>`)] })), 'fail');
  });

  test('"How", "Why", "Can" and a trailing question mark all make a question', () => {
    const r = run(
      'E1',
      context({
        pages: [
          content(
            '<h2>How it works</h2><h2>Why choose us</h2><h3>Can I cancel anytime</h3><h2>Pricing?</h2>',
          ),
        ],
      }),
    );
    assert.equal(r.evidence.questions, 4);
  });
});

describe('E2 direct answers under questions', () => {
  test('PASS: each question has a short answer right under it', () => {
    assert.equal(status('E2', context({ pages: [content(qa(3, 25))] })), 'pass');
  });

  test('FAIL: the paragraph under each question runs past 60 words', () => {
    const r = run('E2', context({ pages: [content(qa(3, 120))] }));
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.tooLong, 3);
  });

  test('FAIL: questions followed straight by another heading, with no answer', () => {
    const r = run(
      'E2',
      context({
        pages: [content('<h2>What is it?</h2><h2>Who is it for?</h2><h2>Where is it?</h2>')],
      }),
    );
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.noParagraph, 3);
  });

  test('PARTIAL: some answers short, some long', () => {
    const r = run(
      'E2',
      context({ pages: [content(qa(2, 20) + qa(2, 100).replaceAll('thing', 'other'))] }),
    );
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 3);
  });

  test('FAIL: there are no questions to answer', () => {
    const r = run('E2', context({ pages: [content('<h2>Overview</h2><p>text</p>')] }));
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.questions, 0);
  });

  test('FAQ items in <details> are questions with answers inside them', () => {
    const faq =
      '<details><summary>Is it safe?</summary><p>Yes, it is tested to the highest standard available today.</p></details>'.repeat(
        2,
      );
    assert.equal(status('E2', context({ pages: [content(faq)] })), 'pass');
  });

  test('a list under a question is not a paragraph answer, but the next paragraph past it is not borrowed either', () => {
    const r = run(
      'E2',
      context({
        pages: [
          content(
            '<h2>What do you sell?</h2><ul><li>a</li><li>b</li></ul><h2>Next?</h2><p>Answer to the next one here, in a few words.</p>',
          ),
        ],
      }),
    );
    assert.equal(r.evidence.questions, 2);
    assert.equal(r.evidence.direct, 1);
  });
});

describe('E3 lists and tables', () => {
  const longText = `<p>${words(200)}</p>`;

  test('PASS: lists or tables on at least half of the content pages', () => {
    const withList = content(`${longText}<ul><li>a</li><li>b</li><li>c</li></ul>`);
    const withTable = page({
      url: 'https://acme.com/pricing',
      html: html({
        body: `<main>${longText}<table><tr><td>1</td></tr><tr><td>2</td></tr></table></main>`,
      }),
    });
    assert.equal(status('E3', context({ pages: [withList, withTable] })), 'pass');
  });

  test('FAIL: long pages made only of paragraphs', () => {
    assert.equal(status('E3', context({ pages: [content(longText), content(longText)] })), 'fail');
  });

  test('PARTIAL: one page in four', () => {
    const withList = content(`${longText}<ol><li>a</li><li>b</li><li>c</li></ol>`);
    const r = run(
      'E3',
      context({ pages: [withList, content(longText), content(longText), content(longText)] }),
    );
    assert.equal(r.status, 'partial');
  });

  test('NOT APPLICABLE: no page has 150 words', () => {
    assert.equal(status('E3', context({ pages: [content('<p>short</p>')] })), 'not_applicable');
  });
});

describe('E4 FAQ section', () => {
  const faqSchema = ld({ '@type': 'FAQPage', mainEntity: [] });

  test('PASS: a visible FAQ and FAQPage schema', () => {
    assert.equal(
      status(
        'E4',
        context({ pages: [content('<h2>Frequently asked questions</h2><p>x</p>', faqSchema)] }),
      ),
      'pass',
    );
  });

  test('PARTIAL: a FAQ with no schema', () => {
    const r = run('E4', context({ pages: [content('<h2>FAQ</h2><p>x</p>')] }));
    assert.equal(r.status, 'partial');
    assert.match(r.summary, /no FAQPage schema/);
  });

  test('PARTIAL: schema with nothing visible behind it', () => {
    const r = run('E4', context({ pages: [content('<p>text</p>', faqSchema)] }));
    assert.equal(r.status, 'partial');
    assert.match(r.summary, /must match what visitors can see/);
  });

  test('three question headings are a FAQ even without the word', () => {
    assert.equal(run('E4', context({ pages: [content(qa(3))] })).evidence.sectionOn.length, 1);
  });

  test('FAIL: none', () => {
    assert.equal(status('E4', context({ pages: [content('<h2>Overview</h2><p>x</p>')] })), 'fail');
  });
});

describe('E5 evidence', () => {
  test('PASS: an author, outside sources and figures', () => {
    assert.equal(status('E5', context({ pages: [home()] })), 'pass');
  });

  test('FAIL: claims with no author, no sources and no numbers', () => {
    assert.equal(
      status('E5', context({ pages: [content('<p>We are the best, trusted by many.</p>')] })),
      'fail',
    );
  });

  test('PARTIAL: an author and nothing else', () => {
    const r = run(
      'E5',
      context({ pages: [content('<p class="byline">By Jo</p><p>We are the best.</p>')] }),
    );
    assert.equal(r.status, 'partial');
    assert.match(r.summary, /links to outside sources, specific figures/);
  });

  test('links to social networks and to the site itself are not outside sources', () => {
    const r = run(
      'E5',
      context({
        pages: [
          content(
            '<p>See <a href="https://twitter.com/a">us</a>, <a href="https://www.facebook.com/a">here</a> and <a href="/about">about</a>.</p>',
          ),
        ],
      }),
    );
    assert.equal(r.evidence.outsideSources, false);
  });
});

describe('E6 freshness', () => {
  test('PASS: visible, recent dates, and a sitemap that is current', () => {
    const recent = new Date('2026-09-20T00:00:00Z');
    const r = run('E6', context({ pages: [home()], sitemaps: { lastmods: [recent, recent] } }));
    assert.equal(r.status, 'pass', r.summary);
  });

  test('FAIL: nothing dated at all', () => {
    const r = run('E6', context({ pages: [content('<p>Timeless.</p>')] }));
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /neither/);
  });

  test('PARTIAL: dates are shown but the newest is years old', () => {
    const old = content('<time datetime="2021-03-04">March 2021</time><p>Posted long ago</p>');
    const r = run('E6', context({ pages: [old] }));
    assert.equal(r.status, 'partial');
    assert.match(r.summary, /last 12 months/);
  });

  test('dates in the future are ignored', () => {
    const future = content('<time datetime="2031-01-01">someday</time>');
    assert.equal(run('E6', context({ pages: [future] })).evidence.datedItems, 0);
  });

  test('a recent Last-Modified header counts as fresh', () => {
    const fresh = page({
      html: html({ body: '<main><p>x</p></main>' }),
      headers: { 'last-modified': 'Mon, 21 Sep 2026 10:00:00 GMT' },
    });
    assert.equal(run('E6', context({ pages: [fresh] })).evidence.sitemapOrHeaderFresh, true);
  });
});

// --- F -------------------------------------------------------------------------------------------------------

describe('F1 indexable with correct canonicals', () => {
  test('PASS: indexable, each page its own canonical', () => {
    assert.equal(status('F1', context({ pages: [home()] })), 'pass');
  });

  test('FAIL: the home page is noindex (a staging site left that way)', () => {
    const staging = page({
      html: html({ head: '<meta name="robots" content="noindex, nofollow">', body: '<p>x</p>' }),
    });
    const r = run('F1', context({ pages: [staging] }));
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /noindex/);
  });

  test('FAIL: noindex arrives in an X-Robots-Tag header instead', () => {
    const header = page({
      html: html({ body: '<p>x</p>' }),
      headers: { 'x-robots-tag': 'noindex' },
    });
    assert.equal(status('F1', context({ pages: [header] })), 'fail');
  });

  test('PARTIAL: a page whose canonical names a different page', () => {
    const wrong = page({
      url: 'https://acme.com/pricing',
      html: html({ head: '<link rel="canonical" href="https://acme.com/">', body: '<p>x</p>' }),
    });
    const r = run('F1', context({ pages: [home(), wrong] }));
    assert.equal(r.status, 'partial');
    assert.match(r.summary, /different page as canonical/);
  });

  test('PARTIAL: no canonical tags at all earns half of that half', () => {
    const bare = page({ html: html({ body: '<p>x</p>' }) });
    const r = run('F1', context({ pages: [bare] }));
    assert.equal(r.status, 'partial');
    assert.equal(r.points, 3);
  });

  test('a trailing slash or a tracking parameter does not make a canonical wrong', () => {
    const slashed = page({
      url: 'https://acme.com/about',
      html: html({
        head: '<link rel="canonical" href="https://acme.com/about/?utm_source=x">',
        body: '<p>x</p>',
      }),
    });
    assert.equal(run('F1', context({ pages: [slashed] })).points, 4);
  });
});

describe('F2 HTTPS, 200 and redirects', () => {
  test('PASS', () => {
    assert.equal(status('F2', context({ pages: [home()] })), 'pass');
  });

  test('PARTIAL: plain HTTP', () => {
    const insecure = page({ url: 'http://acme.com/', html: goodHome() });
    const r = run('F2', context({ pages: [insecure] }));
    assert.equal(r.status, 'partial');
    assert.match(r.summary, /not served over HTTPS/);
  });

  test('PARTIAL: a key page that returns 404, and a redirect chain', () => {
    const missing = page({ url: 'https://acme.com/about', html: '<p>nope</p>', status: 404 });
    const chain = page({ url: 'https://acme.com/pricing', html: goodHome(), redirectCount: 3 });
    const r = run('F2', context({ pages: [home(), missing, chain] }));
    assert.equal(r.status, 'partial');
    assert.match(r.summary, /did not answer 200/);
    assert.match(r.summary, /more than one redirect/);
  });

  test('ERROR: no page answered at all', () => {
    assert.equal(status('F2', context({ pages: [page({ fetchFailed: true })] })), 'error');
  });
});

describe('F3 titles and descriptions', () => {
  const titled = (path, title, description) =>
    page({
      url: `https://acme.com${path}`,
      html: html({
        head: `${title ? `<title>${title}</title>` : ''}${description ? `<meta name="description" content="${description}">` : ''}`,
        body: '<p>x</p>',
      }),
    });

  test('PASS: every page has its own', () => {
    assert.equal(
      status(
        'F3',
        context({
          pages: [titled('/', 'Home', 'The home page'), titled('/about', 'About', 'About us')],
        }),
      ),
      'pass',
    );
  });

  test('PARTIAL: missing descriptions and a shared title', () => {
    const r = run(
      'F3',
      context({
        pages: [
          titled('/', 'Acme', 'Home'),
          titled('/about', 'Acme', ''),
          titled('/pricing', 'Acme', ''),
        ],
      }),
    );
    assert.equal(r.status, 'partial');
    assert.match(r.summary, /no meta description/);
    assert.match(r.summary, /share a title/);
  });

  test('FAIL: nothing on any page', () => {
    assert.equal(
      status('F3', context({ pages: [titled('/', '', ''), titled('/about', '', '')] })),
      'partial',
    );
  });
});

describe('F4 llms.txt', () => {
  test('PASS: present', () => {
    assert.equal(
      status('F4', context({ llmsTxt: { status: 'present', httpStatus: 200 } })),
      'pass',
    );
  });

  test('FAIL: absent (and the summary says it is optional)', () => {
    const r = run('F4', context());
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /optional/);
    assert.equal(r.evidence.informational, true);
  });

  test('ERROR: could not be checked', () => {
    assert.equal(status('F4', context({ llmsTxt: { status: 'error', httpStatus: 503 } })), 'error');
  });
});
