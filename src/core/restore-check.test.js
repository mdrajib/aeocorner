import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  compareMigrations,
  compareTables,
  gapSeconds,
  renderReport,
  verdict,
} from './restore-check.js';

const statusOf = (rows, table) => rows.find((r) => r.table === table).status;

describe('comparing the tables of a copy with the live database', () => {
  const rows = compareTables(
    { a: 10, b: 5, c: 8, d: 0, e: 3, gone: 2 },
    { a: 10, b: 4, c: 0, d: 0, e: 9, extra: 1 },
  );

  test('the same, fewer (expected) and more (rows deleted since) are told apart', () => {
    assert.equal(statusOf(rows, 'a'), 'same');
    assert.equal(statusOf(rows, 'b'), 'behind');
    assert.equal(statusOf(rows, 'e'), 'ahead');
    assert.equal(statusOf(rows, 'd'), 'same', 'empty on both sides is the same');
  });

  test('a table that is empty in the copy but not live is flagged, and a missing one is missing', () => {
    assert.equal(statusOf(rows, 'c'), 'empty');
    assert.equal(statusOf(rows, 'gone'), 'missing');
    assert.equal(statusOf(rows, 'extra'), 'extra');
  });
});

describe('comparing migrations', () => {
  test('one the copy has not applied is a warning for later; one the code does not know is a failure', () => {
    const m = compareMigrations(['0001', '0002', '0003'], ['0001', '0002', '0099']);
    assert.deepEqual(m.notApplied, ['0003']);
    assert.deepEqual(m.unknown, ['0099']);
  });
});

describe('how far behind the restore point the newest row is', () => {
  test('seconds, never negative, and unknown when either side is missing', () => {
    const point = new Date('2026-10-07T10:00:00Z');
    assert.equal(gapSeconds(point, new Date('2026-10-07T09:59:30Z')), 30);
    assert.equal(gapSeconds(point, new Date('2026-10-07T10:05:00Z')), 0);
    assert.equal(gapSeconds(null, point), null);
    assert.equal(gapSeconds(point, null), null);
  });
});

describe('the verdict', () => {
  const clean = {
    tables: compareTables({ a: 2 }, { a: 1 }),
    migrations: { notApplied: [], unknown: [] },
    checkRows: [],
  };

  test('a copy that is merely behind passes', () => {
    const v = verdict(clean);
    assert.equal(v.ok, true);
    assert.deepEqual(v.failures, []);
  });

  test('a missing table, an unknown migration or a guard-rail row fails it', () => {
    assert.equal(verdict({ ...clean, tables: compareTables({ a: 1 }, {}) }).ok, false);
    assert.equal(
      verdict({ ...clean, migrations: { notApplied: [], unknown: ['0099_x'] } }).ok,
      false,
    );
    const v = verdict({
      ...clean,
      checkRows: [{ failed_check: 'missing primary key', table_name: 't' }],
    });
    assert.equal(v.ok, false);
    assert.match(v.failures[0], /missing primary key/);
  });

  test('an empty table and an unapplied migration are warnings, not failures', () => {
    const v = verdict({
      tables: compareTables({ a: 5 }, { a: 0 }),
      migrations: { notApplied: ['0013_x'], unknown: [] },
      checkRows: [],
    });
    assert.equal(v.ok, true);
    assert.equal(v.warnings.length, 2);
    assert.match(v.warnings[1], /prisma migrate deploy/);
  });

  test('the report names the result and never prints a password', () => {
    const v = verdict(clean);
    const text = renderReport({
      database: 'host:25060/aeo_corner',
      tables: clean.tables,
      newest: { usage_ledger: new Date('2026-10-07T09:59:00Z'), runs: null },
      migrations: clean.migrations,
      checkRows: [],
      verdict: v,
      restorePoint: new Date('2026-10-07T10:00:00Z'),
    });
    assert.match(text, /RESULT: the copy passes/);
    assert.match(text, /60 s before the restore point/);
    assert.match(text, /runs\s+none/);
    assert.doesNotMatch(text, /password|doadmin/i);
  });
});
