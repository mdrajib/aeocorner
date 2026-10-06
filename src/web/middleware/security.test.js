import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../lib/config.js';
import { buildCspDirectives } from './security.js';

test('the baseline CSP is strict: no unsafe-inline, no unsafe-eval, nothing third-party', () => {
  const d = buildCspDirectives(loadConfig({}));
  const all = Object.values(d).flat().join(' ');
  assert.doesNotMatch(all, /unsafe-inline|unsafe-eval|\*/);
  assert.doesNotMatch(all, /https?:/);
  assert.deepEqual(d['script-src'], ["'self'"]);
  assert.deepEqual(d['style-src'], ["'self'"]);
  assert.deepEqual(d['frame-ancestors'], ["'none'"]);
  assert.deepEqual(d['frame-src'], ["'none'"]);
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'self'"]);
});

test('Turnstile origins are added only when a site key is configured', () => {
  const off = buildCspDirectives(loadConfig({}));
  assert.equal(off['script-src'].includes('https://challenges.cloudflare.com'), false);
  const on = buildCspDirectives(loadConfig({ TURNSTILE_SITE_KEY: '0x4AAA' }));
  assert.ok(on['script-src'].includes('https://challenges.cloudflare.com'));
  assert.deepEqual(on['frame-src'], ['https://challenges.cloudflare.com']);
});

test('PostHog origins are added only when PostHog is configured, and only the hosts it needs', () => {
  const off = buildCspDirectives(loadConfig({}));
  assert.deepEqual(off['connect-src'], ["'self'"]);
  const on = buildCspDirectives(loadConfig({ POSTHOG_API_KEY: 'phc_x' }));
  assert.ok(on['script-src'].includes('https://us-assets.i.posthog.com'));
  assert.deepEqual(on['connect-src'], [
    "'self'",
    'https://us.i.posthog.com',
    'https://us-assets.i.posthog.com',
  ]);
  assert.equal(on['script-src'].includes('https://us.i.posthog.com'), false);
});

test('production upgrades insecure requests; development does not', () => {
  assert.ok(
    'upgrade-insecure-requests' in
      buildCspDirectives(
        loadConfig({
          NODE_ENV: 'production',
          APP_SECRET: 'test-secret-test-secret-test-secret-123',
        }),
      ),
  );
  assert.equal('upgrade-insecure-requests' in buildCspDirectives(loadConfig({})), false);
});

test("Clerk's frontend API host is allowed for scripts and connections only when sign-in is configured", () => {
  const off = buildCspDirectives(loadConfig({}));
  assert.doesNotMatch(off['script-src'].join(' '), /clerk/);
  const on = buildCspDirectives({ auth: { frontendApi: 'x.clerk.accounts.dev' } });
  assert.ok(on['script-src'].includes('https://x.clerk.accounts.dev'));
  assert.ok(on['connect-src'].includes('https://x.clerk.accounts.dev'));
  assert.equal(on['frame-src'].join(' '), "'none'");
});

test("forms may be answered by a redirect to Google's consent page only when Google OAuth is configured", () => {
  assert.deepEqual(buildCspDirectives(loadConfig({}))['form-action'], ["'self'"]);
  const on = buildCspDirectives({ google: { clientId: 'x', clientSecret: 'y' } });
  assert.deepEqual(on['form-action'], ["'self'", 'https://accounts.google.com']);
});

test("workers may start from blob: URLs only when sign-in is configured (Clerk's token timer)", () => {
  assert.equal('worker-src' in buildCspDirectives(loadConfig({})), false);
  const on = buildCspDirectives({ auth: { frontendApi: 'x.clerk.accounts.dev' } });
  assert.deepEqual(on['worker-src'], ["'self'", 'blob:']);
  assert.doesNotMatch(on['script-src'].join(' '), /blob:/);
});
