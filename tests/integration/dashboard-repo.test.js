import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/**
 * The reads behind the dashboard screens (Milestone 5) against the real database, on data made the way tracking makes
 * it: answers read and stored, a run settled into cells, the day rolled up. The cross-organization checks are in
 * tests/tenancy/repositories.test.js; the arithmetic is in src/core/dashboard.test.js.
 */

const db = connectTestDb();
const fx = fixtures(db);
let org;
let owner;
const scoped = () => db.forOrg(org.org.id);
const unique = () => Math.random().toString(36).slice(2, 8);
const hosts = [];

before(async () => {
  org = await fx.org();
  owner = org.owner;
});

after(async () => {
  await fx.forgetDomains(hosts);
  await fx.cleanup();
  await db.close();
});

const refuses = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof DomainError && e.code === code);

const WIDE = { from: '2020-01-01', to: '2099-12-31' };

/**
 * A project with a brand, a rival and two questions, and one settled check with five answers:
 *   question 1  perplexity  sample 0: names the brand at rank 1 and the rival at rank 2, cites g2 and the brand's site
 *               sample 1: names only the rival, cites g2
 *   question 2  perplexity  sample 0: names nobody, cites reddit
 *               gemini      sample 0: could not be collected (failed)
 *               perplexity  sample 1: collected but never read
 */
async function settledProject() {
  const project = await fx.project(org.org.id, `Dash ${unique()}`);
  await fx.engines(project, ['perplexity', 'gemini']);
  const brand = await fx.entity(project, {
    kind: 'brand',
    name: `Brand ${unique()}`,
    domains: ['brand.example.test'],
  });
  const rival = await fx.entity(project, { kind: 'competitor', name: `Rival ${unique()}` });
  const q1 = await fx.prompt(project, { text: `Best dentist ${unique()}?` });
  const q2 = await fx.prompt(project, { text: `Cheap dentist ${unique()}?` });
  const run = await fx.run(project, { status: 'rolling_up', trigger: 'schedule' });
  const g2 = `https://www.g2-${unique()}.example.test/reviews`;
  const reddit = `https://reddit-${unique()}.example.test/r/dentists`;
  hosts.push(new URL(g2).hostname.replace(/^www\./, ''), new URL(reddit).hostname);
  const brandSite = `https://brand-${unique()}.example.test/`;
  hosts.push(new URL(brandSite).hostname);

  await fx.readAnswer(run, q1, {
    excerpt: 'Top picks: the brand, then the rival.',
    mentions: [
      {
        entity: brand,
        listRank: 1,
        stance: 'recommended',
        sentiment: 2,
        excerpt: 'The brand is the top pick.',
      },
      { entity: rival, listRank: 2, stance: 'neutral', sentiment: 0 },
    ],
    citations: [{ url: g2 }, { url: brandSite, isOwn: true, owner: brand }],
  });
  await fx.readAnswer(run, q1, {
    sampleIdx: 1,
    excerpt: 'Only the rival.',
    mentions: [{ entity: rival, listRank: 1, stance: 'recommended', sentiment: 1 }],
    citations: [{ url: g2 }],
  });
  await fx.readAnswer(run, q2, { excerpt: 'Nobody in particular.', citations: [{ url: reddit }] });
  // A collection that failed, and one that was collected but never read: both are "couldn't check".
  const failed = await scoped().snapshots.create({
    runId: run.id,
    promptId: q2.id,
    engineCode: 'gemini',
    sampleIdx: 0,
    providerCode: 'dataforseo',
    method: 'ui_capture',
  });
  await scoped().snapshots.fail(failed.snapshot.id, 'provider down');
  await fx.collectedAnswer(run, q2, { engine: 'perplexity', sampleIdx: 1 });

  await scoped().runs.settle(run.id);
  await scoped().metrics.rollupDay(project.id, run.run_date);
  return { project, brand, rival, q1, q2, run };
}

