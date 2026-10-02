import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  context,
  goodHome,
  html,
  ld,
  page,
  robots,
  words,
} from '../../../tests/helpers/readiness.js';
import {
  CATEGORIES,
  CHECK_CODES,
  CHECKS,
  MIN_EVALUATED_SHARE,
  RUBRIC_CODES,
  RUBRIC_VERSION,
  RUNNER_CODES,
  runReadinessChecks,
  scoreChecks,
} from './index.js';
import { finishCheck } from './rubric.js';

const byCode = (report) => Object.fromEntries(report.checks.map((c) => [c.code, c]));

/** A site that does nearly everything right, as the pipeline would hand it over. */
function wellBuiltSite() {
  const about = html({
    head: `<title>About Acme Widgets</title><meta name="description" content="Who we are"><link rel="canonical" href="https://acme.com/about">${ld({ '@type': 'BreadcrumbList', itemListElement: [] })}${ld({ '@type': 'AboutPage' })}`,
    body: `<main><h1>About</h1><p>Acme Widgets is a manufacturer of industrial widgets, based in Columbus, Ohio, serving small factories since 1998. ${words(30)}</p></main>`,
  });
  const faq = html({
    head: `<title>Widget FAQ</title><meta name="description" content="Answers"><link rel="canonical" href="https://acme.com/faq">${ld({ '@type': 'FAQPage', mainEntity: [] })}${ld({ '@type': 'BreadcrumbList' })}`,
    body: `<main><h1>FAQ</h1><h2>Frequently asked questions</h2><h2>Is it safe?</h2><p>Yes, every widget is tested for ten thousand hours.</p><h2>How long is the warranty?</h2><p>Every widget comes with a five year warranty from the day you buy it.</p></main>`,
  });
  const home = goodHome();
  return context({
    robots: robots(
      'User-agent: *\nDisallow: /admin/\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: https://acme.com/sitemap.xml\n',
    ),
    sitemaps: {
      found: [{ url: 'https://acme.com/sitemap.xml', kind: 'urlset', urlCount: 30 }],
      referenced: ['https://acme.com/sitemap.xml'],
      lastmods: [new Date('2026-09-20T00:00:00Z')],
    },
    botProbes: {
      control: { agent: 'AEOCornerBot', blocked: false },
      bots: ['OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Claude-SearchBot'].map((agent) => ({
        agent,
        blocked: false,
      })),
    },
    llmsTxt: { status: 'present', httpStatus: 200 },
    pages: [
      page({ html: home, rendered: home }),
      page({ url: 'https://acme.com/about', html: about, rendered: about }),
      page({ url: 'https://acme.com/faq', html: faq }),
    ],
  });
}

describe('the rubric', () => {
  test('has 24 checks worth exactly 100 points, in the six categories of MVP §6.6', () => {
    assert.equal(CHECK_CODES.length, 24);
    assert.equal(
      Object.values(CHECKS).reduce((sum, c) => sum + c.points, 0),
      100,
    );
    const perCategory = {};
    for (const c of Object.values(CHECKS))
      perCategory[c.category] = (perCategory[c.category] ?? 0) + c.points;
    assert.deepEqual(perCategory, { A: 20, B: 10, C: 20, D: 15, E: 25, F: 10 });
    for (const [letter, { points }] of Object.entries(CATEGORIES))
      assert.equal(perCategory[letter], points);
  });

  test('every check has a runner and every runner has a rubric entry', () => {
    assert.deepEqual([...RUNNER_CODES].sort(), [...RUBRIC_CODES].sort());
  });

  test('the point values are the ones the spec lists', () => {
    const expected = {
      A1: 8,
      A2: 2,
      A3: 6,
      A4: 4,
      B1: 7,
      B2: 3,
      C1: 6,
      C2: 8,
      C3: 3,
      C4: 3,
      D1: 4,
      D2: 4,
      D3: 4,
      D4: 3,
      E1: 5,
      E2: 6,
      E3: 4,
      E4: 4,
      E5: 3,
      E6: 3,
      F1: 4,
      F2: 2,
      F3: 3,
      F4: 1,
    };
    assert.deepEqual(
      Object.fromEntries(Object.entries(CHECKS).map(([c, d]) => [c, d.points])),
      expected,
    );
  });

  test('the two informational checks are marked', () => {
    assert.deepEqual(
      Object.entries(CHECKS)
        .filter(([, d]) => d.informational)
        .map(([c]) => c),
      ['A2', 'F4'],
    );
  });

  test('the version is stored with every scan', () => {
    assert.equal(RUBRIC_VERSION, 'v0.1');
    assert.equal(runReadinessChecks(wellBuiltSite()).rubricVersion, 'v0.1');
  });
});

