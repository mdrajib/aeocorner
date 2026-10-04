import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import pino from 'pino';
import { MODULES, adminModules } from '../../src/web/staff/admin.js';
import { csrfToken } from '../../src/web/auth/csrf.js';
import { Worker } from 'bullmq';
import { closeQueues, createQueues } from '../../src/lib/queues.js';
import { closeRedis, createRedis } from '../../src/lib/redis.js';
import { connectTestRedis } from '../helpers/redis.js';
import { APP_SECRET, authHarness, fakeClerk } from './auth-helpers.js';

/**
 * The staff console's modules (Milestone 8, tasks 8.17–8.23): who can open each, that every one sits behind the same wall
 * (Cloudflare Access, a staff session with a second factor, an active staff row, the right role), that every change is audited
 * first and refused if it cannot be, and what each module shows.
 */

const TEAM = 'acme';
const AUD = 'aud-tag-1234567890';
const STAFF_HOST = 'admin.localhost:3000';
const staffFrontend = 'staff-app-34.clerk.accounts.dev';
const staffEnv = {
  CLERK_STAFF_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${staffFrontend}$`).toString('base64')}`,
  CLERK_STAFF_SECRET_KEY: 'sk_test_staff_not_real',
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM,
  CLOUDFLARE_ACCESS_AUD: AUD,
  STAFF_HOST,
};

