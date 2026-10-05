import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pino from 'pino';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createNotifier } from '../../src/lib/notify.js';
import { alertsEvaluate } from '../../src/worker/handlers/digest.js';
import { evaluateProject, recoveryHandlers } from '../../src/worker/handlers/recovery.js';

/**
 * Visibility recovery cases (Milestone 14) against the real database: a decline that has lasted opens exactly one case however
 * many times the job runs, the re-check and the diagnosis are saved, the case closes once and only the system moves it, and
 * the alert is told once. Daily rollup rows are written directly (`fx.seedMetrics`), so weeks of history cost nothing.
 */

const db = connectTestDb();
const fx = fixtures(db);
const logger = pino({ level: 'silent' });
const DAY = 86_400_000;
const NOW = new Date('2026-09-30T10:00:00Z');
const dayAt = (offset, from = NOW) =>
  new Date(from.getTime() + offset * DAY).toISOString().slice(0, 10);

let org;
let scoped;
before(async () => {
  org = await fx.org();
  scoped = org.scoped;
  await fx.setOrg(org.org.id, { plan_code: 'growth', billing_status: 'active' });
});
after(async () => {
  await fx.cleanup();
  await db.close();
});

/** Brand rows, `n` answers a day: `[from, to, rate]` offsets in days from NOW. */
const rowsFor = (spans, { engine = 'chatgpt', partial = 0 } = {}) =>
  spans.flatMap(([from, to, rate]) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      date: dayAt(from + i),
      engine,
      entityKind: 'brand',
      nAnswers: 10,
      kMentioned: Math.round(rate * 10),
      cellsPartial: partial,
    })),
  );

/** A project whose brand was at 60%, then 50%, and has been at 20% for the last fortnight. */
async function declining({
  spans = [
    [-55, -28, 0.6],
    [-27, -14, 0.5],
    [-13, 0, 0.2],
  ],
} = {}) {
  const project = await fx.project(org.org.id, `Recovery ${Math.random()}`, {
    status: 'active',
    slotHour: 4,
  });
  await fx.engines(project, ['chatgpt']);
  await fx.seedMetrics(project, rowsFor(spans));
  return project;
}

function ctxFor(extra = {}) {
  const queued = [];
  return {
    queued,
    db,
    logger,
    now: () => NOW,
    jobs: { add: async (name, data, opts) => queued.push({ name, data, opts }) },
    ...extra,
  };
}
const evaluate = (ctx, project, now = NOW) =>
  evaluateProject(ctx, { orgId: org.org.id, projectId: project.id, now });
const openCases = (project) => scoped.recovery.list(project.id, { view: 'open' });

describe('recovery.evaluate: opening', () => {
  test('a decline that has lasted opens exactly one case, however often (or at once) it runs', async () => {
    const project = await declining();
    const ctx = ctxFor();
    const results = await Promise.all([evaluate(ctx, project), evaluate(ctx, project)]);
    await evaluate(ctx, project);
    const cases = await openCases(project);
    assert.equal(cases.length, 1, JSON.stringify(results));
    const [kase] = cases;
    assert.deepEqual(
      [kase.metric, kase.engineCode, kase.status],
      ['mention_rate', null, 'diagnosing'],
    );
    assert.deepEqual(kase.baseline, { start: dayAt(-55), end: dayAt(-28), n: 280, k: 168 });
    assert.equal(kase.recent.n, 140);
    assert.equal(kase.openKey, 'mention_rate:all');
    // The timeline holds the opening once, and one re-check was asked for.
    const events = await scoped.recovery.events(project.id, kase.id);
    assert.deepEqual(
      events.map((e) => e.kind),
      ['opened'],
    );
    assert.equal(ctx.queued.filter((j) => j.name === 'recovery.recheck').length, 1);
    // Share of voice and the per-engine decline are folded into it: one case, not three.
    assert.equal((await scoped.recovery.list(project.id)).length, 1);
  });

  test('a one-run dip that came back opens nothing', async () => {
    const project = await declining({
      spans: [
        [-55, -28, 0.6],
        [-27, -14, 0.2],
        [-13, 0, 0.6],
      ],
    });
    await evaluate(ctxFor(), project);
    assert.deepEqual(await scoped.recovery.list(project.id), []);
  });

  test('days an engine did not finish are never read as the customer’s decline', async () => {
    const project = await fx.project(org.org.id, 'Outage', { status: 'active', slotHour: 4 });
    await fx.engines(project, ['chatgpt']);
    await fx.seedMetrics(project, [
      ...rowsFor([[-55, -14, 0.6]]),
      ...rowsFor([[-13, 0, 0.1]], { partial: 1 }),
    ]);
    await evaluate(ctxFor(), project);
    assert.deepEqual(await scoped.recovery.list(project.id), []);
  });

  test('an archived project, or one with no history, is left alone', async () => {
    const empty = await fx.project(org.org.id, 'Empty', { status: 'active', slotHour: 4 });
    await fx.entity(empty, { kind: 'brand', name: 'Empty Co' });
    assert.deepEqual((await evaluate(ctxFor(), empty)).opened, []);
  });
});