describe('dashboard.matrix', () => {
  test('gives each active question its newest cell per engine, with the brand’s mentions', async () => {
    const { project, q1, q2 } = await settledProject();
    const { prompts, cells } = await scoped().dashboard.matrix(project.id, WIDE);
    assert.deepEqual(
      prompts.map((p) => p.id),
      [q1.id, q2.id],
    );

    const cell = (prompt, engine) =>
      cells.find((c) => c.promptId === prompt.id && c.engineCode === engine);
    // Question 1: two readable answers, the brand named in one.
    assert.deepEqual(
      [
        cell(q1, 'perplexity').status,
        cell(q1, 'perplexity').nOk,
        cell(q1, 'perplexity').kMentioned,
        cell(q1, 'perplexity').kRecommended,
      ],
      ['complete', 2, 1, 1],
    );
    // Question 2 on perplexity: one answer read (nobody named), one collected but unread → a partial cell.
    assert.deepEqual(
      [
        cell(q2, 'perplexity').status,
        cell(q2, 'perplexity').nOk,
        cell(q2, 'perplexity').nFailed,
        cell(q2, 'perplexity').kMentioned,
      ],
      ['partial', 1, 1, 0],
    );
    // Question 2 on gemini: nothing could be read.
    assert.deepEqual([cell(q2, 'gemini').status, cell(q2, 'gemini').nOk], ['failed', 0]);
    // Gemini was never asked question 1: no cell at all, which is not the same as a zero.
    assert.equal(cell(q1, 'gemini'), undefined);
  });

  test('ignores paused and archived questions and cells outside the period', async () => {
    const { project, q1, q2 } = await settledProject();
    await scoped().prompts.setStatus(q2.id, 'paused', { actorUserId: owner.id });
    const { prompts, cells } = await scoped().dashboard.matrix(project.id, WIDE);
    assert.deepEqual(
      prompts.map((p) => p.id),
      [q1.id],
    );
    assert.ok(cells.length > 0);
    const old = await scoped().dashboard.matrix(project.id, {
      from: '2001-01-01',
      to: '2001-02-01',
    });
    assert.deepEqual(old.cells, []);
  });

  test('refuses another organization’s project', async () => {
    const other = await fx.org();
    const theirs = await fx.project(other.org.id);
    await refuses(scoped().dashboard.matrix(theirs.id, WIDE), 'PROJECT_NOT_IN_ORG');
  });
});

describe('dashboard.question', () => {
  test('shows the history of one question and who was named for it', async () => {
    const { project, q1, brand, rival } = await settledProject();
    const detail = await scoped().dashboard.question(project.id, q1.id, WIDE);
    assert.equal(detail.prompt.id, q1.id);
    assert.equal(detail.history.length, 1);
    assert.equal(detail.history[0].kMentioned, 1);
    assert.equal(detail.readable, 2);
    // The rival was named in both answers, the brand in one.
    assert.deepEqual(
      detail.named.map((n) => [n.entityId, n.k, n.kind]),
      [
        [rival.id, 2, 'competitor'],
        [brand.id, 1, 'brand'],
      ],
    );
  });

  test('a question of another project is not found', async () => {
    const a = await settledProject();
    const b = await settledProject();
    assert.equal(await scoped().dashboard.question(a.project.id, b.q1.id, WIDE), null);
  });
});

describe('dashboard.answers', () => {
  test('lists the newest check’s answers with mentions and sources, and flags what could not be read', async () => {
    const { project, q1, q2, brand } = await settledProject();
    const first = await scoped().dashboard.answers(project.id, q1.id);
    assert.equal(first.snapshots.length, 2);
    const [one, two] = first.snapshots;
    assert.equal(one.read, true);
    assert.equal(one.textExcerpt, 'Top picks: the brand, then the rival.');
    assert.deepEqual(
      one.mentions.map((m) => [m.entityId === brand.id ? 'brand' : 'rival', m.listRank, m.stance]),
      [
        ['brand', 1, 'recommended'],
        ['rival', 2, 'neutral'],
      ],
    );
    assert.equal(one.citations.length, 2);
    assert.equal(one.citations[1].isOwn, true);
    assert.match(one.citations[0].domain, /^g2-/);
    assert.equal(two.mentions.length, 1);

    const second = await scoped().dashboard.answers(project.id, q2.id);
    const byState = Object.fromEntries(
      second.snapshots.map((s) => [`${s.engineCode}${s.sampleIdx}`, s]),
    );
    assert.equal(byState.perplexity0.read, true);
    assert.equal(byState.perplexity1.read, false, 'collected but unread is not a reading');
    assert.equal(byState.gemini0.status, 'failed');
    assert.equal(byState.gemini0.read, false);
  });

  test('a question that has never been checked has no answers', async () => {
    const { project } = await settledProject();
    const fresh = await fx.prompt(project);
    assert.equal(await scoped().dashboard.answers(project.id, fresh.id), null);
  });
});

