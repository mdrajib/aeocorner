import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { refreshProject } from '../../src/worker/handlers/actions.js';

/**
 * The Action Center against the real database (Milestone 6): the rules engine's reads, raising and updating
 * recommendations without duplicates, the lifecycle, the same-day re-check's bookkeeping, and the before/after
 * outcome. The cross-organization checks are in tests/tenancy/repositories.test.js; the arithmetic and the rules are in
 * src/core/*.test.js.
 */

const db = connectTestDb();
const fx = fixtures(db);
let org;
const scoped = () => db.forOrg(org.org.id);
const unique = () => Math.random().toString(36).slice(2, 8);
const DAY = 86_400_000;

before(async () => {
  org = await fx.org();
});

after(async () => {
  await fx.cleanup();
  await db.close();
});

const refuses = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof DomainError && e.code === code);

const check = (code, status, points, possible, summary = '') => ({
  code,
  status,
  points,
  possible,
  summary,
});

/**
 * A project with a brand, a rival and three questions, on two engines, with a finished scan (A1 failed outright, C1
 * partly, F3 passed, B1 could not be checked) and one week of cells (written directly, as exact counts):
 *   question 1  both engines: 10 answers each, the rival named 6 and 3 times, the brand never      → a lost question
 *   question 2  both engines: 10 answers each, the brand named 4 and 5 times                       → fine
 *   question 3  perplexity: a PARTIAL cell that names the brand; chatgpt: complete, brand never    → not lost
 */
async function world({ now = new Date() } = {}) {
  const project = await fx.project(org.org.id, `Actions ${unique()}`);
  await fx.engines(project, ['chatgpt', 'perplexity']);
  const brand = await fx.entity(project, { kind: 'brand', name: `Brand ${unique()}` });
  const rival = await fx.entity(project, { kind: 'competitor', name: `Rival ${unique()}` });
  const prompts = [];
  for (const text of [
    'Best family dentist?',
    'Cheap dentist near me?',
    'Emergency dentist open now?',
  ]) {
    prompts.push(await fx.prompt(project, { text: `${text} ${unique()}` }));
  }
  const scan = await fx.scan(project, {
    finishedAt: new Date(now.getTime() - DAY),
    checks: [
      check('A1', 'fail', 0, 8, 'robots.txt blocks OAI-SearchBot'),
      check('C1', 'partial', 3, 6),
      check('F3', 'pass', 3, 3),
      check('B1', 'error', 0, 7),
    ],
  });
  const run = await fx.run(project, {
    status: 'complete',
    runDate: new Date(now.getTime() - 2 * DAY),
    queuedAt: new Date(now.getTime() - 2 * DAY),
  });
  const [q1, q2, q3] = prompts;
  await fx.cell(run, q1, {
    engine: 'chatgpt',
    brand,
    brandK: 0,
    rivals: [{ entity: rival, k: 6 }],
  });
  await fx.cell(run, q1, {
    engine: 'perplexity',
    brand,
    brandK: 0,
    rivals: [{ entity: rival, k: 3 }],
  });
  await fx.cell(run, q2, { engine: 'chatgpt', brand, brandK: 4 });
  await fx.cell(run, q2, { engine: 'perplexity', brand, brandK: 5 });
  await fx.cell(run, q3, {
    engine: 'chatgpt',
    brand,
    brandK: 0,
    rivals: [{ entity: rival, k: 2 }],
  });
  await fx.cell(run, q3, { engine: 'perplexity', brand, brandK: 1, nOk: 4, status: 'partial' });
  return { project, brand, rival, prompts, scan, run };
}

const refresh = (w, now = new Date()) =>
  refreshProject({ db, scoped: scoped() }, { projectId: w.project.id, runId: w.run.id, now });

