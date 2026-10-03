import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { AUDIT_LIMITS } from '../../src/core/audit-abuse.js';
import { createAuditLimiter } from '../../src/lib/audit-limits.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { connectTestRedis } from '../helpers/redis.js';

/**
 * Who may start a free audit (Milestone 1, task 1.15), against real MySQL and Redis: the daily limits per email, IP
 * and domain, throwaway addresses, staff and automatic blocks, and the bypass attempts a bot would try.
 */
const db = connectTestDb();
const fx = fixtures(db);
const { redis, prefix, close } = connectTestRedis();

const blocked = [];
const unique = () => randomBytes(4).toString('hex');
const ipv4 = () => `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;
const limiter = (options = {}) => createAuditLimiter({ redis, prefix, db, ...options });
const block = async (row) => {
  blocked.push(row);
  return db.abuse.block(row);
};

after(async () => {
  for (const row of blocked) await db.abuse.unblock(row);
  await fx.cleanup();
  await close();
  await db.close();
});

const attempt = (l, over = {}) =>
  l.admit({
    ip: '203.0.113.1',
    email: `a${unique()}@acme.test`,
    domain: `d${unique()}.test`,
    ...over,
  });

describe('the daily limits', () => {
  test('three audits per email: the fourth is refused, even with dots, +tags and capitals', async () => {
    const l = limiter();
    const ip = ipv4();
    const who = `jo${unique()}`;
    const variants = [
      `${who}@gmail.com`,
      `${who.slice(0, 3)}.${who.slice(3)}@gmail.com`,
      `${who}+two@GMAIL.com`,
    ];
    for (const email of variants) {
      assert.equal((await attempt(l, { ip, email })).allowed, true, email);
    }
    const fourth = await attempt(l, { ip, email: `${who}@googlemail.com` });
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.reason, 'email');
    assert.ok(fourth.retryAfterMs > 0 && fourth.retryAfterMs <= 86_400_000);
  });

  test('ten per IP: the eleventh is refused whatever email it brings', async () => {
    const l = limiter();
    const ip = ipv4();
    for (let i = 0; i < AUDIT_LIMITS.perIpPerDay; i += 1) {
      assert.equal((await attempt(l, { ip })).allowed, true, `attempt ${i + 1}`);
    }
    assert.equal((await attempt(l, { ip })).reason, 'ip');
  });

  test('five per target domain across different emails and IPs', async () => {
    const l = limiter();
    const domain = `hammered${unique()}.test`;
    for (let i = 0; i < AUDIT_LIMITS.perDomainPerDay; i += 1) {
      assert.equal((await attempt(l, { ip: ipv4(), domain })).allowed, true);
    }
    assert.equal((await attempt(l, { ip: ipv4(), domain: domain.toUpperCase() })).reason, 'domain');
  });

  test('a refusal does not use up the visitor’s other allowances', async () => {
    const l = limiter({
      limits: { ...AUDIT_LIMITS, perEmailPerDay: 1, perIpPerDay: 2, strikesToBlock: 99 },
    });
    const ip = ipv4();
    const email = `once${unique()}@acme.test`;
    assert.equal((await attempt(l, { ip, email })).allowed, true);
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt(l, { ip, email })).reason, 'email');
    // The IP has used 1 of 2: the five refusals cost it nothing.
    assert.equal((await attempt(l, { ip })).allowed, true);
    assert.equal((await attempt(l, { ip })).reason, 'ip');
  });

  test('the next UTC day starts again', async () => {
    let day = new Date('2026-10-03T23:00:00Z');
    const l = limiter({ now: () => day });
    const email = `late${unique()}@acme.test`;
    const ip = ipv4();
    for (let i = 0; i < 3; i += 1) assert.equal((await attempt(l, { ip, email })).allowed, true);
    assert.equal((await attempt(l, { ip, email })).reason, 'email');
    day = new Date('2026-10-04T00:05:00Z');
    assert.equal((await attempt(l, { ip, email })).allowed, true);
  });

  test('simultaneous requests cannot slip past the limit', async () => {
    const l = limiter();
    const email = `race${unique()}@acme.test`;
    const ip = ipv4();
    const results = await Promise.all(Array.from({ length: 20 }, () => attempt(l, { ip, email })));
    assert.equal(results.filter((r) => r.allowed).length, AUDIT_LIMITS.perEmailPerDay);
  });

  test('Redis holds no email address, IP or domain in the clear', async () => {
    const l = limiter();
    const ip = ipv4();
    const email = `privacy${unique()}@acme.test`;
    const domain = `secret${unique()}.test`;
    await l.admit({ ip, email, domain });
    const [, found] = await redis.scan('0', 'MATCH', `${prefix}:audit-limit:*`, 'COUNT', 1000);
    assert.ok(found.length >= 3);
    for (const key of found) {
      for (const text of [email.split('@')[0], domain, ip]) assert.ok(!key.includes(text), key);
    }
  });
});

describe('throwaway addresses and blocks', () => {
  test('a throwaway mailbox is refused and nothing is counted', async () => {
    const l = limiter();
    const ip = ipv4();
    for (let i = 0; i < 20; i += 1) {
      assert.equal(
        (await attempt(l, { ip, email: `x${i}@mailinator.com` })).reason,
        'disposable_email',
      );
    }
    // 20 refusals from this IP did not touch its counters or strike it.
    assert.equal((await attempt(l, { ip })).allowed, true);
  });

  test('a block on the IP, its network, the email, its domain or the target stops the audit', async () => {
    const l = limiter();
    const n = unique();
    const ip = ipv4();
    const [a, b, c] = ip.split('.');
    const cases = [
      [{ kind: 'ip', value: ip }, { ip }],
      [{ kind: 'ip_prefix', value: `${a}.${b}.${c}.0/24` }, { ip }],
      [{ kind: 'email', value: `bad${n}@acme.test` }, { email: `Bad${n}@acme.test` }],
      [{ kind: 'email_domain', value: `spammy${n}.test` }, { email: `x@spammy${n}.test` }],
      [{ kind: 'target_domain', value: `forbidden${n}.test` }, { domain: `forbidden${n}.test` }],
    ];
    for (const [row, visitor] of cases) {
      await block({ ...row, reason: 'test' });
      const ipOfVisitor = visitor.ip ?? ipv4();
      const result = await attempt(l, { ...visitor, ip: ipOfVisitor });
      assert.deepEqual([row.kind, result.reason], [row.kind, 'blocked']);
    }
  });

  test('an expired block no longer applies, and a permanent one does', async () => {
    const l = limiter();
    const n = unique();
    await block({
      kind: 'email_domain',
      value: `old${n}.test`,
      reason: 't',
      expiresAt: new Date(Date.now() - 1000),
    });
    assert.equal((await attempt(l, { email: `x@old${n}.test` })).allowed, true);
    await block({ kind: 'email_domain', value: `forever${n}.test`, reason: 't' });
    assert.equal((await attempt(l, { email: `x@forever${n}.test` })).reason, 'blocked');
  });

  test('five refusals in a day block the IP for a day; a staff block is never shortened by it', async () => {
    const l = limiter({ limits: { ...AUDIT_LIMITS, perEmailPerDay: 1, strikesToBlock: 3 } });
    const ip = ipv4();
    const email = `strike${unique()}@acme.test`;
    assert.equal((await attempt(l, { ip, email })).allowed, true);
    for (let i = 0; i < 3; i += 1) assert.equal((await attempt(l, { ip, email })).reason, 'email');
    blocked.push({ kind: 'ip', value: ip });
    const row = await db.abuse.active({ ip });
    assert.match(row.reason, /^Automatic/);
    assert.ok(row.expires_at > new Date(Date.now() + 23 * 3_600_000));
    assert.equal(row.created_by_staff_id, null);
    assert.equal(
      (await attempt(l, { ip })).reason,
      'blocked',
      'a fresh email from that IP is turned away',
    );

    // A block staff made has no expiry; the automatic one never replaces it.
    const permanent = ipv4();
    const staff = await fx.staff();
    await block({ kind: 'ip', value: permanent, reason: 'staff said so', staffId: staff.id });
    await db.abuse.block({
      kind: 'ip',
      value: permanent,
      reason: 'Automatic: again',
      expiresAt: new Date(Date.now() + 1000),
    });
    const kept = await db.abuse.active({
      ip: permanent,
      now: new Date(Date.now() + 10 * 86_400_000),
    });
    assert.equal(kept.reason, 'staff said so');
    assert.equal(kept.expires_at, null);
  });

  test('an unknown kind of block is refused rather than silently stored', async () => {
    await assert.rejects(db.abuse.block({ kind: 'country', value: 'XX', reason: 't' }), RangeError);
    assert.equal(await db.abuse.active({}), null);
  });
});
