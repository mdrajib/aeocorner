import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as autopilot from './autopilot.js';
import {
  AUTOPILOT,
  basisOf,
  parseSettings,
  pathOf,
  planTick,
  rejectionAdjustedConfidence,
  withdrawalReason,
} from './autopilot.js';

const NOW = new Date('2026-10-07T09:00:00Z');
const WEEK = '2026-W41';
const on = {
  enabled: true,
  allowAutoFix: true,
  allowContent: true,
  weeklyDrafts: 2,
  pausedAt: null,
};

let n = 0;
const rec = (over = {}) => {
  n += 1;
  return {
    id: String(100 + n),
    ruleCode: 'readiness.C1',
    stableKey: `readiness.c1:${n}`,
    fixPath: 'auto_fix',
    ice: 50,
    status: 'open',
    signalClearedAt: null,
    affectedUrls: [],
    evidence: {},
    ...over,
  };
};
const draftRec = (over = {}) =>
  rec({ ruleCode: 'visibility.lost_prompt', fixPath: 'content', ...over });

const base = (over = {}) => ({
  settings: on,
  planAllows: true,
  flagOn: true,
  spendPaused: false,
  pluginReady: true,
  recommendations: [],
  items: [],
  weekKey: WEEK,
  now: NOW,
  draftsLeft: 10,
  ...over,
});

describe('what Autopilot may do', () => {
  test('the module can prepare and decide what to prepare; it has no way to approve, apply or publish', () => {
    const names = Object.keys(autopilot);
    assert.deepEqual(
      names.filter((k) => /approve|apply|publish|write|send/i.test(k)),
      [],
    );
    assert.deepEqual(Object.keys(autopilot.PREPARES).sort(), ['auto_fix', 'content']);
  });

  test('a fix the plugin writes is auto_fix, a content fix is content, guidance is nothing', () => {
    assert.equal(pathOf(rec()), 'auto_fix');
    assert.equal(pathOf(draftRec()), 'content');
    assert.equal(pathOf(rec({ ruleCode: 'readiness.B1', fixPath: 'guidance' })), null);
    // A4 is "auto_fix" on the rule table but the plugin cannot write a sitemap: not offered.
    assert.equal(pathOf(rec({ ruleCode: 'readiness.A4', fixPath: 'auto_fix' })), null);
  });
});

describe('planTick: when nothing is prepared', () => {
  const some = [rec(), draftRec()];
  for (const [name, over, why] of [
    ['the staff switch is off', { flagOn: false }, 'switched_off'],
    ['the plan has no Autopilot', { planAllows: false }, 'plan'],
    ['the project has it off', { settings: { ...on, enabled: false } }, 'off'],
    ['the project is paused', { settings: { ...on, pausedAt: NOW } }, 'paused'],
    ['the spend cap paused collection', { spendPaused: true }, 'spend_paused'],
  ]) {
    test(name, () => {
      const out = planTick(base({ recommendations: some, ...over }));
      assert.equal(out.skipped, why);
      assert.deepEqual(out.picks, []);
    });
  }

  test('with nothing that has a path, it says so', () => {
    const out = planTick(
      base({ recommendations: [rec({ ruleCode: 'readiness.B1', fixPath: 'guidance' })] }),
    );
    assert.equal(out.skipped, 'nothing');
  });

  test('a fix needs the plugin; a draft does not', () => {
    const out = planTick(base({ recommendations: [rec(), draftRec()], pluginReady: false }));
    assert.deepEqual(
      out.picks.map((p) => p.kind),
      ['content'],
    );
  });

  test('a kind the owner switched off is never prepared', () => {
    const out = planTick(
      base({
        recommendations: [rec(), draftRec()],
        settings: { ...on, allowContent: false },
      }),
    );
    assert.deepEqual(
      out.picks.map((p) => p.kind),
      ['auto_fix'],
    );
  });
});

