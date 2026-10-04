import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  KINDS,
  applyUnsubscribe,
  digestWeekKey,
  isDigestHour,
  localParts,
  prefAllows,
  readPrefs,
  readUnsubscribeToken,
  unsubscribeToken,
} from './notify.js';

const SECRET = 'test-secret-test-secret-test-secret-123';

describe('preferences', () => {
  test('a member who never chose has both on; junk is read as the defaults', () => {
    assert.deepEqual(readPrefs(null), { digest: true, alerts: true });
    assert.deepEqual(readPrefs('x'), { digest: true, alerts: true });
    assert.deepEqual(readPrefs({ digest: 'no', alerts: false }), { digest: true, alerts: false });
  });

  test('digests and alerts follow the person’s choice; account messages ignore it', () => {
    const off = { digest: false, alerts: false };
    assert.equal(prefAllows(off, 'digest'), false);
    assert.equal(prefAllows(off, 'alert'), false);
    assert.equal(prefAllows(off, 'trial-ending'), true);
    assert.equal(prefAllows(off, 'retention-warning'), true);
    assert.equal(prefAllows({}, 'digest'), true);
    assert.equal(prefAllows({}, 'nonsense'), false);
  });

  test('only digests and alerts are proactive', () => {
    assert.deepEqual(
      Object.entries(KINDS)
        .filter(([, v]) => v.category === 'proactive')
        .map(([k]) => k)
        .sort(),
      ['alert', 'digest'],
    );
  });
});

describe('when the digest goes out', () => {
  test('Monday 08:00 in the person’s own timezone, and only then', () => {
    const mondayUtc8 = new Date('2026-10-05T08:30:00Z'); // a Monday
    assert.equal(isDigestHour(mondayUtc8, 'UTC'), true);
    assert.equal(isDigestHour(mondayUtc8, 'America/New_York'), false); // 04:30 there
    assert.equal(isDigestHour(new Date('2026-10-05T12:00:00Z'), 'America/New_York'), true);
    assert.equal(isDigestHour(new Date('2026-10-04T08:00:00Z'), 'UTC'), false); // Sunday
    assert.equal(isDigestHour(new Date('2026-10-05T09:00:00Z'), 'UTC'), false);
  });

  test('a timezone we do not know is read as UTC rather than crashing', () => {
    assert.equal(isDigestHour(new Date('2026-10-05T08:00:00Z'), 'Mars/Olympus'), true);
    assert.equal(localParts(new Date('2026-10-05T08:00:00Z'), 'Mars/Olympus').date, '2026-10-05');
  });

  test('daylight saving does not move the local hour', () => {
    // 2026-11-02 is the Monday after US clocks go back: 08:00 is 13:00 UTC in New York.
    assert.equal(isDigestHour(new Date('2026-11-02T13:00:00Z'), 'America/New_York'), true);
    assert.equal(isDigestHour(new Date('2026-11-02T12:00:00Z'), 'America/New_York'), false);
  });

  test('the week key is the ISO week of the person’s own date', () => {
    assert.equal(digestWeekKey(new Date('2026-10-05T08:00:00Z'), 'UTC'), '2026-W41');
    assert.equal(digestWeekKey(new Date('2026-12-31T08:00:00Z'), 'UTC'), '2026-W53');
    assert.equal(digestWeekKey(new Date('2027-01-01T08:00:00Z'), 'UTC'), '2026-W53');
    // Sunday evening in New York is already Monday in UTC: the keys differ by a week.
    const instant = new Date('2026-10-05T01:00:00Z');
    assert.equal(digestWeekKey(instant, 'UTC'), '2026-W41');
    assert.equal(digestWeekKey(instant, 'America/New_York'), '2026-W40');
  });
});

describe('one-click unsubscribe', () => {
  test('a token we made reads back; anything else is refused', () => {
    const token = unsubscribeToken({ userId: '42', pref: 'digest' }, SECRET);
    assert.deepEqual(readUnsubscribeToken(token, SECRET), { userId: '42', pref: 'digest' });
    assert.equal(readUnsubscribeToken(token, 'another-secret-another-secret-12345'), null);
    assert.equal(readUnsubscribeToken(token.replace('42', '43'), SECRET), null);
    assert.equal(readUnsubscribeToken(token.replace('digest', 'all'), SECRET), null);
    assert.equal(readUnsubscribeToken(`${token}x`, SECRET), null);
    for (const junk of [
      undefined,
      '',
      'a.b.c',
      '1.digest.',
      `${'9'.repeat(300)}`,
      '0.digest.AAAA',
    ]) {
      assert.equal(readUnsubscribeToken(junk, SECRET), null);
    }
  });

  test('a token for an unknown preference cannot be made', () => {
    assert.throws(() => unsubscribeToken({ userId: '1', pref: 'everything' }, SECRET), TypeError);
  });

  test('unsubscribing switches off exactly what was asked, and again changes nothing', () => {
    assert.deepEqual(applyUnsubscribe(null, 'digest'), { digest: false, alerts: true });
    assert.deepEqual(applyUnsubscribe({ digest: true, alerts: true }, 'alerts'), {
      digest: true,
      alerts: false,
    });
    assert.deepEqual(applyUnsubscribe({}, 'all'), { digest: false, alerts: false });
    const once = applyUnsubscribe({}, 'digest');
    assert.deepEqual(applyUnsubscribe(once, 'digest'), once);
  });
});