describe('what the rules engine reads', () => {
  test('signals(): the latest scan, the grid with who was named, complete cells only for "absent"', async () => {
    const w = await world();
    const now = new Date();
    const s = await scoped().recommendations.signals(w.project.id, {
      from: new Date(now.getTime() - 27 * DAY),
      to: now,
    });
    assert.equal(s.enginesCount, 2);
    assert.equal(s.prompts.length, 3);
    assert.equal(s.scan.id, w.scan.id);
    assert.deepEqual(
      s.scan.checks.map((c) => [c.code, c.status]),
      [
        ['A1', 'fail'],
        ['B1', 'error'],
        ['C1', 'partial'],
        ['F3', 'pass'],
      ],
    );
    assert.equal(s.scan.checks[0].summary, 'robots.txt blocks OAI-SearchBot');
    const byPrompt = Object.fromEntries(s.grid.map((r) => [r.promptId, r]));
    const q1 = byPrompt[String(w.prompts[0].id)];
    assert.deepEqual(
      q1.engines.map((e) => [e.engineCode, e.status, e.nOk, e.brandK, e.rivals.map((r) => r.k)]),
      [
        ['chatgpt', 'complete', 10, 0, [6]],
        ['perplexity', 'complete', 10, 0, [3]],
      ],
    );
    const q3 = byPrompt[String(w.prompts[2].id)];
    const partial = q3.engines.find((e) => e.engineCode === 'perplexity');
    assert.deepEqual([partial.status, partial.nOk, partial.brandK], ['partial', 0, 1]);
    assert.equal(s.answersTotal, 10 + 10 + 10 + 10 + 10);
    assert.equal(s.brandName, w.brand.name);
  });

  test('signals(): the latest scan wins, and a scan that failed is ignored', async () => {
    const w = await world();
    const now = new Date();
    await fx.scan(w.project, {
      status: 'failed',
      finishedAt: new Date(now.getTime() + 1000),
      checks: [],
    });
    const newer = await fx.scan(w.project, {
      finishedAt: new Date(now.getTime() + 2000),
      checks: [check('A1', 'pass', 8, 8)],
    });
    const s = await scoped().recommendations.signals(w.project.id, {
      from: new Date(now - 27 * DAY),
      to: new Date(now.getTime() + DAY),
    });
    assert.equal(s.scan.id, newer.id);
  });

  test('signals(): the brand’s sentiment is summed over the window', async () => {
    const w = await world();
    const run = await fx.run(w.project, { status: 'complete' });
    await fx.cell(run, w.prompts[1], {
      engine: 'chatgpt',
      brand: w.brand,
      brandK: 8,
      sentiment: -2,
    });
    const now = new Date();
    const s = await scoped().recommendations.signals(w.project.id, {
      from: new Date(now - 27 * DAY),
      to: new Date(now.getTime() + DAY),
    });
    // the world's own cells have sentiment 0 (4 + 5 + 1 mentions), plus 8 mentions at -2
    assert.deepEqual(s.sentiment, { n: 4 + 5 + 1 + 8, sum: -16 });
  });
});

