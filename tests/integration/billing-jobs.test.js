import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import pino from 'pino';
import { addDays } from '../../src/core/entitlements.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createStripe } from '../../src/integrations/stripe.js';
import { memoryAlerter } from '../../src/lib/alerts.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createNotifier } from '../../src/lib/notify.js';
import {
  billingNotices,
  billingReconcile,
  billingReportUsage,
  retentionSweep,
} from '../../src/worker/handlers/billing.js';
import { startStripeStub } from '../helpers/stripe-stub.js';

/**
 * The billing jobs (Milestone 8) against the real database, a Stripe stand-in and an in-memory mailer: the daily
 * reconcile, the hourly usage report, the retention sweep and the trial notice.
 */

const db = connectTestDb();
const fx = fixtures(db);
const stub = await startStripeStub();
const stripe = createStripe({ secretKey: stub.secretKey, baseUrl: stub.url });
const mailer = memoryMailer();
const alerts = memoryAlerter();
let clock = new Date();
const ctx = {
  db,
  alerts,
  logger: pino({ level: 'silent' }),
  now: () => clock,
  billing: { stripe, enforced: true },
  mail: createNotifier({
    db,
    mailer,
    baseUrl: 'https://aeocorner.test',
    secret: 'test-secret-test-secret-test-secret-123',
    now: () => clock,
  }),
};

after(async () => {
  await fx.cleanup();
  await db.close();
  await stub.close();
});

let n = 0;
const customerFor = (org) => `cus_job_${Date.now()}_${n++}_${org.id}`;

describe('billing.reconcile', () => {
  test('puts right an organization a missed webhook left behind, and says so', async () => {
    const { org, scoped } = await fx.org();
    const customer = customerFor(org);
    await scoped.billing.attachCustomer(customer);
    const sub = stub.setSubscription({
      customer,
      status: 'trialing',
      metadata: { org_id: org.public_id },
      items: { data: [stub.item({ priceId: 'p', lookupKey: 'aeo-plan-starter-monthly-7900' })] },
    });
    // We know the subscription (the webhook for its creation arrived)…
    await ctx.db.system.billing.subscriptions.apply({
      parsed: (await import('../../src/core/billing.js')).subscriptionFromStripe(sub, new Map()),
      now: clock,
    });
    // …then Stripe moves it to active and the webhook never reaches us.
    sub.status = 'active';
    sub.trial_end = null;

    const result = await billingReconcile(ctx);
    assert.ok(result.checked >= 1);
    assert.ok(result.differed >= 1);
    assert.equal((await scoped.billing.summary()).billingStatus, 'active');
    assert.ok(alerts.sent.some((a) => a.key.startsWith('billing.mismatch:')));

    // Running again finds nothing to correct.
    const sentBefore = alerts.sent.length;
    const again = await billingReconcile(ctx);
    assert.equal(again.differed, 0);
    assert.equal(alerts.sent.length, sentBefore);
  });

  test('without Stripe it does nothing and says why', async () => {
    const out = await billingReconcile({ ...ctx, billing: { enforced: false, stripe: null } });
    assert.match(out.skipped, /not configured/);
  });
});

