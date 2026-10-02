import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ulid } from '../lib/ulid.js';
import {
  fnv1a,
  HOURS_PER_WEEK,
  hourOfWeek,
  isoWeekKey,
  slotHourOf,
  slotsToCheck,
  startOfHour,
} from './slots.js';

const at = (iso) => new Date(iso);

describe('weekly slot of a project', () => {
  test('is always 0-167 and the same every time for the same project', () => {
    const id = '01JABCDEFGHJKMNPQRSTVWXYZ0';
    assert.equal(slotHourOf(id), slotHourOf(id));
    for (let i = 0; i < 1000; i += 1) {
      const slot = slotHourOf(ulid());
      assert.ok(Number.isInteger(slot) && slot >= 0 && slot < HOURS_PER_WEEK);
    }
  });

  test('is pinned: changing the hash would silently move every project to a new hour', () => {
    assert.equal(slotHourOf('01JABCDEFGHJKMNPQRSTVWXYZ0'), 106);
    assert.equal(slotHourOf('01JZZZZZZZZZZZZZZZZZZZZZZZ'), 122);
  });

  test('the hash is FNV-1a: it reproduces the published test vectors', () => {
    assert.equal(fnv1a(''), 0x811c9dc5);
    assert.equal(fnv1a('a'), 0xe40c292c);
    assert.equal(fnv1a('foobar'), 0xbf9cf968);
  });

  test('spreads projects over the week instead of piling them on a few hours', () => {
    const counts = new Array(HOURS_PER_WEEK).fill(0);
    for (let i = 0; i < 16_800; i += 1) counts[slotHourOf(ulid())] += 1;
    // 100 per hour on average. A fair hash stays well inside 50-170; a bad one has empty and crowded hours.
    assert.ok(Math.min(...counts) > 50, `quietest hour has ${Math.min(...counts)}`);
    assert.ok(Math.max(...counts) < 170, `busiest hour has ${Math.max(...counts)}`);
  });
});

describe('hour of the week', () => {
  test('Monday 00:00 UTC is hour 0 and Sunday 23:00 is hour 167', () => {
    assert.equal(hourOfWeek(at('2026-10-05T00:00:00Z')), 0);
    assert.equal(hourOfWeek(at('2026-10-05T00:59:59Z')), 0);
    assert.equal(hourOfWeek(at('2026-10-05T01:00:00Z')), 1);
    assert.equal(hourOfWeek(at('2026-10-04T23:00:00Z')), 167);
    assert.equal(hourOfWeek(at('2026-10-02T13:24:00Z')), 4 * 24 + 13); // a Friday
  });
});

describe('ISO week key', () => {
  test('ordinary dates', () => {
    assert.equal(isoWeekKey(at('2026-10-02T12:00:00Z')), '2026-W40');
    assert.equal(isoWeekKey(at('2026-10-04T23:59:59Z')), '2026-W40'); // Sunday
    assert.equal(isoWeekKey(at('2026-10-05T00:00:00Z')), '2026-W41'); // Monday
  });

  test('year boundaries follow the Thursday rule', () => {
    assert.equal(isoWeekKey(at('2026-01-01T00:00:00Z')), '2026-W01');
    assert.equal(isoWeekKey(at('2025-12-29T00:00:00Z')), '2026-W01'); // belongs to next year's week 1
    assert.equal(isoWeekKey(at('2027-01-01T00:00:00Z')), '2026-W53'); // belongs to last year's week 53
    assert.equal(isoWeekKey(at('2020-12-31T00:00:00Z')), '2020-W53');
    assert.equal(isoWeekKey(at('2024-12-30T00:00:00Z')), '2025-W01');
  });
});

describe('slots to check on a scheduler tick', () => {
  test('the current hour plus the previous three, oldest first', () => {
    const slots = slotsToCheck(at('2026-10-02T13:24:00Z'));
    assert.deepEqual(
      slots.map((s) => s.hour),
      [4 * 24 + 10, 4 * 24 + 11, 4 * 24 + 12, 4 * 24 + 13],
    );
    assert.equal(slots.at(-1).at.toISOString(), '2026-10-02T13:00:00.000Z');
  });

  test('across Monday midnight each hour carries its own week', () => {
    const slots = slotsToCheck(at('2026-10-05T01:30:00Z'));
    assert.deepEqual(
      slots.map((s) => [s.hour, s.weekKey]),
      [
        [166, '2026-W40'],
        [167, '2026-W40'],
        [0, '2026-W41'],
        [1, '2026-W41'],
      ],
    );
  });

  test('startOfHour', () => {
    assert.equal(
      startOfHour(at('2026-10-02T13:59:59.999Z')).toISOString(),
      '2026-10-02T13:00:00.000Z',
    );
  });
});
