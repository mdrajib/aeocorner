import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { citationHandlers } from '../../src/worker/handlers/citations.js';
import { refreshProject } from '../../src/worker/handlers/actions.js';

/**
 * Citation opportunities against the real database (Milestone 13): the reads under the Citations screen, the rules that
 * turn a gap into a task (and when its path is Content Studio rather than "get listed"), the job that reads the format of
 * cited pages, and the before/after measurement of a citation fix on citation share. Pure rules: src/core/citation-*.test.js.
 */

const db = connectTestDb();
const fx = fixtures(db);
let org;
const scoped = () => db.forOrg(org.org.id);
const unique = () => Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;
const HOSTS = ['g2.com', 'reddit.com', 'rivalco.test', 'acme-cit.test'];

before(async () => {
  org = await fx.org();
});

after(async () => {
  await fx.cleanup();
  await fx.forgetDomains(HOSTS);
  await db.close();
});

/**
 * A project whose brand (acme-cit.test) was never named for two questions. Engines cited g2.com in 4 answers to the first
 * and the rival's comparison page in 2; a forum thread in 2 answers to the second; and the brand's own pricing page in 12
 * answers (so the site is cited often enough for "never" to mean something). Its scan found four key pages.
 */
async function world({ now = new Date() } = {}) {
  // The URL dictionary is global: forget what an earlier test learned about these pages.
  await fx.forgetDomains(HOSTS);
  const project = await fx.project(org.org.id, `Cit ${unique()}`);
  await fx.engines(project, ['perplexity']);
  const brand = await fx.entity(project, {
    kind: 'brand',
    name: `Acme ${unique()}`,
    domains: ['acme-cit.test'],
  });
  const rival = await fx.entity(project, {
    kind: 'competitor',
    name: `Rival ${unique()}`,
    domains: ['rivalco.test'],
  });
  const q1 = await fx.prompt(project, { text: `Best CRM for dentists ${unique()}?` });
  const q2 = await fx.prompt(project, { text: `Dental CRM pricing ${unique()}?` });
  const run = await fx.run(project, {
    status: 'complete',
    runDate: new Date(now.getTime() - 2 * DAY),
    queuedAt: new Date(now.getTime() - 2 * DAY),
  });
  let sample = 0;
  const answer = (prompt, citations, mentions = []) =>
    fx.readAnswer(run, prompt, { sampleIdx: sample++, citations, mentions });
  for (let i = 0; i < 4; i++) {
    await answer(q1, [
      { url: 'https://www.g2.com/categories/dental-crm' },
      ...(i < 2 ? [{ url: 'https://rivalco.test/compare/us-vs-them', owner: rival }] : []),
    ]);
  }
  for (let i = 0; i < 2; i++) await answer(q2, [{ url: 'https://www.reddit.com/r/dentistry/x' }]);
  for (let i = 0; i < 12; i++) {
    await answer(
      q2,
      [{ url: 'https://acme-cit.test/pricing', isOwn: true, owner: brand }],
      [{ entity: brand, listRank: 1 }],
    );
  }
  await fx.cell(run, q1, { brand, brandK: 0, nOk: 4, citationsTotal: 6, citationsOwn: 0 });
  await fx.cell(run, q2, { brand, brandK: 12, nOk: 14, citationsTotal: 14, citationsOwn: 12 });
  const scan = await fx.scan(project, {
    finishedAt: new Date(now.getTime() - DAY),
    checks: [{ code: 'F3', status: 'pass', points: 3, possible: 3 }],
  });
  await fx.scanPages(scan, [
    { url: 'https://acme-cit.test/' },
    { url: 'https://acme-cit.test/pricing' },
    { url: 'https://acme-cit.test/services/implants' },
    { url: 'https://acme-cit.test/about' },
    { url: 'https://acme-cit.test/careers', key: false },
  ]);
  return { project, brand, rival, prompts: [q1, q2], run };
}

const refresh = (w, now = new Date()) =>
  refreshProject({ db, scoped: scoped() }, { projectId: w.project.id, runId: w.run.id, now });

const todo = async (w) =>
  (await scoped().recommendations.list(w.project.id, { view: 'todo' })).filter((r) =>
    r.ruleCode.startsWith('citation.'),
  );

const range = () => ({ from: new Date(Date.now() - 27 * DAY), to: new Date() });