describe('planTick: what it picks', () => {
  test('the best first by ICE, ties by ID; only open recommendations whose problem still shows', () => {
    const a = rec({ ice: 10 });
    const b = rec({ ice: 90 });
    const c = rec({ ice: 90 });
    const started = rec({ status: 'in_progress', ice: 99 });
    const cleared = rec({ ice: 99, signalClearedAt: NOW });
    const out = planTick(base({ recommendations: [a, started, cleared, c, b] }));
    assert.deepEqual(
      out.picks.map((p) => p.rec.id),
      [b.id, c.id, a.id],
    );
  });

  test('the same state prepares the same items, whatever order the rows arrive in', () => {
    const rows = [rec({ ice: 5 }), draftRec({ ice: 70 }), rec({ ice: 70 }), draftRec({ ice: 8 })];
    const forward = planTick(base({ recommendations: rows }));
    const backward = planTick(base({ recommendations: [...rows].reverse() }));
    assert.deepEqual(
      forward.picks.map((p) => [p.rec.id, p.kind, p.basis]),
      backward.picks.map((p) => [p.rec.id, p.kind, p.basis]),
    );
  });

  test('a second tick for the same state prepares nothing more', () => {
    const rows = [rec(), rec(), draftRec()];
    const first = planTick(base({ recommendations: rows }));
    assert.equal(first.picks.length, 3);
    const items = first.picks.map((p) => ({
      recommendationId: p.rec.id,
      basisHash: p.basis,
      kind: p.kind,
      status: 'ready',
      weekKey: WEEK,
      createdAt: NOW,
    }));
    const second = planTick(base({ recommendations: rows, items }));
    assert.deepEqual(second.picks, []);
  });

  test('a rejected item is not prepared again on the same evidence, but is on new evidence', () => {
    const r = rec({ affectedUrls: ['https://x.test/a'] });
    const rejected = {
      recommendationId: r.id,
      basisHash: basisOf(r),
      kind: 'auto_fix',
      status: 'rejected',
      weekKey: '2026-W40',
      createdAt: new Date('2026-09-30T09:00:00Z'),
    };
    assert.deepEqual(planTick(base({ recommendations: [r], items: [rejected] })).picks, []);
    const changed = { ...r, affectedUrls: ['https://x.test/a', 'https://x.test/b'] };
    assert.equal(planTick(base({ recommendations: [changed], items: [rejected] })).picks.length, 1);
  });

  test('the basis ignores the order of the pages and the volatile numbers in the evidence', () => {
    const a = rec({ affectedUrls: ['b', 'a'], evidence: { pages: 3 } });
    const b = { ...a, affectedUrls: ['a', 'b'], evidence: { pages: 9 } };
    assert.equal(basisOf(a), basisOf(b));
  });
});

describe('planTick: the limits', () => {
  const many = (kind, count) =>
    Array.from({ length: count }, (_, i) =>
      kind === 'fix' ? rec({ ice: 100 - i }) : draftRec({ ice: 100 - i }),
    );

  test('at most three fixes in a week', () => {
    const out = planTick(base({ recommendations: many('fix', 8) }));
    assert.equal(out.picks.length, AUTOPILOT.maxFixesPerWeek);
  });

  test('drafts follow the weekly budget the owner set', () => {
    const out = planTick(base({ recommendations: many('draft', 8) }));
    assert.equal(out.picks.length, 2);
    const none = planTick(
      base({ recommendations: many('draft', 8), settings: { ...on, weeklyDrafts: 0 } }),
    );
    assert.equal(none.skipped, 'nothing');
  });

  test('drafts already started this week, whatever became of them, count against the budget', () => {
    const items = [
      {
        recommendationId: '1',
        basisHash: 'a',
        kind: 'content',
        status: 'rejected',
        weekKey: WEEK,
        createdAt: new Date('2026-10-06T09:00:00Z'),
      },
    ];
    const out = planTick(base({ recommendations: many('draft', 8), items }));
    assert.equal(out.picks.length, 1);
  });

  test('never more than what is left of the month’s draft allowance', () => {
    const out = planTick(base({ recommendations: many('draft', 8), draftsLeft: 1 }));
    assert.equal(out.picks.length, 1);
    const empty = planTick(base({ recommendations: many('draft', 8), draftsLeft: 0 }));
    assert.equal(empty.skipped, 'nothing');
    const unlimited = planTick(base({ recommendations: many('draft', 8), draftsLeft: null }));
    assert.equal(unlimited.picks.length, 2);
  });

  test('a full inbox prepares nothing, a busy day prepares no more', () => {
    const waiting = Array.from({ length: AUTOPILOT.maxReady }, (_, i) => ({
      recommendationId: `w${i}`,
      basisHash: `h${i}`,
      kind: 'content',
      status: 'ready',
      weekKey: '2026-W38',
      createdAt: new Date('2026-09-20T09:00:00Z'),
    }));
    assert.equal(
      planTick(base({ recommendations: [rec()], items: waiting })).skipped,
      'inbox_full',
    );
    const today = Array.from({ length: AUTOPILOT.maxPerDay }, (_, i) => ({
      recommendationId: `t${i}`,
      basisHash: `h${i}`,
      kind: 'auto_fix',
      status: 'approved',
      weekKey: '2026-W39',
      createdAt: NOW,
    }));
    assert.equal(planTick(base({ recommendations: [rec()], items: today })).skipped, 'limit_today');
  });
});

