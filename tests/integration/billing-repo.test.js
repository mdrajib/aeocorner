import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { addonLookupKey } from '../../src/core/addons.js';
import { subscriptionFromStripe } from '../../src/core/billing.js';
import { addDays } from '../../src/core/entitlements.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/**
 * Billing against the real database (Milestone 8): what a Stripe subscription writes, that writing it again changes
 * nothing, what the plan allows, and the cancelled-account clock. Cross-organization checks are in
 * tests/tenancy/repositories.test.js; the rules themselves are in src/core/billing.test.js and entitlements.test.js.
 */

const db = connectTestDb();
const fx = fixtures(db);
after(async () => {
  await fx.cleanup();
  await db.close();
});

const NOW = new Date('2026-10-04T12:00:00Z');
const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const billing = db.system.billing;
let seq = 0;

/** A Stripe-shaped subscription for an organization. */
function stripeSub(org, overrides = {}) {
  seq += 1;
  const id = overrides.id ?? `sub_t${Date.now()}${seq}`;
  return {
    id,
    customer: overrides.customer ?? `cus_t${Date.now()}${seq}`,
    status: 'trialing',
    trial_end: sec('2026-10-18T00:00:00Z'),
    metadata: { org_id: org.public_id },
    items: {
      data: [
        {
          id: `si_${id}`,
          quantity: 1,
          current_period_start: sec('2026-10-04T00:00:00Z'),
          current_period_end: sec('2026-10-18T00:00:00Z'),
          price: { id: 'price_x', lookup_key: 'aeo-plan-starter-monthly-7900' },
        },
        ...(overrides.extraItems ?? []),
      ],
    },
    ...overrides.fields,
  };
}
const parse = (sub) => subscriptionFromStripe(sub, new Map());
const apply = (sub, extra = {}) =>
  billing.subscriptions.apply({ parsed: parse(sub), now: NOW, ...extra });

