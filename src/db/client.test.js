import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDatabaseUrl } from './client.js';

test('a plain mysql URL becomes connection settings', () => {
  assert.deepEqual(
    parseDatabaseUrl('mysql://aeo_app:p%40ss%2Fw0rd@db.example.test:25060/aeo_corner'),
    {
      host: 'db.example.test',
      port: 25060,
      user: 'aeo_app',
      password: 'p@ss/w0rd',
      database: 'aeo_corner',
    },
  );
});

test('the port defaults to 3306 and TLS stays off without ssl-mode', () => {
  const s = parseDatabaseUrl('mysql://root:x@127.0.0.1/aeo_corner_dev');
  assert.equal(s.port, 3306);
  assert.equal(s.ssl, undefined);
});

test('ssl-mode=REQUIRED (DigitalOcean) turns on verified TLS', () => {
  const s = parseDatabaseUrl('mysql://u:p@h.example.test:25060/db?ssl-mode=REQUIRED');
  assert.deepEqual(s.ssl, { rejectUnauthorized: true });
});

test('other schemes are refused', () => {
  assert.throws(() => parseDatabaseUrl('postgres://u:p@h/db'), /mysql:\/\//);
});
