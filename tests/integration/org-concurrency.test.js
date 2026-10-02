import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { isDeadlock } from '../../src/db/transaction.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/**
 * Many people creating organizations at the same moment, with the same name, so they all fight over the same
 * slug. InnoDB resolves such fights by abandoning one transaction as a deadlock; the repositories must retry it
 * (src/db/transaction.js) instead of failing the person's request. This used to fail now and then, and showed up
 * as an unrelated test breaking whenever the whole suite ran at once.
 */
const db = connectTestDb();
const fx = fixtures(db);

after(async () => {
  await fx.cleanup();
  await db.close();
});

describe('a deadlock the database really raises', () => {
  test('without a retry, one of two transactions that lock each other’s rows fails with the deadlock error', async () => {
    const { results, runs } = await fx.provokeDeadlock({ attempts: 1 });
    const failed = results.filter((r) => r.error);
    assert.equal(failed.length, 1, 'MySQL abandons exactly one');
    assert.ok(
      isDeadlock(failed[0].error),
      `recognised: ${failed[0].error.code} ${failed[0].error.message}`,
    );
    assert.deepEqual(runs, [1, 1]);
  });

  test('with the retry, both finish, and the abandoned one ran again', async () => {
    const { results, runs } = await fx.provokeDeadlock({ attempts: 4 });
    assert.deepEqual(
      results.map((r) => r.value),
      ['committed', 'committed'],
    );
    assert.equal(runs[0] + runs[1], 3, 'three runs in all: one of them was repeated');
  });
});

describe('creating organizations at the same moment', () => {
  test('every one succeeds, each with its own slug', async () => {
    const name = `Rush Hour ${Date.now()}`;
    for (let round = 0; round < 3; round += 1) {
      const users = await Promise.all(Array.from({ length: 12 }, () => fx.user()));
      const created = await Promise.all(
        users.map((user) => db.organizations.createWithOwner({ user, name })),
      );
      for (const { org } of created) fx.trackOrg(org.id);
      assert.equal(created.length, 12);
      assert.equal(new Set(created.map(({ org }) => org.slug)).size, 12, 'no two share a slug');
      for (const [i, { membership }] of created.entries()) {
        assert.equal(membership.user_id, users[i].id);
        assert.equal(membership.role, 'owner');
      }
    }
  });

  test('and several members joining one organization together all get in', async () => {
    const { org, scoped } = await fx.org();
    const people = await Promise.all(Array.from({ length: 10 }, () => fx.user()));
    const added = await Promise.all(
      people.map((user) => scoped.memberships.add({ userId: user.id, role: 'viewer' })),
    );
    assert.equal(added.length, 10);
    assert.equal((await scoped.memberships.list()).length, 11, 'the owner and the ten');
    assert.ok(org.id);
  });
});
