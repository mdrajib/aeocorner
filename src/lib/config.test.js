import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from './config.js';

test('defaults describe a local development environment', () => {
  const c = loadConfig({});
  assert.equal(c.nodeEnv, 'development');
  assert.equal(c.appEnv, 'development');
  assert.equal(c.isProduction, false);
  assert.equal(c.indexable, false);
  assert.equal(c.port, 3000);
  assert.equal(c.baseUrl, 'http://localhost:3000');
  assert.equal(c.maintenance, false);
  assert.equal(c.turnstileSiteKey, null);
  assert.equal(c.posthog, null);
});

test('only the production environment is indexable; staging runs NODE_ENV=production but is not', () => {
  assert.equal(loadConfig({ NODE_ENV: 'production' }).indexable, true);
  assert.equal(loadConfig({ NODE_ENV: 'production', APP_ENV: 'production' }).indexable, true);
  const staging = loadConfig({ NODE_ENV: 'production', APP_ENV: 'staging' });
  assert.equal(staging.isProduction, true);
  assert.equal(staging.appEnv, 'staging');
  assert.equal(staging.indexable, false);
});

test('empty strings in .env mean "not set"', () => {
  const c = loadConfig({
    TURNSTILE_SITE_KEY: '',
    POSTHOG_API_KEY: '',
    POSTHOG_HOST: '',
    APP_ENV: '',
  });
  assert.equal(c.turnstileSiteKey, null);
  assert.equal(c.posthog, null);
  assert.equal(c.appEnv, 'development');
});

test('the base URL loses its trailing slash', () => {
  assert.equal(
    loadConfig({ APP_BASE_URL: 'https://aeocorner.com/' }).baseUrl,
    'https://aeocorner.com',
  );
});

test('PostHog hosts: the assets host is derived from the ingestion host', () => {
  const us = loadConfig({ POSTHOG_API_KEY: 'phc_x' }).posthog;
  assert.deepEqual(us, {
    apiKey: 'phc_x',
    host: 'https://us.i.posthog.com',
    assetsHost: 'https://us-assets.i.posthog.com',
  });
  const eu = loadConfig({
    POSTHOG_API_KEY: 'phc_x',
    POSTHOG_HOST: 'https://eu.i.posthog.com',
  }).posthog;
  assert.equal(eu.assetsHost, 'https://eu-assets.i.posthog.com');
  const proxied = loadConfig({
    POSTHOG_API_KEY: 'phc_x',
    POSTHOG_HOST: 'https://ph.example.com',
    POSTHOG_ASSETS_HOST: 'https://ph-assets.example.com',
  }).posthog;
  assert.equal(proxied.host, 'https://ph.example.com');
  assert.equal(proxied.assetsHost, 'https://ph-assets.example.com');
});

test('MAINTENANCE_MODE parses string booleans', () => {
  assert.equal(loadConfig({ MAINTENANCE_MODE: 'true' }).maintenance, true);
  assert.equal(loadConfig({ MAINTENANCE_MODE: 'false' }).maintenance, false);
});

test('invalid values fail loudly instead of silently falling back', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'prod' }));
  assert.throws(() => loadConfig({ PORT: 'abc' }));
  assert.throws(() => loadConfig({ APP_BASE_URL: 'not a url' }));
});
