import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { alertSubject, claimKey, selectAlerts } from './alerts.js';
import { buildDigest } from './digest.js';
import { headline } from './dashboard.js';
import { detectChanges } from './trends.js';

const BRAND = '1';
const RIVAL = '2';
const AS_OF = '2026-10-26';
const engineNames = { chatgpt: 'ChatGPT' };
const entityNames = { [RIVAL]: 'Rival Dental' };

/** Four weekly runs before and four after, the way trends.test.js builds them. */
const day = (metricDate, engineCode, { n, bk, rk = 0 }) =>
  [
    [BRAND, bk],
    [RIVAL, rk],
  ].map(([entityId, k]) => ({
    metricDate,
    engineCode,
    entityId,
    cellsTotal: 5,
    cellsPartial: 0,
    nAnswers: n,
    kMentioned: k,
    kRecommended: 0,
    kCited: 0,
    rankSum: 0,
    rankN: 0,
    sentimentSum: 0,
    sentimentN: 0,
    citationsTotal: 0,
    citationsEntity: 0,
    visWeightedSum: null,
    visWeightTotal: null,
  }));
const weeks = (before, after, engine = 'chatgpt') => [
  ...['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].flatMap((d) =>
    day(d, engine, before),
  ),
  ...['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].flatMap((d) => day(d, engine, after)),
];

/** Turn what `detectChanges` found into stored-event rows, as `change_events` would hold them. */
const stored = (found) =>
  found.map((e, i) => ({
    id: BigInt(i + 1),
    kind: e.kind,
    engine_code: e.engineCode,
    entity_id: BigInt(e.entityId),
    value_before: e.valueBefore,
    value_after: e.valueAfter,
    delta_pp: e.deltaPp,
    direction: e.direction,
    n_before: e.nBefore,
    k_before: e.kBefore,
    n_after: e.nAfter,
    k_after: e.kAfter,
    after_start: e.after[0],
    after_end: e.after[1],
    is_significant: true,
  }));

describe('a fixture week: no drop, no alert; a real drop, an alert', () => {
  test('a steady week raises nothing', () => {
    const rows = weeks({ n: 30, bk: 12 }, { n: 30, bk: 12 });
    const events = stored(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }));
    assert.equal(events.length, 0);
    assert.deepEqual(selectAlerts({ events, engineNames, entityNames }), {
      items: [],
      eventIds: [],
      caseIds: [],
    });
  });

  test('a real fall in how often the brand is named raises one alert, with the numbers behind it', () => {
    const rows = weeks({ n: 30, bk: 18 }, { n: 30, bk: 6 });
    const events = stored(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }));
    const { items, eventIds } = selectAlerts({ events, engineNames, entityNames });
    const drop = items.find((i) => i.kind === 'drop');
    assert.ok(drop, 'an alert was raised');
    assert.equal(
      items.filter((i) => i.measure === 'How often AI answers name you').length,
      1,
      'one alert per measure',
    );
    assert.match(drop.title, /fell \d+ points/);
    assert.match(drop.text, /72 of 120|24 of 120/);
    assert.match(drop.text, /significance test/);
    assert.match(drop.text, /fall shows on ChatGPT/);
    assert.ok(
      eventIds.length >= 2,
      'the all-engines and the per-engine events are both marked alerted',
    );
  });

  test('a rise is not alerted: the digest celebrates it', () => {
    const rows = weeks({ n: 30, bk: 6 }, { n: 30, bk: 18 });
    const events = stored(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }));
    assert.ok(events.length > 0);
    assert.deepEqual(
      selectAlerts({ events: events.filter((e) => e.kind !== 'competitor_surge'), engineNames })
        .items,
      [],
    );
  });

  test('a significantly rising competitor is a warning that names it', () => {
    const rows = weeks({ n: 30, bk: 12, rk: 6 }, { n: 30, bk: 12, rk: 20 });
    const events = stored(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }));
    const { items } = selectAlerts({ events, engineNames, entityNames });
    const surge = items.find((i) => i.kind === 'surge');
    assert.ok(surge);
    assert.equal(surge.tone, 'warning');
    assert.match(surge.title, /Rival Dental/);
    assert.equal(
      items.filter((i) => i.kind === 'surge').length,
      1,
      'one alert per competitor, not per engine',
    );
  });

  test('an event that did not pass the test is never alerted, whatever its direction', () => {
    const rows = weeks({ n: 30, bk: 18 }, { n: 30, bk: 6 });
    const events = stored(detectChanges({ rows, brandId: BRAND, asOf: AS_OF })).map((e) => ({
      ...e,
      is_significant: false,
    }));
    assert.deepEqual(selectAlerts({ events }).items, []);
  });
});