describe('raising recommendations', () => {
  test('the rules raise what the evidence supports, with words, scope and a score', async () => {
    const w = await world();
    const result = await refresh(w);
    // A1 (fail) and C1 (partial) from the scan; question 1 is lost; question 3 is not (a partial cell names the brand)
    assert.equal(result.candidates, 3);
    assert.equal(result.created.length, 3);
    const todo = await scoped().recommendations.list(w.project.id, { view: 'todo' });
    assert.deepEqual(
      todo.map((r) => r.stableKey).sort(),
      [`visibility.lost_prompt:${w.prompts[0].id}`, 'readiness.A1:a1', 'readiness.C1:c1'].sort(),
    );
    const a1 = todo.find((r) => r.ruleCode === 'readiness.A1');
    assert.equal(a1.status, 'open');
    assert.equal(a1.fixPath, 'auto_fix');
    assert.equal(a1.category, 'crawler_access');
    assert.equal(a1.effort, 1);
    assert.equal(a1.evidence.type, 'readiness');
    assert.equal(a1.evidence.check.code, 'A1');
    assert.match(a1.whyMd, /earned 0 of 8 points/);
    assert.match(a1.stepsMd, /^1\. /);
    assert.equal(a1.narrativeVersion, 't1');
    assert.equal(a1.questions, 3); // a site-wide fix targets every active question
    assert.ok(a1.ice > 0 && a1.impact === 100);
    const lost = todo.find((r) => r.ruleCode === 'visibility.lost_prompt');
    assert.equal(lost.questions, 1);
    assert.equal(lost.fixPath, 'content');
    assert.deepEqual(
      lost.evidence.competitors.map((c) => c.k),
      [9],
    );
    // best first
    assert.deepEqual(
      todo.map((r) => r.ice),
      [...todo.map((r) => r.ice)].sort((a, b) => b - a),
    );
  });

  test('running it again changes nothing: one row per issue, however often it runs', async () => {
    const w = await world();
    await refresh(w);
    const again = await refresh(w);
    assert.equal(again.created.length, 0);
    assert.equal(again.updated, 3);
    const all = (await scoped().recommendations.counts(w.project.id)).todo;
    assert.equal(all, 3);
  });

  test('two refreshes at the same moment do not make two rows', async () => {
    const w = await world();
    await Promise.all([refresh(w), refresh(w), refresh(w)]);
    assert.equal((await scoped().recommendations.counts(w.project.id)).todo, 3);
  });

  test('a check that could not be run is not an issue', async () => {
    const w = await world();
    await refresh(w);
    const keys = (await scoped().recommendations.list(w.project.id)).map((r) => r.ruleCode);
    assert.ok(!keys.includes('readiness.B1'));
    assert.ok(!keys.includes('readiness.F3'));
  });

  test('when the problem is fixed on the site the signal is marked cleared, and it leaves "top"', async () => {
    const w = await world();
    await refresh(w);
    assert.equal((await scoped().recommendations.top(w.project.id, 5)).length, 3);
    await fx.scan(w.project, {
      finishedAt: new Date(Date.now() + 60_000),
      checks: [check('A1', 'pass', 8, 8), check('C1', 'partial', 3, 6)],
    });
    const result = await refresh(w, new Date(Date.now() + 120_000));
    assert.equal(result.cleared, 1);
    const todo = await scoped().recommendations.list(w.project.id, { view: 'todo' });
    const a1 = todo.find((r) => r.ruleCode === 'readiness.A1');
    assert.ok(a1.signalClearedAt);
    assert.deepEqual(
      (await scoped().recommendations.top(w.project.id, 5)).map((r) => r.ruleCode).sort(),
      ['readiness.C1', 'visibility.lost_prompt'],
    );
    // and if it comes back, the mark goes
    await fx.scan(w.project, {
      finishedAt: new Date(Date.now() + 180_000),
      checks: [check('A1', 'fail', 0, 8), check('C1', 'partial', 3, 6)],
    });
    await refresh(w, new Date(Date.now() + 240_000));
    const back = (await scoped().recommendations.list(w.project.id, { view: 'todo' })).find(
      (r) => r.ruleCode === 'readiness.A1',
    );
    assert.equal(back.signalClearedAt, null);
  });

  test('a project that has no scan yet has not "fixed" its readiness issues', async () => {
    const w = await world();
    await refresh(w);
    const bare = await fx.project(org.org.id, `Bare ${unique()}`);
    const out = await refreshProject(
      { db, scoped: scoped() },
      { projectId: bare.id, now: new Date() },
    );
    assert.equal(out.candidates, 0);
    assert.equal(out.cleared, 0);
  });

  test('an issue the caps left out is not mistaken for a fixed one', async () => {
    const w = await world();
    const rival = w.rival;
    const run = await fx.run(w.project, { status: 'complete' });
    // twelve more lost questions: the engine raises ten of the thirteen and must keep all of them "live"
    for (let i = 0; i < 12; i += 1) {
      const q = await fx.prompt(w.project, { text: `Extra question ${i} ${unique()}?` });
      await fx.cell(run, q, {
        engine: 'chatgpt',
        brand: w.brand,
        brandK: 0,
        rivals: [{ entity: rival, k: 5 }],
      });
    }
    const first = await refresh(w);
    assert.equal(first.candidates, 12); // 2 readiness + 10 lost questions
    const lostBefore = (await scoped().recommendations.list(w.project.id)).filter(
      (r) => r.ruleCode === 'visibility.lost_prompt',
    );
    assert.equal(lostBefore.length, 10);
    const second = await refresh(w);
    assert.equal(second.cleared, 0);
  });
});