describe('withdrawalReason', () => {
  const r = rec();
  const item = { basisHash: basisOf(r), createdAt: NOW };
  test('stands while the recommendation is open and unchanged', () => {
    assert.equal(withdrawalReason(item, r, { now: NOW }), null);
    assert.equal(withdrawalReason(item, { ...r, status: 'in_progress' }, { now: NOW }), null);
  });
  test('is withdrawn when it was dismissed, done another way, cleared, changed or left too long', () => {
    for (const status of ['dismissed', 'done', 'measuring', 'proven_win']) {
      assert.match(withdrawalReason(item, { ...r, status }, { now: NOW }), /\S/);
    }
    assert.match(
      withdrawalReason(item, { ...r, signalClearedAt: NOW }, { now: NOW }),
      /no longer showing/,
    );
    assert.match(
      withdrawalReason(item, { ...r, affectedUrls: ['x'] }, { now: NOW }),
      /evidence changed/,
    );
    assert.match(withdrawalReason(item, null, { now: NOW }), /gone/);
    const later = new Date(NOW.getTime() + 29 * 86_400_000);
    assert.match(withdrawalReason(item, r, { now: later }), /four weeks/);
  });
});

describe('rejectionAdjustedConfidence', () => {
  test('changes nothing without a rejection', () => {
    assert.equal(rejectionAdjustedConfidence(0.5, {}), 0.5);
    assert.equal(rejectionAdjustedConfidence(0.5, { accepted: 9 }), 0.5);
  });
  test('falls with rejections, slowly, and never below half of itself', () => {
    const one = rejectionAdjustedConfidence(0.6, { rejected: 1 });
    const five = rejectionAdjustedConfidence(0.6, { rejected: 5 });
    const many = rejectionAdjustedConfidence(0.6, { rejected: 1000 });
    assert.ok(one < 0.6 && one > 0.55);
    assert.ok(five < one);
    assert.ok(many >= 0.3 && many < 0.31);
  });
  test('approvals soften it', () => {
    assert.ok(
      rejectionAdjustedConfidence(0.6, { rejected: 3, accepted: 10 }) >
        rejectionAdjustedConfidence(0.6, { rejected: 3, accepted: 0 }),
    );
  });
  test('refuses a confidence outside 0 to 1', () => {
    assert.throws(() => rejectionAdjustedConfidence(2, { rejected: 1 }), RangeError);
  });
});

describe('parseSettings', () => {
  test('reads a form and defaults the budget', () => {
    const out = parseSettings({ enabled: 'on', allowAutoFix: 'on' });
    assert.deepEqual(out, {
      ok: true,
      value: { enabled: true, allowAutoFix: true, allowContent: false, weeklyDrafts: 2 },
    });
  });
  test('refuses a budget that is not a whole number from 0 to 10 instead of clipping it', () => {
    for (const bad of ['-1', '11', '2.5', 'many']) {
      const out = parseSettings({ weeklyDrafts: bad });
      assert.equal(out.ok, false);
      assert.match(out.errors.weeklyDrafts, /0 to 10/);
    }
    assert.equal(parseSettings({ weeklyDrafts: '0' }).value.weeklyDrafts, 0);
  });
});