describe('recovery.recheck and the diagnosis', () => {
  test('saves the re-check once and says "can’t tell" when nothing lines up', async () => {
    const project = await declining();
    const ctx = ctxFor();
    await evaluate(ctx, project);
    const [kase] = await openCases(project);
    const data = {
      orgId: String(org.org.id),
      projectId: String(project.id),
      caseId: String(kase.id),
    };
    const first = await recoveryHandlers['recovery.recheck'](ctx, data, {});
    const again = await recoveryHandlers['recovery.recheck'](ctx, data, {});
    assert.equal(first.status, 'diagnosing');
    assert.equal(again.repeated, true);
    const fresh = await scoped.recovery.byId(project.id, kase.id);
    assert.ok(fresh.recheckDoneAt);
    assert.equal(fresh.diagnosis.outcome, 'cant_tell');
    assert.deepEqual(fresh.repairs, []);
    // Evaluating again re-reads the diagnosis without repeating the timeline.
    await evaluate(ctx, project);
    const kinds = (await scoped.recovery.events(project.id, kase.id)).map((e) => e.kind);
    assert.deepEqual(kinds, ['opened', 'rechecked', 'diagnosed']);
  });

  test('names a readiness regression, moves to repairing and links the repair already on the Actions list', async () => {
    const project = await declining();
    const ctx = ctxFor();
    await fx.scan(project, {
      finishedAt: new Date(`${dayAt(-40)}T05:00:00Z`),
      checks: [{ code: 'A1', status: 'pass', points: 8, possible: 8 }],
    });
    await fx.scan(project, {
      finishedAt: new Date(`${dayAt(-2)}T05:00:00Z`),
      checks: [{ code: 'A1', status: 'fail', points: 0, possible: 8 }],
    });
    const rec = await fx.recommendation(project, {
      rule_code: 'readiness.A1',
      stable_key: 'readiness.a1:a1',
      category: 'crawler_access',
      fix_path: 'auto_fix',
      title: 'Let answer crawlers in',
    });
    await evaluate(ctx, project);
    const [kase] = await openCases(project);
    await recoveryHandlers['recovery.recheck'](
      ctx,
      { orgId: String(org.org.id), projectId: String(project.id), caseId: String(kase.id) },
      {},
    );
    const named = await scoped.recovery.byId(project.id, kase.id);
    assert.equal(named.status, 'repairing');
    assert.equal(named.diagnosis.outcome, 'named');
    assert.deepEqual(
      named.diagnosis.causes.map((c) => c.code),
      ['readiness_regression'],
    );
    const progress = await scoped.recovery.repairProgress(project.id, named);
    assert.deepEqual(
      progress.repairs[0].links.map((l) => l.recommendationId),
      [rec.id],
    );
    assert.equal(progress.repaired, false);
    // A named diagnosis is kept: a later evaluation does not re-diagnose it.
    await evaluate(ctx, project);
    const kinds = (await scoped.recovery.events(project.id, kase.id)).map((e) => e.kind);
    assert.deepEqual(kinds, ['opened', 'rechecked', 'diagnosed', 'repairs_linked']);
  });

  test('a fix that fell off a published page is read as gone, one we could not fetch as unknown', async () => {
    const project = await declining();
    await evaluate(ctxFor(), project);
    const [kase] = await openCases(project);
    const published = await fx.recommendation(project, {
      rule_code: 'readiness.E2',
      stable_key: 'readiness.e2:e2',
      title: 'Answer questions directly',
      status: 'done',
      done_at: new Date(`${dayAt(-30)}T00:00:00Z`),
      verified_at: new Date(`${dayAt(-29)}T00:00:00Z`),
    });
    await fx.contentItem(project, {
      recommendationId: published.id,
      status: 'published',
      publishedUrl: 'https://x.test/guide',
      html: '<p>x</p>',
    });
    const pages = { 'https://x.test/guide': { status: 404, body: Buffer.from('') } };
    const fetcher = {
      fetch: async (url) => {
        const page = pages[url];
        if (!page) throw new Error('down');
        return { status: page.status, body: page.body, url, headers: {} };
      },
    };
    const ctx = ctxFor({ crawler: { fetcher } });
    const result = await recoveryHandlers['recovery.recheck'](
      ctx,
      { orgId: String(org.org.id), projectId: String(project.id), caseId: String(kase.id) },
      {},
    );
    assert.equal(result.fixes, 1);
    const fresh = await scoped.recovery.byId(project.id, kase.id);
    assert.deepEqual(
      fresh.recheck.fixes.map((f) => [f.recommendationId, f.live, f.via]),
      [[String(published.id), 'gone', 'live_page']],
    );
    assert.equal(fresh.diagnosis.causes[0].code, 'earlier_fix_gone');
    assert.equal(fresh.status, 'repairing');
  });
});

