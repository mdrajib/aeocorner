import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import pino from 'pino';
import { addDays } from '../../src/core/entitlements.js';
import { subscriptionFromStripe } from '../../src/core/billing.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createNotifier } from '../../src/lib/notify.js';
import { billingNotices, retentionSweep } from '../../src/worker/handlers/billing.js';

/**
 * Claude after a downgrade (founder decision F3, option C): a project that already tracks Claude keeps it until the end
 * of the period the customer has paid for, then it stops; going back to a plan with Claude before then keeps it.
 * Against the real database; the mailer is in memory.
 */

const db = connectTestDb();
const fx = fixtures(db);
after(async () => {
  await fx.cleanup();
  await db.close();
});

const NOW = new Date('2026-10-10T12:00:00Z');
const PERIOD_END = '2026-10-28T00:00:00Z';
const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const billing = db.system.billing;
let seq = 0;

/** An active Stripe subscription on `plan` (the lookup key names the plan), the same subscription every time for one org. */
function sub(org, plan, { periodEnd = PERIOD_END, id } = {}) {
  return {
    id: id ?? `sub_grace_${org.id}`,
    customer: `cus_grace_${org.id}`,
    status: 'active',
    metadata: { org_id: org.public_id },
    items: {
      data: [
        {
          id: `si_grace_${org.id}`,
          quantity: 1,
          current_period_start: sec('2026-09-28T00:00:00Z'),
          current_period_end: sec(periodEnd),
          price: { id: `price_${plan}`, lookup_key: `aeo-plan-${plan}-monthly-${++seq}` },
        },
      ],
    },
  };
}
const apply = (org, plan, opts) =>
  billing.subscriptions.apply({
    parsed: subscriptionFromStripe(sub(org, plan, opts), new Map()),
    now: NOW,
  });
const claudeUntil = async (org) => (await fx.billingRows(org.id)).org.claude_until;

/** An organization on `plan` with one project that tracks perplexity and Claude. */
async function withClaude(plan) {
  const one = await fx.org();
  await fx.setOrg(one.org.id, { plan_code: plan });
  const project = await fx.project(one.org.id, 'Claude Co', { status: 'active' });
  await fx.engines(project, ['perplexity', 'claude']);
  const run = await fx.run(project, { status: 'queued' });
  return { ...one, project, run };
}

const enginesPlanned = async (one, now) =>
  (await db.forOrg(one.org.id).runs.plan(one.run.id, { now })).engines.map((e) => e.code).sort();

describe('a downgrade starts a grace that lasts until the paid period ends', () => {
  test('agency to growth: Claude is kept until the period end, and a repeat of the event changes nothing', async () => {
    const { org } = await fx.org();
    await apply(org, 'agency');
    assert.equal(await claudeUntil(org), null, 'a plan with Claude has no grace');

    await apply(org, 'growth');
    assert.equal((await claudeUntil(org))?.toISOString(), new Date(PERIOD_END).toISOString());

    await apply(org, 'growth');
    assert.equal((await claudeUntil(org))?.toISOString(), new Date(PERIOD_END).toISOString());

    const summary = await db.forOrg(org.id).billing.summary({ now: NOW });
    assert.equal(summary.claudeUntil?.toISOString(), new Date(PERIOD_END).toISOString());
  });

  test('switching back to a plan with Claude clears the grace', async () => {
    const { org } = await fx.org();
    await apply(org, 'agency');
    await apply(org, 'growth');
    assert.ok(await claudeUntil(org));
    await apply(org, 'agency');
    assert.equal(await claudeUntil(org), null);
  });

  test('a move between two plans without Claude neither starts nor extends a grace', async () => {
    const { org } = await fx.org();
    await apply(org, 'starter');
    await apply(org, 'growth', { periodEnd: '2026-11-28T00:00:00Z' });
    assert.equal(await claudeUntil(org), null);

    const other = await fx.org();
    await apply(other.org, 'agency');
    await apply(other.org, 'growth');
    await apply(other.org, 'starter', { periodEnd: '2026-11-28T00:00:00Z' });
    assert.equal(
      (await claudeUntil(other.org))?.toISOString(),
      new Date(PERIOD_END).toISOString(),
      'the grace stays what it was',
    );
  });

  test('a period that has already ended starts no grace', async () => {
    const { org } = await fx.org();
    await apply(org, 'agency', { periodEnd: '2026-10-05T00:00:00Z' });
    await apply(org, 'growth', { periodEnd: '2026-10-05T00:00:00Z' });
    assert.equal(await claudeUntil(org), null);
  });
});

