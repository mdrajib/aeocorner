import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from './config.js';

const full = {
  DO_SPACES_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
  DO_SPACES_BUCKET: 'aeo-corner-raw',
  DO_SPACES_KEY: 'DO00KEY',
  DO_SPACES_SECRET: 'secret-value',
};
const secret = 'x'.repeat(40);

test('no DO_SPACES_* values means no object storage (development writes to local disk)', () => {
  assert.equal(loadConfig({}).spaces, null);
});

test('endpoint, bucket, key and secret give a store; the region and folder are worked out', () => {
  const c = loadConfig(full);
  assert.deepEqual(c.spaces, {
    endpoint: 'https://fra1.digitaloceanspaces.com',
    region: 'fra1',
    bucket: 'aeo-corner-raw',
    accessKeyId: 'DO00KEY',
    secretAccessKey: 'secret-value',
    prefix: 'aeo-corner/dev/',
  });
});

test('the folder follows the environment so staging and production can share a bucket', () => {
  assert.equal(
    loadConfig({ ...full, APP_ENV: 'staging', NODE_ENV: 'production', APP_SECRET: secret }).spaces
      .prefix,
    'aeo-corner/staging/',
  );
  assert.equal(
    loadConfig({ ...full, NODE_ENV: 'production', APP_SECRET: secret }).spaces.prefix,
    'aeo-corner/prod/',
  );
});

test('region and folder can be set explicitly', () => {
  const c = loadConfig({ ...full, DO_SPACES_REGION: 'nyc3', DO_SPACES_PREFIX: 'tenant-a/raw/' });
  assert.equal(c.spaces.region, 'nyc3');
  assert.equal(c.spaces.prefix, 'tenant-a/raw/');
});

test('a partial set is an error that names what is missing, never a silent fallback to disk', () => {
  assert.throws(
    () => loadConfig({ DO_SPACES_ENDPOINT: full.DO_SPACES_ENDPOINT }),
    /DO_SPACES_BUCKET, DO_SPACES_KEY, DO_SPACES_SECRET/,
  );
  assert.throws(() => loadConfig({ ...full, DO_SPACES_SECRET: undefined }), /DO_SPACES_SECRET/);
});

test('empty values count as not set', () => {
  assert.equal(
    loadConfig({
      DO_SPACES_ENDPOINT: '',
      DO_SPACES_BUCKET: '',
      DO_SPACES_KEY: '',
      DO_SPACES_SECRET: '',
    }).spaces,
    null,
  );
});

test('bad values are rejected', () => {
  assert.throws(() => loadConfig({ ...full, DO_SPACES_BUCKET: 'Has Spaces' }));
  assert.throws(() => loadConfig({ ...full, DO_SPACES_ENDPOINT: 'not a url' }));
  assert.throws(() => loadConfig({ ...full, DO_SPACES_PREFIX: '../escape' }));
  assert.throws(() => loadConfig({ ...full, DO_SPACES_PREFIX: 'no-trailing-slash' }));
});

test('the address copied from the DigitalOcean dashboard (with the bucket name in front) works too', () => {
  const c = loadConfig({
    ...full,
    DO_SPACES_ENDPOINT: 'https://aeo-corner-raw.sgp1.digitaloceanspaces.com',
  });
  assert.equal(c.spaces.endpoint, 'https://sgp1.digitaloceanspaces.com');
  assert.equal(c.spaces.region, 'sgp1');
});
