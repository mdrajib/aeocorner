import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { ADDONS, addonLookupKey, planLookupKey } from '../../src/core/addons.js';
import { StripeError, createStripe } from '../../src/integrations/stripe.js';
import { syncCatalog } from '../../src/integrations/stripe-catalog.js';
import { startStripeStub } from '../helpers/stripe-stub.js';

/** The Stripe client and the catalog sync (Milestone 8, task 8.01) against a Stripe stand-in on a real socket. */

const stub = await startStripeStub();
const stripe = createStripe({
  secretKey: stub.secretKey,
  baseUrl: stub.url,
  apiVersion: '2026-09-30',
});
after(() => stub.close());

const PLANS = [
  { code: 'starter', name: 'Starter', price_usd_month: '79.00', is_public: true },
  { code: 'growth', name: 'Growth', price_usd_month: '249.00', is_public: true },
  { code: 'agency', name: 'Agency', price_usd_month: '599.00', is_public: true },
  { code: 'secret', name: 'Private', price_usd_month: '1.00', is_public: false },
];

describe('the client', () => {
  test('sends the key as a bearer token, the version as a header, and a form body', async () => {
    await stripe.customers.create({ name: 'Acme', metadata: { org_id: 'O1' } });
    const call = stub.calls.at(-1);
    assert.equal(call.headers.authorization, `Bearer ${stub.secretKey}`);
    assert.equal(call.headers['stripe-version'], '2026-09-30');
    assert.match(call.headers['content-type'], /x-www-form-urlencoded/);
    assert.deepEqual(call.form, { name: 'Acme', metadata: { org_id: 'O1' } });
  });

  test('a wrong key is a StripeError with Stripe’s own words, and the key is not in the message', async () => {
    const wrong = createStripe({ secretKey: 'sk_test_wrong', baseUrl: stub.url });
    await assert.rejects(wrong.customers.create({}), (e) => {
      assert.ok(e instanceof StripeError);
      assert.equal(e.status, 401);
      assert.doesNotMatch(e.message, /sk_test_wrong/);
      return true;
    });
  });

  test('an unreachable Stripe is a StripeError, not a crash', async () => {
    const dead = createStripe({
      secretKey: 'sk_test_x',
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
    });
    await assert.rejects(
      dead.customers.create({}),
      (e) => e instanceof StripeError && e.code === 'unreachable',
    );
  });

  test('a meter event carries the customer and value in the payload', async () => {
    await stripe.meterEvents.create({
      eventName: 'aeo_extra_draft',
      customerId: 'cus_9',
      value: 1,
      identifier: 'draft-1-1',
      timestamp: 1_800_000_000,
    });
    const event = stub.state.meterEvents.at(-1);
    assert.equal(event.event_name, 'aeo_extra_draft');
    assert.deepEqual(event.payload, { stripe_customer_id: 'cus_9', value: '1' });
    assert.equal(event.identifier, 'draft-1-1');
    await assert.rejects(
      stripe.meterEvents.create({
        eventName: 'aeo_extra_draft',
        customerId: 'cus_9',
        value: 1,
        identifier: 'draft-1-1',
      }),
      (e) => e.code === 'billing_meter_event_duplicate',
    );
  });

  test('a missing key cannot build a client', () => {
    assert.throws(() => createStripe({ secretKey: '' }), TypeError);
  });
});

describe('syncing the catalog', () => {
  test('makes a product and a monthly price for each public plan, and each add-on, with the right amounts', async () => {
    const report = await syncCatalog({ stripe, plans: PLANS });
    assert.deepEqual(
      report.plans.map((p) => [p.code, p.created]),
      [
        ['starter', true],
        ['growth', true],
        ['agency', true],
      ],
    );
    const price = (code) =>
      stub.state.prices.find(
        (p) => p.lookup_key === planLookupKey(PLANS.find((x) => x.code === code)),
      );
    assert.equal(price('starter').unit_amount, 7900);
    assert.equal(price('growth').unit_amount, 24900);
    assert.equal(price('agency').unit_amount, 59900);
    assert.equal(price('starter').recurring.interval, 'month');
    assert.equal(price('starter').currency, 'usd');
    assert.ok(
      !stub.state.products.some((p) => p.id === 'aeo_plan_secret'),
      'a private plan is not synced',
    );

    const pack = stub.state.prices.find((p) => p.lookup_key === addonLookupKey('prompt_pack'));
    assert.equal(pack.unit_amount, ADDONS.prompt_pack.priceUsdMonth * 100);
    const draft = stub.state.prices.find((p) => p.lookup_key === addonLookupKey('extra_draft'));
    assert.equal(draft.recurring.usage_type, 'metered');
    assert.equal(draft.recurring.meter, stub.state.meters[0].id);
    assert.equal(stub.state.meters[0].event_name, 'aeo_extra_draft');
    assert.equal(stub.state.meters[0].default_aggregation.formula, 'sum');
  });

  test('running it again creates nothing', async () => {
    const before = {
      products: stub.state.products.length,
      prices: stub.state.prices.length,
      meters: stub.state.meters.length,
    };
    const report = await syncCatalog({ stripe, plans: PLANS });
    assert.ok(report.plans.every((p) => !p.created));
    assert.ok(report.addons.every((a) => !a.created));
    assert.ok(report.meters.every((m) => !m.created));
    assert.deepEqual(
      {
        products: stub.state.products.length,
        prices: stub.state.prices.length,
        meters: stub.state.meters.length,
      },
      before,
    );
  });

  test('a changed price is a new Stripe price; the old one stays for the customers on it', async () => {
    const changed = PLANS.map((p) =>
      p.code === 'starter' ? { ...p, price_usd_month: '89.00' } : p,
    );
    const report = await syncCatalog({ stripe, plans: changed });
    assert.equal(report.plans.find((p) => p.code === 'starter').created, true);
    assert.ok(
      stub.state.prices.some((p) => p.lookup_key === 'aeo-plan-starter-monthly-7900'),
      'the old price is untouched',
    );
    assert.ok(stub.state.prices.some((p) => p.lookup_key === 'aeo-plan-starter-monthly-8900'));
  });

  test('a plan with no price is refused before anything is made for it', async () => {
    await assert.rejects(
      syncCatalog({
        stripe,
        plans: [{ code: 'free', name: 'Free', price_usd_month: '0.00', is_public: true }],
      }),
      /no price/,
    );
  });
});
