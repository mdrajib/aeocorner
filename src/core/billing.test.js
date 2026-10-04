import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ADDONS, addonLookupKey, planLookupKey } from './addons.js';
import {
  billingView,
  datesAfter,
  firstPayment,
  grantsFromAddons,
  invoiceSubscriptionId,
  orgBillingStatus,
  subscriptionFromStripe,
  trialDaysLeft,
} from './billing.js';
import { accessFor } from './entitlements.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const PRICES = new Map([['price_starter', 'starter']]);

const stripeSub = (extra = {}) => ({
  id: 'sub_1',
  customer: 'cus_1',
  status: 'trialing',
  trial_end: sec('2026-10-18T00:00:00Z'),
  cancel_at_period_end: false,
  metadata: { org_id: '01HORGPUBLICID' },
  items: {
    data: [
      {
        id: 'si_plan',
        quantity: 1,
        current_period_start: sec('2026-10-04T00:00:00Z'),
        current_period_end: sec('2026-10-18T00:00:00Z'),
        price: { id: 'price_starter', lookup_key: 'aeo-plan-starter-monthly-7900' },
      },
    ],
  },
  ...extra,
});

describe('subscriptionFromStripe', () => {
  test('reads the plan, status, trial and the period from the item (newer API versions)', () => {
    const row = subscriptionFromStripe(stripeSub(), PRICES);
    assert.equal(row.planCode, 'starter');
    assert.equal(row.status, 'trialing');
    assert.equal(row.orgStatus, 'trialing');
    assert.equal(row.stripeCustomerId, 'cus_1');
    assert.equal(row.orgPublicId, '01HORGPUBLICID');
    assert.equal(row.trialEndsAt.toISOString(), '2026-10-18T00:00:00.000Z');
    assert.equal(row.currentPeriodEnd.toISOString(), '2026-10-18T00:00:00.000Z');
  });

  test('reads the period from the subscription itself (older API versions)', () => {
    const sub = stripeSub({
      current_period_start: sec('2026-09-01T00:00:00Z'),
      current_period_end: sec('2026-10-01T00:00:00Z'),
    });
    assert.equal(
      subscriptionFromStripe(sub, PRICES).currentPeriodEnd.toISOString(),
      '2026-10-01T00:00:00.000Z',
    );
  });

  test('the same object always gives the same row (a replayed event changes nothing)', () => {
    assert.deepEqual(
      subscriptionFromStripe(stripeSub(), PRICES),
      subscriptionFromStripe(stripeSub(), PRICES),
    );
  });

  test('finds the plan by our lookup key when the price is not in the plan table yet', () => {
    assert.equal(subscriptionFromStripe(stripeSub(), new Map()).planCode, 'starter');
  });

  test('add-on items become add-ons; a customer string or object both work', () => {
    const sub = stripeSub({
      customer: { id: 'cus_obj' },
      items: {
        data: [
          ...stripeSub().items.data,
          {
            id: 'si_pack',
            quantity: 2,
            price: { id: 'price_pack', lookup_key: addonLookupKey('prompt_pack') },
          },
          { id: 'si_other', quantity: 1, price: { id: 'price_x', lookup_key: 'something-else' } },
        ],
      },
    });
    const row = subscriptionFromStripe(sub, PRICES);
    assert.equal(row.stripeCustomerId, 'cus_obj');
    assert.deepEqual(row.addons, [{ code: 'prompt_pack', itemId: 'si_pack', quantity: 2 }]);
  });

  test('a subscription with no plan we know, or an unknown status, is not stored', () => {
    assert.equal(
      subscriptionFromStripe(
        stripeSub({ items: { data: [{ id: 'x', price: { id: 'p', lookup_key: 'zzz' } }] } }),
        PRICES,
      ),
      null,
    );
    assert.equal(subscriptionFromStripe(stripeSub({ status: 'mystery' }), PRICES), null);
    assert.equal(subscriptionFromStripe(null, PRICES), null);
  });

  test('a scheduled cancellation is a cancellation at period end', () => {
    assert.equal(
      subscriptionFromStripe(stripeSub({ cancel_at_period_end: true }), PRICES).cancelAtPeriodEnd,
      true,
    );
    assert.equal(
      subscriptionFromStripe(stripeSub({ cancel_at: sec('2026-11-01T00:00:00Z') }), PRICES)
        .cancelAtPeriodEnd,
      true,
    );
  });
});