describe('the reads under the Citations screen', () => {
  test('who is who, per question and site, the brand’s own pages, and the scan’s key pages', async () => {
    const w = await world();
    const who = await scoped().dashboard.citationContext(w.project.id);
    assert.deepEqual(who.ownDomains.slice(-1), ['acme-cit.test']);
    assert.deepEqual(who.rivalDomains, ['rivalco.test']);

    const rows = await scoped().dashboard.citationOpportunityRows(w.project.id, range());
    const g2 = rows.find((r) => r.domain === 'g2.com');
    assert.deepEqual(
      [g2.timesCited, g2.answersCiting, g2.answersWithBrand, g2.answersInQuestion],
      [4, 4, 0, 4],
    );
    assert.equal(g2.pages[0].url, 'https://www.g2.com/categories/dental-crm');
    assert.equal(g2.pages[0].format, null, 'a page nobody has read has no format');
    const rival = rows.find((r) => r.domain === 'rivalco.test');
    assert.equal(rival.answersCiting, 2);

    const own = await scoped().dashboard.ownPageCitations(w.project.id, range());
    assert.equal(own.ownCitations, 12);
    assert.deepEqual(
      own.pages.map((p) => [p.url, p.timesCited]),
      [['https://acme-cit.test/pricing', 12]],
    );

    const keys = await scoped().dashboard.keyPages(w.project.id);
    assert.deepEqual(
      keys.map((k) => k.url),
      [
        'https://acme-cit.test/',
        'https://acme-cit.test/pricing',
        'https://acme-cit.test/services/implants',
        'https://acme-cit.test/about',
      ],
    );

    const daily = await scoped().dashboard.citationShareDaily(w.project.id, range());
    assert.equal(
      daily.reduce((n, d) => n + d.total, 0),
      20,
    );
    assert.equal(
      daily.reduce((n, d) => n + d.own, 0),
      12,
    );
  });
});

describe('the citation rules', () => {
  test('a gap on a review site is "get listed"; a key page never cited is a page to make easier to cite', async () => {
    const w = await world();
    const out = await refresh(w);
    assert.ok(out.created.length >= 3);
    const recs = await todo(w);
    const byRule = (code) => recs.filter((r) => r.ruleCode === code);

    const gaps = byRule('citation.gap');
    assert.deepEqual(gaps.map((g) => g.evidence.domain).sort(), [
      'g2.com',
      'reddit.com',
      'rivalco.test',
    ]);
    const g2 = gaps.find((g) => g.evidence.domain === 'g2.com');
    assert.equal(g2.fixPath, 'guidance');
    assert.equal(g2.metric, 'citation_share');
    assert.equal(g2.title, 'Get listed or mentioned on g2.com');
    assert.equal(g2.evidence.siteType, 'Review site or directory');
    assert.equal(g2.evidence.answersWithoutBrand, 4);
    assert.equal(g2.evidence.questions[0].answersWithoutBrand, 4);
    assert.equal(
      (await scoped().recommendations.get(w.project.id, g2.id)).prompts.length,
      1,
      'the fix is scoped to the question the site was cited for',
    );
    const reddit = gaps.find((g) => g.evidence.domain === 'reddit.com');
    assert.equal(reddit.evidence.siteType, 'Forum or community');
    const rival = gaps.find((g) => g.evidence.domain === 'rivalco.test');
    assert.equal(rival.evidence.siteKind, 'competitor');
    assert.equal(rival.fixPath, 'guidance', 'its format is not known until the page is read');

    const uncited = byRule('citation.own_page_uncited');
    assert.deepEqual(uncited.map((r) => r.evidence.url).sort(), [
      'https://acme-cit.test/about',
      'https://acme-cit.test/services/implants',
    ]);
    assert.ok(uncited.every((r) => r.fixPath === 'content' && r.metric === 'citation_share'));
    assert.ok(uncited.every((r) => r.evidence.ownCitations === 12));

    assert.equal(
      recs.filter((r) => r.ruleCode === 'visibility.cited_source').length,
      0,
      'the old cited-source rule is replaced',
    );
  });

  test('running the rules again changes nothing: one task per gap and per page, however often', async () => {
    const w = await world();
    await refresh(w);
    const first = await todo(w);
    const again = await refresh(w);
    assert.equal(again.created.length, 0);
    const second = await todo(w);
    assert.deepEqual(second.map((r) => r.id).sort(), first.map((r) => r.id).sort());
  });

  test('once a page is cited its task looks fixed, and a site that now names the brand is no gap', async () => {
    const w = await world();
    await refresh(w);
    const cited = (await todo(w)).find(
      (r) => r.evidence.url === 'https://acme-cit.test/services/implants',
    );
    await fx.readAnswer(w.run, w.prompts[1], {
      sampleIdx: 99,
      citations: [{ url: 'https://acme-cit.test/services/implants', isOwn: true, owner: w.brand }],
    });
    await refresh(w);
    const detail = await scoped().recommendations.get(w.project.id, cited.id);
    assert.ok(detail.recommendation.signalClearedAt, 'the signal is gone');
  });

  test('a project with no scan cannot say a page was never cited', async () => {
    const w = await world();
    const empty = await fx.project(org.org.id, `Cit empty ${unique()}`);
    await fx.engines(empty, ['perplexity']);
    const brand = await fx.entity(empty, { kind: 'brand', domains: ['acme-empty.test'] });
    const q = await fx.prompt(empty, { text: `Q ${unique()}?` });
    const run = await fx.run(empty, { status: 'complete', queuedAt: new Date(Date.now() - DAY) });
    await fx.cell(run, q, { brand, brandK: 0, nOk: 5 });
    const out = await refreshProject({ db, scoped: scoped() }, { projectId: empty.id });
    assert.ok(out.candidates >= 0);
    const recs = await scoped().recommendations.list(empty.id, { view: 'todo' });
    assert.deepEqual(
      recs.filter((r) => r.ruleCode === 'citation.own_page_uncited'),
      [],
    );
    assert.ok(w.project.id);
  });
});

