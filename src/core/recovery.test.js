import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  alertItem,
  canMoveCase,
  declineOf,
  decideClose,
  diagnose,
  estimateOnset,
  findLastingDeclines,
  findUnsupportedCauses,
  foldOwnCitations,
  inCooldown,
  judgeDecline,
  openKey,
  outcomeSentence,
  recentWindow,
  regressedChecks,
  repairsFor,
  selectDeclines,
  seoSafe,
} from './recovery.js';

const ASOF = '2026-09-30';
const BRAND = '1';
const RIVAL = '2';
const DAY = 86_400_000;
const day = (offset) =>
  new Date(Date.parse(`${ASOF}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);

/** Rows for one entity on one engine: `from`/`to` are offsets in days from ASOF, `rate` of `n` answers a day. */
function fill(
  rows,
  { from, to, engine = 'chatgpt', entity = BRAND, rate, n = 10, partial = 0, extra = {} },
) {
  for (let d = from; d <= to; d += 1) {
    rows.push({
      metricDate: day(d),
      engineCode: engine,
      entityId: entity,
      cellsPartial: partial,
      nAnswers: n,
      kMentioned: Math.round(rate * n),
      citationsTotal: 0,
      citationsEntity: 0,
      aioQueries: 0,
      aioTriggered: 0,
      ...extra,
    });
  }
  return rows;
}

/** A brand that was at `before`, fell to `fell` from offset -20 on, and is `recent` over the last 14 days. */
function falling({ before = 0.6, fell = 0.3, recent = 0.3, engines = ['chatgpt'] } = {}) {
  const rows = [];
  for (const engine of engines) {
    fill(rows, { from: -55, to: -28, engine, rate: before });
    fill(rows, {
      from: -27,
      to: -14,
      engine,
      rate: fell === recent ? fell : before - (before - fell) / 2,
    });
    fill(rows, { from: -13, to: 0, engine, rate: recent });
  }
  return rows;
}

describe('judgeDecline: is a decline lasting? (task 14.02)', () => {
  const judge = (rows, extra = {}) =>
    judgeDecline({ rows, brandId: BRAND, asOf: ASOF, metric: 'mention_rate', ...extra });

  it('calls a fall that stays down lasting', () => {
    const verdict = judge(falling());
    assert.equal(verdict.verdict, 'lasting');
    assert.equal(verdict.baseline.n, 280);
    assert.ok(verdict.deltaPp < 0 && verdict.p < 0.05);
  });

  it('says nothing is wrong for a flat, noisy series', () => {
    const rows = [];
    fill(rows, { from: -55, to: -28, rate: 0.6 });
    fill(rows, { from: -27, to: 0, rate: 0.5 });
    // A ten-point dip over 280 answers a side is significant; a two-point one is not.
    const flat = [];
    fill(flat, { from: -55, to: -28, rate: 0.6 });
    fill(flat, { from: -27, to: 0, rate: 0.59 });
    assert.equal(judge(flat).verdict, 'none');
  });

  it('does not open a case for a one-run dip that has come back', () => {
    const rows = [];
    fill(rows, { from: -55, to: -28, rate: 0.6 });
    fill(rows, { from: -27, to: -14, rate: 0.2 });
    fill(rows, { from: -13, to: 0, rate: 0.6 });
    const verdict = judge(rows);
    assert.equal(verdict.verdict, 'noise');
  });

  it('waits when the latest days have too few answers to say whether it lasts', () => {
    const rows = [];
    fill(rows, { from: -55, to: -28, rate: 0.6 });
    fill(rows, { from: -27, to: -14, rate: 0.2 });
    fill(rows, { from: -13, to: 0, rate: 0.2, n: 0 });
    assert.equal(judge(rows).verdict, 'pending');
  });

  it('is "not enough data", never "no decline", with fewer than 20 answers in a window', () => {
    const rows = [];
    fill(rows, { from: -55, to: -28, rate: 0.6, n: 0 });
    fill(rows, { from: -27, to: 0, rate: 0.2 });
    assert.equal(judge(rows).verdict, 'not_enough_data');
  });

  it('leaves a day an engine did not finish out of both windows: an outage is not the customer’s decline', () => {
    const rows = [];
    fill(rows, { from: -55, to: -28, rate: 0.6 });
    // The recent weeks were half collected: low numbers, but flagged partial.
    fill(rows, { from: -27, to: -14, rate: 0.6 });
    fill(rows, { from: -13, to: 0, rate: 0.1, partial: 1 });
    const verdict = judge(rows);
    assert.equal(verdict.verdict, 'none');
    assert.equal(verdict.recent.n, 0);
  });

  it('a rise or a smaller-than-five-point fall never opens anything', () => {
    const up = [];
    fill(up, { from: -55, to: -28, rate: 0.3 });
    fill(up, { from: -27, to: 0, rate: 0.6 });
    assert.equal(judge(up).verdict, 'none');
  });

  it('finds the decline per engine and across them, broadest first', () => {
    const rows = [
      ...falling({ engines: ['chatgpt'] }),
      ...fill([], { from: -55, to: 0, engine: 'gemini', rate: 0.5 }),
    ];
    const found = findLastingDeclines({ rows, brandId: BRAND, asOf: ASOF });
    const keys = found.map((d) => openKey(d.metric, d.engineCode));
    assert.ok(keys.includes('mention_rate:chatgpt'));
    assert.ok(!keys.includes('mention_rate:gemini'));
    assert.equal(openKey('mention_rate', null), 'mention_rate:all');
  });

  it('puts the latest 14 days in a window ending on the day', () => {
    assert.deepEqual(recentWindow('2026-09-30'), ['2026-09-17', '2026-09-30']);
  });
});

describe('estimateOnset', () => {
  it('names the first week that was already well below the earlier range', () => {
    const rows = [];
    fill(rows, { from: -55, to: -28, rate: 0.6 });
    fill(rows, { from: -27, to: -15, rate: 0.6 });
    fill(rows, { from: -14, to: 0, rate: 0.2 });
    const decline = judgeDecline({ rows, brandId: BRAND, asOf: ASOF, metric: 'mention_rate' });
    const onset = estimateOnset({ rows, brandId: BRAND, decline });
    assert.ok(onset >= day(-20) && onset <= day(-12), onset);
  });
});

describe('diagnose (task 14.03)', () => {
  const decline = (rows, extra = {}) =>
    judgeDecline({ rows, brandId: BRAND, asOf: ASOF, metric: 'mention_rate', ...extra });
  const ctx = (rows, more = {}) => ({
    decline: decline(rows, more.scope ? { engineCode: more.scope } : {}),
    rows,
    brandId: BRAND,
    asOf: ASOF,
    ...more,
  });
  const scanOf = (checks, score) => ({ finishedAt: '2026-08-20T00:00:00Z', score, checks });

  it('says "can’t tell" when nothing lines up', () => {
    const d = diagnose(ctx(falling()));
    assert.equal(d.outcome, 'cant_tell');
    assert.deepEqual(d.causes, []);
    assert.deepEqual(findUnsupportedCauses(d), []);
  });

  it('names a site change only with a second fact behind it', () => {
    const change = {
      id: 7,
      kind: 'robots_txt',
      targetUrl: null,
      appliedAt: day(-22),
      rolledBack: false,
    };
    const lone = diagnose(ctx(falling(), { siteChanges: [change] }));
    assert.equal(lone.outcome, 'cant_tell');
    assert.deepEqual(lone.considered, ['site_change']);

    const scans = {
      before: scanOf([{ code: 'A1', status: 'pass' }], 90),
      latest: scanOf([{ code: 'A1', status: 'fail' }], 80),
    };
    const named = diagnose(ctx(falling(), { siteChanges: [change], scans }));
    assert.equal(named.outcome, 'named');
    const cause = named.causes.find((c) => c.code === 'site_change');
    assert.ok(cause);
    assert.equal(cause.facts.length, 2);
    assert.match(cause.facts[0].text, /robots\.txt lines/);
    assert.deepEqual(findUnsupportedCauses(named), []);
  });

  it('ignores a change that was taken back and one that came long before the fall', () => {
    const scans = {
      before: scanOf([{ code: 'A1', status: 'pass' }], 90),
      latest: scanOf([{ code: 'A1', status: 'fail' }], 80),
    };
    const changes = [
      { id: 1, kind: 'jsonld', appliedAt: day(-22), rolledBack: true },
      { id: 2, kind: 'jsonld', appliedAt: day(-90), rolledBack: false },
    ];
    const d = diagnose(ctx(falling(), { siteChanges: changes, scans }));
    assert.ok(!d.causes.some((c) => c.code === 'site_change'));
  });

  it('names a readiness regression from two facts and links the failing checks', () => {
    const scans = {
      before: scanOf(
        [
          { code: 'A1', status: 'pass' },
          { code: 'B1', status: 'pass' },
          { code: 'C1', status: 'error' },
        ],
        90,
      ),
      latest: scanOf(
        [
          { code: 'A1', status: 'fail' },
          { code: 'B1', status: 'pass' },
          { code: 'C1', status: 'fail' },
        ],
        70,
      ),
    };
    assert.deepEqual(
      regressedChecks(scans.before, scans.latest).map((c) => c.code),
      ['A1'],
    );
    const d = diagnose(ctx(falling(), { scans }));
    const cause = d.causes.find((c) => c.code === 'readiness_regression');
    assert.ok(cause && cause.facts.length >= 3);
    assert.equal(cause.band, 'strong');
    const repairs = repairsFor(d, { regressed: regressedChecks(scans.before, scans.latest) });
    assert.deepEqual(repairs[0].ruleCodes, ['readiness.A1']);
  });

  it('a check that errored on either side is never a regression', () => {
    const scans = {
      before: scanOf([{ code: 'A1', status: 'pass' }], 90),
      latest: scanOf([{ code: 'A1', status: 'error' }], null),
    };
    assert.deepEqual(regressedChecks(scans.before, scans.latest), []);
    assert.equal(diagnose(ctx(falling(), { scans })).outcome, 'cant_tell');
  });

  it('names an earlier fix that is gone, and never one we could not look at', () => {
    const fixes = [
      {
        recommendationId: 5,
        title: 'Add Organization schema',
        live: 'gone',
        verifiedBefore: true,
        doneAt: day(-40),
      },
    ];
    const d = diagnose(ctx(falling(), { earlierFixes: fixes }));
    const cause = d.causes.find((c) => c.code === 'earlier_fix_gone');
    assert.ok(cause);
    assert.equal(cause.facts.length, 3);
    assert.deepEqual(
      repairsFor(d)
        .filter((r) => r.kind === 'redo')
        .map((r) => r.recommendationId),
      ['5'],
    );
    const unknown = diagnose(
      ctx(falling(), { earlierFixes: fixes.map((f) => ({ ...f, live: 'unknown' })) }),
    );
    assert.equal(unknown.outcome, 'cant_tell');
  });

  it('does not name a cause when the facts against it match the facts for it', () => {
    const fixes = [
      { recommendationId: 5, title: 'A', live: 'gone', verifiedBefore: false, doneAt: day(-100) },
      { recommendationId: 6, title: 'B', live: 'present' },
      { recommendationId: 7, title: 'C', live: 'present' },
    ];
    const d = diagnose(ctx(falling(), { earlierFixes: fixes }));
    assert.ok(!d.causes.some((c) => c.code === 'earlier_fix_gone'));
  });

  it('names a competitor gain when a rival rose by about what the brand lost', () => {
    const rows = falling();
    fill(rows, { from: -55, to: -28, entity: RIVAL, rate: 0.2 });
    fill(rows, { from: -27, to: -14, entity: RIVAL, rate: 0.35 });
    fill(rows, { from: -13, to: 0, entity: RIVAL, rate: 0.5 });
    const d = diagnose(ctx(rows, { entityNames: { [RIVAL]: 'Rival Dental' } }));
    const cause = d.causes.find((c) => c.code === 'competitor_gain');
    assert.ok(cause);
    assert.match(cause.facts[0].text, /Rival Dental/);
    assert.deepEqual(findUnsupportedCauses(d), []);
  });

  it('names an engine-wide move: only this engine fell, and the competitors on it fell too', () => {
    const rows = [
      ...falling({ engines: ['chatgpt'] }),
      ...fill([], { from: -55, to: 0, engine: 'gemini', rate: 0.6 }),
    ];
    fill(rows, { from: -55, to: -28, engine: 'chatgpt', entity: RIVAL, rate: 0.5 });
    fill(rows, { from: -27, to: 0, engine: 'chatgpt', entity: RIVAL, rate: 0.2 });
    fill(rows, { from: -55, to: 0, engine: 'gemini', entity: RIVAL, rate: 0.5 });
    const d = diagnose(ctx(rows, { scope: 'chatgpt' }));
    const cause = d.causes.find((c) => c.code === 'engine_wide');
    assert.ok(cause, JSON.stringify(d));
    assert.equal(cause.facts.length, 2);
    assert.deepEqual(
      repairsFor(d).map((r) => r.kind),
      ['none'],
    );
  });

  it('names an engine that stopped showing an answer', () => {
    const rows = [];
    const aio = (queries, triggered) => ({ aioQueries: queries, aioTriggered: triggered });
    fill(rows, { from: -55, to: -28, engine: 'google_aio', rate: 0.6, extra: aio(10, 9) });
    fill(rows, { from: -27, to: -14, engine: 'google_aio', rate: 0.3, extra: aio(10, 3) });
    fill(rows, { from: -13, to: 0, engine: 'google_aio', rate: 0.3, extra: aio(10, 3) });
    const d = diagnose(ctx(rows, { scope: 'google_aio' }));
    const cause = d.causes.find((c) => c.code === 'engine_no_answer');
    assert.ok(cause, JSON.stringify(d.considered));
    assert.match(cause.facts[0].text, /Google AI Overviews showed an answer/);
  });

  it('names lost citations from the pages that stopped being cited', () => {
    const own = {
      before: {
        total: 12,
        pages: [
          { url: 'https://x.test/guide', count: 6 },
          { url: 'https://x.test/faq', count: 3 },
        ],
      },
      after: { total: 3, pages: [{ url: 'https://x.test/faq', count: 3 }] },
    };
    const d = diagnose(ctx(falling(), { ownCitations: own }));
    const cause = d.causes.find((c) => c.code === 'lost_citation');
    assert.ok(cause);
    assert.match(cause.facts.map((f) => f.text).join(' '), /x\.test\/guide/);
  });

  it('flags a made-up cause: the checker rejects fewer than two facts', () => {
    const bad = {
      outcome: 'named',
      causes: [
        {
          code: 'site_change',
          label: 'x',
          band: 'likely',
          facts: [{ id: 'a', text: 'b' }],
          against: [],
        },
      ],
    };
    assert.deepEqual(findUnsupportedCauses(bad), ['site_change has fewer than two facts']);
  });
});

describe('repairs and the SEO-safe rule (task 14.05)', () => {
  it('points a site change at its undo and never at a forbidden change', () => {
    const d = {
      outcome: 'named',
      causes: [
        {
          code: 'site_change',
          label: 'x',
          band: 'likely',
          facts: [
            { id: 'site_change.7', text: 't', data: { siteChangeId: '7' } },
            { id: 'site_change.regressed', text: 't' },
          ],
          against: [],
        },
      ],
    };
    const repairs = repairsFor(d);
    assert.deepEqual(
      repairs.map((r) => [r.kind, r.siteChangeId]),
      [['undo', '7']],
    );
    assert.ok(repairs.every(seoSafe));
    for (const forbidden of ['block_crawlers', 'remove_noindex_handling', 'change_canonical']) {
      assert.equal(seoSafe({ kind: 'rules', ruleCodes: [forbidden] }), false);
    }
    assert.equal(seoSafe({ kind: 'delete_site' }), false);
  });
});

describe('closing a case (task 14.06)', () => {
  const kase = {
    metric: 'mention_rate',
    engineCode: null,
    openedAt: new Date('2026-09-10T00:00:00Z'),
    baseline: { n: 280, k: 168 },
    decline: { n: 280, k: 100 },
  };
  const now = new Date('2026-09-30T12:00:00Z');
  const recentAt = (rate, n = 10) => {
    const rows = [];
    fill(rows, { from: -13, to: 0, rate, n });
    return rows;
  };

  it('is recovered when the latest 14 days are back and a repair was done', () => {
    const closed = decideClose({
      kase,
      rows: recentAt(0.6),
      brandId: BRAND,
      asOf: ASOF,
      repaired: true,
      now,
    });
    assert.equal(closed.status, 'recovered');
    assert.equal(closed.recent.n, 140);
  });

  it('is "recovered by itself" when nothing was done', () => {
    const closed = decideClose({
      kase,
      rows: recentAt(0.6),
      brandId: BRAND,
      asOf: ASOF,
      repaired: false,
      now,
    });
    assert.equal(closed.status, 'closed_noise');
  });

  it('stays open while the figure is still down', () => {
    assert.equal(
      decideClose({ kase, rows: recentAt(0.3), brandId: BRAND, asOf: ASOF, repaired: true, now })
        .status,
      null,
    );
  });

  it('a recent window with too few answers decides nothing', () => {
    assert.equal(
      decideClose({ kase, rows: recentAt(0.6, 0), brandId: BRAND, asOf: ASOF, repaired: true, now })
        .status,
      null,
    );
  });

  it('is not a recovery when the days were only half collected', () => {
    const rows = [];
    fill(rows, { from: -13, to: 0, rate: 0.9, partial: 1 });
    assert.equal(
      decideClose({ kase, rows, brandId: BRAND, asOf: ASOF, repaired: true, now }).status,
      null,
    );
  });

  it('closes as unknown after the set time still down', () => {
    const old = { ...kase, openedAt: new Date('2026-07-01T00:00:00Z') };
    assert.equal(
      decideClose({
        kase: old,
        rows: recentAt(0.3),
        brandId: BRAND,
        asOf: ASOF,
        repaired: false,
        now,
      }).status,
      'closed_unknown',
    );
  });

  it('only the system’s moves are in the table, and a closed case never reopens', () => {
    assert.equal(canMoveCase('diagnosing', 'repairing'), true);
    assert.equal(canMoveCase('repairing', 'recovered'), true);
    assert.equal(canMoveCase('recovered', 'diagnosing'), false);
    assert.equal(canMoveCase('closed_unknown', 'repairing'), false);
  });

  it('a decline that just ended a case is not opened again inside the cooldown', () => {
    assert.equal(inCooldown(new Date('2026-09-25T00:00:00Z'), now), true);
    assert.equal(inCooldown(new Date('2026-08-25T00:00:00Z'), now), false);
    assert.equal(inCooldown(null, now), false);
  });
});

describe('words', () => {
  const kase = {
    id: 3,
    metric: 'mention_rate',
    engineCode: 'chatgpt',
    baseline: { n: 280, k: 168 },
    decline: { n: 280, k: 100 },
    recent: { n: 140, k: 84 },
  };
  it('says what was measured, in counts of answers', () => {
    const text = outcomeSentence(kase);
    assert.match(
      text,
      /was 60% \(280 answers\), fell to 36% \(280 answers\) and is 60% over the last 14 days \(140 answers\)/,
    );
  });
  it('the alert item names the engine and is about this case only', () => {
    const item = alertItem({
      ...kase,
      baseline: kase.baseline,
      decline: kase.decline,
      recent: undefined,
    });
    assert.equal(item.key, 'recovery.3');
    assert.match(item.title, /on ChatGPT/);
    assert.equal(item.tone, 'danger');
  });
});

describe('which declines become cases', () => {
  const d = (metric, engineCode) => ({ metric, engineCode });
  it('folds a one-engine decline into the all-engines one, and share of voice into mention rate', () => {
    const found = [
      d('mention_rate', null),
      d('mention_rate', 'chatgpt'),
      d('share_of_voice', null),
      d('citation_share', 'gemini'),
    ];
    const keys = selectDeclines(found).map((x) => openKey(x.metric, x.engineCode));
    assert.deepEqual(keys, ['mention_rate:all', 'citation_share:gemini']);
  });
  it('knows about cases that are already open', () => {
    const found = [d('mention_rate', 'chatgpt'), d('share_of_voice', 'chatgpt')];
    assert.deepEqual(selectDeclines(found, ['mention_rate:all']), []);
    assert.deepEqual(
      selectDeclines(found, ['mention_rate:chatgpt']).map((x) => x.metric),
      ['mention_rate'],
    );
    assert.deepEqual(
      selectDeclines([d('share_of_voice', null)], []).map((x) => x.metric),
      ['share_of_voice'],
    );
  });
  it('turns a stored case back into the decline it was opened from', () => {
    const decline = declineOf({
      metric: 'mention_rate',
      engineCode: null,
      baseline: { start: '2026-07-08', end: '2026-08-04', n: 280, k: 168 },
      decline: { start: '2026-08-05', end: '2026-09-01', n: 280, k: 100 },
      recent: { n: 140, k: 40 },
      p: 0.001,
    });
    assert.equal(decline.deltaPp, -24.29);
    assert.deepEqual(decline.decline.window, ['2026-08-05', '2026-09-01']);
  });
  it('sums a page’s citations over engines', () => {
    const folded = foldOwnCitations({
      ownCitations: 9,
      pages: [
        { url: 'https://x.test/a', timesCited: 2 },
        { url: 'https://x.test/a', timesCited: 3 },
        { url: 'https://x.test/b', timesCited: 4 },
      ],
    });
    assert.deepEqual(folded, {
      total: 9,
      pages: [
        { url: 'https://x.test/a', count: 5 },
        { url: 'https://x.test/b', count: 4 },
      ],
    });
  });
});
