import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createQueues, closeQueues, QUEUE_NAMES } from '../../src/lib/queues.js';
import { queueBoard } from '../../src/web/staff/queues.js';
import { connectTestRedis } from '../helpers/redis.js';
import { authHarness, fakeClerk } from './auth-helpers.js';
import { silentLogger } from './helpers.js';

/**
 * The queue dashboard on the staff host (/queues, Bull Board): who can open it, that every change made through it
 * is audited before it happens, and that the content security policy lets it run. A real queue on a private Redis
 * prefix, the real staff wall (Cloudflare Access token + staff Clerk session + role).
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

/** A request to the staff host as a signed-in staff member holding `roles`. */
async function asStaff(roles, method, path, { headers = {} } = {}) {
  const member = await h.fx.staff({ roles });
  const me = staffClerk.signIn(
    { id: `cu_${member.email}`, email: member.email, name: member.name },
    { claims: { fva: [1, 2] } },
  );
  let req = h.agent[method](path)
    .set('Host', STAFF_HOST)
    .set('Cf-Access-Jwt-Assertion', await signToken())
    .set('X-Test-Session', me.session);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  const res = await req;
  return { res, member };
}

describe('who can open the dashboard', () => {
  test('ops sees every queue; so does a super admin', async () => {
    for (const role of ['ops', 'super_admin']) {
      const { res } = await asStaff([role], 'get', '/queues/api/queues');
      assert.equal(res.status, 200, role);
      assert.deepEqual(res.body.queues.map((q) => q.name).sort(), [...QUEUE_NAMES].sort());
    }
  });

  test('the page itself is served, with its own script and no inline code', async () => {
    const { res } = await asStaff(['ops'], 'get', '/queues/');
    assert.equal(res.status, 200);
    assert.match(res.text, /AEO Corner queues/);
    const executable = [...res.text.matchAll(/<script\b([^>]*)>/gi)].filter(
      ([, attrs]) => !/\bsrc=/.test(attrs) && !/type="application\/json"/.test(attrs),
    );
    assert.deepEqual(executable, [], 'no inline <script> that could run');
    assert.doesNotMatch(res.text, /\son[a-z]+\s*=/i, 'no inline event handlers');
  });

  test('other staff roles are refused, and learn nothing about the queues', async () => {
    for (const role of ['support', 'reviewer', 'finance']) {
      const { res } = await asStaff([role], 'get', '/queues/api/queues');
      assert.equal(res.status, 403, role);
      assert.doesNotMatch(res.text, /collect|crawl/);
    }
  });

  test('without a staff session the visitor is sent to sign in', async () => {
    const res = await h.agent
      .get('/queues/')
      .set('Host', STAFF_HOST)
      .set('Cf-Access-Jwt-Assertion', await signToken());
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.location).hostname, 'staff-app-34.accounts.dev');
  });

  test('without the Cloudflare token even ops is refused', async () => {
    const member = await h.fx.staff({ roles: ['ops'] });
    const me = staffClerk.signIn(
      { id: `cu_${member.email}`, email: member.email, name: 'x' },
      { claims: { fva: [1, 2] } },
    );
    const res = await h.agent
      .get('/queues/api/queues')
      .set('Host', STAFF_HOST)
      .set('X-Test-Session', me.session);
    assert.equal(res.status, 403);
  });

  test('the customer host has no queue page', async () => {
    assert.equal((await h.agent.get('/queues/')).status, 404);
  });
});

describe('changes are audited first', () => {
  test('a read writes no audit row', async () => {
    const { member } = await asStaff(['ops'], 'get', '/queues/api/queues');
    assert.deepEqual(await h.fx.staffAuditRows(member.id), []);
  });

  test('pausing a queue is recorded against that queue, with who, what and from where', async () => {
    const { res, member } = await asStaff(['ops'], 'put', '/queues/api/queues/digest/pause', {
      headers: { 'User-Agent': 'staff-test-agent' },
    });
    assert.equal(res.status, 200);
    assert.equal(await queues.digest.isPaused(), true, 'the change really happened');
    const rows = await h.fx.staffAuditRows(member.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'queue.write');
    assert.equal(rows[0].target_type, 'queue');
    assert.equal(rows[0].target_id, 'digest');
    assert.deepEqual(rows[0].after_state, {
      method: 'PUT',
      path: '/queues/api/queues/digest/pause',
    });
    assert.equal(rows[0].user_agent, 'staff-test-agent');
    await queues.digest.resume();
  });

  test('"pause everything" is not recorded as if "pause" were a queue', async () => {
    const { member } = await asStaff(['ops'], 'put', '/queues/api/queues/pause');
    const [row] = await h.fx.staffAuditRows(member.id);
    assert.equal(row.target_id, null);
    for (const q of Object.values(queues)) await q.resume();
  });

  test('a cross-site request is refused: nothing changes and nothing is recorded', async () => {
    const { res, member } = await asStaff(['ops'], 'put', '/queues/api/queues/digest/pause', {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(res.status, 403);
    assert.equal(await queues.digest.isPaused(), false);
    assert.deepEqual(await h.fx.staffAuditRows(member.id), []);
  });

  test('a role that cannot open the page cannot change a queue either', async () => {
    const { res, member } = await asStaff(['support'], 'put', '/queues/api/queues/digest/pause');
    assert.equal(res.status, 403);
    assert.equal(await queues.digest.isPaused(), false);
    assert.deepEqual(await h.fx.staffAuditRows(member.id), []);
  });
});

describe('no unrecorded changes', () => {
  /** The queue router on its own, signed in as ops, with an audit log that can be made to fail. */
  function board({ failAudit }) {
    const audited = [];
    const app = express();
    app.use(
      '/queues',
      queueBoard({
        queues,
        logger: silentLogger,
        staffAuth: {
          identify: (req, res, next) => {
            req.staff = { id: 7n, roles: ['ops'] };
            next();
          },
          requireRole: () => (req, res, next) => next(),
        },
        db: {
          staff: {
            audit: async (entry) => {
              if (failAudit) throw new Error('audit log unavailable');
              audited.push(entry);
            },
          },
        },
      }),
    );
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(500).send('failed'));
    return { agent: request(app), audited };
  }

  test('when the audit write fails, the action is refused and does not happen', async () => {
    const b = board({ failAudit: true });
    const res = await b.agent.put('/queues/api/queues/digest/pause');
    assert.equal(res.status, 500);
    assert.equal(await queues.digest.isPaused(), false, 'the queue was left alone');
    // Reading still works while the audit log is down: only changes need it.
    assert.equal((await b.agent.get('/queues/api/queues')).status, 200);
  });

  test('when the audit write works, it has happened before the response', async () => {
    const b = board({ failAudit: false });
    try {
      const res = await b.agent.put('/queues/api/queues/digest/pause');
      assert.equal(res.status, 200);
      assert.equal(b.audited.length, 1);
      assert.equal(b.audited[0].staffId, 7n);
    } finally {
      await queues.digest.resume();
    }
  });
});
