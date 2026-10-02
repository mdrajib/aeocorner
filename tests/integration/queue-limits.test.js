import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { acquireLease, releaseLease } from '../../src/core/concurrency.js';
import { takeTokens } from '../../src/core/token-bucket.js';
import { createConcurrencyLimiter } from '../../src/lib/concurrency.js';
import { createRateLimiter } from '../../src/lib/rate-limit.js';
import { connectTestRedis } from '../helpers/redis.js';

const main = connectTestRedis();
const second = connectTestRedis(); // a second connection stands in for a second worker process
// Both connections must use the same keys, so the second one adopts the first one's prefix.
const prefix = main.prefix;
after(async () => {
  await main.close();
  await second.close();
});

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('rate limiter in Redis', () => {
  const limiter = createRateLimiter(main.redis, { prefix });
  const config = { capacity: 10, refillPerSec: 5 };

  test('answers exactly like the model, over thousands of random calls', async () => {
    const random = seeded(21);
    let state = null;
    let now = 1_000_000;
    for (let i = 0; i < 3_000; i += 1) {
      now += Math.floor(random() * 500);
      const cost = 1 + Math.floor(random() * 3);
      const expected = takeTokens(state, now, config, cost);
      state = expected.state;
      const actual = await limiter.take('differential', config, cost, { nowMs: now });
      assert.equal(actual.allowed, expected.allowed, `call ${i}: allowed`);
      assert.equal(actual.retryAfterMs, expected.retryAfterMs, `call ${i}: retryAfterMs`);
      assert.ok(Math.abs(actual.tokens - expected.state.tokens) < 1e-9, `call ${i}: tokens`);
    }
  });

  test('two hundred simultaneous calls get exactly `capacity` tokens: no token is handed out twice', async () => {
    const tight = { capacity: 50, refillPerSec: 0.001 };
    const results = await Promise.all(
      Array.from({ length: 200 }, () => limiter.take('burst', tight)),
    );
    assert.equal(results.filter((r) => r.allowed).length, 50);
  });

  test('two worker processes share one bucket', async () => {
    const other = createRateLimiter(second.redis, { prefix });
    const tight = { capacity: 20, refillPerSec: 0.001 };
    const calls = Array.from({ length: 100 }, (_, i) =>
      (i % 2 ? limiter : other).take('shared', tight),
    );
    const allowed = (await Promise.all(calls)).filter((r) => r.allowed).length;
    assert.equal(allowed, 20);
  });

  test('buckets are independent per provider', async () => {
    const tight = { capacity: 1, refillPerSec: 0.001 };
    assert.equal((await limiter.take('provider-a', tight)).allowed, true);
    assert.equal((await limiter.take('provider-a', tight)).allowed, false);
    assert.equal((await limiter.take('provider-b', tight)).allowed, true);
  });

  test('uses Redis’s clock when no time is given, and refills as real time passes', async () => {
    const fast = { capacity: 1, refillPerSec: 20 }; // a token every 50 ms
    assert.equal((await limiter.take('realtime', fast)).allowed, true);
    const denied = await limiter.take('realtime', fast);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 50);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await limiter.take('realtime', fast)).allowed, true);
  });

  test('refuses nonsense settings instead of storing them', async () => {
    await assert.rejects(limiter.take('x', { capacity: 0, refillPerSec: 1 }), RangeError);
    await assert.rejects(limiter.take('x', { capacity: 5, refillPerSec: 1 }, 6), RangeError);
  });
});

describe('per-organization concurrency cap in Redis', () => {
  const caps = createConcurrencyLimiter(main.redis, { prefix });
  const limit = { cap: 3, ttlMs: 60_000 };

  test('answers exactly like the model, over thousands of random calls', async () => {
    const random = seeded(33);
    let model = new Map();
    const held = [];
    let now = 5_000_000;
    for (let i = 0; i < 2_000; i += 1) {
      now += Math.floor(random() * 4_000);
      if (held.length && random() < 0.4) {
        const [id] = held.splice(Math.floor(random() * held.length), 1);
        model = releaseLease(model, id);
        await caps.release('diff', 'org-1', id);
      }
      const id = `job-${i}`;
      const expected = acquireLease(model, now, limit, id);
      model = expected.leases;
      const actual = await caps.acquire('diff', 'org-1', limit, id, { nowMs: now });
      assert.equal(actual, expected.acquired, `call ${i}`);
      if (actual) held.push(id);
    }
  });

  test('forty simultaneous jobs from two workers: exactly `cap` get in', async () => {
    const other = createConcurrencyLimiter(second.redis, { prefix });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 ? caps : other).acquire('race', 'org-2', limit, `job-${i}`),
      ),
    );
    assert.equal(results.filter(Boolean).length, 3);
    assert.equal(await caps.active('race', 'org-2'), 3);
  });

  test('releasing frees a slot for the next job', async () => {
    for (const id of ['a', 'b', 'c'])
      assert.equal(await caps.acquire('free', 'org-3', limit, id), true);
    assert.equal(await caps.acquire('free', 'org-3', limit, 'd'), false);
    await caps.release('free', 'org-3', 'b');
    assert.equal(await caps.acquire('free', 'org-3', limit, 'd'), true);
  });

  test('a crashed worker’s slot comes back when its lease expires', async () => {
    const short = { cap: 1, ttlMs: 150 };
    assert.equal(await caps.acquire('crash', 'org-4', short, 'dies'), true);
    assert.equal(await caps.acquire('crash', 'org-4', short, 'next'), false);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(await caps.acquire('crash', 'org-4', short, 'next'), true);
  });

  test('organizations and scopes do not share a cap', async () => {
    const one = { cap: 1, ttlMs: 60_000 };
    assert.equal(await caps.acquire('iso', 'org-5', one, 'x'), true);
    assert.equal(await caps.acquire('iso', 'org-5', one, 'y'), false);
    assert.equal(await caps.acquire('iso', 'org-6', one, 'x'), true, 'another organization');
    assert.equal(await caps.acquire('other-scope', 'org-5', one, 'x'), true, 'another queue');
  });
});
