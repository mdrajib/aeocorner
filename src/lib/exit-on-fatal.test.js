import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const MODULE = new URL('./exit-on-fatal.js', import.meta.url).href;
const run = (code) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    timeout: 15_000,
  });

test('an unhandled rejection after the import ends the process with code 1', () => {
  const r = run(
    `import ${JSON.stringify(MODULE)}; Promise.reject(new Error('bad config')); setTimeout(() => {}, 5000);`,
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"level":"fatal"/);
  assert.match(r.stderr, /bad config/);
});

test('an uncaught exception ends the process with code 1', () => {
  const r = run(
    `import ${JSON.stringify(MODULE)}; setTimeout(() => { throw new Error('boom'); }, 10);`,
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /boom/);
});

test('a rejection that is thrown by start-up code itself (top-level await) also exits', () => {
  const r = run(`import ${JSON.stringify(MODULE)}; await Promise.reject(new Error('start-up'));`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /start-up/);
});

test('the real server entry exits (not hangs) when production config is wrong', () => {
  const r = spawnSync(process.execPath, ['src/web/server.js'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      APP_ENV: 'production',
      APP_SECRET: 'x'.repeat(40),
      APP_BASE_URL: 'https://example.test',
      CLERK_STAFF_PUBLISHABLE_KEY: `pk_test_${Buffer.from('staff.clerk.accounts.dev$').toString('base64')}`,
      CLERK_STAFF_SECRET_KEY: 'sk_test_not_real',
    },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /production Clerk instance/);
});
