import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createBkash } from '../../src/integrations/bkash.js';
import { STUB_CREDENTIALS, startBkashStub } from '../helpers/bkash-stub.js';
import { authHarness, orgPathOf } from './auth-helpers.js';

/**
 * Paying with bKash through the real app (ADR-0018): the plan screen in taka, the free trial, asking bKash for a month,
 * the trip back from bKash's page (where the payment is executed and only then believed), and everything a customer or
 * someone else could try to make that trip lie. bKash is a stand-in (tests/helpers/bkash-stub.js).
 */

const stub = startBkashStub();
const bkash = createBkash({ ...STUB_CREDENTIALS, fetchImpl: stub.fetchImpl });
const h = authHarness({
  billing: { bkash },
  env: {
    BKASH_APP_KEY: STUB_CREDENTIALS.appKey,
    BKASH_APP_SECRET: STUB_CREDENTIALS.appSecret,
    BKASH_USERNAME: STUB_CREDENTIALS.username,
    BKASH_PASSWORD: STUB_CREDENTIALS.password,
  },
});

// The same two prices in both bKash test files, and never put back to NULL: the files run side by side on one database.
before(async () => {
  await h.db.system.billing.plans.setBdtPrice('starter', 2500);
  await h.db.system.billing.plans.setBdtPrice('growth', 7500);
});
after(async () => {
  await h.close();
});

/** An organization with an owner, an editor and a viewer. */
async function newOrg() {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Taka Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  const members = {};
  for (const role of ['editor', 'viewer']) {
    const m = await h.signedIn();
    await scoped.memberships.add({ userId: m.user.id, role });
    members[role] = m;
  }
  return { owner, members, org: found.org, scoped, base: `/app/o/${orgId}` };
}

const notice = (res) => new URL(res.headers.location, 'http://x').searchParams.get('notice');
const summary = (o) => o.scoped.billing.summary({ enforced: true });

/** Start a trial, then ask for a payment; returns bKash's payment ID and the stored row. */
async function startPayment(o, plan = 'starter') {
  const res = await o.owner.post(`${o.base}/billing/bkash/pay`, { plan }).expect(303);
  assert.match(res.headers.location, /^https:\/\/sandbox\.payment\.bkash\.com\/\?paymentId=TR\d+$/);
  const paymentId = new URL(res.headers.location).searchParams.get('paymentId');
  const [row] = await o.scoped.bkash.recent();
  return { paymentId, row };
}
const comeBack = (o, paymentId, status = 'success') =>
  o.owner.get(`${o.base}/billing/bkash/return?paymentID=${paymentId}&status=${status}`);

describe('the plan screen', () => {
  test('shows prices in taka and a free trial button, and nothing about cards', async () => {
    const o = await newOrg();
    const page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /৳2,500/);
    assert.match(page.text, /৳7,500/);
    assert.match(page.text, /Start free trial/);
    assert.match(page.text, /bKash/);
    assert.doesNotMatch(page.text, /Stripe/);
    assert.doesNotMatch(page.text, /\$79/);
  });

  test('a plan with no taka price is not open, and says so', async () => {
    const o = await newOrg();
    const page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /Not open yet/); // the agency plan has no taka price
  });

  test('only an owner sees it or pays', async () => {
    const o = await newOrg();
    await o.members.viewer.get(`${o.base}/billing`).expect(403);
    await o.members.editor.post(`${o.base}/billing/bkash/pay`, { plan: 'starter' }).expect(403);
    await o.members.editor.post(`${o.base}/billing/bkash/trial`, { plan: 'starter' }).expect(403);
    await o.members.editor
      .get(`${o.base}/billing/bkash/return?paymentID=TR000001&status=success`)
      .expect(403);
    await o.members.editor.post(`${o.base}/billing/bkash/renewal`, { stop: '1' }).expect(403);
  });
});

describe('the free trial', () => {
  test('starts with no payment and no call to bKash, once per organization', async () => {
    const o = await newOrg();
    const before = stub.calls.length;
    const res = await o.owner
      .post(`${o.base}/billing/bkash/trial`, { plan: 'starter' })
      .expect(303);
    assert.equal(notice(res), 'billing-bkash-trial');
    assert.equal(stub.calls.length, before);

    const s = await summary(o);
    assert.equal(s.billingStatus, 'trialing');
    assert.equal(s.planCode, 'starter');
    assert.equal(s.access.level, 'full');
    assert.equal(s.subscription.provider, 'bkash');

    const again = await o.owner
      .post(`${o.base}/billing/bkash/trial`, { plan: 'growth' })
      .expect(303);
    assert.equal(notice(again), 'billing-trial-used');
    assert.equal((await summary(o)).planCode, 'starter');
  });

  test('the screen then says what to do when it ends, and offers payment, not another trial', async () => {
    const o = await newOrg();
    await o.owner.post(`${o.base}/billing/bkash/trial`, { plan: 'starter' }).expect(303);
    const page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /Nothing is charged automatically/);
    assert.match(page.text, /Renew with bKash/);
    assert.match(page.text, /Pay ৳7,500 with bKash/);
    assert.doesNotMatch(page.text, /Start free trial/);
  });

  test('a plan that does not exist, is not public, or has no taka price starts nothing', async () => {
    const o = await newOrg();
    for (const [plan, expected] of [
      ['platinum', 'billing-bad-plan'],
      ["x' OR 1=1", 'billing-bad-plan'],
      ['agency', 'billing-not-ready'],
    ]) {
      const res = await o.owner.post(`${o.base}/billing/bkash/trial`, { plan }).expect(303);
      assert.equal(notice(res), expected, plan);
    }
    assert.equal((await summary(o)).billingStatus, 'none');
  });
});

