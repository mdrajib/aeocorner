import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { compareMigrations, compareTables, verdict } from '../../src/core/restore-check.js';
import { inspectDatabase, migrationsInCode } from '../../src/db/restore-check.js';

/**
 * The restore drill's checker (docs/RUNBOOK_RESTORE_DRILL.md) against the real test database, standing in for a restored
 * copy: a database that is fully migrated and clean must pass, and the script must refuse to treat the live database
 * (DATABASE_URL) as the copy.
 */

const url = process.env.TEST_DATABASE_URL;
if (!new URL(url).pathname.slice(1).endsWith('_test'))
  throw new Error('This test reads only a database named *_test.');

describe('inspecting a migrated database', () => {
  test('finds its tables and rows, every migration of the code, and no failing guard rail', async () => {
    const copy = await inspectDatabase(url);
    assert.ok(copy.tables.organizations !== undefined, 'a table every install has');
    assert.ok(copy.tables._prisma_migrations >= 13);
    assert.deepEqual(compareMigrations(migrationsInCode(), copy.migrations), {
      notApplied: [],
      unknown: [],
    });
    assert.deepEqual(copy.checkRows, [], 'docs/db/checks.sql returns nothing');
    assert.ok('usage_ledger' in copy.newest);
  });

  test('compared with itself it passes, and with a table taken away it fails', async () => {
    const copy = await inspectDatabase(url);
    const same = verdict({
      tables: compareTables(copy.tables, copy.tables),
      migrations: compareMigrations(migrationsInCode(), copy.migrations),
      checkRows: copy.checkRows,
    });
    assert.equal(same.ok, true, same.failures.join('; '));

    const without = Object.fromEntries(
      Object.entries(copy.tables).filter(([name]) => name !== 'organizations'),
    );
    const broken = verdict({
      tables: compareTables(copy.tables, without),
      migrations: compareMigrations(migrationsInCode(), copy.migrations),
      checkRows: [],
    });
    assert.equal(broken.ok, false);
  });
});

describe('the script', () => {
  const run = (args, env = {}) =>
    spawnSync(process.execPath, ['scripts/restore-check.js', ...args], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url, ...env },
    });

  test('refuses to look at the live database as if it were the copy, without printing its password', () => {
    const result = run(['--restored', url]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /same database as DATABASE_URL/);
    const password = new URL(url).password;
    if (password) {
      assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password));
    }
  });

  test('needs an address for the copy, and a valid restore point', () => {
    assert.equal(run([], { RESTORE_DATABASE_URL: '' }).status, 1);
    const other = url.replace(/\/[^/?]+(\?|$)/, '/other_db$1');
    const result = run(['--restored', other, '--restore-point', 'nope']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /restore-point/);
  });
});
