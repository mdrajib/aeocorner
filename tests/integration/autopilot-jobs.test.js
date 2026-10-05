import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { proposeAutofix } from '../../src/lib/autofix-proposal.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSecretBox } from '../../src/lib/secrets.js';
import { autopilotTick } from '../../src/worker/handlers/autopilot.js';
import { queueAutopilot } from '../../src/worker/refresh-queue.js';

/**
 * Autopilot (Milestone 15) against the real database: the weekly tick PREPARES items and never decides. Under option A of founder
 * decision F1 nothing reaches the customer's site or `published` without a person, so these tests look at the repository's state,
 * not at what a route would say: no change is written to `site_changes`, no content item is approved or published, an item is
 * `approved` only when a person approved what it points at, and the same state always prepares the same items.
 */
const db = connectTestDb();
const fx = fixtures(db);
const logger = createLogger({ isTest: true, appEnv: 'test' });
const box = createSecretBox({ current: { version: 1, key: randomBytes(32) } });
const WEEK_NOW = new Date();

after(async () => {
  await fx.cleanup();
  await db.close();
});

const recorder = () => ({
  added: [],
  async add(name, data, opts) {
    this.added.push({ name, data, opts });
  },
});
const ctxFor = (over = {}) => ({
  db,
  logger,
  now: () => WEEK_NOW,
  jobs: recorder(),
  billing: { enforced: false },
  ...over,
});
const tick = (ctx, w) =>
  autopilotTick(ctx, { orgId: String(w.o.org.id), projectId: String(w.project.id) });

const ON = { enabled: true, allowAutoFix: true, allowContent: true, weeklyDrafts: 2 };

/** An organization on Growth (which has Autopilot) with a project and a connected WordPress plugin. */
async function world({ settings = ON, plugin = true, plan = 'growth' } = {}) {
  const o = await fx.org();
  await fx.setOrg(o.org.id, { plan_code: plan, billing_status: 'active' });
  const project = await fx.project(o.org.id, 'Data Dental', { status: 'active' });
  const scoped = db.forOrg(o.org.id);
  if (plugin) {
    await scoped.integrations.saveWordpress(project.id, {
      config: {
        siteUrl: 'https://data-dental.example.test/',
        username: 'owner',
        pluginConnected: true,
        pluginVersion: '1.1.0',
      },
      secret: box.encrypt(
        { appPassword: 'x'.repeat(24), hmacSecret: 'b'.repeat(64) },
        `wordpress:${o.org.id}:${project.id}`,
      ),
      userId: o.owner.id,
    });
  }
  if (settings) {
    await scoped.autopilot.saveSettings(project.id, settings, { userId: o.owner.id });
  }
  return { o, project, scoped };
}

const fixRec = (w, over = {}) =>
  fx.recommendation(w.project, {
    rule_code: 'readiness.C1',
    category: 'structured_data',
    fix_path: 'auto_fix',
    title: 'Add Organization schema',
    ice: '5.000',
    ...over,
  });
const pageRec = (w, over = {}) =>
  fx.recommendation(w.project, { title: 'Write about teeth whitening', ice: '4.000', ...over });

const items = (w, statuses = null) => w.scoped.autopilot.list(w.project.id, { statuses });