describe('closing', () => {
  async function opened() {
    const project = await declining();
    const ctx = ctxFor();
    await evaluate(ctx, project);
    const [kase] = await openCases(project);
    return { project, kase, ctx };
  }
  const later = new Date(NOW.getTime() + 20 * DAY);
  const recovered = (project) => fx.seedMetrics(project, rowsFor([[1, 20, 0.6]]));

  test('recovers on its own when nothing was done: "recovered by itself", closed once', async () => {
    const { project, kase, ctx } = await opened();
    await recovered(project);
    const result = await evaluate(ctx, project, later);
    assert.deepEqual(result.closed, [{ id: String(kase.id), status: 'closed_noise' }]);
    await evaluate(ctx, project, later);
    const closed = await scoped.recovery.byId(project.id, kase.id);
    assert.equal(closed.status, 'closed_noise');
    assert.equal(closed.openKey, null);
    assert.equal(closed.closeDetails.n, 140);
    const kinds = (await scoped.recovery.events(project.id, kase.id)).map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === 'closed_noise').length, 1);
  });

  test('is "recovered" when a linked repair was done after the case opened', async () => {
    const { project, kase, ctx } = await opened();
    await scoped.recovery.saveDiagnosis(project.id, kase.id, {
      diagnosis: {
        outcome: 'named',
        causes: [
          {
            code: 'competitor_gain',
            label: 'x',
            band: 'likely',
            facts: [
              { id: 'a', text: 'a' },
              { id: 'b', text: 'b' },
            ],
            against: [],
          },
        ],
      },
      repairs: [
        {
          cause: 'competitor_gain',
          kind: 'rules',
          ruleCodes: ['visibility.lost_prompt'],
          text: 'Work through the matching actions.',
        },
      ],
    });
    const rec = await fx.recommendation(project, {
      status: 'done',
      done_at: new Date(NOW.getTime() + 2 * DAY),
    });
    await recovered(project);
    const progress = await scoped.recovery.repairProgress(
      project.id,
      await scoped.recovery.byId(project.id, kase.id),
    );
    assert.equal(progress.repaired, true);
    assert.deepEqual(
      progress.repairs[0].links.map((l) => [l.recommendationId, l.done]),
      [[rec.id, true]],
    );
    await evaluate(ctx, project, later);
    assert.equal((await scoped.recovery.byId(project.id, kase.id)).status, 'recovered');
  });

  test('stays open while the figure is still down, and closes as unknown after eight weeks', async () => {
    const { project, kase, ctx } = await opened();
    await fx.seedMetrics(project, rowsFor([[1, 20, 0.2]]));
    await evaluate(ctx, project, later);
    assert.equal((await scoped.recovery.byId(project.id, kase.id)).status, 'diagnosing');
    const wayLater = new Date(NOW.getTime() + 60 * DAY);
    await evaluate(ctx, project, wayLater);
    const closed = await scoped.recovery.byId(project.id, kase.id);
    assert.equal(closed.status, 'closed_unknown');
    assert.equal(closed.openKey, null);
  });

  test('only the system moves a case: a closed one never reopens, and the same decline waits out the cooldown', async () => {
    const { project, kase } = await opened();
    assert.equal(
      await scoped.recovery.close(project.id, kase.id, {
        status: 'closed_noise',
        recent: { n: 140, k: 84 },
        now: NOW,
      }),
      true,
    );
    assert.equal(
      await scoped.recovery.close(project.id, kase.id, {
        status: 'recovered',
        recent: { n: 1, k: 1 },
        now: NOW,
      }),
      false,
    );
    assert.equal(
      await scoped.recovery.saveDiagnosis(project.id, kase.id, {
        diagnosis: { outcome: 'cant_tell', causes: [] },
        repairs: [],
      }),
      null,
    );
    assert.equal((await scoped.recovery.byId(project.id, kase.id)).status, 'closed_noise');
    // The same decline right after is the same wobble, not a second case.
    const decline = {
      metric: 'mention_rate',
      engineCode: null,
      baseline: { window: [dayAt(-55), dayAt(-28)], n: 280, k: 168 },
      decline: { window: [dayAt(-27), dayAt(0)], n: 280, k: 100 },
      recent: { n: 140, k: 28 },
      deltaPp: -24,
      p: 0.001,
    };
    const again = await scoped.recovery.open(project.id, decline, {
      asOf: dayAt(0),
      now: new Date(NOW.getTime() + 5 * DAY),
    });
    assert.equal(again.created, false);
    assert.equal(again.reason, 'cooldown');
    const after = await scoped.recovery.open(project.id, decline, {
      asOf: dayAt(0),
      now: new Date(NOW.getTime() + 20 * DAY),
    });
    assert.equal(after.created, true);
  });
});