describe('finishing a check', () => {
  test('points are the score times the check’s worth, to one decimal', () => {
    assert.equal(finishCheck('E1', { score: 0.5 }).points, 2.5);
    assert.equal(finishCheck('D3', { score: 1 / 3 }).points, 1.3);
  });

  test('status follows the points', () => {
    assert.equal(finishCheck('A1', { score: 1 }).status, 'pass');
    assert.equal(finishCheck('A1', { score: 0 }).status, 'fail');
    assert.equal(finishCheck('A1', { score: 0.4 }).status, 'partial');
  });

  test('a score outside 0 to 1 is clamped, never allowed to break the CHECK constraint', () => {
    assert.equal(finishCheck('A1', { score: 1.7 }).points, 8);
    assert.equal(finishCheck('A1', { score: -3 }).points, 0);
  });

  test('"not applicable" and "error" earn nothing and carry no score', () => {
    for (const status of ['not_applicable', 'error']) {
      const r = finishCheck('B1', { status, summary: 's' });
      assert.deepEqual([r.status, r.points, r.possible], [status, 0, 7]);
    }
  });
});

describe('scoring a whole site', () => {
  test('a well-built site scores high with nothing left unchecked', () => {
    const report = runReadinessChecks(wellBuiltSite());
    assert.equal(
      report.counts.error,
      0,
      JSON.stringify(report.checks.filter((c) => c.status === 'error')),
    );
    assert.ok(
      report.score >= 85,
      `score ${report.score}: ${report.checks
        .filter((c) => c.status !== 'pass')
        .map((c) => `${c.code}=${c.points}/${c.possible}`)
        .join(' ')}`,
    );
    assert.equal(report.coverage, 1);
  });

  test('a staging-style site (noindex, everything blocked, no schema) scores low but still scores', () => {
    const staging = html({
      head: '<title>Staging</title><meta name="robots" content="noindex">',
      body: `<p>${words(50)}</p>`,
    });
    const report = runReadinessChecks(
      context({
        robots: robots('User-agent: *\nDisallow: /\n'),
        pages: [page({ html: staging, rendered: staging })],
        llmsTxt: { status: 'missing' },
      }),
    );
    const checks = byCode(report);
    assert.equal(checks.A1.status, 'fail');
    assert.equal(checks.F1.status, 'fail');
    assert.ok(report.score !== null && report.score <= 25, `score ${report.score}`);
  });

  test('a site that could not be read at all has NO score, never a score of 0', () => {
    const report = runReadinessChecks(
      context({
        robots: robots('unreachable'),
        pages: [page({ fetchFailed: true })],
        llmsTxt: { status: 'error' },
      }),
    );
    assert.equal(report.score, null);
    assert.equal(
      report.counts.fail,
      0,
      'nothing is marked as failing just because we could not look',
    );
    assert.ok(report.counts.error >= 15);
    assert.ok(report.coverage < MIN_EVALUATED_SHARE);
  });

  test('a firewall that blocks everything: robots are checked, page checks are "couldn’t check"', () => {
    const report = runReadinessChecks(
      context({
        robots: robots('User-agent: *\nDisallow:\n'),
        pages: [page({ status: 403, html: '<html><body>Access denied</body></html>' })],
        botProbes: {
          control: { agent: 'AEOCornerBot', blocked: true },
          bots: [{ agent: 'OAI-SearchBot', blocked: true }],
        },
      }),
    );
    const checks = byCode(report);
    assert.equal(checks.A1.status, 'pass');
    assert.equal(checks.A3.status, 'fail');
    assert.equal(
      checks.C1.status,
      'error',
      'no readable page, so schema is unknown rather than missing',
    );
  });

  test('errors and not-applicable checks are left out of the score instead of counting against it', () => {
    const results = [
      finishCheck('A1', { score: 1 }), // 8 / 8
      finishCheck('B1', { status: 'error' }), // left out
      finishCheck('D4', { status: 'not_applicable' }), // left out
      finishCheck('E1', { score: 0.5 }), // 2.5 / 5
    ];
    const scored = scoreChecks(results);
    assert.equal(scored.earned, 10.5);
    assert.equal(scored.possible, 13);
    assert.equal(scored.score, Math.round((10.5 / 13) * 100));
    assert.deepEqual(scored.counts, { pass: 1, partial: 1, fail: 0, not_applicable: 1, error: 1 });
  });

  test('too little of the rubric evaluated means no score', () => {
    const results = [
      finishCheck('A1', { score: 1 }),
      finishCheck('B1', { status: 'error' }),
      finishCheck('C2', { status: 'error' }),
      finishCheck('E2', { status: 'error' }),
    ];
    assert.equal(scoreChecks(results).score, null);
  });

  test('a category leaves its unchecked checks out of its own score too', () => {
    const results = [
      finishCheck('A1', { score: 1 }),
      finishCheck('A3', { status: 'error' }),
      finishCheck('A4', { score: 0.5 }),
    ];
    const a = scoreChecks(results).categories.A;
    assert.deepEqual([a.possible, a.earned, a.evaluated, a.checks], [12, 10, 2, 3]);
    assert.equal(a.score, 83);
    // A category with nothing evaluated has no score at all, not 0.
    assert.equal(scoreChecks(results).categories.B.score, null);
  });

  test('categories are scored on their own', () => {
    const report = runReadinessChecks(wellBuiltSite());
    assert.equal(report.categories.A.possible, 20);
    assert.ok(report.categories.A.score >= 80);
    assert.equal(report.categories.A.evaluated, 4);
    for (const letter of 'ABCDEF')
      assert.equal(report.categories[letter].name, CATEGORIES[letter].name);
  });
});

