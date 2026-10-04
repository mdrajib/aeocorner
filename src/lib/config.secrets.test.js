import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';

const key = () => randomBytes(32).toString('base64');
const prod = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40) };

test('development gets a fixed key so the screens work on a laptop; production without one has none', () => {
  assert.equal(loadConfig({ NODE_ENV: 'development' }).secrets.current.key.length, 32);
  assert.equal(loadConfig(prod).secrets, null);
});

test('a configured key is parsed, versioned, and the previous key is one version older', () => {
  const cfg = loadConfig({
    ...prod,
    SECRETS_MASTER_KEY: key(),
    SECRETS_MASTER_KEY_VERSION: '3',
    SECRETS_MASTER_KEY_PREVIOUS: key(),
  });
  assert.equal(cfg.secrets.current.version, 3);
  assert.deepEqual(
    cfg.secrets.previous.map((k) => k.version),
    [2],
  );
  assert.equal(loadConfig({ ...prod, SECRETS_MASTER_KEY: key() }).secrets.previous.length, 0);
});

test('a bad key or a previous key with no older version is refused', () => {
  assert.throws(
    () => loadConfig({ ...prod, SECRETS_MASTER_KEY: randomBytes(30).toString('base64') }),
    /32 bytes/,
  );
  assert.throws(
    () => loadConfig({ ...prod, SECRETS_MASTER_KEY: key(), SECRETS_MASTER_KEY_PREVIOUS: key() }),
    /VERSION of 2 or more/,
  );
});