describe('the alert: "a decline has lasted"', () => {
  const mailer = memoryMailer();
  let clock = NOW;
  const mail = createNotifier({
    db,
    mailer,
    baseUrl: 'https://aeocorner.test',
    secret: 'test-secret-test-secret-test-secret-123',
    now: () => clock,
  });
  const alertCtx = () => ({ ...ctxFor(), now: () => clock, mail });
  const toOwner = () => mailer.sent.filter((m) => m.to === org.owner.email);

  test('is told once per case, in one email that names the case', async () => {
    const project = await declining();
    clock = NOW;
    await evaluate(alertCtx(), project);
    const [kase] = await openCases(project);
    const data = {
      orgId: String(org.org.id),
      projectId: String(project.id),
      slot: `case${kase.id}`,
    };
    const before = toOwner().length;
    const first = await alertsEvaluate(alertCtx(), data);
    assert.equal(first.alerts, 1);
    assert.equal(toOwner().length, before + 1);
    assert.match(toOwner().at(-1).email.subject, /AI answers name you less often/);
    assert.ok((await scoped.recovery.byId(project.id, kase.id)).alertedAt);
    const second = await alertsEvaluate(alertCtx(), data);
    assert.equal(second.alerts, 0);
    assert.equal(toOwner().length, before + 1);
    const kinds = (await scoped.recovery.events(project.id, kase.id)).map((e) => e.kind);
    assert.ok(kinds.includes('alerted'));
  });

  test('when someone’s daily limit holds the email back, the case stays untold and goes out the next day', async () => {
    const project = await declining();
    clock = new Date('2026-10-01T10:00:00Z');
    await evaluate(alertCtx(), project, clock);
    const [kase] = await openCases(project);
    // One proactive email already went out to the owner today.
    await mail.send({
      to: org.owner.email,
      userId: org.owner.id,
      orgId: org.org.id,
      kind: 'digest',
      dedupeKey: `test.digest.${kase.id}`,
      data: {
        digest: {
          subject: 'x',
          headline: 'x',
          preheader: 'x',
          figures: [],
          changes: [],
          actions: [],
          proofs: [],
          notices: [],
          project: { name: 'x', domain: 'x' },
          hasNews: false,
          hasData: false,
        },
        dashboardUrl: 'https://aeocorner.test',
        settingsUrl: 'https://aeocorner.test',
      },
    });
    const data = {
      orgId: String(org.org.id),
      projectId: String(project.id),
      slot: `case${kase.id}`,
    };
    const held = await alertsEvaluate(alertCtx(), data);
    assert.equal(held.sent, 0);
    assert.equal((await scoped.recovery.byId(project.id, kase.id)).alertedAt, null);
    clock = new Date('2026-10-02T10:00:00Z');
    const sent = await alertsEvaluate(alertCtx(), data);
    assert.equal(sent.sent, 1);
    assert.ok((await scoped.recovery.byId(project.id, kase.id)).alertedAt);
  });

  test('a plan without alerts is never emailed', async () => {
    const other = await fx.org();
    await fx.setOrg(other.org.id, { plan_code: 'starter', billing_status: 'active' });
    const project = await fx.project(other.org.id, 'No alerts', { status: 'active', slotHour: 4 });
    await fx.engines(project, ['chatgpt']);
    await fx.seedMetrics(
      project,
      rowsFor([
        [-55, -28, 0.6],
        [-27, -14, 0.5],
        [-13, 0, 0.2],
      ]),
    );
    clock = NOW;
    await evaluateProject(alertCtx(), { orgId: other.org.id, projectId: project.id, now: NOW });
    const before = mailer.sent.length;
    const result = await alertsEvaluate(alertCtx(), {
      orgId: String(other.org.id),
      projectId: String(project.id),
      slot: 'case1',
    });
    assert.ok(result.skipped);
    assert.equal(mailer.sent.length, before);
    // The case itself was still opened: alerts are a plan feature, the diagnosis is not.
    assert.equal((await other.scoped.recovery.list(project.id)).length, 1);
  });
});
