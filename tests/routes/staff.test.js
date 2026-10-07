import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { csrfToken } from '../../src/web/auth/csrf.js';
import { createStaffAuth, hasSecondFactor } from '../../src/web/staff/auth.js';
import { APP_SECRET, authHarness, fakeClerk } from './auth-helpers.js';
import { silentLogger } from './helpers.js';

const TEAM = 'acme';
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
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
let staffClerk;
let signer; // { sign(claims overrides), otherKeyToken() }

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });

  signer = {
    sign: ({ issuer = ISSUER, audience = AUD, expiresIn = '5m', key = privateKey } = {}) =>
      new SignJWT({ email: 'someone@example.test' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('cf-user')
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(key),
    other: async () => (await generateKeyPair('RS256')).privateKey,
  };

  staffClerk = fakeClerk();
  h = authHarness({ env: staffEnv, staffProvider: staffClerk, cloudflareKeys: keys });
});
after(() => h.close());

/** A request to the staff host, with a valid Cloudflare token unless told otherwise. */
async function staff(method, path, { cf = true, session, body, headers = {} } = {}) {
  let req = h.agent[method](path).set('Host', STAFF_HOST).set('Accept', 'text/html');
  if (cf)
    req = req.set('Cf-Access-Jwt-Assertion', typeof cf === 'string' ? cf : await signer.sign());
  if (session) req = req.set('X-Test-Session', session);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return body ? req.type('form').send(body) : req;
}

/** Register a staff Clerk user + session. `fva` is the second-factor claim. */
function staffSession(clerkUser, { fva = [1, 2], emails } = {}) {
  return staffClerk.signIn(clerkUser, { emails, claims: { fva } });
}

describe('configuration', () => {
  test('the staff app is on its own host and Clerk app', () => {
    assert.equal(h.config.staff.host, STAFF_HOST);
    assert.equal(h.config.staff.baseUrl, `http://${STAFF_HOST}`);
    assert.equal(h.config.staff.cloudflareAccess.teamDomain, `${TEAM}.cloudflareaccess.com`);
    assert.notEqual(h.config.staff.publishableKey, h.config.auth.publishableKey);
    assert.equal(h.config.staff.signInUrl, 'https://staff-app-34.accounts.dev/sign-in');
  });
});

describe('the Cloudflare Access wall', () => {
  test('no token: refused before anything else runs', async () => {
    const res = await staff('get', '/', { cf: false }).then((r) => r);
    assert.equal(res.status, 403);
    assert.equal(res.text, 'Access denied.');
  });

  test('a token for the wrong application, wrong team, expired, or signed by someone else is refused', async () => {
    const bad = [
      await signer.sign({ audience: 'another-application' }),
      await signer.sign({ issuer: 'https://evil.cloudflareaccess.com' }),
      await signer.sign({ expiresIn: '-1m' }),
      await signer.sign({ key: await signer.other() }),
      'not.a.jwt',
    ];
    for (const token of bad) {
      const res = await staff('get', '/', { cf: token });
      assert.equal(res.status, 403, token.slice(0, 20));
    }
  });

  test('even a signed-in staff member is refused without the token (going around Cloudflare)', async () => {
    const member = await h.fx.staff({ roles: ['super_admin'] });
    const me = staffSession({ id: 'cu_bypass', email: member.email, name: 'Bypass' });
    const res = await staff('get', '/', { cf: false, session: me.session });
    assert.equal(res.status, 403);
  });

  test('with a valid token and no sign-in, the visitor is sent to the STAFF Clerk app', async () => {
    const res = await staff('get', '/');
    assert.equal(res.status, 302);
    const url = new URL(res.headers.location);
    assert.equal(url.hostname, 'staff-app-34.accounts.dev');
    assert.equal(url.searchParams.get('redirect_url'), `http://${STAFF_HOST}/`);
  });

  test('the staff host serves only staff pages; the public site lives on its own host', async () => {
    const res = await staff('get', '/app');
    assert.equal(res.status, 404, 'customer routes do not exist on the staff host');
    const methodology = await staff('get', '/methodology');
    assert.equal(methodology.status, 404);
    const publicHome = await h.agent.get('/').expect(200);
    assert.match(publicHome.text, /Is AI sending your customers to your competitors/);
    const staffOnPublic = await h.agent.get('/sign-out');
    assert.equal(staffOnPublic.status, 404, 'no staff pages on the public host');
  });
});

describe('second factor is mandatory', () => {
  test('hasSecondFactor reads Clerk’s fva claim', () => {
    assert.equal(hasSecondFactor({ fva: [3, 5] }), true);
    assert.equal(hasSecondFactor({ fva: [3, 0] }), true);
    assert.equal(
      hasSecondFactor({ fva: [3, -1] }),
      false,
      '-1 = no second factor, or never verified',
    );
    assert.equal(hasSecondFactor({ fva: [3] }), false);
    assert.equal(hasSecondFactor({ fva: 'x' }), false);
    assert.equal(hasSecondFactor({}), false);
    assert.equal(hasSecondFactor(undefined), false);
  });

  test('a session with no second factor is rejected, even for an invited super admin', async () => {
    const member = await h.fx.staff({ roles: ['super_admin'] });
    const me = staffSession(
      { id: 'cu_nomfa', email: member.email, name: 'No MFA' },
      { fva: [2, -1] },
    );
    const res = await staff('get', '/', { session: me.session });
    assert.equal(res.status, 403);
    assert.match(res.text, /Two-factor sign-in is required/);
    assert.doesNotMatch(res.text, /Staff console/);
    // And the invitation was not consumed by the failed attempt.
    assert.equal(await h.db.staff.findByClerkId('cu_nomfa'), null);
  });

  test('a session with no fva claim at all is rejected', async () => {
    const member = await h.fx.staff();
    const me = staffClerk.signIn(
      { id: 'cu_nofva', email: member.email, name: 'x' },
      { claims: {} },
    );
    assert.equal((await staff('get', '/', { session: me.session })).status, 403);
  });
});