describe('applying a subscription', () => {
  test('a trial subscription puts the organization on the plan and links its customer', async () => {
    const { org, scoped } = await fx.org();
    const sub = stripeSub(org);
    const result = await apply(sub);
    assert.equal(result.applied, true);
    assert.equal(result.changed, true);

    const { subscriptions, org: row } = await fx.billingRows(org.id);
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0].status, 'trialing');
    assert.equal(subscriptions[0].plan_code, 'starter');
    assert.equal(row.plan_code, 'starter');
    assert.equal(row.billing_status, 'trialing');
    assert.equal(row.stripe_customer_id, sub.customer);

    const summary = await scoped.billing.summary({ now: NOW });
    assert.equal(summary.access.level, 'full');
    assert.equal(summary.subscription.trialEndsAt.toISOString(), '2026-10-18T00:00:00.000Z');
  });

  test('replaying created, updated and cancelled is a no-op: the same rows, no duplicates', async () => {
    const { org } = await fx.org();
    const created = stripeSub(org);
    const updated = { ...created, status: 'active', trial_end: null };
    const canceled = { ...updated, status: 'canceled', canceled_at: sec('2026-11-01T00:00:00Z') };

    for (const step of [created, updated, canceled]) {
      await apply(step);
      const first = await fx.billingRows(org.id);
      // The same event again, three times.
      for (let i = 0; i < 3; i += 1) {
        const again = await apply(step);
        assert.equal(again.changed, false, `${step.status} replay changed the organization`);
      }
      const second = await fx.billingRows(org.id);
      const omit = (row, ...keys) =>
        Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
      const strip = (rows) =>
        JSON.stringify(
          {
            s: rows.subscriptions.map((r) => omit(r, 'updated_at')),
            g: rows.grants.map((r) => omit(r, 'created_at')),
            o: omit(rows.org, 'updated_at'),
          },
          (_k, v) => (typeof v === 'bigint' ? String(v) : v),
        );
      assert.equal(
        second.subscriptions.length,
        1,
        'one subscription row, however often it is replayed',
      );
      assert.equal(strip(second), strip(first), `${step.status}: replay changed the rows`);
    }
    const { org: row } = await fx.billingRows(org.id);
    assert.equal(row.billing_status, 'canceled');
    assert.ok(row.retain_until, 'cancelling starts the retention window');
    assert.ok(row.canceled_at);
  });

  test('a late event about an old cancelled subscription cannot overwrite the current one', async () => {
    const { org } = await fx.org();
    const customer = `cus_late${Date.now()}`;
    const old = stripeSub(org, { customer, fields: { status: 'canceled', trial_end: null } });
    const current = stripeSub(org, { customer, fields: { status: 'active', trial_end: null } });
    await apply(old);
    await apply(current);
    await apply(old); // the stale event arrives again
    const { org: row, subscriptions } = await fx.billingRows(org.id);
    assert.equal(subscriptions.length, 2);
    assert.equal(row.billing_status, 'active');
    assert.equal(row.retain_until, null, 'an active organization is not on the retention clock');
  });

  test('a failed payment starts a seven-day grace once; paying clears it', async () => {
    const { org, scoped } = await fx.org();
    const sub = stripeSub(org, { fields: { status: 'active', trial_end: null } });
    await apply(sub);
    const failedAt = NOW;
    await apply({ ...sub, status: 'past_due' }, { now: failedAt });
    let summary = await scoped.billing.summary({ now: addDays(failedAt, 3) });
    assert.equal(summary.access.level, 'grace');
    assert.equal(summary.access.collect, true);

    // A second failure three days later does not restart the clock.
    await billing.subscriptions.apply({
      parsed: parse({ ...sub, status: 'past_due' }),
      now: addDays(failedAt, 3),
    });
    summary = await scoped.billing.summary({ now: addDays(failedAt, 8) });
    assert.equal(
      summary.access.level,
      'paused',
      'seven days after the FIRST failure, tracking pauses',
    );

    await apply({ ...sub, status: 'active' }, { now: addDays(failedAt, 9) });
    summary = await scoped.billing.summary({ now: addDays(failedAt, 9) });
    assert.equal(summary.access.level, 'full');
    assert.equal(summary.subscription.graceUntil, null);
  });

  test('the first real payment opens the 30-day money-back window; a $0 trial invoice does not', async () => {
    const { org, scoped } = await fx.org();
    const sub = stripeSub(org, { fields: { status: 'active', trial_end: null } });
    await apply(sub, { invoice: { amount_paid: 0, created: sec('2026-10-04T00:00:00Z') } });
    assert.equal((await scoped.billing.summary({ now: NOW })).subscription.moneyBackUntil, null);
    await apply(sub, {
      invoice: { amount_paid: 7900, status_transitions: { paid_at: sec('2026-10-18T00:00:00Z') } },
    });
    const first = (await scoped.billing.summary({ now: NOW })).subscription;
    assert.equal(first.moneyBackUntil.toISOString(), '2026-11-17T00:00:00.000Z');
    // A later payment keeps the original window.
    await apply(sub, {
      invoice: { amount_paid: 7900, status_transitions: { paid_at: sec('2026-11-18T00:00:00Z') } },
    });
    assert.equal(
      (await scoped.billing.summary({ now: NOW })).subscription.moneyBackUntil.toISOString(),
      '2026-11-17T00:00:00.000Z',
    );
  });

  test('add-on items become grants that raise the limit, and removing the item ends the grant', async () => {
    const { org, scoped } = await fx.org();
    const pack = {
      id: 'si_pack1',
      quantity: 2,
      price: { id: 'p', lookup_key: addonLookupKey('prompt_pack') },
    };
    const sub = stripeSub(org, {
      extraItems: [pack],
      fields: { status: 'active', trial_end: null },
    });
    await apply(sub);
    assert.equal((await scoped.billing.summary({ now: NOW })).limits.prompts, 50 + 50);
    assert.equal((await scoped.billing.addons({ now: NOW })).length, 1);

    const without = { ...sub, items: { data: sub.items.data.slice(0, 1) } };
    await apply(without);
    assert.equal((await scoped.billing.summary({ now: addDays(NOW, 1) })).limits.prompts, 50);
    assert.equal((await scoped.billing.addons({ now: addDays(NOW, 1) })).length, 0);
  });

  test('a subscription that is not ours is refused, and says why', async () => {
    const { org } = await fx.org();
    const other = await fx.org();
    const sub = stripeSub(org);
    await apply(sub);
    // Same organization, a different Stripe customer: refused (the customer stored first wins).
    const hijack = stripeSub(org, { customer: 'cus_someone_else' });
    assert.deepEqual(await apply(hijack), { applied: false, reason: 'customer_mismatch' });
    // A subscription with no organization we know.
    const ghost = {
      ...stripeSub(org),
      metadata: { org_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' },
      customer: 'cus_ghost',
    };
    assert.deepEqual(await apply(ghost), { applied: false, reason: 'unknown_organization' });
    // The subscription id of one organization cannot be claimed by another.
    const stolen = { ...stripeSub(other.org), id: sub.id, customer: 'cus_other' };
    assert.deepEqual(await apply(stolen), { applied: false, reason: 'customer_mismatch' });
    assert.equal((await fx.billingRows(other.org.id)).subscriptions.length, 0);
  });
});

