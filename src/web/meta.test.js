import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.js';
import { buildMeta, normalizePath } from './meta.js';

test('normalizePath gives one canonical form per page', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');
  assert.equal(normalizePath('/methodology/'), '/methodology');
  assert.equal(normalizePath('/methodology?utm_source=x'), '/methodology');
  assert.equal(normalizePath('/privacy#subprocessors'), '/privacy');
  assert.equal(normalizePath('terms'), '/terms');
});

test('canonical URLs use the configured base URL, not the request host', () => {
  const config = loadConfig({ APP_BASE_URL: 'https://aeocorner.com' });
  assert.equal(
    buildMeta({ config, path: '/methodology/' }).canonical,
    'https://aeocorner.com/methodology',
  );
  assert.equal(
    buildMeta({ config, path: '/anything', meta: { path: '/' } }).canonical,
    'https://aeocorner.com/',
  );
});

test('production is indexable; staging and development are noindex; a page can opt out', () => {
  const prod = loadConfig({
    NODE_ENV: 'production',
    APP_ENV: 'production',
    APP_SECRET: 'test-secret-test-secret-test-secret-123',
  });
  assert.match(buildMeta({ config: prod, path: '/' }).robots, /^index, follow/);
  assert.equal(
    buildMeta({ config: prod, path: '/', meta: { noindex: true } }).robots,
    'noindex, nofollow',
  );
  for (const env of [
    {
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      APP_SECRET: 'test-secret-test-secret-test-secret-123',
    },
    {},
  ]) {
    assert.equal(buildMeta({ config: loadConfig(env), path: '/' }).robots, 'noindex, nofollow');
  }
});

test('every page carries Organization and WebSite JSON-LD, plus its own', () => {
  const config = loadConfig({});
  const { jsonLd } = buildMeta({ config, path: '/', meta: { jsonLd: [{ '@type': 'FAQPage' }] } });
  assert.deepEqual(
    jsonLd.map((j) => j['@type']),
    ['Organization', 'WebSite', 'FAQPage'],
  );
});
