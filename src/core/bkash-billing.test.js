import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  addMonths,
  invoiceNumber,
  lapseTransition,
  quotePayment,
  reminderDue,
  subscriptionAfterPayment,
  subscriptionFromRow,
  takaText,
  trialSubscription,
} from './bkash-billing.js';

const day = 86_400_000;
const at = (s) => new Date(`${s}T10:00:00.000Z`);
const starter = { code: 'starter', price_bdt_month: '2500.00' };
const growth = { code: 'growth', price_bdt_month: '7500.00' };

describe('months and money', () => {
  test('a month later keeps the day, or the month’s last day where there is none', () => {
    assert.equal(addMonths(at('2026-10-08')).toISOString(), '2026-11-08T10:00:00.000Z');
    assert.equal(addMonths(at('2026-01-31')).toISOString(), '2026-02-28T10:00:00.000Z');
    assert.equal(addMonths(at('2028-01-31')).toISOString(), '2028-02-29T10:00:00.000Z');
    assert.equal(addMonths(at('2026-12-15')).toISOString(), '2027-01-15T10:00:00.000Z');
  });

  test('taka text: whole taka without decimals, thousands separated', () => {
    assert.equal(takaText(2500), '৳2,500');
    assert.equal(takaText('7500.00'), '৳7,500');
    assert.equal(takaText(2499.5), '৳2,499.50');
  });

  test('an invoice number is ours, at most 40 characters, with no spaces', () => {
    const n = invoiceNumber('01ARZ3NDEKTSV4RRFFQ69G5FAV', at('2026-10-08'), 'a1b2c3');
    assert.ok(n.length <= 40);
    assert.match(n, /^AEO-[A-Z0-9]{8}-[a-z0-9]+-a1b2c3$/);
  });
});

describe('what a payment costs and buys', () => {
  const now = at('2026-10-08');

  test('a first payment (no subscription) is one month from now', () => {
    const q = quotePayment({ plan: starter, now });
    assert.equal(q.ok, true);
    assert.equal(q.amountBdt, 2500);
    assert.equal(q.purpose, 'start');
    assert.equal(q.periodStart.toISOString(), now.toISOString());
    assert.equal(q.periodEnd.toISOString(), '2026-11-08T10:00:00.000Z');
  });

  test('a plan with no taka price cannot be paid for', () => {
    assert.deepEqual(quotePayment({ plan: { code: 'x', price_bdt_month: null }, now }), {
      ok: false,
      reason: 'no_price',
    });
  });

  test('paying during a trial starts the paid month when the trial ends, so no trial days are lost', () => {
    const sub = {
      status: 'trialing',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 10 * day),
      firstPaidAt: null,
    };
    const q = quotePayment({ plan: starter, subscription: sub, currentPlan: starter, now });
    assert.equal(q.periodStart.getTime(), sub.currentPeriodEnd.getTime());
    assert.equal(q.purpose, 'renewal');
  });

  test('renewing early extends from the end of the paid period; renewing late starts from now', () => {
    const paid = (end) => ({
      status: 'active',
      currentPeriodStart: addMonths(end, -1),
      currentPeriodEnd: end,
      firstPaidAt: at('2026-09-01'),
    });
    const early = quotePayment({
      plan: starter,
      subscription: paid(new Date(now.getTime() + 3 * day)),
      currentPlan: starter,
      now,
    });
    assert.equal(early.periodStart.getTime(), now.getTime() + 3 * day);
    const late = quotePayment({
      plan: starter,
      subscription: { ...paid(new Date(now.getTime() - 3 * day)), status: 'past_due' },
      currentPlan: starter,
      now,
    });
    assert.equal(late.periodStart.getTime(), now.getTime());
  });

  test('a bigger plan mid-month starts now, less the unused part of the month already paid', () => {
    const sub = {
      status: 'active',
      currentPeriodStart: at('2026-10-01'),
      currentPeriodEnd: at('2026-11-01'),
      firstPaidAt: at('2026-10-01'),
    };
    const q = quotePayment({
      plan: growth,
      subscription: sub,
      currentPlan: starter,
      now: at('2026-10-16'),
    });
    assert.equal(q.ok, true);
    assert.equal(q.purpose, 'change');
    assert.equal(q.periodStart.toISOString(), at('2026-10-16').toISOString());
    // 16 of 31 days left of ৳2,500 is a credit of 1,290; the new plan is ৳7,500.
    assert.equal(q.creditBdt, 1290);
    assert.equal(q.amountBdt, 7500 - 1290);
    assert.ok(q.amountBdt >= 1);
  });

  test('a smaller plan mid-month waits for the last week, and then starts when the paid month ends', () => {
    const sub = {
      status: 'active',
      currentPeriodStart: at('2026-10-01'),
      currentPeriodEnd: at('2026-11-01'),
      firstPaidAt: at('2026-10-01'),
    };
    assert.deepEqual(
      quotePayment({
        plan: starter,
        subscription: sub,
        currentPlan: growth,
        now: at('2026-10-10'),
      }),
      { ok: false, reason: 'downgrade_mid_period' },
    );
    const late = quotePayment({
      plan: starter,
      subscription: sub,
      currentPlan: growth,
      now: at('2026-10-27'),
    });
    assert.equal(late.ok, true);
    assert.equal(late.periodStart.toISOString(), at('2026-11-01').toISOString());
    assert.equal(late.amountBdt, 2500);
  });

  test('a cancelled subscription starts afresh', () => {
    const sub = {
      status: 'canceled',
      currentPeriodStart: at('2026-08-01'),
      currentPeriodEnd: at('2026-09-01'),
    };
    const q = quotePayment({ plan: growth, subscription: sub, currentPlan: starter, now });
    assert.equal(q.purpose, 'start');
    assert.equal(q.periodStart.getTime(), now.getTime());
  });
});