describe('limits and usage', () => {
  test('before billing an organization has no plan: nothing is limited except the placeholders', async () => {
    const { scoped } = await fx.org();
    const summary = await scoped.billing.summary({ now: NOW });
    assert.equal(summary.limits.projects, null);
    assert.equal(summary.limits.prompts, null);
    assert.equal(summary.limits.drafts, 4);
    assert.equal(summary.limits.runs_now, 4);
    assert.equal((await scoped.billing.canAdd('projects')).allowed, true);
    assert.equal(await scoped.billing.promptRoom(1n), null);
  });

  test('on Starter, one project fits and the second does not; archiving makes room', async () => {
    const { org, scoped } = await fx.org();
    await fx.setOrg(org.id, { plan_code: 'starter', billing_status: 'trialing' });
    assert.equal((await scoped.billing.canAdd('projects')).allowed, true);
    const project = await fx.project(org.id);
    const full = await scoped.billing.canAdd('projects');
    assert.deepEqual([full.allowed, full.used, full.limit], [false, 1, 1]);
    await fx.setProject(project.id, { status: 'archived' });
    assert.equal((await scoped.billing.canAdd('projects')).allowed, true, 'archiving makes room');
  });

  test('questions are counted across projects: one project can only use what the others leave', async () => {
    const { org, scoped } = await fx.org();
    await fx.setOrg(org.id, { plan_code: 'growth', billing_status: 'active' }); // 150 questions
    const a = await fx.project(org.id);
    const b = await fx.project(org.id);
    for (let i = 0; i < 3; i += 1) {
      await scoped.prompts.add(
        a.id,
        {
          text: `Question number ${i} for project A ${Date.now()}`,
          intent: 'discovery',
          priority: 2,
          country: 'US',
          language: 'en',
        },
        { actorUserId: null },
      );
    }
    assert.equal(await scoped.billing.promptRoom(a.id), 150);
    assert.equal(await scoped.billing.promptRoom(b.id), 147);
    assert.equal((await scoped.billing.usage({ now: NOW })).prompts, 3);
  });

  test('a seat counts members and pending invitations', async () => {
    const { org, scoped } = await fx.org();
    await fx.setOrg(org.id, { plan_code: 'starter' });
    assert.equal((await scoped.billing.usage({ now: NOW })).seats, 1);
  });

  test('a grant lifts the draft allowance, and a metered add-on lets drafting go past it', async () => {
    const { org, scoped } = await fx.org();
    await fx.setOrg(org.id, { plan_code: 'starter', billing_status: 'active' });
    assert.equal(await scoped.billing.limitFor('drafts'), 4);
    await fx.grant(org.id, { meter: 'drafts', amount: 2, source: 'staff_grant' });
    assert.equal(await scoped.billing.limitFor('drafts'), 6);
    assert.equal(await scoped.billing.hasMeteredDrafts(), false);
    await fx.grant(org.id, { meter: 'drafts', amount: 0, source: 'addon', itemId: 'si_metered' });
    assert.equal(await scoped.billing.hasMeteredDrafts(), true);
    assert.equal(
      await scoped.billing.limitFor('drafts'),
      6,
      'the metered add-on adds no fixed amount',
    );
  });

  test('only the first Stripe customer sticks', async () => {
    const { scoped } = await fx.org();
    assert.equal(await scoped.billing.attachCustomer('cus_first'), 'cus_first');
    assert.equal(await scoped.billing.attachCustomer('cus_second'), 'cus_first');
  });

  test('a plan feature is allowed with no plan yet, and needs the switch once there is one', async () => {
    const { org, scoped } = await fx.org();
    assert.equal(await scoped.billing.featureAllowed('client_seats'), true);
    await fx.setOrg(org.id, { plan_code: 'starter' });
    assert.equal(await scoped.billing.featureAllowed('client_seats'), false);
    await fx.setOrg(org.id, { plan_code: 'agency' });
    assert.equal(await scoped.billing.featureAllowed('client_seats'), true);
  });
});

describe('the scheduler and plans', () => {
  test('with billing enforced, an organization that may not collect is left out of the week’s runs', async () => {
    const paid = await fx.org();
    const lapsed = await fx.org();
    const none = await fx.org();
    const slotHour = 77;
    for (const o of [paid, lapsed, none]) {
      const p = await fx.project(o.org.id, 'Scheduled', { status: 'active', slotHour });
      assert.ok(p);
    }
    await fx.setOrg(paid.org.id, { plan_code: 'starter', billing_status: 'active' });
    await fx.setOrg(lapsed.org.id, { plan_code: 'starter', billing_status: 'past_due' });

    const ids = async (opts) =>
      (await db.system.scheduling.dueProjects({ hour: slotHour, now: NOW, ...opts })).map(
        (r) => r.orgId,
      );
    const unenforced = await ids({});
    for (const o of [paid, lapsed, none])
      assert.ok(unenforced.includes(o.org.id), 'without enforcement everyone runs');

    const enforced = await ids({ enforced: true });
    assert.ok(enforced.includes(paid.org.id));
    assert.ok(!enforced.includes(lapsed.org.id), 'past due with no grace date: paused');
    assert.ok(!enforced.includes(none.org.id), 'no subscription: nothing is tracked');
  });
});

