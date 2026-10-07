import { readFileSync, readdirSync } from 'node:fs';
import mariadb from 'mariadb';
import { parseDatabaseUrl } from './client.js';

/**
 * Reads a database for the restore drill (docs/RUNBOOK_RESTORE_DRILL.md; the rules are src/core/restore-check.js).
 * READ ONLY: the session is switched to read-only before anything is asked, so a mistake in this file cannot change
 * a restored copy, and cannot change the live database either. Counts are exact (`COUNT(*)`), which is fine for a
 * drill that runs once a month and slow only on the largest fact tables.
 */

const SAFE_NAME = /^[A-Za-z0-9_]+$/;
// The column that says when a row was written, where it is not `created_at`.
const WRITTEN_AT = { webhook_events: 'received_at', usage_ledger: 'occurred_at' };
// Tables that are written to all the time: their newest row is how far back the copy really goes.
const NEWEST_OF = [
  'usage_ledger',
  'runs',
  'answer_snapshots',
  'audits',
  'org_activity_log',
  'webhook_events',
];

/** Where a database URL points, without the password: for messages, and to tell two databases apart. */
export function describeUrl(databaseUrl) {
  const { host, port, database } = parseDatabaseUrl(databaseUrl);
  return `${host}:${port}/${database}`;
}

/** The migrations the code carries: the folder names in `prisma/migrations`. */
export function migrationsInCode(dir = new URL('../../prisma/migrations/', import.meta.url)) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * @param {string} databaseUrl
 * @param {{ caCertPath?: string, checksSqlPath?: URL|string }} [options]
 * @returns {Promise<{ database: string, tables: Record<string, number>, newest: Record<string, Date|null>, migrations: string[], checkRows: object[] }>}
 */
export async function inspectDatabase(databaseUrl, { caCertPath, checksSqlPath } = {}) {
  const settings = parseDatabaseUrl(databaseUrl, { caCertPath });
  const conn = await mariadb.createConnection({
    ...settings,
    multipleStatements: true,
    timezone: 'Z',
    bigIntAsNumber: true,
    connectTimeout: 15_000,
  });
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.query('SET SESSION TRANSACTION READ ONLY');

    const names = (
      await conn.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
      )
    ).map((r) => String(r.name));
    for (const name of names)
      if (!SAFE_NAME.test(name)) throw new Error(`Unexpected table name: ${name}`);

    const tables = {};
    for (const name of names) {
      const [row] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
      tables[name] = Number(row.n);
    }

    const newest = {};
    for (const name of NEWEST_OF) {
      if (!(name in tables)) continue;
      const column = WRITTEN_AT[name] ?? 'created_at';
      const has = await conn.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [name, column],
      );
      if (has.length === 0) continue;
      const [row] = await conn.query(`SELECT MAX(\`${column}\`) AS at FROM \`${name}\``);
      newest[name] = row.at ? new Date(row.at) : null;
    }

    const migrations =
      '_prisma_migrations' in tables
        ? (
            await conn.query(
              'SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name',
            )
          ).map((r) => String(r.name))
        : [];

    // docs/db/checks.sql: every query must return zero rows. Each statement's rows are collected; an OK packet is not rows.
    const sql = readFileSync(
      checksSqlPath ?? new URL('../../docs/db/checks.sql', import.meta.url),
      'utf8',
    );
    const results = await conn.query(sql);
    const checkRows = (Array.isArray(results[0]) ? results : [results])
      .filter((r) => Array.isArray(r))
      .flat();

    return { database: describeUrl(databaseUrl), tables, newest, migrations, checkRows };
  } finally {
    await conn.end();
  }
}
