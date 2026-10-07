#!/usr/bin/env node
import 'dotenv/config';
import {
  compareMigrations,
  compareTables,
  renderReport,
  verdict,
} from '../src/core/restore-check.js';
import { describeUrl, inspectDatabase, migrationsInCode } from '../src/db/restore-check.js';

/**
 * Judge a database restored from a backup (docs/RUNBOOK_RESTORE_DRILL.md). Read-only on both databases.
 *
 *   npm run restore:check -- --restored "mysql://doadmin:…@restored-host:25060/aeo_corner?ssl-mode=REQUIRED" \
 *       [--live] [--restore-point 2026-10-07T09:30:00Z] [--ca path/to/ca.pem]
 *
 * `--restored` (or RESTORE_DATABASE_URL) is the copy. `--live` compares it with DATABASE_URL, the running database: a
 * copy is older, so fewer rows is normal; a missing table or an unknown migration is not. `--restore-point` is the
 * moment the restore was asked to go back to; with it the report says how far behind it the newest rows are, which is
 * the data you would have lost. The copy must be a different database from DATABASE_URL: this refuses to look at the
 * live database as if it were the copy.
 */

const args = process.argv.slice(2);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const restoredUrl = valueOf('--restored') ?? process.env.RESTORE_DATABASE_URL;
const caCertPath = valueOf('--ca') ?? process.env.RESTORE_CA_CERT_PATH ?? undefined;
const point = valueOf('--restore-point');
const withLive = args.includes('--live');

if (!restoredUrl || args.includes('--help')) {
  console.log(
    'Usage: npm run restore:check -- --restored <mysql:// URL of the copy> [--live] [--restore-point <ISO time>] [--ca <file>]',
  );
  process.exit(args.includes('--help') ? 0 : 1);
}

const restorePoint = point ? new Date(point) : null;
if (restorePoint && Number.isNaN(restorePoint.getTime())) {
  console.error('--restore-point is not a valid ISO time.');
  process.exit(1);
}

let same;
try {
  same =
    process.env.DATABASE_URL && describeUrl(restoredUrl) === describeUrl(process.env.DATABASE_URL);
} catch (error) {
  console.error(`The restored database address is not usable: ${error.message}`);
  process.exit(1);
}
if (same) {
  console.error(
    'Refusing: the restored address is the same database as DATABASE_URL. The copy must be the new cluster the restore made.',
  );
  process.exit(1);
}

try {
  const copy = await inspectDatabase(restoredUrl, { caCertPath });
  const live = withLive ? await inspectDatabase(process.env.DATABASE_URL) : null;
  // Without --live the copy is compared with itself: every table is "same" and only the structure is judged.
  const tables = compareTables(live?.tables ?? copy.tables, copy.tables);
  const migrations = compareMigrations(migrationsInCode(), copy.migrations);
  const v = verdict({ tables, migrations, checkRows: copy.checkRows });
  console.log(
    renderReport({
      database: copy.database,
      tables,
      newest: copy.newest,
      migrations,
      checkRows: copy.checkRows,
      verdict: v,
      restorePoint,
    }),
  );
  process.exit(v.ok ? 0 : 1);
} catch (error) {
  console.error(`Could not read the database: ${error.message}`);
  process.exit(1);
}
