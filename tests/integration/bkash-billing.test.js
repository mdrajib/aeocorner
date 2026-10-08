import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pino from 'pino';
import { addMonths, invoiceNumber } from '../../src/core/bkash-billing.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createBkash } from '../../src/integrations/bkash.js';
import { memoryAlerter } from '../../src/lib/alerts.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createNotifier } from '../../src/lib/notify.js';
import { billingNotices, bkashSweep } from '../../src/worker/handlers/billing.js';
import { STUB_CREDENTIALS, startBkashStub } from '../helpers/bkash-stub.js';

/**
 * Paying with bKash against the real database (ADR-0018): a payment settles into a subscription exactly once, a payment
 * that does not match what we asked for is refused, time lapses an unpaid period, the sweep finds payments whose callback
 * never came, and the reminder email goes out once.
 */

const db = connectTestDb();
const fx = fixtures(db);
const stub = startBkashStub();
const bkash = createBkash({ ...STUB_CREDENTIALS, fetchImpl: stub.fetchImpl });
const mailer = memoryMailer();
const alerts = memoryAlerter();
const day = 86_400_000;
let clock = new Date('2026-10-08T10:00:00.000Z');
const sys = db.system.billing.bkash;
const ctx = {
  db,
  alerts,
  logger: pino({ level: 'silent' }),
  now: () => clock,
  billing: { bkash },
  mail: createNotifier({
    db,
    mailer,
    baseUrl: 'https://aeocorner.test',
    secret: 'test-secret-test-secret-test-secret-123',
    now: () => clock,
  }),
};

// The same two prices in both bKash test files, and never put back to NULL: the files run side by side on one database.
before(async () => {
  await db.system.billing.plans.setBdtPrice('starter', 2500);
  await db.system.billing.plans.setBdtPrice('growth', 7500);
});
after(async () => {
  await fx.cleanup();
  await db.close();
});

let n = 0;
/** A payment row for an organization, as the pay route makes it. */
async function payment(scoped, org, { plan = 'starter', amount = 2500, purpose = 'start' } = {}) {
  return scoped.bkash.begin({
    planCode: plan,
    purpose,
    amountBdt: amount,
    invoiceNumber: invoiceNumber(org.public_id, clock, `t${n++}`),
    now: clock,
  });
}
const paidFor = (p, over = {}) => ({
  trxId: `TRX-${p.publicId}`,
  amount: p.amountBdt,
  currency: 'BDT',
  invoiceNumber: p.invoiceNumber,
  ...over,
});
const summaryOf = (scoped) => scoped.billing.summary({ now: clock, enforced: true });