describe('paying', () => {
  test('sends the customer to bKash for the plan’s taka price, and nothing is active until bKash confirms', async () => {
    const o = await newOrg();
    const { paymentId, row } = await startPayment(o);
    assert.equal(row.status, 'created');
    assert.equal(row.amountBdt, 2500);
    assert.equal(row.purpose, 'start');
    assert.equal(stub.payments.get(paymentId).amount, '2500.00');
    assert.equal(stub.payments.get(paymentId).invoice, row.invoiceNumber);
    assert.match(
      stub.payments.get(paymentId).callbackURL,
      new RegExp(`${o.base}/billing/bkash/return$`),
    );
    assert.equal((await summary(o)).billingStatus, 'none');
  });

  test('coming back after approving executes the payment and activates the plan; coming back again changes nothing', async () => {
    const o = await newOrg();
    const { paymentId, row } = await startPayment(o);
    stub.approve(paymentId);
    const res = await comeBack(o, paymentId).expect(303);
    assert.equal(notice(res), 'billing-bkash-paid');

    const s = await summary(o);
    assert.equal(s.billingStatus, 'active');
    assert.equal(s.planCode, 'starter');
    assert.equal(s.subscription.provider, 'bkash');
    assert.equal((await o.scoped.bkash.recent())[0].trxId, stub.payments.get(paymentId).trxID);
    const end = s.subscription.currentPeriodEnd.getTime();

    const again = await comeBack(o, paymentId).expect(303);
    assert.equal(notice(again), 'billing-bkash-paid');
    assert.equal((await summary(o)).subscription.currentPeriodEnd.getTime(), end);
    assert.equal(row.publicId, (await o.scoped.bkash.recent())[0].publicId);

    const page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /Paid until/);
    assert.match(page.text, /Payments/);
    assert.match(page.text, new RegExp(stub.payments.get(paymentId).trxID));
  });

  test('a customer who paid in the trial keeps every trial day: the paid month starts when the trial ends', async () => {
    const o = await newOrg();
    await o.owner.post(`${o.base}/billing/bkash/trial`, { plan: 'starter' }).expect(303);
    const trialEnd = (await summary(o)).subscription.currentPeriodEnd.getTime();
    const { paymentId } = await startPayment(o);
    stub.approve(paymentId);
    await comeBack(o, paymentId).expect(303);
    const row = (await o.scoped.bkash.recent())[0];
    assert.equal(row.periodStart.getTime(), trialEnd);
  });

  test('cancelling on bKash’s page, or a failure there, charges nothing and activates nothing', async () => {
    const o = await newOrg();
    const a = await startPayment(o);
    assert.equal(
      notice(await comeBack(o, a.paymentId, 'cancel').expect(303)),
      'billing-bkash-cancelled',
    );
    const b = await startPayment(o);
    assert.equal(
      notice(await comeBack(o, b.paymentId, 'failure').expect(303)),
      'billing-bkash-failed',
    );
    assert.equal((await summary(o)).billingStatus, 'none');
    const statuses = (await o.scoped.bkash.recent()).map((r) => r.status);
    assert.deepEqual(statuses, ['failed', 'cancelled']);
  });

  test('a return that says "success" for a payment the customer never approved is not believed', async () => {
    const o = await newOrg();
    const { paymentId } = await startPayment(o);
    // Nobody approved on bKash. Someone opens the return link by hand.
    const res = await comeBack(o, paymentId, 'success').expect(303);
    assert.equal(notice(res), 'billing-bkash-failed');
    assert.equal((await summary(o)).billingStatus, 'none');
    assert.equal((await o.scoped.bkash.recent())[0].status, 'failed');
  });

  test('a payment ID that is unknown, malformed or another organization’s does nothing', async () => {
    const mine = await newOrg();
    const theirs = await newOrg();
    const stolen = await startPayment(theirs);
    stub.approve(stolen.paymentId);

    for (const id of [stolen.paymentId, 'TR999999', '../etc/passwd', 'x'.repeat(200), '']) {
      const res = await mine.owner
        .get(`${mine.base}/billing/bkash/return?status=success&paymentID=${encodeURIComponent(id)}`)
        .expect(303);
      assert.equal(notice(res), 'billing-bkash-failed', id);
    }
    assert.equal((await summary(mine)).billingStatus, 'none');
    // Their payment was not executed, not completed, and is still theirs to finish.
    assert.equal(stub.payments.get(stolen.paymentId).status, 'Initiated');
    assert.equal((await theirs.scoped.bkash.recent())[0].status, 'created');
    assert.equal(
      notice(await comeBack(theirs, stolen.paymentId).expect(303)),
      'billing-bkash-paid',
    );
  });

  test('bKash being down creates no active plan and leaves the payment marked failed, with a plain message', async () => {
    const o = await newOrg();
    stub.setDown(true);
    const res = await o.owner.post(`${o.base}/billing/bkash/pay`, { plan: 'starter' }).expect(303);
    stub.setDown(false);
    assert.equal(notice(res), 'billing-bkash-error');
    assert.equal((await o.scoped.bkash.recent())[0].status, 'failed');
    const page = await o.owner.get(`${o.base}/billing?notice=billing-bkash-error`).expect(200);
    assert.match(page.text, /couldn’t reach bKash/);
  });

  test('when bKash can’t be asked on the way back, the page says we are checking and the sweep settles it later', async () => {
    const o = await newOrg();
    const { paymentId } = await startPayment(o);
    stub.approve(paymentId);
    stub.setDown(true);
    const res = await comeBack(o, paymentId).expect(303);
    stub.setDown(false);
    assert.equal(notice(res), 'billing-bkash-checking');
    assert.equal((await summary(o)).billingStatus, 'none');
    assert.equal((await o.scoped.bkash.recent())[0].status, 'created');
  });

  test('a plan with no taka price cannot be paid for, and a bad plan code is refused', async () => {
    const o = await newOrg();
    assert.equal(
      notice(await o.owner.post(`${o.base}/billing/bkash/pay`, { plan: 'agency' }).expect(303)),
      'billing-not-ready',
    );
    assert.equal(
      notice(await o.owner.post(`${o.base}/billing/bkash/pay`, { plan: 'nope' }).expect(303)),
      'billing-bad-plan',
    );
    assert.equal((await o.scoped.bkash.recent()).length, 0);
  });
});

