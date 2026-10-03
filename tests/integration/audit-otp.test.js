import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { createOtpStore } from '../../src/lib/otp.js';
import { redisKeys } from '../../src/lib/redis.js';
import { connectTestRedis } from '../helpers/redis.js';

/**
 * The email-ownership code (Milestone 1, task 1.13), against a real Redis: the right code passes once; wrong,
 * expired, over-limit and replayed codes fail; and "send me another" gives a bot no extra guesses.
 */
const { redis, prefix, close } = connectTestRedis();
after(close);

let counter = 0;
const nextId = () => `audit${Date.now()}${(counter += 1)}`;
const store = (options = {}) =>
  createOtpStore(redis, { prefix, secret: 'test-secret-test-secret-test-secret', ...options });
const wrong = (code) => (code === '000000' ? '000001' : '000000');

describe('issuing and checking a code', () => {
  test('the right code passes, exactly once', async () => {
    const otp = store();
    const id = nextId();
    const { ok, code } = await otp.issue(id);
    assert.equal(ok, true);
    assert.match(code, /^\d{6}$/);
    assert.deepEqual(await otp.verify(id, code), { ok: true });
    assert.deepEqual(
      await otp.verify(id, code),
      { ok: false, reason: 'expired' },
      'a used code is dead',
    );
  });

  test('spaces typed around or inside the digits are forgiven', async () => {
    const otp = store();
    const id = nextId();
    const { code } = await otp.issue(id);
    assert.deepEqual(await otp.verify(id, ` ${code.slice(0, 3)} ${code.slice(3)} `), { ok: true });
  });

  test('codes are zero-padded, so 000042 is possible', async () => {
    const otp = store({ random: () => 42 });
    const id = nextId();
    const { code } = await otp.issue(id);
    assert.equal(code, '000042');
    assert.equal((await otp.verify(id, '000042')).ok, true);
  });

  test('one audit’s code does not open another audit', async () => {
    const codes = [111111, 222222];
    const otp = store({ random: () => codes.shift() });
    const [one, two] = [nextId(), nextId()];
    await otp.issue(one);
    await otp.issue(two);
    assert.equal((await otp.verify(two, '111111')).reason, 'wrong');
    assert.equal((await otp.verify(two, '222222')).ok, true);
    assert.equal((await otp.verify(one, '111111')).ok, true);
  });

  test('nothing stored is the code itself', async () => {
    const otp = store();
    const id = nextId();
    const { code } = await otp.issue(id);
    const stored = await redis.hgetall(redisKeys(prefix).otp(id));
    assert.ok(!JSON.stringify(stored).includes(code), 'only a keyed hash is in Redis');
    assert.equal(stored.a, '0');
  });
});

describe('wrong, malformed, expired and over-limit codes', () => {
  test('a wrong code is refused and counted; the right one still works afterwards', async () => {
    const otp = store();
    const id = nextId();
    const { code } = await otp.issue(id);
    assert.deepEqual(await otp.verify(id, wrong(code)), {
      ok: false,
      reason: 'wrong',
      attemptsLeft: 4,
    });
    assert.deepEqual(await otp.verify(id, code), { ok: true });
  });

  test('five wrong guesses kill the code, and then even the right one fails', async () => {
    const otp = store();
    const id = nextId();
    const { code } = await otp.issue(id);
    for (let left = 4; left >= 1; left -= 1) {
      assert.deepEqual(await otp.verify(id, wrong(code)), {
        ok: false,
        reason: 'wrong',
        attemptsLeft: left,
      });
    }
    assert.deepEqual(await otp.verify(id, wrong(code)), { ok: false, reason: 'locked' });
    assert.deepEqual(await otp.verify(id, code), { ok: false, reason: 'expired' });
  });

  test('guesses sent at the same moment cannot beat the limit', async () => {
    const otp = store();
    const id = nextId();
    const { code } = await otp.issue(id);
    // 30 simultaneous wrong guesses, then the right code.
    const guesses = await Promise.all(
      Array.from({ length: 30 }, () => otp.verify(id, wrong(code))),
    );
    assert.ok(
      guesses.filter((g) => g.reason === 'wrong').length <= 4,
      'at most four were counted as plain wrong',
    );
    assert.equal((await otp.verify(id, code)).ok, false, 'the code died under the barrage');
  });

  test('a right code sent twice at once passes only once', async () => {
    const otp = store();
    const id = nextId();
    const { code } = await otp.issue(id);
    const both = await Promise.all([otp.verify(id, code), otp.verify(id, code)]);
    assert.equal(both.filter((r) => r.ok).length, 1);
  });

  test('something that is not six digits is "malformed" and costs no attempt', async () => {
    const otp = store();
    const id = nextId();
    const { code } = await otp.issue(id);
    for (const typed of ['', '12345', '1234567', 'abcdef', '12 34', null, undefined, ['123456']]) {
      assert.deepEqual(
        await otp.verify(id, typed),
        { ok: false, reason: 'malformed' },
        String(typed),
      );
    }
    assert.equal(await redis.hget(redisKeys(prefix).otp(id), 'a'), '0');
    assert.equal((await otp.verify(id, code)).ok, true);
  });

  test('a code that expires, or was never made, is "expired"', async () => {
    const otp = store({ ttlSeconds: 1 });
    const id = nextId();
    const { code } = await otp.issue(id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(await otp.verify(id, code), { ok: false, reason: 'expired' });
    assert.deepEqual(await store().verify(nextId(), '123456'), { ok: false, reason: 'expired' });
  });
});

describe('asking for another code', () => {
  test('is refused during the cooldown, which gives a guesser no fresh attempts', async () => {
    const otp = store();
    const id = nextId();
    const first = await otp.issue(id);
    await otp.verify(id, wrong(first.code));
    const again = await otp.issue(id);
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'cooldown');
    assert.ok(again.retryAfterMs > 0 && again.retryAfterMs <= 60_000);
    assert.deepEqual(
      await otp.verify(id, first.code),
      { ok: true },
      'the first code is still the live one',
    );
  });

  test('after the cooldown a new code replaces the old one and the attempts start again', async () => {
    const otp = store({ cooldownSeconds: 1 });
    const id = nextId();
    const first = await otp.issue(id);
    await otp.verify(id, wrong(first.code));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = await otp.issue(id);
    assert.equal(second.ok, true);
    if (second.code !== first.code) {
      assert.equal((await otp.verify(id, first.code)).ok, false, 'the old code no longer works');
    }
    assert.equal((await otp.verify(id, second.code)).ok, true);
  });

  test('is limited to a few sends in a window, however long one waits between them', async () => {
    const otp = store({ cooldownSeconds: 0.05, maxSends: 3 });
    const id = nextId();
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await otp.issue(id)).ok, true);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const fourth = await otp.issue(id);
    assert.equal(fourth.ok, false);
    assert.equal(fourth.reason, 'limit');
    assert.ok(fourth.retryAfterMs > 0);
  });

  test('a locked-out audit cannot get its sends back by waiting for the code to expire', async () => {
    const otp = store({ cooldownSeconds: 0.05, maxSends: 2, ttlSeconds: 1 });
    const id = nextId();
    await otp.issue(id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await otp.issue(id);
    await new Promise((resolve) => setTimeout(resolve, 1200)); // both codes are long gone
    assert.equal((await otp.issue(id)).reason, 'limit');
  });
});