describe('the subscription a payment or a trial makes', () => {
  test('a trial is 14 days, trialing, with the period equal to the trial', () => {
    const now = at('2026-10-08');
    const t = trialSubscription({ orgPublicId: 'ORG', planCode: 'starter', now });
    assert.equal(t.provider, 'bkash');
    assert.equal(t.status, 'trialing');
    assert.equal(t.orgStatus, 'trialing');
    assert.equal(t.stripeSubscriptionId, 'bkash-ORG');
    assert.equal(t.stripeCustomerId, null);
    assert.equal(t.trialEndsAt.getTime(), now.getTime() + 14 * day);
    assert.equal(t.currentPeriodEnd.getTime(), t.trialEndsAt.getTime());
  });

  test('a payment makes it active for the period bought, and clears a scheduled end', () => {
    const p = subscriptionAfterPayment({
      orgPublicId: 'ORG',
      planCode: 'growth',
      period: { start: at('2026-10-08'), end: at('2026-11-08') },
      previous: { trialEndsAt: at('2026-10-01') },
    });
    assert.equal(p.status, 'active');
    assert.equal(p.orgStatus, 'active');
    assert.equal(p.cancelAtPeriodEnd, false);
    assert.equal(p.trialEndsAt.getTime(), at('2026-10-01').getTime());
    assert.equal(p.currentPeriodEnd.toISOString(), '2026-11-08T10:00:00.000Z');
  });

  test('a stored row turned back keeps its fields and takes the changes', () => {
    const row = {
      planCode: 'starter',
      status: 'active',
      trialEndsAt: null,
      currentPeriodStart: at('2026-09-08'),
      currentPeriodEnd: at('2026-10-08'),
      cancelAtPeriodEnd: true,
      canceledAt: null,
    };
    const p = subscriptionFromRow(row, 'ORG', { status: 'canceled', canceledAt: at('2026-10-09') });
    assert.equal(p.status, 'canceled');
    assert.equal(p.orgStatus, 'canceled');
    assert.equal(p.planCode, 'starter');
    assert.equal(p.cancelAtPeriodEnd, true);
  });
});

describe('what time does to a subscription nobody renews by themselves', () => {
  const now = at('2026-10-08');
  const sub = (o) => ({
    status: 'active',
    currentPeriodEnd: new Date(now.getTime() - day),
    cancelAtPeriodEnd: false,
    ...o,
  });

  test('a period still running changes nothing', () => {
    assert.equal(
      lapseTransition({
        subscription: sub({ currentPeriodEnd: new Date(now.getTime() + day) }),
        now,
      }),
      null,
    );
  });
  test('a trial or paid month that ran out is past due, or cancelled if the customer asked it to end', () => {
    assert.equal(lapseTransition({ subscription: sub({}), now }), 'past_due');
    assert.equal(lapseTransition({ subscription: sub({ status: 'trialing' }), now }), 'past_due');
    assert.equal(
      lapseTransition({ subscription: sub({ cancelAtPeriodEnd: true }), now }),
      'canceled',
    );
  });
  test('past due is left alone until the grace period plus 30 days has passed', () => {
    const graceEnd = (daysAgo) => new Date(now.getTime() - daysAgo * day);
    assert.equal(
      lapseTransition({ subscription: sub({ status: 'past_due', graceUntil: graceEnd(10) }), now }),
      null,
    );
    assert.equal(
      lapseTransition({ subscription: sub({ status: 'past_due', graceUntil: graceEnd(31) }), now }),
      'canceled',
    );
  });
  test('an ended subscription is not touched', () => {
    assert.equal(lapseTransition({ subscription: sub({ status: 'canceled' }), now }), null);
    assert.equal(lapseTransition({ subscription: null, now }), null);
  });
});

describe('the reminder', () => {
  const now = at('2026-10-08');
  const sub = (days, o = {}) => ({
    status: 'active',
    currentPeriodEnd: new Date(now.getTime() + days * day),
    cancelAtPeriodEnd: false,
    ...o,
  });
  test('goes out in the last five days of a trial or paid period', () => {
    assert.equal(reminderDue({ subscription: sub(4), now }), true);
    assert.equal(reminderDue({ subscription: sub(2, { status: 'trialing' }), now }), true);
  });
  test('not earlier, not after the end, not once the customer asked the plan to end', () => {
    assert.equal(reminderDue({ subscription: sub(10), now }), false);
    assert.equal(reminderDue({ subscription: sub(-1), now }), false);
    assert.equal(reminderDue({ subscription: sub(3, { cancelAtPeriodEnd: true }), now }), false);
    assert.equal(reminderDue({ subscription: sub(3, { status: 'past_due' }), now }), false);
  });
});