describe('cancelled accounts', () => {
  test('closing waits for the end of the window, happens once, and archives the projects', async () => {
    const { org } = await fx.org();
    await fx.project(org.id, 'Soon gone', { status: 'active' });
    const sub = stripeSub(org, { fields: { status: 'canceled', trial_end: null } });
    await apply(sub, { now: NOW });
    assert.ok(!(await billing.retention.due({ now: NOW })).includes(org.id), 'not yet');

    const later = addDays(NOW, 91);
    assert.ok((await billing.retention.due({ now: later })).includes(org.id));
    assert.equal(await billing.retention.close(org.id, { now: later }), true);
    assert.equal(
      await billing.retention.close(org.id, { now: later }),
      false,
      'closing twice changes nothing',
    );
    const { org: row } = await fx.billingRows(org.id);
    assert.ok(row.deleted_at);
    assert.equal(row.purge_after.toISOString(), addDays(later, 30).toISOString());
    assert.ok(!(await billing.retention.due({ now: later })).includes(org.id));
  });

  test('only a cancelled organization can be closed', async () => {
    const { org } = await fx.org();
    await fx.setOrg(org.id, { billing_status: 'active', retain_until: addDays(NOW, -1) });
    assert.equal(await billing.retention.close(org.id, { now: NOW }), false);
  });

  test('the warning list names owners of accounts closing within two weeks', async () => {
    const { org, owner } = await fx.org();
    await fx.setOrg(org.id, { billing_status: 'canceled', retain_until: addDays(NOW, 10) });
    const found = (await billing.retention.warnable({ now: NOW })).find((w) => w.orgId === org.id);
    assert.ok(found);
    assert.deepEqual(
      found.owners.map((o) => o.id),
      [owner.id],
    );
    await fx.setOrg(org.id, { retain_until: addDays(NOW, 40) });
    assert.ok(!(await billing.retention.warnable({ now: NOW })).some((w) => w.orgId === org.id));
  });
});

describe('trials and usage meters', () => {
  test('a trial ending within four days is listed with its owner and plan', async () => {
    const { org, owner } = await fx.org();
    const sub = stripeSub(org, { fields: { trial_end: sec('2026-10-07T00:00:00Z') } });
    await apply(sub);
    const found = (await billing.trials.ending({ now: NOW })).find((t) => t.orgId === org.id);
    assert.equal(found.planName, 'Starter');
    assert.equal(found.priceText, '$79');
    assert.deepEqual(
      found.owners.map((o) => o.id),
      [owner.id],
    );
    assert.ok(
      !(await billing.trials.ending({ now: addDays(NOW, -10) })).some((t) => t.orgId === org.id),
    );
  });

  test('drafts past the allowance are reported once, whole drafts only', async () => {
    const { org, scoped } = await fx.org();
    await fx.setOrg(org.id, {
      plan_code: 'starter',
      billing_status: 'active',
      stripe_customer_id: `cus_meter${Date.now()}`,
    });
    await fx.grant(org.id, { meter: 'drafts', amount: 0, source: 'addon', itemId: 'si_m' });
    assert.deepEqual(
      (await billing.meters.draftsToReport({ now: new Date() })).filter((r) => r.orgId === org.id),
      [],
    );

    // Use 6.5 drafts of a 4-draft allowance: 2 whole drafts over (the half waits).
    const period = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await fx.setQuota(org.id, period, 'drafts', 6.5);
    const pending = (await billing.meters.draftsToReport({ now: new Date() })).find(
      (r) => r.orgId === org.id,
    );
    assert.equal(pending.units, 2);

    await billing.meters.markDraftsReported({ orgId: org.id, period, units: 2 });
    assert.equal(
      (await billing.meters.draftsToReport({ now: new Date() })).filter((r) => r.orgId === org.id)
        .length,
      0,
    );
    await fx.setQuota(org.id, period, 'drafts', 7.5);
    const next = (await billing.meters.draftsToReport({ now: new Date() })).find(
      (r) => r.orgId === org.id,
    );
    assert.equal(next.units, 1);
    assert.ok(scoped);
  });
});