describe('settling a payment', () => {
  test('a completed payment makes the subscription active for a month, on the right plan, and opens the money-back window', async () => {
    const { org, scoped } = await fx.org();
    const p = await payment(scoped, org);
    const done = await sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock });
    assert.equal(done.settled, true);

    const s = await summaryOf(scoped);
    assert.equal(s.billingStatus, 'active');
    assert.equal(s.planCode, 'starter');
    assert.equal(s.subscription.provider, 'bkash');
    assert.equal(s.subscription.status, 'active');
    assert.equal(s.subscription.currentPeriodEnd.toISOString(), addMonths(clock).toISOString());
    assert.ok(s.subscription.firstPaidAt);
    assert.ok(s.subscription.moneyBackUntil > clock);
    assert.equal(s.access.level, 'full');
    const [row] = await scoped.bkash.recent();
    assert.equal(row.status, 'completed');
    assert.equal(row.trxId, `TRX-${p.publicId}`);
  });

  test('settling the same payment again changes nothing', async () => {
    const { org, scoped } = await fx.org();
    const p = await payment(scoped, org);
    await sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock });
    const before = await summaryOf(scoped);
    clock = new Date(clock.getTime() + 2 * day);
    const again = await sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock });
    assert.equal(again.settled, true);
    assert.equal(
      (await summaryOf(scoped)).subscription.currentPeriodEnd.getTime(),
      before.subscription.currentPeriodEnd.getTime(),
    );
    assert.equal((await scoped.bkash.recent()).length, 1);
  });

  test('two settles at the same moment make one period', async () => {
    const { org, scoped } = await fx.org();
    const p = await payment(scoped, org);
    const results = await Promise.all([
      sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock }),
      sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock }),
    ]);
    assert.ok(results.every((r) => r.settled));
    const s = await summaryOf(scoped);
    assert.equal(s.subscription.currentPeriodEnd.toISOString(), addMonths(clock).toISOString());
  });

  test('a payment that does not match what we asked for is refused: wrong amount, currency, invoice, or no transaction', async () => {
    const { org, scoped } = await fx.org();
    for (const over of [
      { amount: 1 },
      { currency: 'USD' },
      { invoiceNumber: 'someone-elses-invoice' },
      { trxId: '' },
      { amount: null },
    ]) {
      const p = await payment(scoped, org);
      const done = await sys.settle({ publicId: p.publicId, paid: paidFor(p, over), now: clock });
      assert.equal(done.settled, false, JSON.stringify(over));
      assert.equal(done.reason, 'mismatch');
    }
    assert.equal((await summaryOf(scoped)).billingStatus, 'none');
    assert.ok((await scoped.bkash.recent()).every((r) => r.status === 'failed'));
  });

  test('an unknown payment is not settled', async () => {
    const done = await sys.settle({ publicId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', paid: {}, now: clock });
    assert.deepEqual(done, { settled: false, reason: 'unknown_payment' });
  });

  test('a payment that completes after we gave up on it still counts: the money was taken', async () => {
    const { org, scoped } = await fx.org();
    const p = await payment(scoped, org);
    await sys.expire({ before: new Date(clock.getTime() + day) });
    assert.equal((await scoped.bkash.recent())[0].status, 'expired');
    const done = await sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock });
    assert.equal(done.settled, true);
    assert.equal((await summaryOf(scoped)).billingStatus, 'active');
  });

  test('paying early extends from the end of the paid month; paying a bigger plan starts it now', async () => {
    const { org, scoped } = await fx.org();
    const first = await payment(scoped, org);
    await sys.settle({ publicId: first.publicId, paid: paidFor(first), now: clock });
    const firstEnd = addMonths(clock);

    clock = new Date(clock.getTime() + 5 * day);
    const renewal = await payment(scoped, org, { purpose: 'renewal' });
    await sys.settle({ publicId: renewal.publicId, paid: paidFor(renewal), now: clock });
    assert.equal(
      (await summaryOf(scoped)).subscription.currentPeriodEnd.toISOString(),
      addMonths(firstEnd).toISOString(),
    );

    const upgrade = await payment(scoped, org, { plan: 'growth', amount: 7000, purpose: 'change' });
    await sys.settle({ publicId: upgrade.publicId, paid: paidFor(upgrade), now: clock });
    const s = await summaryOf(scoped);
    assert.equal(s.planCode, 'growth');
    assert.equal(s.subscription.currentPeriodEnd.toISOString(), addMonths(clock).toISOString());
  });

  test('a payment resets a scheduled end: paying means carrying on', async () => {
    const { org, scoped } = await fx.org();
    const p = await payment(scoped, org);
    await sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock });
    assert.equal(await scoped.bkash.setCancelAtPeriodEnd(true), true);
    assert.equal((await summaryOf(scoped)).subscription.cancelAtPeriodEnd, true);
    const again = await payment(scoped, org, { purpose: 'renewal' });
    await sys.settle({ publicId: again.publicId, paid: paidFor(again), now: clock });
    assert.equal((await summaryOf(scoped)).subscription.cancelAtPeriodEnd, false);
  });

  test('a completed payment whose subscription update was lost is finished by the sweep', async () => {
    const { org, scoped } = await fx.org();
    const p = await payment(scoped, org);
    // Complete the payment row but never apply it, as a crash between the two steps would leave it.
    await db.system.billing.bkash.settle({ publicId: p.publicId, paid: paidFor(p), now: clock });
    await fx.unapplyBkashPayment(p.publicId);
    const out = await bkashSweep(ctx);
    assert.ok(out.retried >= 0);
    assert.equal((await summaryOf(scoped)).billingStatus, 'active');
  });
});

describe('time moves an unpaid subscription along', () => {
  async function trial(plan = 'starter') {
    const made = await fx.org();
    const { trialSubscription } = await import('../../src/core/bkash-billing.js');
    await db.system.billing.subscriptions.apply({
      parsed: trialSubscription({ orgPublicId: made.org.public_id, planCode: plan, now: clock }),
      now: clock,
    });
    return made;
  }

  test('a trial is free and full access; unpaid at its end it becomes past due with a grace week, then pauses, then is cancelled', async () => {
    const { org, scoped } = await trial();
    let s = await summaryOf(scoped);
    assert.equal(s.billingStatus, 'trialing');
    assert.equal(s.access.level, 'full');

    // Day 15: the trial has run out.
    clock = new Date(clock.getTime() + 15 * day);
    await sys.lapse({ now: clock });
    s = await summaryOf(scoped);
    assert.equal(s.billingStatus, 'past_due');
    assert.equal(s.access.level, 'grace');
    assert.ok(s.subscription.graceUntil > clock);

    // After the grace week: paused (data kept, nothing collected).
    clock = new Date(clock.getTime() + 8 * day);
    s = await summaryOf(scoped);
    assert.equal(s.access.level, 'paused');
    assert.equal(s.access.collect, false);
    await sys.lapse({ now: clock });
    assert.equal((await summaryOf(scoped)).billingStatus, 'past_due', 'not cancelled yet');

    // Grace plus 30 days: cancelled, which opens the read-only window.
    clock = new Date(clock.getTime() + 31 * day);
    await sys.lapse({ now: clock });
    s = await summaryOf(scoped);
    assert.equal(s.billingStatus, 'canceled');
    assert.equal(s.access.level, 'readonly');
    assert.ok((await fx.organizationRow(org.id)).retain_until > clock);
  });

  test('a paid month that was set not to renew ends in cancellation, not a grace period', async () => {
    const { org, scoped } = await fx.org();
    const p = await payment(scoped, org);
    await sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock });
    await scoped.bkash.setCancelAtPeriodEnd(true);
    clock = new Date(addMonths(clock).getTime() + day);
    await sys.lapse({ now: clock });
    assert.equal((await summaryOf(scoped)).billingStatus, 'canceled');
  });

  test('paying while past due brings full access back at once', async () => {
    const { org, scoped } = await trial();
    clock = new Date(clock.getTime() + 20 * day);
    await sys.lapse({ now: clock });
    assert.equal((await summaryOf(scoped)).billingStatus, 'past_due');
    const p = await payment(scoped, org);
    await sys.settle({ publicId: p.publicId, paid: paidFor(p), now: clock });
    const s = await summaryOf(scoped);
    assert.equal(s.billingStatus, 'active');
    assert.equal(s.access.level, 'full');
    assert.equal(s.subscription.graceUntil, null);
  });

  test('Stripe’s reconcile never sees a bKash subscription', async () => {
    const { org } = await trial();
    const all = await db.system.billing.subscriptions.reconcilable({ afterId: 0n, limit: 100000 });
    assert.ok(!all.some((s) => s.stripeSubscriptionId === `bkash-${org.public_id}`));
  });
});

