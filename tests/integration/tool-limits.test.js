import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { createToolLimiterModel, TOOL_LIMITS } from '../../src/core/tool-limits.js';
import { connectTestDb } from '../../src/db/testing.js';
import { createToolLimiter } from '../../src/lib/tool-limits.js';
import { connectTestRedis } from '../helpers/redis.js';

/**
 * Who may run a free tool (Milestone 17, task 17.02), against real Redis and MySQL: the Lua script and the pure model
 * in `src/core/tool-limits.js` must give the same answer to the same traffic, and the automatic block must reach the
 * real `abuse_blocks` table.
 */
const db = connectTestDb();
const { redis, prefix, close } = connectTestRedis();
const blocked = [];

after(async () => {
  for (const row of blocked) await db.abuse.unblock(row);
  await close();
  await db.close();
});

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const unique = () => randomBytes(4).toString('hex');
const ipv4 = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

/** A fixed clock the test moves, and an in-memory `abuse` so a replay can run many thousands of requests quickly. */
function rig() {
  const clock = { ms: T0 };
  const rows = new Set();
  const fakeDb = {
    abuse: {
      active: async ({ ip }) => (rows.has(ip) ? { id: 1 } : null),
      block: async ({ value }) => rows.add(value),
    },
  };
  const limiter = createToolLimiter({
    redis,
    prefix: `${prefix}${unique()}`,
    db: fakeDb,
    now: () => new Date(clock.ms),
  });
  return { clock, limiter, rows };
}

/** A small deterministic random generator, so "random" traffic is the same every run. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('the Redis limiter against the pure model', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`3,000 random requests, seed ${seed}: every answer is the same`, async () => {
      const { clock, limiter } = rig();
      const model = createToolLimiterModel();
      const rand = seeded(seed);
      const ips = Array.from({ length: 6 }, (_, i) => `203.0.113.${i + 1}`);
      const domains = Array.from({ length: 5 }, (_, i) => `site${i}.test`);
      for (let i = 0; i < 3000; i += 1) {
        // Time moves in small, uneven steps, so minute, hour and day boundaries are all crossed.
        clock.ms += Math.floor(rand() * 4_000);
        const request = {
          kind: rand() < 0.75 ? 'fetch' : 'generate',
          ip: ips[Math.floor(rand() * ips.length)],
          domain: domains[Math.floor(rand() * domains.length)],
        };
        const want = model.admit({ ...request, nowMs: clock.ms });
        const got = await limiter.admit(request);
        assert.deepEqual(got, want, `request ${i}: ${JSON.stringify(request)}`);
      }
    });
  }

  test('two requests at the same moment cannot both take the last place', async () => {
    const { limiter } = rig();
    const ip = ipv4();
    const answers = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        limiter.admit({ kind: 'fetch', ip, domain: `d${i}.test` }),
      ),
    );
    assert.equal(answers.filter((a) => a.allowed).length, TOOL_LIMITS.fetch.perIpPerMinute);
  });
});

describe('what the limiter keeps', () => {
  test('no address or domain is in a Redis key in the clear', async () => {
    const { limiter } = rig();
    const ip = '203.0.113.77';
    await limiter.admit({ kind: 'fetch', ip, domain: 'secret-brand.test' });
    // The test prefix is shared by every rig of this file, so list all of its keys.
    let cursor = '0';
    const found = [];
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    assert.ok(found.length > 0);
    for (const key of found) {
      assert.ok(!key.includes('203.0.113.77'), key);
      assert.ok(!key.includes('secret-brand'), key);
    }
  });

  test('every counter has an expiry, so nothing is kept for good', async () => {
    const { limiter } = rig();
    await limiter.admit({ kind: 'fetch', ip: ipv4(), domain: `d${unique()}.test` });
    let cursor = '0';
    const found = [];
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}*tool-limit*`,
        'COUNT',
        500,
      );
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    assert.ok(found.length > 0);
    for (const key of found) assert.ok((await redis.pttl(key)) > 0, key);
  });
});

describe('the automatic block, in the real table', () => {
  test('five refused fetches in a day block the IP in abuse_blocks, and it stays blocked', async () => {
    const clock = { ms: T0 };
    const limiter = createToolLimiter({
      redis,
      prefix: `${prefix}${unique()}`,
      db,
      now: () => new Date(clock.ms),
    });
    const ip = ipv4();
    blocked.push({ kind: 'ip', value: ip });
    for (let i = 0; i < TOOL_LIMITS.fetch.perIpPerMinute; i += 1)
      assert.equal(
        (await limiter.admit({ kind: 'fetch', ip, domain: `d${i}.test` })).allowed,
        true,
      );
    for (let i = 0; i < TOOL_LIMITS.strikesToBlock; i += 1)
      assert.equal((await limiter.admit({ kind: 'fetch', ip, domain: 'x.test' })).allowed, false);

    assert.ok(await db.abuse.active({ ip, now: new Date(clock.ms) }), 'a row was written');
    clock.ms += 5 * 60_000; // the minute counter is clear, but the block is not
    const after = await limiter.admit({ kind: 'fetch', ip, domain: 'y.test' });
    assert.deepEqual(after, { allowed: false, reason: 'blocked' });
    // ...and the generators are closed to it too: a blocked address is blocked everywhere.
    assert.deepEqual(await limiter.admit({ kind: 'generate', ip }), {
      allowed: false,
      reason: 'blocked',
    });
  });

  test('a staff block on a target domain refuses a fetch tool, and a generator does not care', async () => {
    const limiter = createToolLimiter({ redis, prefix: `${prefix}${unique()}`, db });
    const domain = `blocked-${unique()}.test`;
    blocked.push({ kind: 'target_domain', value: domain });
    await db.abuse.block({ kind: 'target_domain', value: domain, reason: 'test' });
    assert.deepEqual(await limiter.admit({ kind: 'fetch', ip: ipv4(), domain }), {
      allowed: false,
      reason: 'blocked',
    });
    assert.equal((await limiter.admit({ kind: 'generate', ip: ipv4(), domain })).allowed, true);
  });

  test('with Redis unreachable the limiter throws, so the caller closes the tool', async () => {
    const { createRedis, closeRedis } = await import('../../src/lib/redis.js');
    const dead = createRedis('redis://127.0.0.1:1', { role: 'producer', name: 'aeo-test-dead' });
    dead.on('error', () => {});
    const limiter = createToolLimiter({ redis: dead, prefix, db });
    await assert.rejects(limiter.admit({ kind: 'generate', ip: ipv4() }));
    await closeRedis(dead);
  });
});
