import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GRACE_DAYS,
  accessFor,
  addDays,
  checkLimit,
  featureOn,
  grantIsActive,
  limitsFor,
} from './entitlements.js';

const NOW = new Date('2026-10-04T12:00:00Z');
const starter = {
  code: 'starter',
  max_projects: 1,
  max_prompts: 50,
  max_seats: null,
  drafts_per_month: '4.0',
  runs_now_per_month: null,
  features: { csv_export: false, alerts: false },
};

describe('limitsFor', () => {
  test('a plan number is the limit; NULL stays "not enforced", never zero', () => {
    const limits = limitsFor(starter, [], NOW);
    assert.equal(limits.projects, 1);
    assert.equal(limits.prompts, 50);
    assert.equal(limits.drafts, 4);
    assert.equal(limits.seats, null);
    assert.equal(limits.runs_now, null);
  });

  test('active grants add to a limit; ended and future ones do not', () => {
    const grants = [
      { meter: 'prompts', amount: 25, starts_at: addDays(NOW, -1), ends_at: null },
      { meter: 'prompts', amount: 100, starts_at: addDays(NOW, -10), ends_at: addDays(NOW, -1) },
      { meter: 'prompts', amount: 1000, starts_at: addDays(NOW, 1), ends_at: null },
      { meter: 'projects', amount: 2, starts_at: addDays(NOW, -1), ends_at: addDays(NOW, 5) },
    ];
    const limits = limitsFor(starter, grants, NOW);
    assert.equal(limits.prompts, 75);
    assert.equal(limits.projects, 3);
  });

  test('a grant cannot turn an unenforced meter into an enforced one', () => {
    const limits = limitsFor(
      starter,
      [{ meter: 'seats', amount: 5, starts_at: NOW, ends_at: null }],
      NOW,
    );
    assert.equal(limits.seats, null);
  });

  test('no plan at all uses the fallback, else nothing is enforced', () => {
    assert.equal(limitsFor(null, [], NOW).projects, null);
    assert.equal(limitsFor(null, [], NOW, { projects: 2 }).projects, 2);
  });

  test('grantIsActive is half-open: it ends exactly at ends_at', () => {
    assert.equal(grantIsActive({ starts_at: NOW, ends_at: NOW }, NOW), false);
    assert.equal(grantIsActive({ starts_at: NOW, ends_at: addDays(NOW, 1) }, NOW), true);
  });
});

describe('checkLimit', () => {
  test('blocks over quota and allows in quota', () => {
    assert.equal(checkLimit({ limit: 50, used: 49 }).allowed, true);
    assert.equal(checkLimit({ limit: 50, used: 50 }).allowed, false);
    assert.equal(checkLimit({ limit: 50, used: 45, want: 6 }).allowed, false);
    assert.equal(checkLimit({ limit: 50, used: 45, want: 5 }).allowed, true);
    assert.deepEqual(checkLimit({ limit: 50, used: 38 }), {
      allowed: true,
      used: 38,
      limit: 50,
      left: 12,
    });
  });

  test('half a draft counts: a refresh is 0.5', () => {
    assert.equal(checkLimit({ limit: 4, used: 3.5, want: 0.5 }).allowed, true);
    assert.equal(checkLimit({ limit: 4, used: 3.5, want: 1 }).allowed, false);
  });

  test('a limit that is not set allows anything', () => {
    assert.deepEqual(checkLimit({ limit: null, used: 9999 }), {
      allowed: true,
      used: 9999,
      limit: null,
      left: null,
    });
  });

  test('over the limit (a downgrade) has nothing left, not a negative number', () => {
    assert.equal(checkLimit({ limit: 10, used: 14 }).left, 0);
  });
});

describe('accessFor', () => {
  const at = (extra) => accessFor({ now: NOW, ...extra });

  test('without enforcement (no Stripe keys) everything is allowed', () => {
    assert.equal(at({ enforced: false, billingStatus: 'none' }).level, 'full');
    assert.equal(at({ enforced: false, billingStatus: 'canceled' }).collect, true);
  });

  test('trial and active collect', () => {
    for (const billingStatus of ['trialing', 'active']) {
      const a = at({ billingStatus });
      assert.equal(a.level, 'full');
      assert.equal(a.collect, true);
    }
  });

  test('no subscription: set up is allowed, collecting is not', () => {
    const a = at({ billingStatus: 'none' });
    assert.equal(a.level, 'setup');
    assert.equal(a.collect, false);
    assert.equal(a.edit, true);
  });

  test('a failed payment keeps collecting through the grace period, then pauses', () => {
    const inside = at({ billingStatus: 'past_due', graceUntil: addDays(NOW, 1) });
    assert.equal(inside.level, 'grace');
    assert.equal(inside.collect, true);
    const after = at({ billingStatus: 'past_due', graceUntil: addDays(NOW, -1) });
    assert.equal(after.level, 'paused');
    assert.equal(after.collect, false);
    assert.equal(after.edit, true, 'the data is kept and the customer can still work in it');
    assert.equal(at({ billingStatus: 'past_due' }).level, 'paused', 'no grace date: no grace');
  });

  test('cancelled: read-only inside the retention window, ended after it', () => {
    assert.equal(
      at({ billingStatus: 'canceled', retainUntil: addDays(NOW, 30) }).level,
      'readonly',
    );
    assert.equal(at({ billingStatus: 'canceled', retainUntil: addDays(NOW, 30) }).edit, false);
    assert.equal(at({ billingStatus: 'canceled', retainUntil: addDays(NOW, -1) }).level, 'ended');
    assert.equal(at({ billingStatus: 'canceled' }).level, 'ended');
  });

  test('the grace period is seven days', () => {
    assert.equal(GRACE_DAYS, 7);
  });
});

describe('featureOn', () => {
  test('reads the plan switch; an unknown feature or no plan is off', () => {
    assert.equal(featureOn({ features: { alerts: true } }, 'alerts'), true);
    assert.equal(featureOn(starter, 'alerts'), false);
    assert.equal(featureOn(starter, 'nope'), false);
    assert.equal(featureOn(null, 'alerts'), false);
  });
});
