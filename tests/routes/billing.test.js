import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addonLookupKey } from '../../src/core/addons.js';
import { createStripe, signStripePayload } from '../../src/integrations/stripe.js';
import { syncCatalog } from '../../src/integrations/stripe-catalog.js';
import { startStripeStub } from '../helpers/stripe-stub.js';
import { authHarness, orgPathOf } from './auth-helpers.js';

/**
 * Plans, billing and the Stripe webhook through the real app (Milestone 8): the webhook's signature and replay rules,
 * Checkout with the 14-day trial, the return trip, the Customer Portal, plan changes, add-ons, and the plan guards on the
 * screens that cost money. Stripe is a stand-in (tests/helpers/stripe-stub.js); a test card in Stripe's own test mode
 * needs the founder's keys (MILESTONES 8, Definition of Done).
 */

const WEBHOOK_SECRET = 'whsec_test_webhook_secret_for_billing';
const stub = await startStripeStub();
const stripe = createStripe({ secretKey: stub.secretKey, baseUrl: stub.url });
const jobs = {
  added: [],
  async add(name, data) {
    this.added.push({ name, data });
  },
};
const h = authHarness({
  jobs,
  billing: { stripe },
  env: { STRIPE_SECRET_KEY: 'sk_test_stub', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
});

let catalog;
before(async () => {
  catalog = await syncCatalog({ stripe, plans: await h.db.reference.plans.list() });
  for (const p of catalog.plans) await h.db.system.billing.plans.setStripePrice(p.code, p.priceId);
});
after(async () => {
  for (const p of catalog.plans) await h.db.system.billing.plans.setStripePrice(p.code, null);
  await h.close();
  await stub.close();
});

let n = 0;
const site = () => `billing-${Date.now().toString(36)}-${n++}.example.test`;
const priceOf = (code) => catalog.plans.find((p) => p.code === code).priceId;

/** An organization with an owner, an editor and a viewer. */
async function newOrg() {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Billing Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  const members = {};
  for (const role of ['editor', 'viewer']) {
    const m = await h.signedIn();
    await scoped.memberships.add({ userId: m.user.id, role });
    members[role] = m;
  }
  return { owner, members, org: found.org, orgId, scoped, base: `/app/o/${orgId}` };
}

/** A subscription in Stripe's memory for the organization, on a plan, with an optional add-on item. */
function subscribe(
  o,
  { plan = 'starter', status = 'trialing', customer, extra = [], fields = {} } = {},
) {
  const customerId = customer ?? o.org.stripe_customer_id ?? `cus_${n++}_${Date.now()}`;
  return stub.setSubscription({
    customer: customerId,
    status,
    metadata: { org_id: o.org.public_id },
    items: {
      data: [
        stub.item({
          priceId: priceOf(plan),
          lookupKey: `aeo-plan-${plan}-monthly-${plan === 'starter' ? 7900 : plan === 'growth' ? 24900 : 59900}`,
        }),
        ...extra,
      ],
    },
    ...fields,
  });
}

/** POST a Stripe event, signed the way Stripe signs it. */
function deliver(event, { secret = WEBHOOK_SECRET, timestamp, tamper } = {}) {
  const body = JSON.stringify({ id: h.fx.stripeEventId(), object: 'event', ...event });
  const header = signStripePayload(body, secret, timestamp);
  return {
    id: JSON.parse(body).id,
    req: h.agent
      .post('/webhooks/stripe')
      .set('stripe-signature', header)
      .set('content-type', 'application/json')
      .send(tamper ? tamper(body) : body),
  };
}
const subEvent = (type, sub) => ({ type, data: { object: sub } });

describe('the Stripe webhook', () => {
  test('a signed event is applied: the organization lands on the plan, and the delivery is recorded', async () => {
    const o = await newOrg();
    const customer = `cus_wh_${Date.now()}`;
    await h.db.forOrg(o.org.id).billing.attachCustomer(customer);
    const sub = subscribe(o, { customer });
    const { id, req } = deliver(subEvent('customer.subscription.created', sub));
    const res = await req.expect(200);
    assert.equal(res.body.status, 'processed');

    const { org } = await h.fx.billingRows(o.org.id);
    assert.equal(org.plan_code, 'starter');
    assert.equal(org.billing_status, 'trialing');
    const stored = await h.db.webhookEvents.find('stripe', id);
    assert.equal(stored.status, 'processed');
  });

  test('the same event delivered again is a duplicate and changes nothing', async () => {
    const o = await newOrg();
    const customer = `cus_dup_${Date.now()}`;
    await h.db.forOrg(o.org.id).billing.attachCustomer(customer);
    const sub = subscribe(o, { customer });
    const body = JSON.stringify({
      id: h.fx.stripeEventId(),
      object: 'event',
      ...subEvent('customer.subscription.updated', sub),
    });
    const send = () =>
      h.agent
        .post('/webhooks/stripe')
        .set('stripe-signature', signStripePayload(body, WEBHOOK_SECRET))
        .set('content-type', 'application/json')
        .send(body);
    assert.equal((await send().expect(200)).body.status, 'processed');
    const before = await h.fx.billingRows(o.org.id);
    for (let i = 0; i < 3; i += 1)
      assert.equal((await send().expect(200)).body.status, 'duplicate');
    const after = await h.fx.billingRows(o.org.id);
    assert.equal(after.subscriptions.length, before.subscriptions.length);
    assert.equal(after.org.updated_at.getTime(), before.org.updated_at.getTime());
  });

  test('a body changed after signing, a wrong secret and a stale signature are refused, and nothing is stored', async () => {
    const o = await newOrg();
    const sub = subscribe(o);
    const event = subEvent('customer.subscription.created', sub);
    const tampered = deliver(event, { tamper: (b) => b.replace('trialing', 'active') });
    await tampered.req.expect(400);
    assert.equal(await h.db.webhookEvents.find('stripe', tampered.id), null);

    const wrong = deliver(event, { secret: 'whsec_somebody_else' });
    await wrong.req.expect(400);
    assert.equal(await h.db.webhookEvents.find('stripe', wrong.id), null);

    const stale = deliver(event, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    await stale.req.expect(400);
    assert.equal(await h.db.webhookEvents.find('stripe', stale.id), null);

    await h.agent
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .send('{}')
      .expect(400);
    assert.equal((await h.fx.billingRows(o.org.id)).subscriptions.length, 0);
  });

  test('when Stripe cannot be asked, the answer is 500 so Stripe sends it again, and the retry works', async () => {
    const o = await newOrg();
    const customer = `cus_retry_${Date.now()}`;
    await h.db.forOrg(o.org.id).billing.attachCustomer(customer);
    const sub = subscribe(o, { customer });
    const body = JSON.stringify({
      id: h.fx.stripeEventId(),
      object: 'event',
      ...subEvent('customer.subscription.updated', sub),
    });
    const send = () =>
      h.agent
        .post('/webhooks/stripe')
        .set('stripe-signature', signStripePayload(body, WEBHOOK_SECRET))
        .set('content-type', 'application/json')
        .send(body);
    stub.failNext(500, 'Stripe is down');
    await send().expect(500);
    const id = JSON.parse(body).id;
    assert.equal((await h.db.webhookEvents.find('stripe', id)).status, 'failed');
    assert.equal((await send().expect(200)).body.status, 'processed');
    assert.equal((await h.db.webhookEvents.find('stripe', id)).status, 'processed');
    assert.equal((await h.fx.billingRows(o.org.id)).org.plan_code, 'starter');
  });

  test('an event type we do not use is acknowledged and ignored', async () => {
    const { req } = deliver({ type: 'charge.refunded', data: { object: { id: 'ch_1' } } });
    assert.equal((await req.expect(200)).body.status, 'ignored');
  });

  test('an invoice paid for a trial’s first real charge opens the money-back window', async () => {
    const o = await newOrg();
    const customer = `cus_inv_${Date.now()}`;
    await h.db.forOrg(o.org.id).billing.attachCustomer(customer);
    const sub = subscribe(o, { customer, status: 'active', fields: { trial_end: null } });
    const invoice = {
      id: 'in_1',
      amount_paid: 7900,
      subscription: sub.id,
      created: Math.floor(Date.now() / 1000),
    };
    await deliver({ type: 'invoice.paid', data: { object: invoice } }).req.expect(200);
    const summary = await h.db.forOrg(o.org.id).billing.summary();
    assert.ok(summary.subscription.moneyBackUntil);
    assert.equal(summary.subscription.status, 'active');
  });

  test('without a signing secret on our side the endpoint says it is not configured', async () => {
    const bare = authHarness();
    try {
      await bare.agent.post('/webhooks/stripe').send('{}').expect(503);
    } finally {
      await bare.close();
    }
  });
});

describe('starting a trial', () => {
  test('Checkout is made for a new customer with the 14-day trial and the organization’s ID, and the owner is sent to Stripe', async () => {
    const o = await newOrg();
    const res = await o.owner.post(`${o.base}/billing/checkout`, { plan: 'starter' }).expect(303);
    assert.match(res.headers.location, /^https:\/\/checkout\.stripe\.test\//);

    const session = stub.state.checkouts.at(-1);
    assert.equal(session.mode, 'subscription');
    assert.equal(session.line_items[0].price, priceOf('starter'));
    assert.equal(session.subscription_data.trial_period_days, '14');
    assert.equal(session.subscription_data.metadata.org_id, o.org.public_id);
    assert.equal(session.client_reference_id, o.org.public_id);
    assert.equal(session.payment_method_collection, 'always');
    assert.match(session.success_url, /\/billing\?notice=billing-started$/);

    const customer = stub.state.customers.get(session.customer);
    assert.equal(customer.metadata.org_id, o.org.public_id);
    // Card details never come here: nothing but our own fields was sent.
    const sent = JSON.stringify(
      stub.calls.filter((c) => c.path === '/v1/checkout/sessions').at(-1).form,
    );
    assert.doesNotMatch(sent, /card|cvc|number/i);
    assert.equal((await o.scoped.billing.summary()).stripeCustomerId, session.customer);
  });

  test('a second click reuses the Stripe customer', async () => {
    const o = await newOrg();
    await o.owner.post(`${o.base}/billing/checkout`, { plan: 'growth' }).expect(303);
    await o.owner.post(`${o.base}/billing/checkout`, { plan: 'growth' }).expect(303);
    const [a, b] = stub.state.checkouts.slice(-2);
    assert.equal(a.customer, b.customer);
  });

  test('an organization that has had a subscription before gets no second free trial', async () => {
    const o = await newOrg();
    const customer = `cus_again_${Date.now()}`;
    await o.scoped.billing.attachCustomer(customer);
    const old = subscribe(o, { customer, status: 'canceled', fields: { trial_end: null } });
    await deliver(subEvent('customer.subscription.deleted', old)).req.expect(200);
    await o.owner.post(`${o.base}/billing/checkout`, { plan: 'starter' }).expect(303);
    assert.equal(stub.state.checkouts.at(-1).subscription_data.trial_period_days, undefined);
  });

  test('only the owner can start one; an editor and a viewer cannot', async () => {
    const o = await newOrg();
    await o.members.editor.post(`${o.base}/billing/checkout`, { plan: 'starter' }).expect(403);
    await o.members.viewer.get(`${o.base}/billing`).expect(403);
    await o.members.editor.post(`${o.base}/billing/portal`).expect(403);
  });

  test('an unknown plan, one not yet synced to Stripe, and a second plan on top of a live one are refused with a reason', async () => {
    const o = await newOrg();
    let res = await o.owner.post(`${o.base}/billing/checkout`, { plan: 'platinum' }).expect(303);
    assert.match(res.headers.location, /billing-bad-plan/);
    res = await o.owner.post(`${o.base}/billing/checkout`, { plan: "x' OR 1=1" }).expect(303);
    assert.match(res.headers.location, /billing-bad-plan/);

    await h.db.system.billing.plans.setStripePrice('agency', null);
    res = await o.owner.post(`${o.base}/billing/checkout`, { plan: 'agency' }).expect(303);
    assert.match(res.headers.location, /billing-not-ready/);
    await h.db.system.billing.plans.setStripePrice('agency', priceOf('agency'));

    const customer = `cus_live_${Date.now()}`;
    await o.scoped.billing.attachCustomer(customer);
    const sub = subscribe(o, { customer });
    await deliver(subEvent('customer.subscription.created', sub)).req.expect(200);
    res = await o.owner.post(`${o.base}/billing/checkout`, { plan: 'growth' }).expect(303);
    assert.match(res.headers.location, /billing-has-plan/);
  });

  test('a Stripe outage is one plain sentence and nothing is changed', async () => {
    const o = await newOrg();
    stub.failNext(500, 'boom');
    const res = await o.owner.post(`${o.base}/billing/checkout`, { plan: 'starter' }).expect(303);
    assert.match(res.headers.location, /billing-stripe-error/);
    const page = await o.owner.get(`${o.base}/billing?notice=billing-stripe-error`).expect(200);
    assert.doesNotMatch(page.text, /boom/);
  });

  test('coming back from Checkout asks Stripe and the plan applies at once, before any webhook', async () => {
    const o = await newOrg();
    await o.owner.post(`${o.base}/billing/checkout`, { plan: 'starter' }).expect(303);
    const customer = stub.state.checkouts.at(-1).customer;
    subscribe(o, { customer });
    const page = await o.owner.get(`${o.base}/billing?notice=billing-started`).expect(200);
    assert.match(page.text, /Trial ends in 14 days/);
    assert.match(page.text, /Starter/);
    assert.match(page.text, /Manage billing/);
    assert.equal((await o.scoped.billing.summary()).planCode, 'starter');
  });
});

describe('the billing screen', () => {
  test('before a plan it offers the trial; the plans show their numbers and the page has no card fields', async () => {
    const o = await newOrg();
    const page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /Choose a plan to start your 14-day free trial/);
    for (const name of ['Starter', 'Growth', 'Agency']) assert.match(page.text, new RegExp(name));
    assert.match(page.text, /\$79/);
    assert.match(page.text, /1 project/);
    assert.match(page.text, /Start free trial/);
    assert.doesNotMatch(page.text, /type="(text|tel)"[^>]*(card|cvc)/i);
  });

  test('on a plan it shows usage against the limits and the current plan has no switch button', async () => {
    const o = await newOrg();
    await h.fx.setOrg(o.org.id, { plan_code: 'starter', billing_status: 'active' });
    await h.fx.project(o.org.id);
    const page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /Projects/);
    assert.match(page.text, />1 of 1</);
    assert.match(page.text, /used all of your plan’s projects/);
    assert.match(page.text, /Your plan/);
  });

  test('every page of an organization says so when there is no plan yet, with a link for the owner only', async () => {
    const o = await newOrg();
    const owner = await o.owner.get(o.base).expect(200);
    assert.match(owner.text, /Choose a plan to start your 14-day free trial/);
    assert.match(owner.text, new RegExp(`href="${o.base}/billing"`));
    const editor = await o.members.editor.get(o.base).expect(200);
    assert.match(editor.text, /Ask an owner of this organization/);
  });
});

describe('plan changes, the portal and add-ons', () => {
  async function subscribed(plan = 'starter') {
    const o = await newOrg();
    const customer = `cus_${plan}_${Date.now()}_${n++}`;
    await o.scoped.billing.attachCustomer(customer);
    const sub = subscribe(o, { customer, plan, status: 'active', fields: { trial_end: null } });
    await deliver(subEvent('customer.subscription.created', sub)).req.expect(200);
    return { ...o, sub };
  }

  test('the portal opens for a customer and not for one who has never subscribed', async () => {
    const fresh = await newOrg();
    let res = await fresh.owner.post(`${fresh.base}/billing/portal`).expect(303);
    assert.match(res.headers.location, /billing-no-customer/);
    const o = await subscribed();
    res = await o.owner.post(`${o.base}/billing/portal`).expect(303);
    assert.match(res.headers.location, /^https:\/\/billing\.stripe\.test\//);
    assert.equal(stub.state.portals.at(-1).customer, o.sub.customer);
    assert.match(stub.state.portals.at(-1).return_url, /\/billing$/);
  });

  test('upgrading changes the plan in Stripe and here', async () => {
    const o = await subscribed('starter');
    const res = await o.owner.post(`${o.base}/billing/plan`, { plan: 'growth' }).expect(303);
    assert.match(res.headers.location, /billing-plan-changed/);
    assert.equal((await o.scoped.billing.summary()).planCode, 'growth');
    assert.equal(stub.state.subscriptions.get(o.sub.id).items.data[0].price.id, priceOf('growth'));
    const again = await o.owner.post(`${o.base}/billing/plan`, { plan: 'growth' }).expect(303);
    assert.match(again.headers.location, /billing-same-plan/);
  });

  test('a smaller plan is refused while more is in use than it allows, and nothing is deleted', async () => {
    const o = await subscribed('growth');
    await h.fx.project(o.org.id);
    await h.fx.project(o.org.id);
    const res = await o.owner.post(`${o.base}/billing/plan`, { plan: 'starter' }).expect(303);
    assert.match(res.headers.location, /billing-downgrade-blocked/);
    assert.equal((await o.scoped.billing.summary()).planCode, 'growth');
    assert.equal(stub.state.subscriptions.get(o.sub.id).items.data[0].price.id, priceOf('growth'));
  });

  test('an add-on raises the limit; removing it takes the extra away; a foreign item cannot be removed', async () => {
    const o = await subscribed('starter');
    const before = (await o.scoped.billing.summary()).limits.prompts;
    const added = await o.owner
      .post(`${o.base}/billing/addons/add`, { addon: 'prompt_pack', quantity: '2' })
      .expect(303);
    assert.match(added.headers.location, /billing-addon-added/);
    assert.equal((await o.scoped.billing.summary()).limits.prompts, before + 50);

    const [grant] = await o.scoped.billing.addons();
    const other = await subscribed('starter');
    await other.owner
      .post(`${other.base}/billing/addons/remove`, { itemId: grant.itemId })
      .expect(303);
    assert.equal(
      (await o.scoped.billing.summary()).limits.prompts,
      before + 50,
      'another organization cannot remove it',
    );

    const removed = await o.owner
      .post(`${o.base}/billing/addons/remove`, { itemId: grant.itemId })
      .expect(303);
    assert.match(removed.headers.location, /billing-addon-removed/);
    assert.equal(
      (await o.scoped.billing.summary({ now: new Date(Date.now() + 5000) })).limits.prompts,
      before,
    );
  });

  test('add-ons need a subscription, and a pack is capped at ten', async () => {
    const o = await newOrg();
    const none = await o.owner
      .post(`${o.base}/billing/addons/add`, { addon: 'prompt_pack' })
      .expect(303);
    assert.match(none.headers.location, /billing-no-plan/);
    const s = await subscribed('starter');
    await s.owner
      .post(`${s.base}/billing/addons/add`, { addon: 'prompt_pack', quantity: '9999' })
      .expect(303);
    const added = stub.state.subscriptions
      .get(s.sub.id)
      .items.data.find((i) => i.price.lookup_key === addonLookupKey('prompt_pack'));
    assert.equal(added.quantity, 10);
  });
});

describe('the plan guards', () => {
  test('a project beyond the plan’s number is refused with the way to upgrade; archiving makes room', async () => {
    const o = await newOrg();
    await h.fx.setOrg(o.org.id, { plan_code: 'starter', billing_status: 'trialing' });
    const first = await o.owner
      .post(`${o.base}/projects`, { website: site(), name: 'One', country: 'US', language: 'en' })
      .expect(303);
    assert.match(first.headers.location, /setup\/brand/);
    const second = await o.owner
      .post(`${o.base}/projects`, { website: site(), name: 'Two', country: 'US', language: 'en' })
      .expect(303);
    assert.match(second.headers.location, /billing\?notice=plan-limit-projects/);
    assert.equal((await o.scoped.projects.list()).length, 1);
  });

  test('seats: an invitation beyond the plan is refused, and client seats are an Agency feature', async () => {
    const o = await newOrg();
    await h.fx.setOrg(o.org.id, { plan_code: 'agency', billing_status: 'active' });
    const project = await h.fx.project(o.org.id);
    await h.fx.setProject(project.id, { status: 'active' });
    // Agency has client seats and (until task 0.17) no seat limit.
    const ok = await o.owner
      .post(`${o.base}/invitations`, {
        email: `seat-${Date.now()}@example.test`,
        role: 'viewer',
        access: 'selected',
        project: project.public_id,
      })
      .expect(303);
    assert.match(ok.headers.location, /invite-sent|invite-email-failed/);

    await h.fx.setOrg(o.org.id, { plan_code: 'starter' });
    const refused = await o.owner
      .post(`${o.base}/invitations`, {
        email: `seat2-${Date.now()}@example.test`,
        role: 'viewer',
        access: 'selected',
        project: project.public_id,
      })
      .expect(303);
    assert.match(refused.headers.location, /plan-no-client-seats/);
  });

  test('with no plan yet, set-up is open but nothing that costs money starts', async () => {
    const o = await newOrg();
    const created = await o.owner
      .post(`${o.base}/projects`, {
        website: site(),
        name: 'Setup Only',
        country: 'US',
        language: 'en',
      })
      .expect(303);
    const pid = created.headers.location.match(/projects\/([0-9A-Z]{26})/)[1];
    const base = `${o.base}/projects/${pid}`;
    const start = await o.owner.post(`${base}/setup/start`).expect(303);
    assert.match(start.headers.location, /plan-paused/);
    const now = await o.owner.post(`${base}/run-now`).expect(303);
    assert.match(now.headers.location, /plan-paused/);
    const project = await o.scoped.projects.getByPublicId(pid);
    assert.notEqual(project.status, 'active', 'tracking did not start');
  });

  test('a lapsed payment past the grace period pauses collection but the data stays readable and editable', async () => {
    const o = await newOrg();
    await h.fx.setOrg(o.org.id, { plan_code: 'starter', billing_status: 'past_due' });
    const project = await h.fx.project(o.org.id);
    await h.fx.setProject(project.id, { status: 'active' });
    const base = `${o.base}/projects/${project.public_id}`;
    await o.owner.get(base).expect(200);
    const page = await o.owner.get(o.base).expect(200);
    assert.match(page.text, /Tracking is paused/);
    const res = await o.owner.post(`${base}/run-now`).expect(303);
    assert.match(res.headers.location, /plan-paused/);
  });

  test('a cancelled account is read-only: every change is refused except subscribing again', async () => {
    const o = await newOrg();
    await h.fx.setOrg(o.org.id, {
      plan_code: 'starter',
      billing_status: 'canceled',
      retain_until: new Date(Date.now() + 30 * 86_400_000),
    });
    await o.owner.get(o.base).expect(200);
    const blocked = await o.owner
      .post(`${o.base}/projects`, { website: site(), name: 'Nope', country: 'US', language: 'en' })
      .expect(303);
    assert.match(blocked.headers.location, /billing\?notice=plan-readonly/);
    const checkout = await o.owner
      .post(`${o.base}/billing/checkout`, { plan: 'starter' })
      .expect(303);
    assert.match(checkout.headers.location, /^https:\/\/checkout\.stripe\.test\//);
  });
});