describe('what is collected', () => {
  test('a plan with Claude collects it; a plan without it does not, grace or not, once the grace is over', async () => {
    const agency = await withClaude('agency');
    assert.deepEqual(await enginesPlanned(agency, NOW), ['claude', 'perplexity']);

    const growth = await withClaude('growth');
    assert.deepEqual(await enginesPlanned(growth, NOW), ['perplexity'], 'no grace, no Claude');

    await fx.setOrg(growth.org.id, { claude_until: new Date(PERIOD_END) });
    assert.deepEqual(
      await enginesPlanned(growth, NOW),
      ['claude', 'perplexity'],
      'during the grace it is still collected',
    );
    assert.deepEqual(
      await enginesPlanned(growth, addDays(new Date(PERIOD_END), 0.01)),
      ['perplexity'],
      'a moment after the grace it is not, before any sweep has run',
    );
  });

  test('an organization with no plan yet is not held back', async () => {
    const one = await withClaude(null);
    assert.deepEqual(await enginesPlanned(one, NOW), ['claude', 'perplexity']);
  });
});

describe('the engine switches while a grace runs', () => {
  test('Claude is shown as stopping, can be kept while saving other changes, and cannot be switched on again', async () => {
    const one = await withClaude('growth');
    await fx.setOrg(one.org.id, { claude_until: addDays(new Date(), 10) });
    const scoped = db.forOrg(one.org.id);

    const choice = (await scoped.projectEngines.choices(one.project.id)).find(
      (c) => c.engine_code === 'claude',
    );
    assert.equal(choice.enabled, true);
    assert.equal(choice.allowed, false);
    assert.ok(choice.graceUntil, 'the screen can say when it stops');

    await scoped.projectEngines.setEnabled(one.project.id, ['perplexity', 'claude']);
    await scoped.projectEngines.setEnabled(one.project.id, ['perplexity']);
    await assert.rejects(
      scoped.projectEngines.setEnabled(one.project.id, ['perplexity', 'claude']),
      (err) => err.code === 'ENGINE_NOT_IN_PLAN',
    );
  });
});

describe('the daily sweep', () => {
  const ctxFor = (clock, mail = null) => ({
    db,
    logger: pino({ level: 'silent' }),
    now: () => clock,
    mail,
  });

  test('switches Claude off when the grace is over, writes a line, and leaves a plan with Claude alone', async () => {
    const done = await withClaude('growth');
    await fx.setOrg(done.org.id, { claude_until: new Date('2026-10-09T00:00:00Z') });
    const live = await withClaude('agency');
    await fx.setOrg(live.org.id, { claude_until: new Date('2026-10-09T00:00:00Z') });
    const waiting = await withClaude('growth');
    await fx.setOrg(waiting.org.id, { claude_until: new Date('2026-10-20T00:00:00Z') });

    const result = await retentionSweep(ctxFor(NOW));
    assert.ok(result.claudeStopped >= 1);

    const claudeOn = (one) =>
      db
        .forOrg(one.org.id)
        .projectEngines.list(one.project.id)
        .then((rows) => rows.find((r) => r.engine_code === 'claude')?.enabled);
    assert.equal(await claudeOn(done), false, 'switched off');
    assert.equal(await claudeOn(live), true, 'a plan with Claude keeps it');
    assert.equal(await claudeOn(waiting), true, 'the grace has not ended');
    assert.equal((await fx.billingRows(done.org.id)).org.claude_until, null);
    assert.equal(
      await fx.count('org_activity_log', { org_id: done.org.id, action: 'engine.claude_stopped' }),
      1,
    );
    assert.equal(
      await fx.count('org_activity_log', { org_id: live.org.id, action: 'engine.claude_stopped' }),
      0,
    );

    await retentionSweep(ctxFor(NOW));
    assert.equal(
      await fx.count('org_activity_log', { org_id: done.org.id, action: 'engine.claude_stopped' }),
      1,
      'a second sweep does nothing more',
    );
  });

  test('the owner is told once, with the end date and the projects, while the grace runs', async () => {
    const one = await withClaude('growth');
    await fx.setOrg(one.org.id, { claude_until: new Date(PERIOD_END) });
    const mailer = memoryMailer();
    const mail = createNotifier({
      db,
      mailer,
      baseUrl: 'https://aeocorner.test',
      secret: 'test-secret-test-secret-test-secret-123',
      now: () => NOW,
    });
    await billingNotices(ctxFor(NOW, mail));
    await billingNotices(ctxFor(NOW, mail));
    const mine = mailer.sent.filter((m) => m.to === one.owner.email);
    assert.equal(mine.length, 1, 'once, however often the job runs');
    assert.match(mine[0].email.subject, /Claude tracking stops on October 28, 2026/);
    assert.match(mine[0].email.text, /Claude Co/);
    assert.match(mine[0].email.text, /\/billing/);
  });

  test('nobody is told when no project tracks Claude', async () => {
    const one = await fx.org();
    await fx.setOrg(one.org.id, { plan_code: 'growth', claude_until: new Date(PERIOD_END) });
    const project = await fx.project(one.org.id, 'No Claude', { status: 'active' });
    await fx.engines(project, ['perplexity']);
    const mailer = memoryMailer();
    const mail = createNotifier({
      db,
      mailer,
      baseUrl: 'https://aeocorner.test',
      secret: 'test-secret-test-secret-test-secret-123',
      now: () => NOW,
    });
    await billingNotices(ctxFor(NOW, mail));
    assert.equal(mailer.sent.filter((m) => m.to === one.owner.email).length, 0);
  });
});