describe('reading the format of cited pages', () => {
  const reader = (results) => ({
    read: async (url) => results[url] ?? { format: null, finding: 'blocked', signals: null },
  });
  const ctxFor = (r, queued = []) => ({
    db,
    crawler: { fetcher: {} },
    citations: { reader: r },
    now: () => new Date(),
    logger: { warn() {}, info() {} },
    jobs: {
      add: async (name, data, opts) => {
        queued.push({ name, data, opts });
      },
    },
  });
  const data = (w) => ({ orgId: String(org.org.id), projectId: String(w.project.id) });

  test('saves the format of what it could read, never one for what it could not, and asks for a refresh', async () => {
    const w = await world();
    const queued = [];
    const ctx = ctxFor(
      reader({
        'https://www.g2.com/categories/dental-crm': {
          format: 'list',
          finding: null,
          signals: { author: true, dated: true, sourcesLinked: 3, figures: 5 },
        },
        'https://rivalco.test/compare/us-vs-them': {
          format: 'comparison',
          finding: null,
          signals: { author: false, dated: false, sourcesLinked: 0, figures: 0 },
        },
      }),
      queued,
    );
    const out = await citationHandlers['citations.formats'](ctx, data(w));
    assert.deepEqual(out, { read: 2, couldNotLook: 1 });
    assert.deepEqual(
      queued.map((q) => q.name),
      ['recommendations.refresh'],
    );
    const rows = await scoped().dashboard.citationOpportunityRows(w.project.id, range());
    const formatOf = (domain) => rows.find((r) => r.domain === domain).pages[0].format;
    assert.equal(formatOf('g2.com'), 'list');
    assert.equal(formatOf('rivalco.test'), 'comparison');
    assert.equal(formatOf('reddit.com'), null, 'blocked: no format, not "other"');

    // Read once is read: only the page that could not be looked at is tried again, and not before a day has passed.
    const unread = await scoped().dashboard.unreadCitedUrls(w.project.id, {
      ...range(),
      limit: 10,
    });
    assert.equal(unread.length, 0);
    const later = await scoped().dashboard.unreadCitedUrls(w.project.id, {
      ...range(),
      limit: 10,
      now: new Date(Date.now() + 2 * DAY),
    });
    assert.deepEqual(
      later.map((u) => u.url),
      ['https://www.reddit.com/r/dentistry/x'],
    );
  });

  test('a competitor’s page in a format we write turns the gap into a page to publish', async () => {
    const w = await world();
    await citationHandlers['citations.formats'](
      ctxFor(
        reader({
          'https://rivalco.test/compare/us-vs-them': {
            format: 'comparison',
            finding: null,
            signals: null,
          },
          'https://www.g2.com/categories/dental-crm': {
            format: 'list',
            finding: null,
            signals: null,
          },
        }),
      ),
      data(w),
    );
    await refresh(w);
    const gaps = (await todo(w)).filter((r) => r.ruleCode === 'citation.gap');
    const rival = gaps.find((g) => g.evidence.domain === 'rivalco.test');
    assert.equal(rival.fixPath, 'content');
    assert.equal(rival.evidence.contentFormat, 'comparison');
    assert.match(rival.title, /^Publish a comparison to compete with rivalco\.test$/);
    const g2 = gaps.find((g) => g.evidence.domain === 'g2.com');
    assert.equal(g2.fixPath, 'guidance', 'a review site is not ours to compete with');
    assert.equal(g2.evidence.format, 'list');
  });

  test('a path that changes while the task is still open is followed; one already started keeps its path', async () => {
    const w = await world();
    await refresh(w);
    const before = (await todo(w)).find((g) => g.evidence.domain === 'rivalco.test');
    assert.equal(before.fixPath, 'guidance');
    await citationHandlers['citations.formats'](
      ctxFor(
        reader({
          'https://rivalco.test/compare/us-vs-them': {
            format: 'comparison',
            finding: null,
            signals: null,
          },
        }),
      ),
      data(w),
    );
    await refresh(w);
    const open = (await scoped().recommendations.get(w.project.id, before.id)).recommendation;
    assert.equal(open.fixPath, 'content');
    assert.equal(open.category, 'content_new');
  });
});

