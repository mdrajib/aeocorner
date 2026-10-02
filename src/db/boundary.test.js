import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ESLint } from 'eslint';

/**
 * The rule "prisma.* and raw SQL only inside src/db" is enforced by ESLint (eslint.config.js). These tests
 * feed the linter code that breaks the rule and code that follows it, so the rule can't silently stop working.
 */
const eslint = new ESLint({ cwd: process.cwd() });

async function problems(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.severity === 2).map((m) => `${m.ruleId}: ${m.message}`);
}

describe('database boundary lint rule', () => {
  const outside = 'src/web/routes/example.js';

  test('importing Prisma outside src/db is an error', async () => {
    assert.equal(
      (
        await problems(
          "import { PrismaClient } from '@prisma/client';\nvoid PrismaClient;",
          outside,
        )
      ).length,
      1,
    );
    assert.equal(
      (await problems("import { x } from '../../db/generated/client/client.ts';\nvoid x;", outside))
        .length,
      1,
    );
    assert.equal(
      (await problems("import { x } from '../../db/repos/users.js';\nvoid x;", outside)).length,
      1,
    );
  });

  test('raw SQL and transactions outside src/db are errors', async () => {
    for (const call of [
      'db.$queryRaw`SELECT 1`',
      'db.$executeRaw`DELETE FROM users`',
      "db.$queryRawUnsafe('SELECT 1')",
      'db.$transaction(() => {})',
    ]) {
      const found = await problems(`export const f = (db) => ${call};`, outside);
      assert.equal(found.length, 1, call);
      assert.match(found[0], /no-restricted-syntax/);
    }
  });

  test('reaching for the private Prisma client is an error', async () => {
    assert.equal((await problems('export const f = (db) => db._prisma;', outside)).length, 1);
  });

  test('the same code is fine inside src/db', async () => {
    const code =
      "import { PrismaClient } from './generated/client/client.ts';\nexport const f = (db) => db.$queryRaw`SELECT 1`;\nvoid PrismaClient;";
    assert.deepEqual(await problems(code, 'src/db/repos/example.js'), []);
  });

  test('using the repositories from the public entry point is fine everywhere', async () => {
    const code =
      "import { createDb } from '../../db/index.js';\nexport const f = () => createDb({});";
    assert.deepEqual(await problems(code, outside), []);
  });

  test('tests are not exempt', async () => {
    assert.equal(
      (await problems('export const f = (db) => db._prisma;', 'tests/integration/x.test.js'))
        .length,
      1,
    );
  });
});
