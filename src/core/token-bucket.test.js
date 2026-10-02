import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { takeTokens } from './token-bucket.js';

const CONFIG = { capacity: 10, refillPerSec: 5 };

/** A small deterministic random generator, so "random" load is the same every run. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('token bucket', () => {
  test('a new bucket starts full: a burst of 100 gets exactly `capacity`', () => {
    let state = null;
    let allowed = 0;
    for (let i = 0; i < 100; i += 1) {
      const r = takeTokens(state, 0, CONFIG);
      state = r.state;
      if (r.allowed) allowed += 1;
    }
    assert.equal(allowed, 10);
  });

  test('a denied call says how long to wait, and waiting exactly that long is enough', () => {
    let state = null;
    for (let i = 0; i < 10; i += 1) state = takeTokens(state, 0, CONFIG).state;
    const denied = takeTokens(state, 0, CONFIG);
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterMs, 200); // 1 token at 5 per second

    const retry = takeTokens(denied.state, denied.retryAfterMs, CONFIG);
    assert.equal(retry.allowed, true);
    assert.equal(takeTokens(retry.state, denied.retryAfterMs, CONFIG).allowed, false);
  });

  test('a denied call takes nothing', () => {
    let state = null;
    for (let i = 0; i < 10; i += 1) state = takeTokens(state, 0, CONFIG).state;
    const before = state.tokens;
    const denied = takeTokens(state, 0, CONFIG, 3);
    assert.equal(denied.allowed, false);
    assert.equal(denied.state.tokens, before);
  });

  test('an idle hour does not bank more than `capacity`', () => {
    let state = takeTokens(null, 0, CONFIG).state;
    state = takeTokens(state, 3_600_000, CONFIG, 10).state;
    assert.equal(state.tokens, 0, 'ten tokens were available, not 18,000');
  });

  test('a clock that steps backwards never mints tokens', () => {
    let state = null;
    for (let i = 0; i < 10; i += 1) state = takeTokens(state, 10_000, CONFIG).state;
    assert.equal(takeTokens(state, 5_000, CONFIG).allowed, false);
  });

  test('heavy cost needs enough tokens at once; more than the bucket can hold is a bug', () => {
    assert.equal(takeTokens(null, 0, CONFIG, 10).allowed, true);
    assert.throws(() => takeTokens(null, 0, CONFIG, 11), RangeError);
    assert.throws(() => takeTokens(null, 0, { capacity: 0, refillPerSec: 1 }), RangeError);
  });

  test('simulated load: 60 s at 4x the allowed rate lets through the rate and no more', () => {
    // Requests arrive every 50 ms (20 per second); the bucket allows 5 per second after the initial 10.
    let state = null;
    let allowed = 0;
    for (let t = 0; t <= 60_000; t += 50) {
      const r = takeTokens(state, t, CONFIG);
      state = r.state;
      if (r.allowed) allowed += 1;
    }
    const ceiling = 10 + 5 * 60; // the burst, plus everything refilled in a minute
    assert.ok(allowed <= ceiling, `${allowed} allowed, more than the ${ceiling} the limit permits`);
    assert.ok(allowed >= ceiling - 5, `${allowed} allowed: the limiter is wasting capacity`);
  });

  test('simulated load: random traffic never breaks the invariants', () => {
    const random = seeded(7);
    let state = null;
    let now = 0;
    let allowed = 0;
    for (let i = 0; i < 20_000; i += 1) {
      now += Math.floor(random() * 400);
      const cost = 1 + Math.floor(random() * 3);
      const r = takeTokens(state, now, CONFIG, cost);
      state = r.state;
      if (r.allowed) allowed += cost;
      assert.ok(state.tokens >= 0, 'tokens went negative');
      assert.ok(state.tokens <= CONFIG.capacity + 1e-9, 'tokens exceeded capacity');
    }
    assert.ok(allowed <= CONFIG.capacity + (now / 1000) * CONFIG.refillPerSec + 1e-6);
  });
});