describe('invite-only staff', () => {
  test('a verified second factor but no invitation: refused, and no staff row appears', async () => {
    const me = staffSession({
      id: 'cu_stranger',
      email: 'stranger@example.test',
      name: 'Stranger',
    });
    const res = await staff('get', '/', { session: me.session });
    assert.equal(res.status, 403);
    assert.match(res.text, /isn’t set up for staff access/);
    assert.equal(await h.db.staff.findByClerkId('cu_stranger'), null);
  });

  test('an invited member signs in: bound on first sight, roles shown, login recorded', async () => {
    const invited = await h.fx.staff({ roles: ['support', 'reviewer'], name: 'Priya Rao' });
    const clerkId = `cu_${randomBytes(4).toString('hex')}`;
    const me = staffSession({ id: clerkId, email: invited.email.toUpperCase(), name: 'Priya Rao' });

    const res = await staff('get', '/', { session: me.session });
    assert.equal(res.status, 200);
    assert.match(res.text, /Staff console/);
    assert.match(res.text, /Priya Rao/);
    assert.match(res.text, />support</);
    assert.match(res.text, />reviewer</);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['x-robots-tag'], /noindex/);

    const bound = await h.db.staff.findByClerkId(clerkId);
    assert.equal(bound.id, invited.id);
    assert.ok(bound.last_login_at);

    const again = await staff('get', '/', { session: me.session });
    assert.equal(again.status, 200);
  });

  test('a second Clerk account with the same email cannot take over a bound staff row', async () => {
    const invited = await h.fx.staff();
    const first = staffSession({
      id: `cu_${randomBytes(4).toString('hex')}`,
      email: invited.email,
      name: 'A',
    });
    assert.equal((await staff('get', '/', { session: first.session })).status, 200);

    const second = staffSession({
      id: `cu_${randomBytes(4).toString('hex')}`,
      email: invited.email,
      name: 'B',
    });
    assert.equal((await staff('get', '/', { session: second.session })).status, 403);
  });

  test('binding needs a VERIFIED email', async () => {
    const invited = await h.fx.staff();
    const me = staffSession(
      { id: `cu_${randomBytes(4).toString('hex')}`, email: invited.email, name: 'Unverified' },
      { emails: [{ address: invited.email, verified: false, primary: true }] },
    );
    assert.equal((await staff('get', '/', { session: me.session })).status, 403);
  });

  test('a suspended staff member is refused', async () => {
    const invited = await h.fx.staff();
    const clerkId = `cu_${randomBytes(4).toString('hex')}`;
    const me = staffSession({ id: clerkId, email: invited.email, name: 'S' });
    assert.equal((await staff('get', '/', { session: me.session })).status, 200);
    await h.fx.suspendStaff(invited.id);
    assert.equal((await staff('get', '/', { session: me.session })).status, 403);
  });

  test('a customer session does not work on the staff host (separate Clerk apps)', async () => {
    const customer = await h.signedIn();
    // The customer's header value is unknown to the staff provider, so it is simply anonymous there.
    const res = await staff('get', '/', { session: customer.session });
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.location).hostname, 'staff-app-34.accounts.dev');
  });
});

describe('staff sign-out', () => {
  test('revokes the staff session, and needs the CSRF token', async () => {
    const invited = await h.fx.staff();
    const me = staffSession({
      id: `cu_${randomBytes(4).toString('hex')}`,
      email: invited.email,
      name: 'Out',
    });

    const noToken = await staff('post', '/sign-out', { session: me.session, body: {} });
    assert.equal(noToken.status, 403);

    const ok = await staff('post', '/sign-out', {
      session: me.session,
      body: { _csrf: csrfToken(APP_SECRET, me.sessionId) },
    });
    assert.equal(ok.status, 303);
    assert.ok(staffClerk.revoked.includes(me.sessionId));
  });

  test('with no session left (the cookie lasts about a minute) it still ends at sign-in, not at "Sign in required"', async () => {
    const res = await staff('post', '/sign-out', { body: {} });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/');
    assert.doesNotMatch(res.text, /Sign in required/);
  });
});

describe('roles inside the console', () => {
  function run(roles, ...needed) {
    const auth = createStaffAuth({
      config: h.config,
      provider: staffClerk,
      db: h.db,
      logger: silentLogger,
    });
    const outcome = { allowed: false, denied: null };
    const res = {
      page: (view, locals) => {
        outcome.denied = [view, locals.reason];
      },
    };
    auth.requireRole(...needed)({ staff: { roles } }, res, () => {
      outcome.allowed = true;
    });
    return outcome;
  }

  test('a role grants only its own area; super_admin grants everything', () => {
    assert.equal(run(['support'], 'support').allowed, true);
    assert.equal(run(['support', 'reviewer'], 'finance', 'reviewer').allowed, true);
    assert.deepEqual(run(['support'], 'finance').denied, ['staff-denied', 'role']);
    assert.deepEqual(run(['reviewer'], 'ops', 'support').denied, ['staff-denied', 'role']);
    assert.equal(run(['super_admin'], 'finance').allowed, true);
    assert.equal(run(['super_admin'], 'anything').allowed, true);
  });
});