describe('the lifecycle', () => {
  async function raised(extra = {}) {
    const w = await world();
    await refresh(w);
    const todo = await scoped().recommendations.list(w.project.id, { view: 'todo' });
    return { ...w, ...extra, rec: (code) => todo.find((r) => r.ruleCode === code) };
  }

  test('start, stop and dismiss are a person’s; each is recorded', async () => {
    const w = await raised();
    const rec = w.rec('readiness.C1');
    const start = await scoped().recommendations.transition(w.project.id, rec.id, 'in_progress', {
      userId: org.owner.id,
    });
    assert.equal(start.status, 'in_progress');
    await scoped().recommendations.transition(w.project.id, rec.id, 'open', {
      userId: org.owner.id,
    });
    const detail = await scoped().recommendations.get(w.project.id, rec.id);
    assert.deepEqual(
      detail.events.map((e) => `${e.fromStatus ?? '-'}>${e.toStatus}:${e.actorType}`),
      ['->open:system', 'open>in_progress:user', 'in_progress>open:user'],
    );
  });

  test('dismissing needs a reason, and takes the recommendation off the list', async () => {
    const w = await raised();
    const rec = w.rec('readiness.C1');
    await refuses(
      scoped().recommendations.transition(w.project.id, rec.id, 'dismissed', {}),
      'DISMISS_REASON_REQUIRED',
    );
    await refuses(
      scoped().recommendations.transition(w.project.id, rec.id, 'dismissed', {
        dismissReason: 'because',
      }),
      'DISMISS_REASON_REQUIRED',
    );
    const gone = await scoped().recommendations.transition(w.project.id, rec.id, 'dismissed', {
      dismissReason: 'wont_do',
      dismissNote: 'Not now',
    });
    assert.equal(gone.status, 'dismissed');
    assert.equal(gone.dismissReason, 'wont_do');
    const counts = await scoped().recommendations.counts(w.project.id);
    assert.deepEqual([counts.todo, counts.dismissed], [2, 1]);
  });

  test('a person can never verify a fix, declare a win, or mark done through transition()', async () => {
    const w = await raised();
    const rec = w.rec('readiness.C1');
    for (const to of [
      'verified',
      'measuring',
      'proven_win',
      'declined',
      'no_change',
      'unverified',
    ]) {
      await refuses(
        scoped().recommendations.transition(w.project.id, rec.id, to),
        'INVALID_TRANSITION',
      );
    }
    await refuses(
      scoped().recommendations.transition(w.project.id, rec.id, 'done'),
      'USE_MARK_DONE',
    );
    await refuses(
      scoped().recommendations.transition(w.project.id, 999999999n, 'in_progress'),
      'RECOMMENDATION_NOT_FOUND',
    );
  });

  test('a dismissed issue is not raised again for 90 days, and a declined one at once as a follow-up', async () => {
    const w = await raised();
    const c1 = w.rec('readiness.C1');
    await scoped().recommendations.transition(w.project.id, c1.id, 'dismissed', {
      dismissReason: 'wont_do',
    });
    const quiet = await refresh(w);
    assert.equal(quiet.suppressed, 1);
    assert.equal(quiet.created.length, 0);
    const later = await refresh(w, new Date(Date.now() + 91 * DAY));
    assert.equal(later.created.length, 1);

    const a1 = w.rec('readiness.A1');
    await fx.forceRecommendation(a1.id, { status: 'declined' });
    const follow = await refresh(w);
    assert.equal(follow.created.length, 1);
    const all = await scoped().recommendations.list(w.project.id, { view: 'todo' });
    const second = all.find((r) => r.ruleCode === 'readiness.A1');
    assert.equal(second.parentId, a1.id);
    assert.notEqual(second.id, a1.id);
  });

  test('marking done saves the baseline and plans the three re-checks of a readiness fix', async () => {
    const w = await raised();
    const rec = w.rec('readiness.A1');
    const now = new Date();
    const done = await scoped().recommendations.markDone(w.project.id, rec.id, {
      userId: org.owner.id,
      now,
    });
    assert.equal(done.verifiable, true);
    assert.equal(done.recommendation.status, 'done');
    const baseline = done.recommendation.baseline;
    // all three questions: 30 complete answers in the one run (the partial cell of question 3 is left out); brand named 9 times
    assert.equal(baseline.n, 50);
    assert.equal(baseline.k, 9);
    assert.deepEqual(baseline.promptIds.sort(), w.prompts.map((p) => String(p.id)).sort());
    assert.equal(baseline.partialCellsLeftOut, 1);
    const attempts = await scoped().recommendations.verificationsOf(w.project.id, rec.id);
    assert.deepEqual(
      attempts.map((a) => [a.attempt, a.status, a.method]),
      [
        [1, 'pending', 'readiness_check'],
        [2, 'pending', 'readiness_check'],
        [3, 'pending', 'readiness_check'],
      ],
    );
    assert.deepEqual(
      attempts.map((a) => a.scheduledFor.getTime() - now.getTime()),
      [0, 3_600_000, 86_400_000],
    );
  });

  test('a fix a machine cannot check goes straight to measuring', async () => {
    const w = await raised();
    const rec = w.rec('visibility.lost_prompt');
    const out = await scoped().recommendations.markDone(w.project.id, rec.id, {
      userId: org.owner.id,
    });
    assert.equal(out.verifiable, false);
    assert.equal(out.recommendation.status, 'measuring');
    assert.ok(out.recommendation.measuringStartedAt);
    // its scope is its own question: 20 complete answers, none naming the brand
    assert.deepEqual([out.recommendation.baseline.n, out.recommendation.baseline.k], [20, 0]);
    const detail = await scoped().recommendations.get(w.project.id, rec.id);
    assert.deepEqual(
      detail.events.map((e) => e.toStatus),
      ['open', 'done', 'unverified', 'measuring'],
    );
    assert.equal(detail.verifications[0].status, 'not_verifiable');
  });

  test('a verified fix moves on to measuring; a failed re-check leaves it unverified until the customer confirms', async () => {
    const w = await raised();
    const a1 = w.rec('readiness.A1');
    const c1 = w.rec('readiness.C1');
    await scoped().recommendations.markDone(w.project.id, a1.id, { userId: org.owner.id });
    await scoped().recommendations.markDone(w.project.id, c1.id, { userId: org.owner.id });

    assert.equal(
      await scoped().recommendations.recordVerification(w.project.id, a1.id, {
        attempt: 1,
        status: 'passed',
      }),
      true,
    );
    // a finished attempt is not overwritten
    assert.equal(
      await scoped().recommendations.recordVerification(w.project.id, a1.id, {
        attempt: 1,
        status: 'failed',
      }),
      false,
    );
    const ok = await scoped().recommendations.settleVerification(w.project.id, a1.id, {
      verdict: 'verified',
      reason: 'passed',
    });
    assert.deepEqual([ok.changed, ok.status], [true, 'measuring']);
    // settling twice is a no-op
    assert.equal(
      (
        await scoped().recommendations.settleVerification(w.project.id, a1.id, {
          verdict: 'verified',
          reason: 'passed',
        })
      ).changed,
      false,
    );

    const bad = await scoped().recommendations.settleVerification(w.project.id, c1.id, {
      verdict: 'unverified',
      reason: 'still_failing',
    });
    assert.deepEqual([bad.changed, bad.status], [true, 'unverified']);
    const confirmed = await scoped().recommendations.transition(w.project.id, c1.id, 'measuring', {
      userId: org.owner.id,
    });
    assert.equal(confirmed.status, 'measuring');
    assert.ok(confirmed.measuringStartedAt);
  });

  test('"fix it again" from unverified forgets the old check and baseline', async () => {
    const w = await raised();
    const c1 = w.rec('readiness.C1');
    await scoped().recommendations.markDone(w.project.id, c1.id, { userId: org.owner.id });
    await scoped().recommendations.settleVerification(w.project.id, c1.id, {
      verdict: 'unverified',
      reason: 'still_failing',
    });
    const again = await scoped().recommendations.transition(w.project.id, c1.id, 'in_progress', {
      userId: org.owner.id,
    });
    assert.deepEqual([again.status, again.baseline, again.doneAt], ['in_progress', null, null]);
    assert.deepEqual(await scoped().recommendations.verificationsOf(w.project.id, c1.id), []);
    // and it can be marked done again, with a fresh set of re-checks
    const second = await scoped().recommendations.markDone(w.project.id, c1.id, {
      userId: org.owner.id,
    });
    assert.equal(second.recommendation.status, 'done');
    assert.equal((await scoped().recommendations.verificationsOf(w.project.id, c1.id)).length, 3);
  });

  test('once done, a refresh no longer changes what the fix is measured against', async () => {
    const w = await raised();
    const a1 = w.rec('readiness.A1');
    await scoped().recommendations.markDone(w.project.id, a1.id, { userId: org.owner.id });
    const before = (await scoped().recommendations.get(w.project.id, a1.id)).recommendation;
    await fx.prompt(w.project, { text: `A brand new question ${unique()}?` });
    await refresh(w);
    const after = (await scoped().recommendations.get(w.project.id, a1.id)).recommendation;
    assert.deepEqual(after.baseline, before.baseline);
    assert.equal((await scoped().recommendations.get(w.project.id, a1.id)).prompts.length, 3);
    assert.equal(after.title, before.title);
  });

  test('only the words, never the scope, of a recommendation that moved on can be rewritten', async () => {
    const w = await raised();
    const c1 = w.rec('readiness.C1');
    const hash = (await scoped().recommendations.get(w.project.id, c1.id)).recommendation.evidence;
    const { canonicalJson } = await import('../../src/core/canonical-json.js');
    assert.equal(
      await scoped().recommendations.saveNarrative(w.project.id, c1.id, {
        why: 'New words that say more than the template did here.',
        steps: '1. Do it.\n2. Then mark it done.',
        version: 'n1',
        evidenceHash: canonicalJson({ different: true }),
      }),
      false,
    );
    assert.equal(
      await scoped().recommendations.saveNarrative(w.project.id, c1.id, {
        why: 'New words that say more than the template did here.',
        steps: '1. Do it.\n2. Then mark it done.',
        version: 'n1',
        evidenceHash: canonicalJson(hash),
      }),
      true,
    );
    // a model-written narrative survives a refresh whose evidence did not change
    await refresh(w);
    const kept = (await scoped().recommendations.get(w.project.id, c1.id)).recommendation;
    assert.equal(kept.narrativeVersion, 'n1');
    assert.match(kept.whyMd, /^New words/);
    // ...but not one that has moved on
    await scoped().recommendations.markDone(w.project.id, c1.id, { userId: org.owner.id });
    assert.equal(
      await scoped().recommendations.saveNarrative(w.project.id, c1.id, {
        why: 'x'.repeat(50),
        steps: '1. y',
        version: 'n1',
      }),
      false,
    );
  });
});