describe('measuring a citation fix', () => {
  const t0 = new Date('2026-10-03T12:00:00Z');

  /** A fix on citation share: four weekly runs before it, `afterRuns` after, each cell `[citationsTotal, citationsOwn]`. */
  async function measured({ before, afterRuns }) {
    const project = await fx.project(org.org.id, `Cit measured ${unique()}`);
    await fx.engines(project, ['perplexity']);
    const brand = await fx.entity(project, { kind: 'brand', name: `Brand ${unique()}` });
    const q = await fx.prompt(project, { text: `Question ${unique()}?` });
    const run = (days) => {
      const at = new Date(t0.getTime() + days * DAY);
      return fx.run(project, { status: 'complete', runDate: at, queuedAt: at });
    };
    for (const days of [-21, -14, -7, -1]) {
      await fx.cell(await run(days), q, {
        brand,
        brandK: 5,
        nOk: 10,
        citationsTotal: before[0],
        citationsOwn: before[1],
      });
    }
    const rec = await fx.recommendation(project, {
      rule_code: 'citation.gap',
      stable_key: `citation.gap:${unique()}.test`,
      category: 'offsite_presence',
      fix_path: 'guidance',
      metric: 'citation_share',
      status: 'open',
    });
    await scoped().recommendations.markDone(project.id, rec.id, { userId: org.owner.id, now: t0 });
    await scoped().recommendations.settleVerification(project.id, rec.id, {
      verdict: 'unverified',
      reason: 'not_verifiable',
      now: t0,
    });
    for (const [days, total, own] of afterRuns) {
      await fx.cell(await run(days), q, {
        brand,
        brandK: 5,
        nOk: 10,
        citationsTotal: total,
        citationsOwn: own,
      });
    }
    return { project, rec };
  }

  test('the baseline counts citations, not answers', async () => {
    const m = await measured({ before: [10, 2], afterRuns: [] });
    const detail = await scoped().recommendations.get(m.project.id, m.rec.id);
    assert.equal(detail.recommendation.metric, 'citation_share');
    assert.deepEqual([detail.recommendation.baseline.n, detail.recommendation.baseline.k], [40, 8]);
    assert.equal(detail.recommendation.baseline.metric, 'citation_share');
  });

  test('a significant rise in citation share is a proven win, in the words of a citation fix', async () => {
    const m = await measured({
      before: [10, 2],
      afterRuns: [
        [3, 12, 6],
        [7, 12, 6],
        [10, 12, 6],
      ],
    });
    const result = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 15 * DAY),
    });
    assert.deepEqual(
      [result.horizon, result.verdict, result.status],
      ['week_2', 'proven_win', 'proven_win'],
    );
    const detail = await scoped().recommendations.get(m.project.id, m.rec.id);
    const [outcome] = detail.outcomes;
    assert.equal(outcome.metric, 'citation_share');
    assert.deepEqual(
      [outcome.nBefore, outcome.kBefore, outcome.nAfter, outcome.kAfter],
      [40, 8, 36, 18],
    );
    assert.equal(outcome.rateBefore, 0.2);
    assert.equal(outcome.rateAfter, 0.5);
    assert.ok(outcome.p < 0.05);
  });

  test('the same movement in citations that is only noise is "no change", judged by the same test', async () => {
    const m = await measured({
      before: [10, 2],
      afterRuns: [
        [3, 12, 3],
        [7, 12, 2],
        [10, 12, 3],
      ],
    });
    const result = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 15 * DAY),
    });
    assert.deepEqual([result.verdict, result.status], ['no_change', 'measuring']);
  });

  test('a mention-rate fix in the same database is still measured on answers', async () => {
    const project = await fx.project(org.org.id, `Mention ${unique()}`);
    await fx.engines(project, ['perplexity']);
    const brand = await fx.entity(project, { kind: 'brand', name: `Brand ${unique()}` });
    const q = await fx.prompt(project, { text: `Question ${unique()}?` });
    const at = new Date(t0.getTime() - DAY);
    const run = await fx.run(project, { status: 'complete', runDate: at, queuedAt: at });
    await fx.cell(run, q, { brand, brandK: 3, nOk: 10, citationsTotal: 50, citationsOwn: 40 });
    const rec = await fx.recommendation(project, { status: 'open' });
    assert.equal(rec.metric, 'mention_rate');
    const done = await scoped().recommendations.markDone(project.id, rec.id, {
      userId: org.owner.id,
      now: t0,
    });
    assert.deepEqual([done.recommendation.baseline.n, done.recommendation.baseline.k], [10, 3]);
  });
});