describe('autopilot.tick: what it prepares', () => {
  test('a fix the plugin can write is prepared with its fingerprint, and nothing is sent or written to the site', async () => {
    const w = await world();
    const rec = await fixRec(w);
    const out = await tick(ctxFor(), w);
    assert.equal(out.prepared, 1);

    const [item] = await items(w);
    assert.equal(item.kind, 'auto_fix');
    assert.equal(item.status, 'ready');
    assert.equal(item.recommendationId, rec.id);
    // The fingerprint is the one the approval screen will carry, because both come from the same function.
    const proposal = await proposeAutofix({
      scoped: w.scoped,
      project: await w.scoped.projects.get(w.project.id),
      rec: (await w.scoped.recommendations.get(w.project.id, rec.id)).recommendation,
    });
    assert.equal(item.preparedHash, proposal.built.hash);
    assert.match(item.summary, /Data Dental/);

    // Prepared, not done: no change row, the recommendation is still open, the person has decided nothing.
    assert.equal(await w.scoped.autofix.current(w.project.id, rec.id), null);
    const after = (await w.scoped.recommendations.get(w.project.id, rec.id)).recommendation;
    assert.equal(after.status, 'open');
    assert.equal(item.decidedByUserId, null);
  });

  test('a draft is started in the Content Studio and queued for research, but never approved or published', async () => {
    const w = await world();
    const rec = await pageRec(w);
    const ctx = ctxFor();
    const out = await tick(ctx, w);
    assert.equal(out.prepared, 1);

    const [item] = await items(w);
    assert.equal(item.kind, 'content');
    assert.ok(item.contentItemId);
    const content = await w.scoped.content.get(w.project.id, String(item.contentItemId));
    assert.equal(content.status, 'researching');
    assert.equal(content.approvedRevisionId, null);
    assert.equal(content.approvedAt, null);
    assert.equal(content.publishedAt ?? null, null);
    assert.equal(content.recommendationId, rec.id);
    // It takes a unit of the month's allowance, like a click, and queues the same first stage.
    assert.equal((await w.scoped.draftQuota.draftsUsed()).used, 1);
    const research = ctx.jobs.added.find((j) => j.name === 'content.research');
    assert.equal(research.data.itemId, String(item.contentItemId));
    // Nothing was written to the site.
    assert.deepEqual(await w.scoped.content.siteChanges(w.project.id, content.id), []);
  });

  test('the best come first and the limits hold: three fixes and the weekly draft budget', async () => {
    const w = await world({ settings: { ...ON, weeklyDrafts: 1 } });
    for (let i = 0; i < 5; i += 1) await fixRec(w, { stable_key: `fix${i}`, ice: String(10 - i) });
    for (let i = 0; i < 3; i += 1)
      await pageRec(w, { stable_key: `page${i}`, ice: String(2 - i * 0.1) });
    const out = await tick(ctxFor(), w);
    // Three fixes, one draft: three items a day is the most it prepares, so the day's limit is what stops it.
    assert.equal(out.prepared, 3);
    const made = await items(w);
    assert.equal(made.length, 3);
    assert.ok(made.every((i) => i.kind === 'auto_fix'));
  });

  test('a second tick for the same state prepares nothing more, and a crash and retry changes nothing', async () => {
    const w = await world();
    await fixRec(w);
    await pageRec(w);
    const ctx = ctxFor();
    const first = await tick(ctx, w);
    assert.equal(first.prepared, 2);
    const again = await Promise.all([tick(ctx, w), tick(ctx, w)]);
    assert.deepEqual(
      again.map((r) => r.prepared),
      [0, 0],
    );
    assert.equal((await items(w)).length, 2);
    assert.equal((await w.scoped.draftQuota.draftsUsed()).used, 1, 'no second unit was taken');
  });
});

describe('autopilot.tick: when it prepares nothing', () => {
  const cases = [
    ['it is off (the default)', { settings: null }, 'off'],
    ['the project is paused', {}, 'paused'],
    ['the plan does not include it', { plan: 'starter' }, 'plan'],
  ];
  for (const [name, opts, why] of cases) {
    test(name, async () => {
      const w = await world(opts);
      if (why === 'paused')
        await w.scoped.autopilot.setPaused(w.project.id, true, { userId: w.o.owner.id });
      await fixRec(w);
      await pageRec(w);
      const out = await tick(ctxFor(), w);
      assert.equal(out.prepared, 0);
      assert.equal(out.skipped, why);
      assert.deepEqual(await items(w), []);
      assert.equal((await w.scoped.draftQuota.draftsUsed()).used, 0);
    });
  }

  test('the staff kill switch stops it at once', async () => {
    const w = await world();
    await fixRec(w);
    const off = { ...db, system: { ...db.system, flags: { isEnabled: async () => false } } };
    const out = await tick(ctxFor({ db: off }), w);
    assert.equal(out.skipped, 'switched_off');
    assert.deepEqual(await items(w), []);
  });

  test('a spend-cap pause stops it, and no draft is started', async () => {
    const w = await world();
    await pageRec(w);
    await w.scoped.spend.pause({
      until: new Date(WEEK_NOW.getTime() + 3_600_000),
      now: WEEK_NOW,
      spentUsd: '5.00',
      capUsd: '5.00',
    });
    const out = await tick(ctxFor(), w);
    assert.equal(out.skipped, 'spend_paused');
    assert.deepEqual(await items(w), []);
    assert.equal((await w.scoped.draftQuota.draftsUsed()).used, 0);
  });

  test('a used-up draft allowance prepares no draft, but still prepares a fix', async () => {
    const w = await world();
    const period = new Date(Date.UTC(WEEK_NOW.getUTCFullYear(), WEEK_NOW.getUTCMonth(), 1));
    await fx.setQuota(w.o.org.id, period, 'drafts', 15);
    await fixRec(w);
    await pageRec(w);
    const out = await tick(ctxFor(), w);
    assert.equal(out.prepared, 1);
    assert.deepEqual(
      (await items(w)).map((i) => i.kind),
      ['auto_fix'],
    );
  });

  test('without a connected plugin a fix is not prepared, but a draft is', async () => {
    const w = await world({ plugin: false });
    await fixRec(w);
    await pageRec(w);
    const out = await tick(ctxFor(), w);
    assert.equal(out.prepared, 1);
    assert.deepEqual(
      (await items(w)).map((i) => i.kind),
      ['content'],
    );
  });

  test('a recommendation a person already started is left alone', async () => {
    const w = await world();
    const rec = await fixRec(w);
    await w.scoped.recommendations.transition(w.project.id, rec.id, 'in_progress', {
      userId: w.o.owner.id,
    });
    const out = await tick(ctxFor(), w);
    assert.equal(out.prepared, 0);
  });

  test('a draft someone already opened for that recommendation is theirs, not Autopilot’s to claim', async () => {
    const w = await world();
    const rec = await pageRec(w);
    await w.scoped.content.create(w.project.id, {
      recommendationId: rec.id,
      title: 'Mine',
      userId: w.o.owner.id,
    });
    const out = await tick(ctxFor(), w);
    assert.equal(out.prepared, 0);
    assert.deepEqual(await items(w), []);
    assert.equal((await w.scoped.draftQuota.draftsUsed()).used, 1, 'only the person’s own unit');
  });
});

