import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  diagnose,
  findUnsupportedCauses,
  judgeDecline,
  regressedChecks,
  repairsFor,
  seoSafe,
} from './recovery.js';

/**
 * The diagnosis eval (Milestone 14, task 14.09). Replayed declines whose cause is known: the engine must name it or say
 * "can't tell", and must never name a cause the evidence does not support. Free to run (no model is involved: the
 * diagnosis is code), so it runs with the unit tests.
 *
 * Two parts:
 *   1. a table of histories with one planted cause each, and histories with no cause at all;
 *   2. a randomised sweep (seeded, so a failure replays) that gives the engine random evidence and checks, for every cause
 *      it names, that the facts point at things that were really in the input.
 */

const ASOF = '2026-09-30';
const BRAND = '1';
const DAY = 86_400_000;
const day = (offset) =>
  new Date(Date.parse(`${ASOF}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);

function fill(rows, { from, to, engine = 'chatgpt', entity = BRAND, rate, n = 10, extra = {} }) {
  for (let d = from; d <= to; d += 1) {
    rows.push({
      metricDate: day(d),
      engineCode: engine,
      entityId: entity,
      cellsPartial: 0,
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

const fall = (extra = {}) => {
  const rows = [];
  fill(rows, { from: -55, to: -28, rate: 0.6, ...extra });
  fill(rows, { from: -27, to: -14, rate: 0.45, ...extra });
  fill(rows, { from: -13, to: 0, rate: 0.3, ...extra });
  return rows;
};

const scan = (checks, score, finishedAt = '2026-08-20T00:00:00Z') => ({
  finishedAt,
  score,
  checks,
});
const run = (rows, more = {}, scope = null) =>
  diagnose({
    decline: judgeDecline({
      rows,
      brandId: BRAND,
      asOf: ASOF,
      metric: 'mention_rate',
      engineCode: scope,
    }),
    rows,
    brandId: BRAND,
    asOf: ASOF,
    ...more,
  });

describe('recovery eval: known causes', () => {
  const planted = [
    {
      name: 'a robots.txt change followed by a lost crawler check',
      expect: 'site_change',
      build: () => ({
        rows: fall(),
        more: {
          siteChanges: [{ id: 9, kind: 'robots_txt', appliedAt: day(-24), rolledBack: false }],
          scans: {
            before: scan([{ code: 'A1', status: 'pass' }], 90),
            latest: scan([{ code: 'A1', status: 'fail' }], 82),
          },
        },
      }),
    },
    {
      name: 'a theme update that broke the home page’s schema',
      expect: 'readiness_regression',
      build: () => ({
        rows: fall(),
        more: {
          scans: {
            before: scan(
              [
                { code: 'C1', status: 'pass' },
                { code: 'B1', status: 'pass' },
              ],
              88,
            ),
            latest: scan(
              [
                { code: 'C1', status: 'fail' },
                { code: 'B1', status: 'fail' },
              ],
              70,
            ),
          },
        },
      }),
    },
    {
      name: 'a fix that fell off the site',
      expect: 'earlier_fix_gone',
      build: () => ({
        rows: fall(),
        more: {
          earlierFixes: [
            {
              recommendationId: 3,
              title: 'Add Organization schema',
              live: 'gone',
              verifiedBefore: true,
              doneAt: day(-50),
            },
          ],
        },
      }),
    },
    {
      name: 'a competitor that took the brand’s place',
      expect: 'competitor_gain',
      build: () => {
        const rows = fall();
        fill(rows, { from: -55, to: -28, entity: '2', rate: 0.2 });
        fill(rows, { from: -27, to: -14, entity: '2', rate: 0.4 });
        fill(rows, { from: -13, to: 0, entity: '2', rate: 0.55 });
        return { rows, more: { entityNames: { 2: 'Rival Dental' } } };
      },
    },
  ];

  for (const scenario of planted) {
    it(`names ${scenario.expect} for ${scenario.name}`, () => {
      const { rows, more } = scenario.build();
      const d = run(rows, more);
      assert.deepEqual(findUnsupportedCauses(d), []);
      assert.equal(d.outcome, 'named');
      assert.ok(
        d.causes.some((c) => c.code === scenario.expect),
        `named ${d.causes.map((c) => c.code)}`,
      );
    });
  }

  const unexplained = [
    { name: 'a fall with nothing recorded', build: () => ({ rows: fall(), more: {} }) },
    {
      name: 'a site change with a clean site check',
      build: () => ({
        rows: fall(),
        more: {
          siteChanges: [{ id: 1, kind: 'meta', appliedAt: day(-24), rolledBack: false }],
          scans: {
            before: scan([{ code: 'F3', status: 'pass' }], 90),
            latest: scan([{ code: 'F3', status: 'pass' }], 90),
          },
        },
      }),
    },
    {
      name: 'checks we could not run',
      build: () => ({
        rows: fall(),
        more: {
          scans: {
            before: scan([{ code: 'A1', status: 'pass' }], 90),
            latest: scan([{ code: 'A1', status: 'error' }], null),
          },
        },
      }),
    },
    {
      name: 'fixes we could not look at',
      build: () => ({
        rows: fall(),
        more: {
          earlierFixes: [
            {
              recommendationId: 3,
              title: 'x',
              live: 'unknown',
              verifiedBefore: true,
              doneAt: day(-50),
            },
          ],
        },
      }),
    },
  ];
  for (const scenario of unexplained) {
    it(`says "can’t tell" for ${scenario.name}`, () => {
      const { rows, more } = scenario.build();
      const d = run(rows, more);
      assert.equal(d.outcome, 'cant_tell');
      assert.deepEqual(d.causes, []);
    });
  }
});

/** A small seeded generator, so a failing case replays from its seed. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('recovery eval: random evidence never yields an unsupported cause', () => {
  const CODES = ['A1', 'A3', 'B1', 'C1', 'C2', 'D3', 'E1', 'F1', 'F3'];
  const STATUSES = ['pass', 'pass', 'fail', 'partial', 'error', 'not_applicable'];

  for (let seed = 1; seed <= 150; seed += 1) {
    it(`seed ${seed}`, () => {
      const rnd = prng(seed);
      const pick = (items) => items[Math.floor(rnd() * items.length)];
      const rows = fall();
      if (rnd() < 0.5) {
        fill(rows, { from: -55, to: -28, entity: '2', rate: rnd() * 0.5 });
        fill(rows, { from: -27, to: 0, entity: '2', rate: rnd() * 0.8 });
      }
      const checks = () => CODES.map((code) => ({ code, status: pick(STATUSES) }));
      const siteChanges = Array.from({ length: Math.floor(rnd() * 3) }, (_, i) => ({
        id: i + 1,
        kind: pick(['jsonld', 'meta', 'robots_txt']),
        appliedAt: day(-Math.floor(rnd() * 60)),
        rolledBack: rnd() < 0.3,
      }));
      const earlierFixes = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => ({
        recommendationId: 100 + i,
        title: `Fix ${i}`,
        live: pick(['present', 'gone', 'unknown']),
        verifiedBefore: rnd() < 0.5,
        doneAt: day(-Math.floor(rnd() * 90)),
      }));
      const scans =
        rnd() < 0.8
          ? {
              before: scan(checks(), Math.floor(rnd() * 100)),
              latest: scan(checks(), Math.floor(rnd() * 100)),
            }
          : null;
      const urls = ['https://x.test/a', 'https://x.test/b', 'https://x.test/c'];
      const ownCitations =
        rnd() < 0.5
          ? {
              before: {
                total: Math.floor(rnd() * 20),
                pages: urls
                  .filter(() => rnd() < 0.7)
                  .map((url) => ({ url, count: 1 + Math.floor(rnd() * 5) })),
              },
              after: {
                total: Math.floor(rnd() * 20),
                pages: urls
                  .filter(() => rnd() < 0.4)
                  .map((url) => ({ url, count: 1 + Math.floor(rnd() * 5) })),
              },
            }
          : null;

      const d = run(rows, { siteChanges, scans, earlierFixes, ownCitations });
      assert.deepEqual(findUnsupportedCauses(d), []);

      const regressed = regressedChecks(scans?.before, scans?.latest).map((c) => c.code);
      for (const cause of d.causes) {
        for (const f of cause.facts) {
          if (f.data?.siteChangeId)
            assert.ok(
              siteChanges.some((c) => String(c.id) === f.data.siteChangeId && !c.rolledBack),
            );
          if (f.data?.recommendationId) {
            assert.ok(
              earlierFixes.some(
                (x) => String(x.recommendationId) === f.data.recommendationId && x.live === 'gone',
              ),
            );
          }
          if (f.id === 'readiness.regressed')
            assert.ok(f.data.codes.every((c) => regressed.includes(c)));
          if (f.data?.urls)
            assert.ok(f.data.urls.every((u) => ownCitations.before.pages.some((p) => p.url === u)));
        }
        if (cause.code === 'earlier_fix_gone')
          assert.ok(earlierFixes.some((x) => x.live === 'gone'));
        if (cause.code === 'readiness_regression') assert.ok(regressed.length > 0);
        if (cause.code === 'lost_citation') assert.ok(ownCitations);
      }
      // Every repair it offers is a safe pointer.
      assert.ok(
        repairsFor(d, { regressed: regressedChecks(scans?.before, scans?.latest) }).every(seoSafe),
      );
    });
  }
});