describe('before and after', () => {
  const t0 = new Date('2026-10-03T12:00:00Z');

  /**
   * A project with one question on two engines and a failed readiness check (A1). Four earlier runs, one a week, each
   * with 10 readable answers on each engine, name the brand `beforeK` times in all: a baseline of 80 answers. The fix is
   * marked done at t0, its re-check passes, and measuring starts. `afterRuns` are runs queued after t0:
   * `[daysAfter, brandKPerEngine]`, each 10 answers on each engine.
   */
  async function measured({ beforeK, afterRuns }) {
    const project = await fx.project(org.org.id, `Measured ${unique()}`);
    await fx.engines(project, ['chatgpt', 'perplexity']);
    const brand = await fx.entity(project, { kind: 'brand', name: `Brand ${unique()}` });
    const rival = await fx.entity(project, { kind: 'competitor', name: `Rival ${unique()}` });
    const q = await fx.prompt(project, { text: `Lost question ${unique()}?` });
    await fx.scan(project, {
      finishedAt: new Date(t0.getTime() - DAY),
      checks: [check('A1', 'fail', 0, 8)],
    });
    const run = async (daysFromT0) => {
      const at = new Date(t0.getTime() + daysFromT0 * DAY);
      return fx.run(project, { status: 'complete', runDate: at, queuedAt: at });
    };
    for (const days of [-21, -14, -7, -1]) {
      const r = await run(days);
      const each = beforeK / 4 / 2;
      await fx.cell(r, q, {
        engine: 'chatgpt',
        brand,
        brandK: each,
        nOk: 10,
        rivals: [{ entity: rival, k: 5 }],
      });
      await fx.cell(r, q, {
        engine: 'perplexity',
        brand,
        brandK: each,
        nOk: 10,
        rivals: [{ entity: rival, k: 5 }],
      });
    }
    await refreshProject({ db, scoped: scoped() }, { projectId: project.id, now: t0 });
    const todo = await scoped().recommendations.list(project.id, { view: 'todo' });
    const rec = todo.find((r) => r.ruleCode === 'readiness.A1');
    assert.ok(rec, 'the failed check is raised');
    await scoped().recommendations.markDone(project.id, rec.id, { userId: org.owner.id, now: t0 });
    await scoped().recommendations.recordVerification(project.id, rec.id, {
      attempt: 1,
      status: 'passed',
      now: t0,
    });
    const settled = await scoped().recommendations.settleVerification(project.id, rec.id, {
      verdict: 'verified',
      reason: 'passed',
      now: t0,
    });
    assert.equal(settled.status, 'measuring');
    for (const [days, k] of afterRuns) {
      const r = await run(days);
      await fx.cell(r, q, { engine: 'chatgpt', brand, brandK: k, nOk: 10 });
      await fx.cell(r, q, { engine: 'perplexity', brand, brandK: k, nOk: 10 });
    }
    return { project, brand, prompts: [q], rec };
  }

  test('the baseline is the four weeks before the fix; the after window counts later runs only', async () => {
    const m = await measured({ beforeK: 40, afterRuns: [[3, 9]] });
    const detail = await scoped().recommendations.get(m.project.id, m.rec.id);
    assert.deepEqual(
      [detail.recommendation.baseline.n, detail.recommendation.baseline.k],
      [80, 40],
    );
    assert.deepEqual(detail.recommendation.baseline.promptIds, [String(m.prompts[0].id)]);
  });

  test('before the horizon nothing is measured', async () => {
    const m = await measured({ beforeK: 0, afterRuns: [[3, 5]] });
    const early = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 13 * DAY),
    });
    assert.deepEqual(early, { skipped: 'not_due' });
  });

  test('a significant rise at two weeks is a proven win, and the recommendation closes as one', async () => {
    // baseline 80 answers, none naming the brand; after 3 runs × 20 answers = 60, 4 named per engine per run = 24
    const m = await measured({
      beforeK: 0,
      afterRuns: [
        [3, 4],
        [7, 4],
        [10, 4],
      ],
    });
    const result = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 15 * DAY),
    });
    assert.equal(result.horizon, 'week_2');
    assert.equal(result.verdict, 'proven_win');
    assert.equal(result.status, 'proven_win');
    const detail = await scoped().recommendations.get(m.project.id, m.rec.id);
    const [outcome] = detail.outcomes;
    assert.deepEqual(
      [outcome.nBefore, outcome.kBefore, outcome.nAfter, outcome.kAfter],
      [80, 0, 60, 24],
    );
    assert.equal(outcome.rateBefore, 0);
    assert.equal(outcome.rateAfter, 0.4);
    assert.equal(outcome.deltaPp, 40);
    assert.ok(outcome.p < 0.001);
    assert.equal(detail.recommendation.status, 'proven_win');
    assert.deepEqual(await scoped().recommendations.provenWins(m.project.id), {
      recommendations: 1,
      questions: 1,
    });
    // measuring again is a no-op
    assert.deepEqual(
      await scoped().outcomes.measure(m.project.id, m.rec.id, {
        now: new Date(t0.getTime() + 16 * DAY),
      }),
      { skipped: 'not_measuring' },
    );
    // the rule engine does not raise the same fix again for a while
    const again = await refreshProject(
      { db, scoped: scoped() },
      { projectId: m.project.id, now: new Date(t0.getTime() + 16 * DAY) },
    );
    assert.equal(again.suppressed, 1);
  });

  test('a significant fall is a decline, and the same issue is raised again as its follow-up', async () => {
    // before: 40 of 80 (50%); after: 6 of 60 (10%)
    const m = await measured({
      beforeK: 40,
      afterRuns: [
        [3, 1],
        [7, 1],
        [10, 1],
      ],
    });
    const result = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 15 * DAY),
    });
    assert.deepEqual([result.verdict, result.status], ['declined', 'declined']);
    // the check is failing in the latest scan, so the engine finds it again, at once, with the old one as its parent
    const raised = await refreshProject(
      { db, scoped: scoped() },
      { projectId: m.project.id, now: new Date(t0.getTime() + 16 * DAY) },
    );
    assert.equal(raised.created.length, 1);
    const [follow] = (await scoped().recommendations.list(m.project.id, { view: 'todo' })).filter(
      (r) => r.ruleCode === 'readiness.A1',
    );
    assert.equal(follow.parentId, m.rec.id);
  });

  test('no change at two weeks keeps measuring; at four weeks it ends as no change', async () => {
    // the rate does not move: 40 of 80 before, 30 of 60 after
    const m = await measured({
      beforeK: 40,
      afterRuns: [
        [3, 5],
        [7, 5],
        [10, 5],
      ],
    });
    const w2 = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 15 * DAY),
    });
    assert.deepEqual([w2.horizon, w2.verdict, w2.status], ['week_2', 'no_change', 'measuring']);
    const w4 = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 29 * DAY),
    });
    assert.deepEqual([w4.horizon, w4.verdict, w4.status], ['week_4', 'no_change', 'no_change']);
    const detail = await scoped().recommendations.get(m.project.id, m.rec.id);
    assert.deepEqual(
      detail.outcomes.map((o) => o.horizon),
      ['week_2', 'week_4'],
    );
    assert.deepEqual(await scoped().recommendations.provenWins(m.project.id), {
      recommendations: 0,
      questions: 0,
    });
  });

  test('too few readable answers is "not enough data", never "no change"', async () => {
    const m = await measured({ beforeK: 0, afterRuns: [] });
    const w2 = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 15 * DAY),
    });
    assert.equal(w2.verdict, 'insufficient_data');
    assert.equal(w2.status, 'measuring');
    const [outcome] = (await scoped().recommendations.get(m.project.id, m.rec.id)).outcomes;
    assert.deepEqual(
      [outcome.nAfter, outcome.rateAfter, outcome.deltaPp, outcome.p],
      [0, null, null, null],
    );
    const w4 = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 29 * DAY),
    });
    assert.deepEqual([w4.verdict, w4.status], ['insufficient_data', 'no_change']);
  });

  test('a half-collected run is left out of the after window, not counted as "not mentioned"', async () => {
    const m = await measured({
      beforeK: 0,
      afterRuns: [
        [3, 4],
        [7, 4],
        [10, 4],
      ],
    });
    const at = new Date(t0.getTime() + 12 * DAY);
    const partial = await fx.run(m.project, { status: 'partial', runDate: at, queuedAt: at });
    await fx.cell(partial, m.prompts[0], {
      engine: 'chatgpt',
      brand: m.brand,
      brandK: 0,
      nOk: 9,
      status: 'partial',
    });
    const result = await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 15 * DAY),
    });
    assert.equal(result.verdict, 'proven_win');
    const [outcome] = (await scoped().recommendations.get(m.project.id, m.rec.id)).outcomes;
    assert.equal(outcome.nAfter, 60); // the partial cell's 9 answers are not in it
  });

  test('the cross-organization lookups give the worker only what is due', async () => {
    const m = await measured({
      beforeK: 0,
      afterRuns: [
        [3, 4],
        [7, 4],
        [10, 4],
      ],
    });
    const notYet = await db.system.outcomes.due({ now: new Date(t0.getTime() + 13 * DAY) });
    assert.ok(!notYet.some((d) => d.recommendationId === m.rec.id));
    const due = await db.system.outcomes.due({ now: new Date(t0.getTime() + 15 * DAY) });
    const mine = due.find((d) => d.recommendationId === m.rec.id);
    assert.deepEqual([mine.orgId, mine.projectId], [org.org.id, m.project.id]);
    await scoped().outcomes.measure(m.project.id, m.rec.id, {
      now: new Date(t0.getTime() + 15 * DAY),
    });
    const after = await db.system.outcomes.due({ now: new Date(t0.getTime() + 15 * DAY) });
    assert.ok(!after.some((d) => d.recommendationId === m.rec.id));
    const stats = await db.system.outcomes.ruleStats();
    assert.ok(stats['readiness.A1'].decided >= 1);
    assert.ok(stats['readiness.A1'].wins >= 1);
  });

  test('re-checks that never ran are found by the safety net', async () => {
    const w = await world();
    await refresh(w);
    const rec = (await scoped().recommendations.list(w.project.id, { view: 'todo' })).find(
      (r) => r.ruleCode === 'readiness.A1',
    );
    const long = new Date(Date.now() - 3 * 3_600_000);
    await scoped().recommendations.markDone(w.project.id, rec.id, {
      userId: org.owner.id,
      now: long,
    });
    const overdue = await db.system.verifications.overdue({ now: new Date() });
    // attempts 1 (at once) and 2 (after an hour) are past due, attempt 3 (a day) is not
    const mine = overdue.filter((o) => o.recommendationId === rec.id).map((o) => o.attempt);
    assert.deepEqual(mine, [1, 2]);
  });
});