describe('negative claims', () => {
  const claim = {
    attribute: 'pricing',
    value: 'Charges hidden fees on every crown',
    count: 3,
    engineCodes: ['chatgpt'],
  };

  test('say what the AI said, in its words, and that we have not checked it', () => {
    const { items } = selectAlerts({ claims: [claim], engineNames });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'claim');
    assert.match(items[0].title, /negative about your pricing/);
    assert.match(
      items[0].text,
      /“Charges hidden fees on every crown” appeared in 3 answers on ChatGPT/,
    );
    assert.match(items[0].text, /not checked whether it is true/);
  });

  test('the same claim has the same key, however it is spaced or cased; another claim does not', () => {
    assert.equal(
      claimKey(claim),
      claimKey({ ...claim, value: '  charges HIDDEN fees on every crown ', count: 9 }),
    );
    assert.notEqual(claimKey(claim), claimKey({ ...claim, value: 'Slow to answer the phone' }));
    assert.notEqual(claimKey(claim), claimKey({ ...claim, attribute: 'service' }));
  });

  test('a very long claim is cut, and an empty one is skipped', () => {
    const long = selectAlerts({ claims: [{ ...claim, value: 'x'.repeat(2000) }] }).items[0];
    assert.ok(long.text.length < 500);
    assert.deepEqual(selectAlerts({ claims: [{ ...claim, value: '   ' }] }).items, []);
  });
});

describe('how many alerts, and the subject', () => {
  test('never more than five in one email', () => {
    const claims = Array.from({ length: 9 }, (_, i) => ({
      attribute: 'a',
      value: `claim ${i}`,
      count: 1,
      engineCodes: [],
    }));
    assert.equal(selectAlerts({ claims }).items.length, 5);
  });

  test('one alert is its own title; several are counted', () => {
    assert.equal(alertSubject([{ title: 'It fell' }], 'Acme'), 'It fell: Acme');
    assert.equal(alertSubject([{}, {}, {}], 'Acme'), '3 things changed for Acme');
  });
});

describe('the weekly digest', () => {
  const project = { name: 'Acme Dental', domain: 'acme.example' };
  const tilesFor = (before, after) => {
    const rows = weeks(before, after);
    return headline({ rows, brandId: BRAND, asOf: AS_OF });
  };

  test('a steady week says so, and shows the figures without colour', () => {
    const { tiles, hasData } = tilesFor({ n: 30, bk: 12 }, { n: 30, bk: 12 });
    const d = buildDigest({
      project,
      tiles,
      hasData,
      now: new Date('2026-10-27T00:00:00Z'),
      lastFinishedAt: '2026-10-26T00:00:00Z',
    });
    assert.equal(d.hasNews, false);
    assert.match(d.headline, /steady week/);
    assert.equal(d.figures[0].display, '40%');
    assert.ok(d.figures.every((f) => f.tone === 'neutral'));
    assert.match(d.subject, /weekly AI visibility update/);
  });

  test('a real drop is the headline, in danger colour, and leads the subject', () => {
    const { tiles, hasData } = tilesFor({ n: 30, bk: 18 }, { n: 30, bk: 6 });
    const events = stored(
      detectChanges({
        rows: weeks({ n: 30, bk: 18 }, { n: 30, bk: 6 }),
        brandId: BRAND,
        asOf: AS_OF,
      }),
    );
    const d = buildDigest({
      project,
      tiles,
      hasData,
      events,
      engineNames,
      now: new Date('2026-10-27T00:00:00Z'),
      lastFinishedAt: '2026-10-26T00:00:00Z',
    });
    assert.equal(d.hasNews, true);
    assert.match(d.headline, /dropped/);
    assert.equal(d.figures[0].tone, 'danger');
    assert.match(d.changes[0].title, /fell/);
    assert.match(d.subject, /^Acme Dental: .*fell/);
    assert.ok(
      d.changes.every((c) => !/ChatGPT/.test(c.title)),
      'only the all-engines events appear, not one line per engine',
    );
  });

  test('a week with no readable answers says so and never shows a figure as zero', () => {
    const d = buildDigest({
      project,
      tiles: {},
      hasData: false,
      now: new Date('2026-10-27T00:00:00Z'),
    });
    assert.match(d.headline, /could not read any answers/);
    assert.deepEqual(d.figures, []);
  });

  test('a figure that could not be read is “Couldn’t check”, not 0', () => {
    const { tiles } = tilesFor({ n: 30, bk: 12 }, { n: 30, bk: 12 });
    const d = buildDigest({
      project,
      hasData: true,
      tiles: { ...tiles, mentionRate: { state: 'unknown' } },
      now: new Date('2026-10-27T00:00:00Z'),
    });
    assert.equal(d.figures[0].display, '—');
    assert.match(d.figures[0].note, /Couldn’t check/);
  });

  test('old numbers carry a notice, and the best three actions and any proof are included', () => {
    const { tiles, hasData } = tilesFor({ n: 30, bk: 12 }, { n: 30, bk: 12 });
    const d = buildDigest({
      project,
      tiles,
      hasData,
      actions: [{ title: 'A' }, { title: 'B', why: 'because' }, { title: 'C' }, { title: 'D' }],
      wins: [{ sentence: 'Since you published X, mentions rose.' }],
      lastFinishedAt: '2026-09-01T00:00:00Z',
      now: new Date('2026-10-27T00:00:00Z'),
    });
    assert.equal(d.notices.length, 1);
    assert.match(d.notices[0].title, /days old/);
    assert.deepEqual(
      d.actions.map((a) => a.title),
      ['A', 'B', 'C'],
    );
    assert.equal(d.hasNews, true);
    assert.match(d.headline, /Good news/);
  });
});