describe('orgBillingStatus', () => {
  test('maps every Stripe status to the organization mirror', () => {
    const expected = {
      trialing: 'trialing',
      active: 'active',
      past_due: 'past_due',
      unpaid: 'past_due',
      paused: 'paused',
      canceled: 'canceled',
      incomplete_expired: 'canceled',
      incomplete: 'none',
    };
    for (const [stripe, ours] of Object.entries(expected))
      assert.equal(orgBillingStatus(stripe), ours, stripe);
  });
});

describe('datesAfter', () => {
  test('a failed payment starts a 7-day grace once; a second failure does not restart it', () => {
    const first = datesAfter({ status: 'past_due', now: NOW });
    assert.equal(first.graceUntil.toISOString(), '2026-10-11T12:00:00.000Z');
    const later = datesAfter({
      status: 'past_due',
      before: { graceUntil: first.graceUntil },
      now: new Date('2026-10-08T00:00:00Z'),
    });
    assert.equal(later.graceUntil.toISOString(), first.graceUntil.toISOString());
  });

  test('paying again clears the grace period', () => {
    assert.equal(
      datesAfter({ status: 'active', before: { graceUntil: NOW }, now: NOW }).graceUntil,
      null,
    );
  });

  test('cancelling starts the 90-day retention window, once', () => {
    const out = datesAfter({ status: 'canceled', now: NOW });
    assert.equal(out.retainUntil.toISOString(), '2027-01-02T12:00:00.000Z');
    const again = datesAfter({
      status: 'canceled',
      before: { retainUntil: out.retainUntil },
      now: new Date('2026-11-01T00:00:00Z'),
    });
    assert.equal(again.retainUntil.toISOString(), out.retainUntil.toISOString());
  });
});

describe('firstPayment', () => {
  test('the first paid invoice opens the 30-day money-back window', () => {
    const out = firstPayment({
      invoice: { amount_paid: 7900, status_transitions: { paid_at: sec('2026-10-18T00:00:00Z') } },
      before: null,
    });
    assert.equal(out.firstPaidAt.toISOString(), '2026-10-18T00:00:00.000Z');
    assert.equal(out.moneyBackUntil.toISOString(), '2026-11-17T00:00:00.000Z');
  });

  test('a $0 trial invoice does not, and a second payment does not move it', () => {
    assert.equal(
      firstPayment({
        invoice: { amount_paid: 0, created: sec('2026-10-04T00:00:00Z') },
        before: null,
      }),
      null,
    );
    assert.equal(
      firstPayment({ invoice: { amount_paid: 7900 }, before: { firstPaidAt: NOW } }),
      null,
    );
  });
});

describe('invoiceSubscriptionId', () => {
  test('finds the subscription in each shape Stripe has used', () => {
    assert.equal(invoiceSubscriptionId({ subscription: 'sub_a' }), 'sub_a');
    assert.equal(invoiceSubscriptionId({ subscription: { id: 'sub_b' } }), 'sub_b');
    assert.equal(
      invoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_c' } } }),
      'sub_c',
    );
    assert.equal(invoiceSubscriptionId({}), null);
  });
});

describe('add-ons', () => {
  test('a prompt pack grants 25 questions a unit; a metered add-on grants nothing but is flagged', () => {
    const grants = grantsFromAddons(
      [
        { code: 'prompt_pack', itemId: 'si_1', quantity: 3 },
        { code: 'extra_draft', itemId: 'si_2', quantity: 1 },
      ],
      ADDONS,
    );
    assert.deepEqual(grants[0], {
      meter: 'prompts',
      amount: 75,
      itemId: 'si_1',
      reason: 'add-on: Extra questions',
      metered: false,
    });
    assert.equal(grants[1].meter, 'drafts');
    assert.equal(grants[1].amount, 0);
    assert.equal(grants[1].metered, true);
  });

  test('lookup keys carry the amount so a new price is a new Stripe price', () => {
    assert.equal(
      planLookupKey({ code: 'growth', price_usd_month: '249.00' }),
      'aeo-plan-growth-monthly-24900',
    );
    assert.equal(addonLookupKey('prompt_pack'), 'aeo-addon-prompt_pack-1900');
  });
});