describe('billing.report_usage', () => {
  test('each whole draft past the allowance goes to the meter once, and a second run sends nothing new', async () => {
    const { org } = await fx.org();
    const customer = customerFor(org);
    await fx.setOrg(org.id, {
      plan_code: 'starter',
      billing_status: 'active',
      stripe_customer_id: customer,
    });
    await fx.grant(org.id, { meter: 'drafts', amount: 0, source: 'addon', itemId: 'si_rep' });
    const period = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1));
    await fx.setQuota(org.id, period, 'drafts', 6); // allowance 4: two over

    const sent = () =>
      stub.state.meterEvents.filter((e) => e.payload.stripe_customer_id === customer);
    const first = await billingReportUsage(ctx);
    assert.ok(first.units >= 2);
    assert.equal(sent().length, 2);
    assert.equal(sent()[0].event_name, 'aeo_extra_draft');
    assert.equal(sent()[0].payload.value, '1');
    assert.notEqual(sent()[0].identifier, sent()[1].identifier);

    await billingReportUsage(ctx);
    assert.equal(sent().length, 2, 'nothing is reported twice');

    await fx.setQuota(org.id, period, 'drafts', 7);
    await billingReportUsage(ctx);
    assert.equal(sent().length, 3);
  });

  test('when a report fails the draft is not marked reported, so the next hour sends it', async () => {
    const { org } = await fx.org();
    const customer = customerFor(org);
    await fx.setOrg(org.id, {
      plan_code: 'starter',
      billing_status: 'active',
      stripe_customer_id: customer,
    });
    await fx.grant(org.id, { meter: 'drafts', amount: 0, source: 'addon', itemId: 'si_fail' });
    const period = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1));
    await fx.setQuota(org.id, period, 'drafts', 5);
    const mine = () =>
      stub.state.meterEvents.filter((e) => e.payload.stripe_customer_id === customer);

    stub.failNext(500, 'meter down');
    const failed = await billingReportUsage(ctx);
    assert.ok(failed.failed >= 1);
    assert.equal(mine().length, 0);
    await billingReportUsage(ctx);
    assert.equal(mine().length, 1);
  });

  test('a duplicate refusal from Stripe counts as reported (an earlier try got through)', async () => {
    const { org } = await fx.org();
    const customer = customerFor(org);
    await fx.setOrg(org.id, {
      plan_code: 'starter',
      billing_status: 'active',
      stripe_customer_id: customer,
    });
    await fx.grant(org.id, { meter: 'drafts', amount: 0, source: 'addon', itemId: 'si_dup' });
    const period = new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1));
    await fx.setQuota(org.id, period, 'drafts', 5);
    stub.state.meterEvents.push({
      identifier: `draft-${org.public_id}-${period.toISOString().slice(0, 7)}-1`,
      payload: { stripe_customer_id: 'someone', value: '1' },
    });
    await billingReportUsage(ctx);
    const [pending] = (await db.system.billing.meters.draftsToReport({ now: clock })).filter(
      (r) => r.orgId === org.id,
    );
    assert.equal(pending, undefined, 'the duplicate was written down as reported');
  });
});

describe('retention.sweep and billing.notices', () => {
  test('the owner is warned once before the account closes, and the account closes when its time comes', async () => {
    const { org, owner } = await fx.org();
    mailer.sent.length = 0;
    await fx.setOrg(org.id, {
      plan_code: 'starter',
      billing_status: 'canceled',
      retain_until: addDays(clock, 10),
    });
    const first = await retentionSweep(ctx);
    assert.ok(first.warned >= 1);
    const mine = mailer.sent.filter((m) => m.to === owner.email);
    assert.equal(mine.length, 1);
    assert.match(mine[0].email.subject, /deleted on/);
    assert.equal(
      mine[0].headers,
      undefined,
      'a notice about the account has no unsubscribe: it is not optional',
    );

    await retentionSweep(ctx);
    assert.equal(
      mailer.sent.filter((m) => m.to === owner.email).length,
      1,
      'the warning is sent once',
    );

    assert.equal((await fx.billingRows(org.id)).org.deleted_at, null);
    clock = addDays(clock, 11);
    const second = await retentionSweep(ctx);
    assert.ok(second.closed >= 1);
    assert.ok((await fx.billingRows(org.id)).org.deleted_at);
    clock = addDays(clock, -11);
  });

  test('a trial ending in four days emails its owner once, with the charge date and price', async () => {
    const { org, owner } = await fx.org();
    mailer.sent.length = 0;
    await fx.setOrg(org.id, { plan_code: 'starter', billing_status: 'trialing' });
    await db.system.billing.subscriptions.apply({
      parsed: {
        stripeSubscriptionId: `sub_notice_${Date.now()}`,
        stripeCustomerId: customerFor(org),
        orgPublicId: org.public_id,
        planCode: 'starter',
        status: 'trialing',
        orgStatus: 'trialing',
        trialEndsAt: addDays(clock, 3),
        currentPeriodStart: clock,
        currentPeriodEnd: addDays(clock, 3),
        cancelAtPeriodEnd: false,
        canceledAt: null,
        addons: [],
      },
      now: clock,
    });
    await billingNotices(ctx);
    await billingNotices(ctx);
    const mine = mailer.sent.filter((m) => m.to === owner.email);
    assert.equal(mine.length, 1);
    assert.match(mine[0].email.text, /\$79/);
    assert.match(mine[0].email.subject, /free trial ends/);
  });
});
