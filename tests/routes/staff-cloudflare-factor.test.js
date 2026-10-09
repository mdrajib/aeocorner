import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadConfig } from '../../src/lib/config.js';
import { authHarness, fakeClerk } from './auth-helpers.js';

// STAFF_SECOND_FACTOR=cloudflare (ADR-0019): no Clerk second factor is asked for; the person Cloudflare Access let in
// must be the staff member who signed in to Clerk.

const TEAM = 'acme';
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const AUD = 'aud-tag-1234567890';
const STAFF_HOST = 'admin.localhost:3000';
const staffFrontend = 'staff-app-35.clerk.accounts.dev';
const staffEnv = {
  CLERK_STAFF_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${staffFrontend}$`).toString('base64')}`,
  CLERK_STAFF_SECRET_KEY: 'sk_test_staff_not_real',
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM,
  CLOUDFLARE_ACCESS_AUD: AUD,
  STAFF_HOST,
};

let h;
let staffClerk;
let sign;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  sign = ({ email } = {}) =>
    new SignJWT(email === undefined ? {} : { email })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setSubject('cf-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  staffClerk = fakeClerk();
  h = authHarness({
    env: { ...staffEnv, STAFF_SECOND_FACTOR: 'cloudflare' },
    staffProvider: staffClerk,
    cloudflareKeys: keys,
  });
});
after(() => h.close());

async function staff(session, accessEmail) {
  return h.agent
    .get('/')
    .set('Host', STAFF_HOST)
    .set('Accept', 'text/html')
    .set('Cf-Access-Jwt-Assertion', await sign({ email: accessEmail }))
    .set('X-Test-Session', session);
}

describe('Cloudflare Access as the staff second factor', () => {
  test('the option is read from the environment', () => {
    assert.equal(h.config.staff.secondFactor, 'cloudflare');
  });

  test('a session with no Clerk second factor gets in when Access vouched for the same email', async () => {
    const member = await h.fx.staff({ roles: ['super_admin'] });
    const me = staffClerk.signIn(
      { id: 'cu_cf_ok', email: member.email, name: 'Via Access' },
      { claims: { fva: [2, -1] } },
    );
    const res = await staff(me.session, member.email.toUpperCase());
    assert.equal(res.status, 200);
    assert.match(res.text, /Staff console/);
  });

  test('Access let in a different person: refused, and the invitation is not used up', async () => {
    const member = await h.fx.staff({ roles: ['super_admin'] });
    const me = staffClerk.signIn(
      { id: 'cu_cf_other', email: member.email, name: 'Borrowed' },
      { claims: { fva: [2, -1] } },
    );
    const res = await staff(me.session, 'someone-else@example.test');
    assert.equal(res.status, 403);
    assert.match(res.text, /two sign-ins don’t match/);
    assert.doesNotMatch(res.text, /Staff console/);
  });

  test('an Access token with no email is refused', async () => {
    const member = await h.fx.staff({ roles: ['super_admin'] });
    const me = staffClerk.signIn(
      { id: 'cu_cf_noemail', email: member.email, name: 'No email' },
      { claims: { fva: [2, 2] } },
    );
    const res = await staff(me.session, undefined);
    assert.equal(res.status, 403);
  });

  test('a person who is not invited is still refused', async () => {
    const me = staffClerk.signIn(
      { id: 'cu_cf_uninvited', email: 'nobody@example.test', name: 'Nobody' },
      { claims: { fva: [2, 2] } },
    );
    const res = await staff(me.session, 'nobody@example.test');
    assert.equal(res.status, 403);
    assert.match(res.text, /isn’t set up for staff access/);
  });
});

describe('configuration', () => {
  const base = {
    NODE_ENV: 'test',
    APP_ENV: 'development',
    CLERK_STAFF_PUBLISHABLE_KEY: staffEnv.CLERK_STAFF_PUBLISHABLE_KEY,
    CLERK_STAFF_SECRET_KEY: staffEnv.CLERK_STAFF_SECRET_KEY,
  };

  test('Cloudflare as the second factor without Cloudflare Access is refused, even on a laptop', () => {
    assert.throws(
      () => loadConfig({ ...base, STAFF_SECOND_FACTOR: 'cloudflare' }),
      /STAFF_SECOND_FACTOR=cloudflare needs Cloudflare Access/,
    );
  });

  test('the default stays Clerk’s own second factor, and an unknown value is refused', () => {
    const ok = loadConfig({
      ...base,
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM,
      CLOUDFLARE_ACCESS_AUD: AUD,
    });
    assert.equal(ok.staff.secondFactor, 'clerk');
    assert.throws(() => loadConfig({ ...base, STAFF_SECOND_FACTOR: 'none' }));
  });
});
