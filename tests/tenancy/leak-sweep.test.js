import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import { connectTestDb, tablesWithOrgId } from '../../src/db/testing.js';

/**
 * The automated leak sweep (Milestone 10, task 10.01). The hand-written suites in this directory prove that the
 * functions we thought of don't leak. This one asks the schema which tables hold tenant data (every table with an
 * `org_id` column) and reads every query in the organization-scoped repositories: a query on such a table that
 * doesn't name `org_id` is a possible leak, and a tenant table that no repository reaches is a table nobody
 * has thought about. A new table or a new query is checked without anyone remembering to add a test.
 */

const db = connectTestDb();
after(() => db.close());

const REPO_DIR = new URL('../../src/db/repos/', import.meta.url);
const files = readdirSync(REPO_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
const read = (f) => readFileSync(new URL(f, REPO_DIR), 'utf8');

/** Files that answer for one organization: `forOrg(orgId)` binds the organization, so every query must name it. */
const SCOPED = files.filter((f) => f.startsWith('org-'));

/**
 * Queries that may touch a tenant table without `org_id` in the same statement, each with the reason. Every entry
 * is a reviewed decision; the list is meant to stay short.
 */
const REVIEWED = {};

/**
 * Tenant tables no code reads or writes yet, each for a feature that isn't built. The day one of them gets a
 * query, it goes in an `org-*.js` repository, the sweep checks it, and the table leaves this list (the test below
 * fails if it stays on it).
 */
const NOT_BUILT = {
  impersonation_sessions: 'read-only impersonation in the staff console',
  org_notes: 'staff notes on a customer',
};

/** The text of a balanced `( … )` starting at the opening parenthesis, skipping quoted strings. */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) i += src[i] === BACKSLASH ? 2 : 1;
    } else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Every Prisma model call on a tenant table: `tx.projects.findMany({ … })`. */
function modelCalls(src, tables) {
  const found = [];
  const re = /\b(?:tx|prisma|db|client)\.(\w+)\.(\w+)\(/g;
  for (const m of src.matchAll(re)) {
    if (!tables.has(m[1])) continue;
    const open = m.index + m[0].length - 1;
    found.push({
      table: m[1],
      method: m[2],
      text: balanced(src, open),
      line: lineOf(src, m.index),
    });
  }
  return found;
}

/** The text of one statement from `from` up to its `;` at depth 0, skipping quoted strings. */
function statementAt(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i += 1;
      while (i < src.length && src[i] !== q) i += src[i] === BACKSLASH ? 2 : 1;
    } else if ('({['.includes(c)) depth += 1;
    else if (')}]'.includes(c)) depth -= 1;
    else if (c === ';' && depth <= 0) return src.slice(from, i);
  }
  return src.slice(from);
}

/**
 * Does the call name `org_id`: in its own text, or in the definition of the variable it uses as its filter
 * (`{ where }`, `where: base`, `...scope`, `where: where(projectId)`) or, for a create, as its data? The definition
 * must come before the call, and only its own statement counts.
 */
function namesOrg(src, call) {
  if (/\borg_id\b/.test(call.text)) return true;
  const before = src
    .split(NEWLINE)
    .slice(0, call.line - 1)
    .join(NEWLINE);
  const key = call.method.startsWith('create') ? 'data' : 'where';
  const names = new Set();
  const re = new RegExp(String.raw`\b${key}\s*(?::\s*(\w+)|[,}])|\.\.\.(\w+)`, 'g');
  for (const m of call.text.matchAll(re)) names.add(m[1] ?? m[2] ?? key);
  for (const name of names) {
    const defs = [...before.matchAll(new RegExp(String.raw`(?:const|let)\s+${name}\b\s*=`, 'g'))];
    const last = defs.at(-1);
    if (last && /\borg_id\b/.test(statementAt(before, last.index))) return true;
  }
  return false;
}