describe('a decline that has lasted (Milestone 14)', () => {
  const kase = {
    id: 7n,
    metric: 'mention_rate',
    engineCode: null,
    baseline: { n: 280, k: 168 },
    decline: { n: 280, k: 100 },
    recent: { n: 140, k: 28 },
  };

  test('is its own alert, told by the case, and stands in for the plain drop alert about the same measure', () => {
    const rows = weeks({ n: 30, bk: 18 }, { n: 30, bk: 6 });
    const events = stored(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }));
    const { items, eventIds, caseIds } = selectAlerts({
      events,
      engineNames,
      entityNames,
      cases: [kase],
    });
    assert.deepEqual(caseIds, [7n]);
    assert.equal(items[0].kind, 'recovery');
    assert.equal(items[0].key, 'recovery.7');
    assert.match(items[0].text, /stayed down for more than two weeks/);
    assert.equal(
      items.filter((i) => i.kind === 'drop' && i.measure === 'How often AI answers name you')
        .length,
      0,
    );
    assert.ok(eventIds.length >= 2, 'the drop events are still marked told');
  });

  test('a drop in another measure is still told on its own', () => {
    const rows = weeks({ n: 30, bk: 18 }, { n: 30, bk: 6 });
    const events = stored(detectChanges({ rows, brandId: BRAND, asOf: AS_OF }));
    const { items } = selectAlerts({
      events,
      engineNames,
      entityNames,
      cases: [{ ...kase, metric: 'citation_share' }],
    });
    assert.ok(items.some((i) => i.kind === 'drop'));
    assert.ok(items.some((i) => i.kind === 'recovery'));
  });
});

describe('the digest and recovery cases (Milestone 14)', () => {
  const project = { name: 'Acme Dental', domain: 'acme.example' };
  const { tiles, hasData } = headline({
    rows: weeks({ n: 30, bk: 12 }, { n: 30, bk: 12 }),
    brandId: BRAND,
    asOf: AS_OF,
  });
  const base = {
    project,
    tiles,
    hasData,
    now: new Date('2026-10-27T00:00:00Z'),
    lastFinishedAt: '2026-10-26T00:00:00Z',
  };
  const open = { metric: 'mention_rate', engineCode: null, status: 'repairing', closedAt: null };

  test('an open case is told in every digest until it ends', () => {
    const d = buildDigest({ ...base, cases: [open] });
    assert.ok(
      d.notices.some((n) => /being looked at/.test(n.title) && /name you less often/.test(n.text)),
    );
  });

  test('a recovery is told in the week it happens, and a stale one is not', () => {
    const recent = { ...open, status: 'recovered', closedAt: new Date('2026-10-24T00:00:00Z') };
    const old = { ...open, status: 'recovered', closedAt: new Date('2026-09-01T00:00:00Z') };
    assert.ok(
      buildDigest({ ...base, cases: [recent] }).notices.some((n) => /has recovered/.test(n.title)),
    );
    assert.equal(buildDigest({ ...base, cases: [old] }).notices.length, 0);
    assert.equal(
      buildDigest({
        ...base,
        cases: [{ ...open, status: 'closed_unknown', closedAt: new Date('2026-10-24T00:00:00Z') }],
      }).notices.length,
      0,
    );
  });
});
