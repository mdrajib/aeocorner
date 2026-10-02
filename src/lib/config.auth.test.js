import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountsOrigin, cloudflareTeamDomain, frontendApiOf, loadConfig } from './config.js';

const frontend = (host) => Buffer.from(`${host}$`).toString('base64');
const customerKeys = {
  CLERK_PUBLISHABLE_KEY: `pk_test_${frontend('example-12.clerk.accounts.dev')}`,
  CLERK_SECRET_KEY: 'sk_test_x',
};
const liveKeys = {
  CLERK_PUBLISHABLE_KEY: `pk_live_${frontend('clerk.aeocorner.com')}`,
  CLERK_SECRET_KEY: 'sk_live_x',
};
const staffKeys = {
  CLERK_STAFF_PUBLISHABLE_KEY: `pk_test_${frontend('staff-9.clerk.accounts.dev')}`,
  CLERK_STAFF_SECRET_KEY: 'sk_test_staff',
};
const secret = 'x'.repeat(40);

test('no Clerk keys means no sign-in and no staff app', () => {
  const c = loadConfig({});
  assert.equal(c.auth, null);
  assert.equal(c.staff, null);
  assert.equal(c.databaseUrl, null);
  assert.equal(c.email.resendApiKey, null);
});

test('Clerk keys give hosted sign-in and sign-up URLs derived from the publishable key', () => {
  const c = loadConfig(customerKeys);
  assert.equal(c.auth.frontendApi, 'example-12.clerk.accounts.dev');
  assert.equal(c.auth.signInUrl, 'https://example-12.accounts.dev/sign-in');
  assert.equal(c.auth.signUpUrl, 'https://example-12.accounts.dev/sign-up');
  assert.equal(c.auth.isLive, false);
  assert.equal(c.auth.webhookSecret, null);

  const live = loadConfig({ NODE_ENV: 'production', APP_SECRET: secret, ...liveKeys });
  assert.equal(live.auth.signInUrl, 'https://accounts.aeocorner.com/sign-in');
});

test('explicit sign-in URLs override the derived ones', () => {
  const c = loadConfig({
    ...customerKeys,
    CLERK_SIGN_IN_URL: 'https://login.example.test/in',
    CLERK_SIGN_UP_URL: 'https://login.example.test/up',
  });
  assert.equal(c.auth.signInUrl, 'https://login.example.test/in');
  assert.equal(c.auth.signUpUrl, 'https://login.example.test/up');
});

test('the two Clerk keys come as a pair, and must look like Clerk keys', () => {
  assert.throws(() => loadConfig({ CLERK_SECRET_KEY: 'sk_test_x' }), /both/);
  assert.throws(
    () => loadConfig({ CLERK_PUBLISHABLE_KEY: customerKeys.CLERK_PUBLISHABLE_KEY }),
    /both/,
  );
  assert.throws(() => loadConfig({ CLERK_PUBLISHABLE_KEY: 'nope', CLERK_SECRET_KEY: 'sk_test_x' }));
  assert.throws(
    () =>
      loadConfig({
        CLERK_PUBLISHABLE_KEY: 'pk_test_bm90LWEtaG9zdA',
        CLERK_SECRET_KEY: 'sk_test_x',
      }),
    /not a valid Clerk key/,
  );
});

test('the live site refuses a Clerk test instance, and a server in production needs APP_SECRET', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', APP_SECRET: secret, ...customerKeys }),
    /production Clerk instance/,
  );
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /APP_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ENV: 'staging' }), /APP_SECRET/);
  assert.throws(() => loadConfig({ APP_SECRET: 'too-short' }));
  // Staging may use test instances.
  assert.doesNotThrow(() =>
    loadConfig({
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      APP_SECRET: secret,
      ...customerKeys,
    }),
  );
});

test('the staff app: its own host, hosted sign-in, and Cloudflare Access required outside development', () => {
  const dev = loadConfig({ ...staffKeys, APP_BASE_URL: 'http://localhost:3000' });
  assert.equal(dev.staff.host, 'admin.localhost:3000');
  assert.equal(dev.staff.baseUrl, 'http://admin.localhost:3000');
  assert.equal(dev.staff.signInUrl, 'https://staff-9.accounts.dev/sign-in');
  assert.equal(dev.staff.cloudflareAccess, null, 'allowed on a laptop only');

  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        APP_SECRET: secret,
        ...staffKeys,
      }),
    /Cloudflare Access/,
  );
  const staging = loadConfig({
    NODE_ENV: 'production',
    APP_ENV: 'staging',
    APP_SECRET: secret,
    APP_BASE_URL: 'https://staging.aeocorner.com',
    ...staffKeys,
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: 'acme',
    CLOUDFLARE_ACCESS_AUD: 'aud',
  });
  assert.equal(staging.staff.host, 'admin.staging.aeocorner.com');
  assert.deepEqual(staging.staff.cloudflareAccess, {
    teamDomain: 'acme.cloudflareaccess.com',
    aud: 'aud',
  });
});

test('the Cloudflare team can be given as a name, a host or a URL', () => {
  for (const input of ['acme', 'acme.cloudflareaccess.com', 'https://acme.cloudflareaccess.com/']) {
    assert.equal(cloudflareTeamDomain(input), 'acme.cloudflareaccess.com');
  }
});

test('the frontend API host and the Account Portal host are derived like Clerk does', () => {
  assert.equal(frontendApiOf(customerKeys.CLERK_PUBLISHABLE_KEY), 'example-12.clerk.accounts.dev');
  assert.equal(frontendApiOf('pk_test_garbage'), null);
  assert.equal(accountsOrigin('clerk.aeocorner.com'), 'https://accounts.aeocorner.com');
  assert.equal(accountsOrigin('example-12.clerk.accounts.dev'), 'https://example-12.accounts.dev');
});