describe('billingView', () => {
  const plans = [
    {
      code: 'starter',
      name: 'Starter',
      price_usd_month: '79.00',
      stripe_price_id: 'price_starter',
      max_projects: 1,
      max_prompts: 50,
      drafts_per_month: '4.0',
      features: {},
    },
    {
      code: 'growth',
      name: 'Growth',
      price_usd_month: '249.00',
      stripe_price_id: null,
      max_projects: 3,
      max_prompts: 150,
      drafts_per_month: '15.0',
      features: { alerts: true },
    },
  ];
  const base = { plan: plans[0], plans, now: NOW };

  test('a trial says how many days are left and when the card is charged', () => {
    const view = billingView({
      ...base,
      billingStatus: 'trialing',
      subscription: { trialEndsAt: new Date('2026-10-10T12:00:00Z') },
      usage: { prompts: 38, projects: 1 },
      limits: { prompts: 50, projects: 1 },
      access: accessFor({ billingStatus: 'trialing', now: NOW }),
    });
    assert.equal(view.statusLine, 'Trial ends in 6 days');
    assert.match(view.lines[0], /\$79 on October 10, 2026/);
    assert.equal(view.meters.find((m) => m.meter === 'prompts').text, '38 of 50');
    assert.equal(view.meters.find((m) => m.meter === 'prompts').nearly, false);
    assert.equal(view.meters.find((m) => m.meter === 'projects').full, true);
    assert.match(view.banners.at(-1).text, /used all of your plan’s projects/);
    assert.equal(view.ctaLabel, 'Change plan');
  });

  test('before any plan the screen offers the trial, and a plan with no Stripe price cannot be chosen yet', () => {
    const view = billingView({
      ...base,
      plan: null,
      billingStatus: 'none',
      subscription: null,
      usage: {},
      limits: {},
      access: accessFor({ billingStatus: 'none', now: NOW }),
    });
    assert.equal(view.ctaLabel, 'Start your 14-day free trial');
    assert.equal(view.canManage, false);
    assert.match(view.banners[0].text, /Choose a plan/);
    assert.deepEqual(
      view.choices.map((c) => c.canChoose),
      [true, false],
    );
  });

  test('an unenforced meter says only what is used; a missing figure is left out, never shown as 0', () => {
    const view = billingView({
      ...base,
      billingStatus: 'active',
      subscription: { currentPeriodEnd: new Date('2026-11-04T00:00:00Z') },
      usage: { seats: 3, drafts: undefined },
      limits: { seats: null },
      access: accessFor({ billingStatus: 'active', now: NOW }),
    });
    assert.equal(view.meters.length, 1);
    assert.equal(view.meters[0].text, '3 used');
    assert.match(view.lines[0], /Renews on November 4, 2026/);
  });

  test('a lapsed payment says tracking is paused and the data is kept', () => {
    const view = billingView({
      ...base,
      billingStatus: 'past_due',
      subscription: {},
      usage: {},
      limits: {},
      access: accessFor({
        billingStatus: 'past_due',
        graceUntil: new Date('2026-10-01T00:00:00Z'),
        now: NOW,
      }),
    });
    assert.match(view.banners[0].text, /paused/);
    assert.match(view.banners[0].text, /data is kept/);
  });

  test('the money-back sentence appears only inside the window', () => {
    const inside = billingView({
      ...base,
      billingStatus: 'active',
      subscription: { moneyBackUntil: new Date('2026-11-01T00:00:00Z') },
      usage: {},
      limits: {},
      access: { level: 'full' },
    });
    assert.ok(inside.lines.some((l) => /full refund/.test(l)));
    const after = billingView({
      ...base,
      billingStatus: 'active',
      subscription: { moneyBackUntil: new Date('2026-09-01T00:00:00Z') },
      usage: {},
      limits: {},
      access: { level: 'full' },
    });
    assert.ok(!after.lines.some((l) => /refund/.test(l)));
  });
});

describe('trialDaysLeft', () => {
  test('rounds up and never goes negative', () => {
    assert.equal(trialDaysLeft(new Date('2026-10-04T13:00:00Z'), NOW), 1);
    assert.equal(trialDaysLeft(new Date('2026-10-01T00:00:00Z'), NOW), 0);
    assert.equal(trialDaysLeft(null, NOW), null);
  });
});
