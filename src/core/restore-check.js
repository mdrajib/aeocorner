/**
 * The rules behind the database restore drill (docs/RUNBOOK_RESTORE_DRILL.md). Pure: the reading of the two databases is
 * `src/db/restore-check.js`; this decides what the numbers mean.
 *
 * A restored copy is of an EARLIER moment than the live database, so it is normal for it to hold fewer rows than the
 * live one. What is not normal is a table that is gone, a migration the code does not know, or a structural guard rail
 * (`docs/db/checks.sql`) that fails. Everything else is a warning a person reads.
 */

/** How one table compares: `same`, `behind` (fewer rows, expected), `ahead` (more rows: rows deleted since), and the bad ones. */
export function compareTables(live, restored) {
  const names = [...new Set([...Object.keys(live), ...Object.keys(restored)])].sort();
  return names.map((table) => {
    const inLive = table in live;
    const inRestored = table in restored;
    if (inLive && !inRestored) {
      return {
        table,
        live: live[table],
        restored: null,
        status: 'missing',
        note: 'The table is not in the restored copy.',
      };
    }
    if (!inLive) {
      return {
        table,
        live: null,
        restored: restored[table],
        status: 'extra',
        note: 'Only the restored copy has this table: a different version of the schema.',
      };
    }
    const l = live[table];
    const r = restored[table];
    if (r === l) return { table, live: l, restored: r, status: 'same', note: '' };
    if (r === 0 && l > 0) {
      return {
        table,
        live: l,
        restored: r,
        status: 'empty',
        note: 'Empty in the copy but not live: right only if the table was first written after the restore point.',
      };
    }
    return r < l
      ? {
          table,
          live: l,
          restored: r,
          status: 'behind',
          note: 'Fewer rows, as expected for an earlier moment.',
        }
      : {
          table,
          live: l,
          restored: r,
          status: 'ahead',
          note: 'More rows than live: rows were deleted since the restore point (a purge, a retention sweep).',
        };
  });
}

/** The migrations of the code against those the restored copy has finished. */
export function compareMigrations(inCode, inRestored) {
  const code = new Set(inCode);
  const have = new Set(inRestored);
  return {
    // Not applied in the copy: it is older than the code, and `prisma migrate deploy` would bring it up.
    notApplied: [...code].filter((m) => !have.has(m)).sort(),
    // Applied in the copy but unknown to the code: the code is older than the data, or this is another database.
    unknown: [...have].filter((m) => !code.has(m)).sort(),
  };
}

/** Seconds between the moment the restore was asked to go back to and the newest row found (never negative). */
export function gapSeconds(restorePoint, newest) {
  if (!restorePoint || !newest) return null;
  return Math.max(0, Math.round((restorePoint.getTime() - newest.getTime()) / 1000));
}

/**
 * The verdict. Failures: a missing table, a migration the code does not know, a guard-rail row, or a database that
 * could not be read. Warnings: everything else a person should read before trusting the copy.
 */
export function verdict({ tables, migrations, checkRows }) {
  const failures = [];
  const warnings = [];
  for (const t of tables) {
    if (t.status === 'missing')
      failures.push(`Table ${t.table} is missing from the restored copy.`);
    if (t.status === 'extra') warnings.push(`Table ${t.table} exists only in the restored copy.`);
    if (t.status === 'empty')
      warnings.push(`Table ${t.table} is empty in the copy but has ${t.live} rows live.`);
  }
  if (migrations.unknown.length) {
    failures.push(
      `The copy has migrations this code does not know: ${migrations.unknown.join(', ')}.`,
    );
  }
  if (migrations.notApplied.length) {
    warnings.push(
      `The copy has not applied: ${migrations.notApplied.join(', ')}. Run prisma migrate deploy on it before pointing the app at it.`,
    );
  }
  for (const row of checkRows) {
    failures.push(`Guard rail failed: ${Object.values(row).join(' ')}`);
  }
  return { ok: failures.length === 0, failures, warnings };
}

/** The report a person reads. `live` is optional: without it only the copy itself is judged. */
export function renderReport({
  database,
  tables,
  newest,
  migrations,
  checkRows,
  verdict: v,
  restorePoint,
}) {
  const lines = [`Restored copy: ${database}`, ''];
  const count = (n) => (n === null ? '-' : String(n));
  lines.push('Tables (rows live / rows in the copy):');
  for (const t of tables) {
    lines.push(
      `  ${t.status.padEnd(7)} ${t.table.padEnd(34)} ${count(t.live).padStart(9)} / ${count(t.restored).padStart(9)}`,
    );
  }
  lines.push('', 'Newest rows in the copy:');
  for (const [table, at] of Object.entries(newest)) {
    const gap = gapSeconds(restorePoint, at);
    lines.push(
      `  ${table.padEnd(22)} ${at ? at.toISOString() : 'none'}${gap === null ? '' : `   (${gap} s before the restore point)`}`,
    );
  }
  lines.push(
    '',
    `Migrations: ${migrations.notApplied.length} not applied, ${migrations.unknown.length} unknown to this code.`,
    `Guard rails (docs/db/checks.sql): ${checkRows.length} failing row${checkRows.length === 1 ? '' : 's'}.`,
    '',
  );
  for (const f of v.failures) lines.push(`FAIL  ${f}`);
  for (const w of v.warnings) lines.push(`warn  ${w}`);
  lines.push(
    v.ok
      ? 'RESULT: the copy passes. Now read the warnings and the runbook’s manual checks.'
      : 'RESULT: the copy FAILS.',
  );
  return lines.join('\n');
}
