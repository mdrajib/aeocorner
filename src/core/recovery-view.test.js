import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { caseView, listView } from './recovery-view.js';

const kase = (extra = {}) => ({
  id: 1n,
  publicId: '01M45CMXHX3F13F4NCZ88RP8EB',
  metric: 'mention_rate',
  engineCode: null,
  status: 'diagnosing',
  baseline: { start: '2026-07-08', end: '2026-08-04', n: 280, k: 168 },
  decline: { start: '2026-08-05', end: '2026-09-01', n: 280, k: 100 },
  recent: { n: 140, k: 28 },
  onsetDate: '2026-08-20',
  openedAt: new Date('2026-09-01T10:00:00Z'),
  closedAt: null,
  closeDetails: null,
  recheck: null,
  diagnosis: null,
  repairs: [],
  ...extra,
});

describe('the recovery case page', () => {
  it('says it is looking before there is a diagnosis', () => {
    const view = caseView({ kase: kase(), events: [], progress: { repairs: [], repaired: false } });
    assert.equal(view.diagnosis.state, 'waiting');
    assert.equal(view.proof, null);
    assert.equal(view.open, true);
    assert.deepEqual(
      view.movement.map((m) => [m.label, m.rate, m.answers]),
      [
        ['Before', '60%', 280],
        ['The fall', '36%', 280],
        ['Now (last 14 days)', '20%', 140],
      ],
    );
  });

  it('shows "can’t tell" as a result with its reason, never as a cause', () => {
    const view = caseView({
      kase: kase({ diagnosis: { outcome: 'cant_tell', causes: [], reason: 'Nothing lines up.' } }),
      events: [],
      progress: { repairs: [], repaired: false },
    });
    assert.equal(view.diagnosis.state, 'cant_tell');
    assert.equal(view.diagnosis.causes, undefined);
    assert.match(view.diagnosis.text, /can’t tell/);
  });

  it('a fix we could not look at is "Couldn’t check", never gone', () => {
    const view = caseView({
      kase: kase({
        recheck: {
          scanId: null,
          scanStatus: 'failed',
          fixes: [
            { recommendationId: '5', live: 'unknown' },
            { recommendationId: '6', live: 'gone' },
          ],
        },
      }),
      events: [],
      fixTitles: { 5: 'Fix five' },
    });
    assert.equal(view.recheck.scanned, false);
    assert.deepEqual(
      view.recheck.fixes.map((f) => [f.title, f.label, f.tone]),
      [
        ['Fix five', 'Couldn’t check', 'unknown'],
        ['An earlier fix', 'No longer on your site', 'warning'],
      ],
    );
  });

  it('only a closed recovery gets the proof card, and "recovered by itself" says so', () => {
    const closed = (status) =>
      caseView({
        kase: kase({
          status,
          closedAt: new Date('2026-09-30T00:00:00Z'),
          closeDetails: { n: 140, k: 84 },
        }),
        events: [],
      });
    assert.equal(closed('recovered').proof.title, 'Recovered');
    assert.equal(closed('closed_noise').proof.title, 'Recovered by itself');
    assert.equal(closed('closed_unknown').proof, null);
    assert.match(closed('recovered').sentence, /is 60% over the last 14 days/);
  });

  it('a window with no readable answer is "Couldn’t check", not 0%', () => {
    const view = caseView({ kase: kase({ recent: { n: 0, k: 0 } }), events: [] });
    assert.equal(view.movement[2].rate, '—');
    assert.equal(view.movement[2].state, 'unknown');
  });

  it('words each timeline entry in plain language', () => {
    const at = new Date('2026-09-02T00:00:00Z');
    const view = caseView({
      kase: kase(),
      events: [
        { kind: 'opened', at, details: { recent: { n: 140, k: 28 } } },
        {
          kind: 'rechecked',
          at,
          details: {
            scanId: '9',
            fixes: [{ live: 'present' }, { live: 'gone' }, { live: 'unknown' }],
          },
        },
        { kind: 'diagnosed', at, details: { outcome: 'cant_tell' } },
      ],
    });
    assert.match(view.timeline[0].text, /20% of 140 answers/);
    assert.match(view.timeline[1].text, /1 still in place, 1 gone, 1 we couldn’t check/);
    assert.equal(view.timeline[2].title, 'We can’t tell what caused it yet');
  });
});

describe('the recovery list', () => {
  it('splits open from closed and says where the cause stands', () => {
    const view = listView({
      cases: [
        kase(),
        kase({
          publicId: 'B',
          status: 'recovered',
          closedAt: new Date('2026-09-20T00:00:00Z'),
          diagnosis: { outcome: 'named', causes: [{ code: 'competitor_gain' }] },
        }),
      ],
    });
    assert.equal(view.open.length, 1);
    assert.equal(view.closed.length, 1);
    assert.equal(view.open[0].cause, 'Looking now');
    assert.equal(view.closed[0].cause, 'A competitor gained ground');
  });
});