/** Every raw SQL template and the tenant tables it names. */
function sqlStatements(src, tables) {
  const found = [];
  const re = /\$(?:queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)\s*`/g;
  for (const m of src.matchAll(re)) {
    const start = m.index + m[0].length;
    let end = start;
    while (end < src.length && src[end] !== '`') end += src[end] === BACKSLASH ? 2 : 1;
    const text = src.slice(start, end);
    const refs = [];
    for (const r of text.matchAll(
      /\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_]+)(?:\s+(?:AS\s+)?(?!(?:WHERE|SET|ON|JOIN|LEFT|RIGHT|INNER|GROUP|ORDER|LIMIT|VALUES|USING|SELECT|FOR|AS|CROSS|STRAIGHT_JOIN|UNION)\b)([a-z_][a-z0-9_]*))?/gi,
    )) {
      if (tables.has(r[1])) refs.push({ table: r[1], alias: r[2] ?? r[1] });
    }
    if (refs.length > 0) found.push({ text, refs, line: lineOf(src, m.index) });
  }
  return found;
}

describe('leak sweep: every query on tenant data names the organization', async () => {
  const tableNames = await tablesWithOrgId(db);
  const tables = new Set(tableNames);

  test('the schema has tenant tables to sweep', () => {
    assert.ok(tables.size > 40, `only ${tables.size} tables with org_id were found`);
    for (const t of ['projects', 'answer_snapshots', 'recommendations', 'content_items']) {
      assert.ok(tables.has(t), `${t} should carry org_id`);
    }
  });

  for (const file of SCOPED) {
    test(`${file}: Prisma calls on tenant tables carry org_id`, () => {
      const src = read(file);
      const bad = modelCalls(src, tables)
        .filter((c) => !namesOrg(src, c))
        .filter((c) => !REVIEWED[`${file}:${c.table}.${c.method}@${c.line}`])
        .map((c) => `${file}:${c.line} ${c.table}.${c.method}()`);
      assert.deepEqual(bad, [], `queries on tenant tables without org_id:\n  ${bad.join('\n  ')}`);
    });

    test(`${file}: raw SQL names org_id for every tenant table it reads or writes`, () => {
      const src = read(file);
      const bad = [];
      for (const s of sqlStatements(src, tables)) {
        for (const ref of s.refs) {
          const qualified = new RegExp(String.raw`\b${ref.alias}\.org_id\b`).test(s.text);
          const single =
            new Set(s.refs.map((r) => r.table)).size === 1 && /\borg_id\b/.test(s.text);
          if (!qualified && !single && !REVIEWED[`${file}:${ref.table}@${s.line}`]) {
            bad.push(`${file}:${s.line} ${ref.table} (as ${ref.alias})`);
          }
        }
      }
      assert.deepEqual(bad, [], `raw SQL on tenant tables without org_id:\n  ${bad.join('\n  ')}`);
    });
  }

  test('every tenant table is reached by a repository someone has reviewed', () => {
    const everything = files.map((f) => read(f)).join('\n');
    const reached = (t) =>
      new RegExp(String.raw`\.${t}\.\w+\(|\b(?:FROM|JOIN|UPDATE|INTO)\s+${t}\b`, 'i').test(
        everything,
      );
    const unreached = tableNames.filter((t) => !reached(t) && !NOT_BUILT[t]);
    assert.deepEqual(
      unreached,
      [],
      `tenant tables no repository reads or writes: ${unreached.join(', ')}`,
    );
    const stale = Object.keys(NOT_BUILT).filter((t) => tables.has(t) && reached(t));
    assert.deepEqual(stale, [], `now in use, remove from NOT_BUILT: ${stale.join(', ')}`);
  });

  test('the sweep itself can see a leak (a query without org_id is reported)', () => {
    const sample = 'const x = await tx.projects.findMany({ where: { id } });';
    const calls = modelCalls(sample, new Set(['projects']));
    assert.equal(calls.length, 1);
    assert.ok(!/\borg_id\b/.test(calls[0].text));
    const sql = sqlStatements(
      'prisma.$queryRaw`SELECT * FROM projects p WHERE p.id = 1`',
      new Set(['projects']),
    );
    assert.equal(sql.length, 1);
    assert.ok(!/\bp\.org_id\b/.test(sql[0].text));
  });
});
