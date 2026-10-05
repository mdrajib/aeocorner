import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDigest } from './digest.js';
import { digestLine, lastTickText, listView, settingsView, standing } from './autopilot-view.js';

const settings = (over = {}) => ({
  enabled: true,
  allowAutoFix: true,
  allowContent: true,
  weeklyDrafts: 2,
  pausedAt: null,
  lastTickAt: null,
  lastTick: null,
  ...over,
});
const BASE = '/app/o/O/projects/P';

describe('standing', () => {
  test('says on, off, paused, not in the plan or switched off, in that order of precedence', () => {
    const on = { planAllows: true, flagOn: true };
    assert.equal(standing({ settings: settings(), ...on }).state, 'on');
    assert.equal(standing({ settings: settings({ enabled: false }), ...on }).state, 'off');
    assert.equal(standing({ settings: settings({ pausedAt: new Date() }), ...on }).state, 'paused');
    assert.equal(standing({ settings: settings(), planAllows: false, flagOn: true }).state, 'plan');
    assert.equal(
      standing({ settings: settings(), planAllows: true, flagOn: false }).state,
      'switched_off',
    );
  });
  test('"on" never promises a fix or a publish', () => {
    const { text } = standing({ settings: settings(), planAllows: true, flagOn: true });
    assert.doesNotMatch(text, /fixed|publish|automatically/i);
  });
});

describe('lastTickText', () => {
  test('says nothing before the first tick, what was prepared after one, and why nothing was after another', () => {
    assert.equal(lastTickText(settings()), null);
    const at = new Date('2026-10-06T09:00:00Z');
    assert.match(
      lastTickText(settings({ lastTickAt: at, lastTick: { prepared: 2 } })),
      /Oct 6, 2026: prepared 2 items for you/,
    );
    assert.match(
      lastTickText(settings({ lastTickAt: at, lastTick: { prepared: 1 } })),
      /prepared 1 item for you/,
    );
    assert.match(
      lastTickText(settings({ lastTickAt: at, lastTick: { prepared: 0, skipped: 'inbox_full' } })),
      /nothing prepared. The inbox is full/,
    );
    assert.match(
      lastTickText(
        settings({ lastTickAt: at, lastTick: { prepared: 0, skipped: 'spend_paused' } }),
      ),
      /daily spend cap/,
    );
  });
});

describe('listView', () => {
  const fix = {
    publicId: 'F'.repeat(26),
    recommendationId: 12n,
    kind: 'auto_fix',
    title: 'Add Organization schema to your home page',
    summary: 'The name “X”.',
    createdAt: new Date('2026-10-06T09:00:00Z'),
  };
  const page = {
    ...fix,
    publicId: 'G'.repeat(26),
    kind: 'content',
    recommendationId: 13n,
    contentItemId: 44n,
    title: 'A page',
  };

  test('a fix links to the screen that shows its exact code; a draft to the draft; neither has an approve link', () => {
    const content = new Map([['44', { publicId: 'C'.repeat(26), status: 'ready' }]]);
    const { ready } = listView({ ready: [fix, page], decided: [], content, projectBase: BASE });
    assert.equal(ready[0].reviewHref, `${BASE}/actions/12/autofix`);
    assert.equal(ready[1].reviewHref, `${BASE}/content/${'C'.repeat(26)}`);
    assert.ok(ready.every((r) => !/approve\b/.test(r.reviewHref)));
    assert.match(ready[0].reviewLabel, /Review the code and approve/);
  });

  test('a draft being written says where it stands and is waiting; a ready one is not', () => {
    const writing = new Map([['44', { publicId: 'C'.repeat(26), status: 'drafting' }]]);
    assert.equal(
      listView({ ready: [page], decided: [], content: writing, projectBase: BASE }).ready[0]
        .waiting,
      true,
    );
    assert.equal(
      listView({ ready: [page], decided: [], content: writing, projectBase: BASE }).ready[0]
        .progress.text,
      'Writing',
    );
    const done = new Map([['44', { publicId: 'C'.repeat(26), status: 'ready' }]]);
    assert.equal(
      listView({ ready: [page], decided: [], content: done, projectBase: BASE }).ready[0].waiting,
      false,
    );
  });

  test('a draft we cannot find says so instead of showing a blank', () => {
    const { ready } = listView({
      ready: [page],
      decided: [],
      content: new Map(),
      projectBase: BASE,
    });
    assert.equal(ready[0].progress.text, 'The draft could not be found.');
    assert.equal(ready[0].reviewHref, `${BASE}/actions/13`);
  });

  test('earlier items say how they ended and why', () => {
    const decided = [
      {
        ...fix,
        status: 'rejected',
        rejectReason: 'wrong_content',
        rejectNote: 'Wrong logo',
        decidedAt: new Date('2026-10-07T00:00:00Z'),
      },
      {
        ...fix,
        publicId: 'H'.repeat(26),
        status: 'withdrawn',
        withdrawnReason: 'You dismissed the recommendation.',
        decidedAt: null,
      },
      {
        ...fix,
        publicId: 'J'.repeat(26),
        status: 'approved',
        decidedAt: new Date('2026-10-08T00:00:00Z'),
      },
    ];
    const { earlier } = listView({ ready: [], decided, projectBase: BASE });
    assert.deepEqual(
      earlier.map((e) => e.statusLabel),
      ['Rejected', 'No longer needed', 'Approved'],
    );
    assert.equal(earlier[0].detail, 'What was prepared is wrong: Wrong logo');
    assert.equal(earlier[1].detail, 'You dismissed the recommendation.');
    assert.equal(earlier[2].detail, 'You approved it.');
    assert.doesNotMatch(JSON.stringify(earlier), /undefined|null/);
  });
});

describe('settingsView', () => {
  test('says the limits in plain numbers that follow the settings', () => {
    const v = settingsView(settings({ weeklyDrafts: 1 }));
    assert.ok(v.limits.some((l) => /At most 1 draft a week/.test(l)));
    assert.ok(v.limits.some((l) => /At most 3 fixes/.test(l)));
    assert.ok(v.limits.some((l) => /4 weeks/.test(l)));
    assert.equal(v.paused, false);
  });
});

describe('what the weekly email says', () => {
  test('a count and a link, and nothing at all when nothing is waiting', () => {
    assert.equal(digestLine(0, { projectBase: BASE }), null);
    assert.deepEqual(digestLine(1, { projectBase: BASE }), {
      text: '1 change is ready for your approval.',
      href: `${BASE}/autopilot`,
    });
    assert.match(digestLine(3, { projectBase: BASE }).text, /^3 changes are ready/);
  });

  test('the digest carries it as a notice, says nothing changes until a person approves, and has no approve link', () => {
    const base = { project: { name: 'X', domain: 'x.test' }, tiles: {}, hasData: false };
    const none = buildDigest({ ...base, autopilotReady: 0 });
    assert.ok(!none.notices.some((n) => /ready for your approval/.test(n.title)));
    const some = buildDigest({ ...base, autopilotReady: 2 });
    const notice = some.notices.find((n) => /ready for your approval/.test(n.title));
    assert.equal(notice.title, '2 changes are ready for your approval.');
    assert.match(notice.text, /Nothing changes on your site until you approve it/);
    assert.equal(some.autopilotReady, 2);
    assert.doesNotMatch(JSON.stringify(some), /approve\?|\/approve/);
  });
});