describe('dashboard.competitorCells', () => {
  test('pools mentions and ranks per question and brand', async () => {
    const { project, q1, brand, rival } = await settledProject();
    const cells = await scoped().dashboard.competitorCells(project.id, WIDE);
    const of = (prompt, entity) =>
      cells.find((c) => c.promptId === String(prompt.id) && c.entityId === String(entity.id));
    assert.deepEqual([of(q1, brand).k, of(q1, brand).rankSum, of(q1, brand).rankN], [1, 1, 1]);
    assert.deepEqual(
      [of(q1, rival).k, of(q1, rival).rankSum, of(q1, rival).rankN],
      [2, 3, 2], // ranks 2 and 1
    );
  });
});

describe('dashboard.citations', () => {
  test('counts sources, shows which were cited where the brand was not named, and the brand’s own', async () => {
    const { project } = await settledProject();
    const { total, domains, urls } = await scoped().dashboard.citations(project.id, WIDE);
    assert.equal(total, 4); // g2 twice, the brand's site once, reddit once
    const g2 = domains.find((d) => d.domain.startsWith('g2-'));
    // g2 was cited in two answers; the brand was named in one of them.
    assert.deepEqual(
      [g2.timesCited, g2.answersCiting, g2.answersWithBrand, g2.own],
      [2, 2, 1, false],
    );
    assert.equal(g2.class, 'unclassified');
    const reddit = domains.find((d) => d.domain.startsWith('reddit-'));
    assert.deepEqual([reddit.answersCiting, reddit.answersWithBrand], [1, 0]);
    const own = domains.find((d) => d.own);
    assert.equal(own.ownerEntityIds.length, 1);
    assert.equal(domains[0].domain, g2.domain, 'most cited first');
    assert.equal(urls.find((u) => u.url.includes('g2-')).timesCited, 2);
  });

  test('a limit caps the lists', async () => {
    const { project } = await settledProject();
    const { domains } = await scoped().dashboard.citations(project.id, { ...WIDE, limit: 1 });
    assert.equal(domains.length, 1);
  });
});

describe('dashboard.reportAnswer', () => {
  test('writes a customer report to the review queue, once for the same person and reason', async () => {
    const { project, q1, brand } = await settledProject();
    const { snapshots } = await scoped().dashboard.answers(project.id, q1.id);
    const snapshot = snapshots[0];
    const first = await scoped().dashboard.reportAnswer(project.id, {
      snapshotId: snapshot.id,
      kind: 'not_us',
      entityId: brand.id,
      comment: '  That is a different company.  ',
      userId: owner.id,
    });
    assert.equal(first.created, true);
    const again = await scoped().dashboard.reportAnswer(project.id, {
      snapshotId: snapshot.id,
      kind: 'not_us',
      entityId: brand.id,
      userId: owner.id,
    });
    assert.deepEqual([again.created, again.id], [false, first.id]);
    // A different reason is a different report.
    const other = await scoped().dashboard.reportAnswer(project.id, {
      snapshotId: snapshot.id,
      kind: 'misread',
      userId: owner.id,
    });
    assert.equal(other.created, true);

    const reports = await scoped().dashboard.reportsFor(
      project.id,
      snapshots.map((s) => s.id),
    );
    assert.deepEqual(reports.map((r) => [r.kind, r.status]).sort(), [
      ['misread', 'open'],
      ['not_us', 'open'],
    ]);
  });

  test('refuses an answer of another project, an unknown reason and a foreign brand', async () => {
    const a = await settledProject();
    const b = await settledProject();
    const mine = (await scoped().dashboard.answers(a.project.id, a.q1.id)).snapshots[0];
    const theirs = (await scoped().dashboard.answers(b.project.id, b.q1.id)).snapshots[0];
    await refuses(
      scoped().dashboard.reportAnswer(a.project.id, {
        snapshotId: theirs.id,
        kind: 'misread',
        userId: owner.id,
      }),
      'SNAPSHOT_NOT_IN_PROJECT',
    );
    await refuses(
      scoped().dashboard.reportAnswer(a.project.id, {
        snapshotId: mine.id,
        kind: 'spam',
        userId: owner.id,
      }),
      'INVALID_REPORT_KIND',
    );
    await refuses(
      scoped().dashboard.reportAnswer(a.project.id, {
        snapshotId: mine.id,
        kind: 'not_us',
        entityId: b.brand.id,
        userId: owner.id,
      }),
      'ENTITY_NOT_IN_PROJECT',
    );
  });
});