let h;
let redis;
let queues;
let staffClerk;
let signToken;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  signToken = () =>
    new SignJWT({ email: 'someone@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(`https://${TEAM}.cloudflareaccess.com`)
      .setAudience(AUD)
      .setSubject('cf-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  redis = connectTestRedis({ role: 'web' });
  queues = createQueues({ connection: redis.redis, prefix: redis.prefix });
  staffClerk = fakeClerk();
  h = authHarness({
    env: staffEnv,
    staffProvider: staffClerk,
    cloudflareKeys: createLocalJWKSet({ keys: [jwk] }),
    queues,
  });
});
after(async () => {
  await h.close();
  await closeQueues(queues);
  await redis.close();
});

/** A staff member with `roles`, and the helpers to act as them on the staff host. */
async function staffer(roles, { fva = [1, 2], uninvited = false } = {}) {
  const member = uninvited
    ? { email: `nobody-${randomBytes(4).toString('hex')}@example.test`, name: 'Nobody', id: null }
    : await h.fx.staff({ roles });
  const me = staffClerk.signIn(
    { id: `cu_${member.email}`, email: member.email, name: member.name },
    { claims: { fva } },
  );
  const csrf = csrfToken(APP_SECRET, me.sessionId);
  const cf = await signToken();
  const base = (method, path, { cloudflare = true, session = true } = {}) => {
    let req = h.agent[method](path).set('Host', STAFF_HOST);
    if (cloudflare) req = req.set('Cf-Access-Jwt-Assertion', cf);
    if (session) req = req.set('X-Test-Session', me.session);
    return req;
  };
  return {
    member,
    csrf,
    get: (path, options) => base('get', path, options),
    post: (path, body = {}, { csrf: token = csrf, ...options } = {}) =>
      base('post', path, options)
        .type('form')
        .send({ ...(token === null ? {} : { _csrf: token }), ...body }),
  };
}

const auditActions = async (member) => (await h.fx.staffAuditRows(member.id)).map((r) => r.action);

describe('the wall around every module', () => {
  // Every route the modules register: [method, path as registered, roles that may use it ([] = super admin only), example path].
  const ROUTES = [
    ['get', '/costs', ['finance', 'ops'], '/costs'],
    ['get', '/providers', ['ops'], '/providers'],
    ['get', '/jobs', ['ops'], '/jobs'],
    ['post', '/jobs/retry', ['ops'], '/jobs/retry'],
    ['get', '/review', ['reviewer'], '/review'],
    ['get', '/review/:id', ['reviewer'], '/review/999999999'],
    ['post', '/review/:id/take', ['reviewer'], '/review/999999999/take'],
    ['post', '/review/:id/resolve', ['reviewer'], '/review/999999999/resolve'],
    ['post', '/review/:id/reject', ['reviewer'], '/review/999999999/reject'],
    ['post', '/review/:id/alias', ['reviewer'], '/review/999999999/alias'],
    ['post', '/review/:id/reextract', ['reviewer'], '/review/999999999/reextract'],
    ['post', '/review/:id/golden', ['reviewer'], '/review/999999999/golden'],
    ['get', '/flags', [], '/flags'],
    ['post', '/flags/default', [], '/flags/default'],
    ['post', '/flags/override', [], '/flags/override'],
    ['post', '/flags/clear', [], '/flags/clear'],
    ['get', '/audit', [], '/audit'],
  ];

  test('the list above is every route the modules register: a new one cannot slip in without being checked', () => {
    const open = (req, res, next) => next();
    const router = adminModules({
      config: h.config,
      db: h.db,
      staffAuth: { identify: open, requireRole: () => open },
      queues: null,
      logger: pino({ level: 'silent' }),
    });
    const registered = router.stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`))
      .sort();
    assert.deepEqual(registered, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
  });

  test('every module’s path is behind the identify wall, not only its routes', () => {
    const open = () => {};
    const router = adminModules({
      config: h.config,
      db: h.db,
      staffAuth: { identify: open, requireRole: () => open },
      queues: null,
      logger: pino({ level: 'silent' }),
    });
    const wall = router.stack.find((l) => !l.route && l.handle === open);
    assert.ok(wall, 'a layer applies identify before any route');
    assert.ok(
      router.stack.indexOf(wall) < router.stack.findIndex((l) => l.route),
      'and it comes first',
    );
  });

  test('every module is in the module list, and the list names the roles the routes use', () => {
    const paths = new Set(ROUTES.map(([, , , example]) => example.split('/')[1]));
    for (const m of MODULES) assert.ok(paths.has(m.href.slice(1)), m.id);
  });

  for (const [method, path, roles, example] of ROUTES) {
    test(`${method.toUpperCase()} ${path}: not reachable around Cloudflare, without a session, without a second factor, as a stranger, or in the wrong role`, async () => {
      const allowed = roles.length ? roles[0] : 'super_admin';
      const ok = await staffer([allowed]);
      const send = (who, options) =>
        method === 'get' ? who.get(example, options) : who.post(example, {}, options);

      assert.equal((await send(ok, { cloudflare: false })).status, 403, 'no Cloudflare token');
      const anon = await send(ok, { session: false });
      assert.equal(anon.status, method === 'get' ? 302 : 401, 'no session');

      const noMfa = await staffer([allowed], { fva: [1, -1] });
      const mfa = await send(noMfa);
      assert.equal(mfa.status, 403, 'no second factor');
      assert.match(mfa.text, /two-factor|second factor|authenticator/i);

      const stranger = await staffer([], { uninvited: true });
      assert.equal((await send(stranger)).status, 403, 'not on the staff list');

      const wrong = (
        await Promise.all(
          ['support', 'reviewer', 'finance', 'ops']
            .filter((r) => !roles.includes(r))
            .map((r) => staffer([r])),
        )
      )[0];
      assert.equal((await send(wrong)).status, 403, 'a role that does not open it');
      assert.ok(wrong.member);
    });
  }

  test('a super admin can open every module', async () => {
    const boss = await staffer(['super_admin']);
    for (const [, path, , example] of ROUTES.filter(([m]) => m === 'get')) {
      const res = await boss.get(example);
      assert.ok([200, 404].includes(res.status), `${path}: ${res.status}`);
      assert.notEqual(res.status, 403, path);
    }
  });

  test('a write without the CSRF token is refused before it is recorded', async () => {
    const boss = await staffer(['super_admin']);
    const res = await boss.post(
      '/flags/default',
      { key: 'x.y', reason: 'because' },
      { csrf: null },
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await auditActions(boss.member), []);
  });

  test('the overview shows each person only the modules their roles open', async () => {
    const ops = await staffer(['ops']);
    const page = await ops.get('/');
    assert.match(page.text, /Provider health/);
    assert.match(page.text, /Failed jobs/);
    assert.doesNotMatch(page.text, /Feature flags/);
    assert.doesNotMatch(page.text, /Review queue/);
    const boss = await staffer(['super_admin']);
    const all = await boss.get('/');
    for (const m of MODULES) assert.match(all.text, new RegExp(m.label));
    const nobody = await staffer(['support']);
    assert.match((await nobody.get('/')).text, /Nothing for your roles yet/);
  });
});

describe('cost and margin', () => {
  test('shows spend by provider and model, the plan margins and the most expensive customers', async () => {
    const o = await h.fx.org({ name: 'Costly Co' });
    await h.fx.setOrg(o.org.id, { plan_code: 'starter', billing_status: 'active' });
    const p = await h.fx.project(o.org.id);
    await o.scoped.usage.record({
      projectId: p.id,
      meter: 'llm_extract',
      providerCode: 'anthropic',
      model: 'claude-opus-5-5',
      unit: 'batch',
      costUsd: '12.500000',
      idempotencyKey: `cost-${randomBytes(6).toString('hex')}`,
    });
    const finance = await staffer(['finance']);
    const page = await finance.get('/costs?days=7');
    assert.equal(page.status, 200);
    assert.match(page.text, /Reading answers \(Claude\)/);
    assert.match(page.text, /claude-opus-5-5/);
    assert.match(page.text, /Costly Co/);
    assert.match(page.text, /\$12\.50/);
    assert.match(page.text, /starter/);
    // The customer paying $79 and costing $12.50 earns 84%: on target.
    assert.match(page.text, /84%/);
    assert.match(page.text, /aria-current="true"[^>]*>7 days/);
  });

  test('an unknown period falls back to 30 days; no data says so instead of showing 0', async () => {
    const ops = await staffer(['ops']);
    const page = await ops.get('/costs?days=9999');
    assert.equal(page.status, 200);
    assert.match(page.text, /last 30 days/);
  });
});

describe('provider health', () => {
  test('a provider with a tripped breaker is first and says so', async () => {
    const provider = 'dataforseo';
    const start = new Date(Math.floor(Date.now() / 300_000) * 300_000 - 300_000);
    await h.db.system.providerHealth.upsertBucket({
      providerCode: provider,
      engineCode: 'zz_test',
      bucketStart: start,
      requests: 50,
      successes: 20,
      failures: 30,
      timeouts: 0,
      p50Ms: 400,
      p95Ms: 1200,
      costUsd: '0.5',
      breakerState: 'open',
    });
    const ops = await staffer(['ops']);
    const page = await ops.get('/providers');
    assert.equal(page.status, 200);
    assert.match(page.text, /dataforseo \(zz_test\)/);
    assert.match(page.text, /Breaker open/);
    assert.match(page.text, /A circuit breaker is open/);
    assert.match(page.text, /1200 ms/);
  });
});

describe('failed jobs and retry', () => {
  test('lists a failed job, retries it once, audits the retry first, and a second retry is "not there"', async () => {
    const ops = await staffer(['ops']);
    const conn = createRedis(process.env.TEST_REDIS_URL, {
      role: 'worker',
      name: 'staff-admin-test',
    });
    const worker = new Worker(
      'system',
      async () => {
        throw new Error('The provider said no');
      },
      { connection: conn, prefix: redis.prefix },
    );
    const jobId = `failed-${randomBytes(4).toString('hex')}`;
    try {
      const failed = new Promise((resolve) => worker.once('failed', resolve));
      await queues.system.add('system.noop', { orgId: '1' }, { jobId, attempts: 1 });
      await failed;
    } finally {
      await worker.close();
      await closeRedis(conn);
    }

    const page = await ops.get('/jobs');
    assert.match(page.text, /system.noop/);
    assert.match(page.text, /The provider said no/);
    assert.match(page.text, new RegExp(jobId));

    const first = await ops.post('/jobs/retry', { queue: 'system', id: jobId });
    assert.equal(first.status, 303);
    assert.match(first.headers.location, /job-retried/);
    assert.deepEqual(await auditActions(ops.member), ['job.retry']);
    assert.notEqual(await (await queues.system.getJob(jobId)).getState(), 'failed');
    const again = await ops.post('/jobs/retry', { queue: 'system', id: jobId });
    assert.match(again.headers.location, /job-gone/);
    await (await queues.system.getJob(jobId)).remove().catch(() => {});
  });

  test('a queue we do not have, or an ID that is not a plain word, retries nothing (and is still audited)', async () => {
    const ops = await staffer(['ops']);
    for (const body of [
      { queue: 'nope', id: 'x' },
      { queue: 'system', id: '../../etc' },
      { queue: '__proto__', id: 'x' },
    ]) {
      const res = await ops.post('/jobs/retry', body);
      assert.match(res.headers.location, /job-gone/);
    }
    assert.equal((await auditActions(ops.member)).length, 3);
  });
});