describe('what a person does with an item', () => {
  test('a rejected item is not prepared again on the same evidence, but is when the evidence changes', async () => {
    const w = await world();
    const rec = await fixRec(w, { affected_urls: ['https://data-dental.example.test/a'] });
    await tick(ctxFor(), w);
    const [item] = await items(w);
    const rejected = await w.scoped.autopilot.reject(w.project.id, item.publicId, {
      userId: w.o.owner.id,
      reason: 'not_useful',
      note: 'We already did this by hand',
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.decidedByUserId, w.o.owner.id);

    assert.equal((await tick(ctxFor(), w)).prepared, 0, 'same basis: not again');
    await fx.forceRecommendation(rec.id, {
      affected_urls: ['https://data-dental.example.test/a', 'https://data-dental.example.test/b'],
    });
    assert.equal((await tick(ctxFor(), w)).prepared, 1, 'new evidence: prepared again');
  });

  test('a decided item is final: it cannot be rejected twice or after it was withdrawn', async () => {
    const w = await world();
    await fixRec(w);
    await tick(ctxFor(), w);
    const [item] = await items(w);
    await w.scoped.autopilot.reject(w.project.id, item.publicId, {
      userId: w.o.owner.id,
      reason: 'not_now',
    });
    await assert.rejects(
      w.scoped.autopilot.reject(w.project.id, item.publicId, {
        userId: w.o.owner.id,
        reason: 'other',
      }),
      { code: 'STALE_STATUS' },
    );
    assert.deepEqual(await w.scoped.autopilot.withdraw(w.project.id, item.id, 'x'), {
      withdrawn: false,
    });
  });

  test('a rejection needs a person and a reason from the list', async () => {
    const w = await world();
    await fixRec(w);
    await tick(ctxFor(), w);
    const [item] = await items(w);
    await assert.rejects(
      w.scoped.autopilot.reject(w.project.id, item.publicId, { userId: null, reason: 'not_now' }),
      {
        code: 'DECISION_NEEDS_A_PERSON',
      },
    );
    await assert.rejects(
      w.scoped.autopilot.reject(w.project.id, item.publicId, {
        userId: w.o.owner.id,
        reason: 'because',
      }),
      { code: 'BAD_REASON' },
    );
    assert.equal((await w.scoped.autopilot.get(w.project.id, item.publicId)).status, 'ready');
  });

  test('"not useful" and "wrong" rejections lower that rule’s confidence in this project; "not now" does not', async () => {
    const w = await world();
    await fixRec(w, { stable_key: 'a' });
    await fixRec(w, { stable_key: 'b' });
    await tick(ctxFor(), w);
    const [one, two] = await items(w);
    await w.scoped.autopilot.reject(w.project.id, one.publicId, {
      userId: w.o.owner.id,
      reason: 'not_useful',
    });
    await w.scoped.autopilot.reject(w.project.id, two.publicId, {
      userId: w.o.owner.id,
      reason: 'not_now',
    });
    assert.deepEqual(await w.scoped.autopilot.decisionCounts(w.project.id), {
      'readiness.C1': { rejected: 1, accepted: 0 },
    });
  });
});

describe('only a person approves: settle follows, it never decides', () => {
  test('an item becomes approved only after a person approved the fix through the Action Center’s own approval', async () => {
    const w = await world();
    const rec = await fixRec(w);
    await tick(ctxFor(), w);
    const [item] = await items(w);

    // Preparing and ticking again approves nothing.
    await tick(ctxFor(), w);
    assert.equal((await w.scoped.autopilot.get(w.project.id, item.publicId)).status, 'ready');
    assert.deepEqual(await w.scoped.autopilot.settle(w.project.id), { approved: 0 });

    // The person approves what was prepared: the same call the approve route makes, carrying the prepared fingerprint.
    const proposal = await proposeAutofix({
      scoped: w.scoped,
      project: await w.scoped.projects.get(w.project.id),
      rec: (await w.scoped.recommendations.get(w.project.id, rec.id)).recommendation,
    });
    assert.equal(proposal.built.hash, item.preparedHash, 'what they approve is what was prepared');
    const { payloadOf } = await import('../../src/core/autofix-fixes.js');
    await w.scoped.autofix.approve(w.project.id, rec.id, {
      userId: w.o.owner.id,
      ruleCode: 'readiness.C1',
      kind: proposal.built.kind,
      targetUrl: proposal.built.targetUrl,
      payload: payloadOf('readiness.C1', proposal.built),
    });
    assert.deepEqual(await w.scoped.autopilot.settle(w.project.id), { approved: 1 });
    const settled = await w.scoped.autopilot.get(w.project.id, item.publicId);
    assert.equal(settled.status, 'approved');
    assert.equal(settled.decidedByUserId, w.o.owner.id);
  });

  test('a draft item becomes approved only when its content item holds a revision a person approved', async () => {
    const w = await world();
    const rec = await pageRec(w);
    const draft = await fx.contentItem(w.project, {
      status: 'ready',
      html: '<p>x</p>',
      recommendationId: rec.id,
    });
    const made = await w.scoped.autopilot.prepare(w.project.id, {
      recommendationId: rec.id,
      kind: 'content',
      basisHash: 'a'.repeat(64),
      weekKey: '2026-W41',
      title: 'Draft',
      contentItemId: draft.id,
    });
    assert.equal(made.created, true);
    assert.deepEqual(await w.scoped.autopilot.settle(w.project.id), { approved: 0 });

    // A person approves it (the check, the pinned revision and the person are the content repository's own rules).
    await fx.forceContent(draft.id, {
      status: 'approved',
      approved_revision_id: draft.current_revision_id,
      approved_at: new Date(),
      approved_by_user_id: w.o.owner.id,
    });
    assert.deepEqual(await w.scoped.autopilot.settle(w.project.id), { approved: 1 });
    const settled = await w.scoped.autopilot.get(w.project.id, made.item.publicId);
    assert.equal(settled.status, 'approved');
    assert.equal(settled.decidedByUserId, w.o.owner.id);
  });

  test('nothing Autopilot does can leave a content item approved or published, or write a site change', async () => {
    const w = await world();
    for (let i = 0; i < 4; i += 1)
      await pageRec(w, { stable_key: `p${i}`, ice: String(4 - i * 0.1) });
    await fixRec(w);
    const ctx = ctxFor();
    await tick(ctx, w);
    await tick(ctx, w);
    const drafts = await w.scoped.content.list(w.project.id);
    assert.ok(drafts.length >= 1);
    for (const d of drafts) {
      assert.ok(
        ['researching', 'briefing', 'drafting', 'qc', 'ready'].includes(d.status),
        d.status,
      );
      assert.equal(d.approvedAt, null);
      assert.equal(d.approvedRevisionId, null);
      assert.equal(d.publishedAt ?? null, null);
    }
    const [fix] = (await items(w)).filter((i) => i.kind === 'auto_fix');
    assert.equal(await w.scoped.autofix.current(w.project.id, fix.recommendationId), null);
    assert.ok(
      ctx.jobs.added.every((j) => !/^(autofix|content\.publish)/.test(j.name)),
      JSON.stringify(ctx.jobs.added.map((j) => j.name)),
    );
  });
});

describe('autopilot.tick: keeping the list true', () => {
  test('an item whose recommendation was dismissed or done another way is withdrawn, with the reason', async () => {
    const w = await world();
    const a = await fixRec(w, { stable_key: 'a' });
    const b = await fixRec(w, { stable_key: 'b' });
    await tick(ctxFor(), w);
    await w.scoped.recommendations.transition(w.project.id, a.id, 'dismissed', {
      userId: w.o.owner.id,
      dismissReason: 'not_relevant',
    });
    await fx.forceRecommendation(b.id, { signal_cleared_at: new Date() });
    const out = await tick(ctxFor(), w);
    assert.equal(out.withdrawn, 2);
    const all = await items(w);
    assert.ok(all.every((i) => i.status === 'withdrawn' && i.withdrawnReason));
  });

  test('an item left four weeks is withdrawn', async () => {
    const w = await world();
    await fixRec(w);
    await tick(ctxFor(), w);
    const later = new Date(WEEK_NOW.getTime() + 29 * 86_400_000);
    const out = await tick(ctxFor({ now: () => later }), w);
    assert.equal(out.withdrawn, 1);
  });

  test('a draft archived on the Content board is withdrawn', async () => {
    const w = await world();
    await pageRec(w);
    await tick(ctxFor(), w);
    const [item] = await items(w);
    await w.scoped.content.archive(w.project.id, item.contentItemId);
    const out = await tick(ctxFor(), w);
    assert.equal(out.withdrawn, 1);
  });

  test('the last tick is kept for the screen, for a project that has it on', async () => {
    const w = await world();
    await fixRec(w);
    await tick(ctxFor(), w);
    const settings = await w.scoped.autopilot.settings(w.project.id);
    assert.equal(settings.lastTick.prepared, 1);
    assert.ok(settings.lastTickAt);
  });

  test('a tick for an archived project does nothing', async () => {
    const w = await world();
    await fixRec(w);
    await w.scoped.projects.archive(w.project.id);
    assert.deepEqual(await tick(ctxFor(), w), { skipped: 'project_gone' });
  });
});

describe('settings and the audit trail', () => {
  test('the audit trail says who turned it on, paused it and rejected an item', async () => {
    const w = await world({ settings: null });
    await w.scoped.autopilot.saveSettings(w.project.id, ON, { userId: w.o.owner.id });
    await w.scoped.autopilot.setPaused(w.project.id, true, { userId: w.o.owner.id });
    await w.scoped.autopilot.setPaused(w.project.id, true, { userId: w.o.owner.id }); // twice: one entry
    await w.scoped.autopilot.setPaused(w.project.id, false, { userId: w.o.owner.id });
    const actions = (await w.scoped.activity.recent()).map((a) => a.action);
    assert.ok(actions.includes('autopilot.settings_saved'));
    assert.equal(actions.filter((a) => a === 'autopilot.paused').length, 1);
    assert.ok(actions.includes('autopilot.resumed'));
  });

  test('preparing writes a line in the recommendation’s own history, by the system', async () => {
    const w = await world();
    const rec = await fixRec(w);
    await tick(ctxFor(), w);
    const detail = await w.scoped.recommendations.get(w.project.id, rec.id);
    const line = detail.events.find((e) => e.toStatus === 'ap_prepared');
    assert.equal(line.actorType, 'system');
    assert.match(line.note, /prepared a fix/);
  });

  test('settings need a person', async () => {
    const w = await world({ settings: null });
    await assert.rejects(w.scoped.autopilot.saveSettings(w.project.id, ON, { userId: null }), {
      code: 'SETTINGS_NEED_A_PERSON',
    });
    await assert.rejects(w.scoped.autopilot.setPaused(w.project.id, true, { userId: null }), {
      code: 'SETTINGS_NEED_A_PERSON',
    });
  });
});

describe('queueAutopilot', () => {
  test('asks for a tick only for a project that has Autopilot on and is not paused', async () => {
    const off = await world({ settings: null });
    const on = await world();
    const paused = await world();
    await paused.scoped.autopilot.setPaused(paused.project.id, true, { userId: paused.o.owner.id });
    const ctx = ctxFor();
    assert.equal(
      await queueAutopilot(ctx, { orgId: off.o.org.id, projectId: off.project.id, tag: 'r1' }),
      false,
    );
    assert.equal(
      await queueAutopilot(ctx, {
        orgId: paused.o.org.id,
        projectId: paused.project.id,
        tag: 'r1',
      }),
      false,
    );
    assert.equal(
      await queueAutopilot(ctx, { orgId: on.o.org.id, projectId: on.project.id, tag: 'r1' }),
      true,
    );
    assert.deepEqual(
      ctx.jobs.added.map((j) => j.name),
      ['autopilot.tick'],
    );
    assert.match(ctx.jobs.added[0].opts.jobId, /^autopilot-/);
  });
});