describe('a check that breaks does not break the scan', () => {
  test('malformed input turns the affected checks into errors and leaves the rest alone', () => {
    const ctx = { ...wellBuiltSite(), pages: null };
    const report = runReadinessChecks(ctx);
    const checks = byCode(report);
    assert.equal(checks.B1.status, 'error');
    assert.match(checks.B1.evidence.internalError, /./);
    assert.equal(checks.A2.status, 'pass', 'a check that does not use pages still runs');
    assert.equal(report.checks.length, 24);
  });

  test('every check returns the stored shape, whatever it concludes', () => {
    for (const ctx of [wellBuiltSite(), context(), { ...context(), pages: null }]) {
      for (const result of runReadinessChecks(ctx).checks) {
        assert.ok(CHECK_CODES.includes(result.code));
        assert.ok(['pass', 'partial', 'fail', 'not_applicable', 'error'].includes(result.status));
        assert.ok(
          result.points >= 0 && result.points <= result.possible,
          `${result.code} ${result.points}`,
        );
        assert.equal(typeof result.summary, 'string');
        assert.doesNotThrow(
          () => JSON.stringify(result.evidence),
          `${result.code} evidence is plain data`,
        );
        assert.ok(
          JSON.stringify(result.evidence).length < 20_000,
          `${result.code} evidence stays small`,
        );
      }
    }
  });
});