describe('changing plan while paid up', () => {
  async function paidUp(plan = 'starter') {
    const o = await newOrg();
    const { paymentId } = await startPayment(o, plan);
    stub.approve(paymentId);
    await comeBack(o, paymentId).expect(303);
    return o;
  }

  test('a bigger plan costs the new price less a credit for the unused month, and starts now', async () => {
    const o = await paidUp('starter');
    const { row } = await startPayment(o, 'growth');
    assert.equal(row.purpose, 'change');
    // Paid moments ago: nearly the whole month is unused, so the credit is nearly all of ৳2,500.
    assert.ok(row.amountBdt < 7500 && row.amountBdt >= 5000, `amount ${row.amountBdt}`);
    const page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /credit of ৳/);
  });

  test('a smaller plan in the middle of the month is refused until the last week', async () => {
    const o = await paidUp('growth');
    const res = await o.owner.post(`${o.base}/billing/bkash/pay`, { plan: 'starter' }).expect(303);
    assert.equal(notice(res), 'billing-downgrade-later');
    assert.equal((await o.scoped.bkash.recent()).length, 1, 'no new payment was made');
  });

  test('stopping the renewal keeps the plan until the end and can be undone', async () => {
    const o = await paidUp('starter');
    assert.equal(
      notice(await o.owner.post(`${o.base}/billing/bkash/renewal`, { stop: '1' }).expect(303)),
      'billing-bkash-renewal-stopped',
    );
    assert.equal((await summary(o)).subscription.cancelAtPeriodEnd, true);
    assert.equal((await summary(o)).billingStatus, 'active');
    let page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /won’t renew/);
    assert.match(page.text, /Keep my plan going/);

    assert.equal(
      notice(await o.owner.post(`${o.base}/billing/bkash/renewal`, { stop: '0' }).expect(303)),
      'billing-bkash-renewal-resumed',
    );
    page = await o.owner.get(`${o.base}/billing`).expect(200);
    assert.match(page.text, /Stop renewing/);
  });

  test('stopping the renewal with no plan does nothing', async () => {
    const o = await newOrg();
    assert.equal(
      notice(await o.owner.post(`${o.base}/billing/bkash/renewal`, { stop: '1' }).expect(303)),
      'billing-no-plan',
    );
  });
});

describe('a form without the token is refused', () => {
  test('every state-changing bKash route needs the CSRF token', async () => {
    const o = await newOrg();
    await o.owner
      .post(`${o.base}/billing/bkash/pay`, { plan: 'starter' }, { csrf: null })
      .expect(403);
    await o.owner
      .post(`${o.base}/billing/bkash/trial`, { plan: 'starter' }, { csrf: null })
      .expect(403);
    await o.owner
      .post(`${o.base}/billing/bkash/renewal`, { stop: '1' }, { csrf: null })
      .expect(403);
    assert.equal((await o.scoped.bkash.recent()).length, 0);
  });
});