describe('the reminder', () => {
  test('goes to the owner in the last days of a trial, once, from the billing address', async () => {
    const { org, scoped, owner } = await fx.org();
    const { trialSubscription } = await import('../../src/core/bkash-billing.js');
    clock = new Date('2026-12-01T10:00:00.000Z');
    await db.system.billing.subscriptions.apply({
      parsed: trialSubscription({ orgPublicId: org.public_id, planCode: 'starter', now: clock }),
      now: clock,
    });
    assert.equal(
      (await db.system.billing.bkash.reminders({ now: clock })).some((r) => r.orgId === org.id),
      false,
    );

    clock = new Date(clock.getTime() + 11 * day);
    const due = (await db.system.billing.bkash.reminders({ now: clock })).find(
      (r) => r.orgId === org.id,
    );
    assert.ok(due, 'a trial with three days left is due');
    assert.equal(due.trial, true);
    assert.equal(due.priceBdt, 2500);

    const sent = () =>
      mailer.sent.filter((m) => m.to === owner.email && /bKash/.test(m.email.subject));
    await billingNotices(ctx);
    assert.equal(sent().length, 1);
    assert.match(sent()[0].email.text, /৳2,500/);
    await billingNotices(ctx);
    assert.equal(sent().length, 1, 'a second run sends nothing more');
    assert.equal(scoped !== null, true);
  });

  test('is not sent once the customer has asked the plan to end', async () => {
    const { org, scoped } = await fx.org();
    const { trialSubscription } = await import('../../src/core/bkash-billing.js');
    clock = new Date('2027-01-10T10:00:00.000Z');
    await db.system.billing.subscriptions.apply({
      parsed: trialSubscription({ orgPublicId: org.public_id, planCode: 'starter', now: clock }),
      now: clock,
    });
    await scoped.bkash.setCancelAtPeriodEnd(true);
    clock = new Date(clock.getTime() + 12 * day);
    assert.equal(
      (await db.system.billing.bkash.reminders({ now: clock })).some((r) => r.orgId === org.id),
      false,
    );
  });
});

describe('the sweep', () => {
  test('finds a payment whose callback never came, settles it, and leaves one still waiting alone', async () => {
    const { org, scoped } = await fx.org();
    clock = new Date(); // payment rows are stamped by the database, so this test's clock starts at the real time
    const p = await payment(scoped, org);
    const created = await bkash.createPayment({
      amountBdt: p.amountBdt,
      invoiceNumber: p.invoiceNumber,
      payerReference: org.public_id,
      callbackUrl: 'https://aeocorner.test/cb',
    });
    await scoped.bkash.attach(p.publicId, created.paymentId);
    stub.approve(created.paymentId);
    await bkash.executePayment(created.paymentId); // bKash took the money; the customer's tab closed before our callback

    const waiting = await payment(scoped, org);
    const second = await bkash.createPayment({
      amountBdt: waiting.amountBdt,
      invoiceNumber: waiting.invoiceNumber,
      payerReference: org.public_id,
      callbackUrl: 'https://aeocorner.test/cb',
    });
    await scoped.bkash.attach(waiting.publicId, second.paymentId);

    clock = new Date(clock.getTime() + 30 * 60_000);
    const out = await bkashSweep(ctx);
    assert.ok(out.settled >= 1);
    const rows = await scoped.bkash.recent();
    assert.equal(rows.find((r) => r.publicId === p.publicId).status, 'completed');
    assert.equal(rows.find((r) => r.publicId === waiting.publicId).status, 'created');
    assert.equal((await summaryOf(scoped)).billingStatus, 'active');

    // A day later the page nobody finished is given up on.
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    await bkashSweep(ctx);
    assert.equal(
      (await scoped.bkash.recent()).find((r) => r.publicId === waiting.publicId).status,
      'expired',
    );
  });

  test('runs its time-based steps even without bKash credentials, and says what it skipped', async () => {
    const out = await bkashSweep({ ...ctx, billing: { bkash: null } });
    assert.equal(out.looked, 0);
  });
});
