import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import pino from 'pino';
import { addDays } from '../../src/core/entitlements.js';
import { WEBHOOK_PAYLOAD_DAYS, WEBHOOK_ROW_DAYS } from '../../src/core/org-purge.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { retentionSweep } from '../../src/worker/handlers/billing.js';

/**
 * What the purge of a closed organization does beyond deleting rows: delete its raw files from Spaces (never one that
 * another owner's rows still point at), delete the Clerk accounts of people who belong nowhere else, and empty old
 * webhook payloads. The bucket and Clerk are stand-ins that record what they were asked to delete.
 */

const db = connectTestDb();
const fx = fixtures(db);
after(async () => {
  await fx.cleanup();
  await db.close();
});

const purge = db.system.billing.retention;
const NOW = new Date();
const unique = () => Math.random().toString(36).slice(2, 10);
const silent = () => pino({ level: 'silent' });

/** An organization with one question and one collected answer whose raw file is at `rawUri`. */
async function withAnswer(rawUri) {
  const one = await fx.org();
  await addAnswer(one.org, rawUri);
  return one;
}

async function addAnswer(org, rawUri) {
  const project = await fx.project(org.id);
  await fx.engines(project);
  const prompt = await fx.prompt(project);
  const run = await fx.run(project, { status: 'complete' });
  await fx.collectedAnswer(run, prompt, { rawUri });
}

const close = (orgId) =>
  fx.setOrg(orgId, { deleted_at: addDays(NOW, -31), purge_after: addDays(NOW, -1) });

describe('retention.purge: the raw files in Spaces', () => {
  test('deletes the files only this organization points at, and keeps one another organization also points at', async () => {
    const shared = `test/purge/shared-${unique()}.json`;
    const mineOnly = `test/purge/mine-${unique()}.json`;
    const mine = await withAnswer(mineOnly);
    const theirs = await withAnswer(shared);
    // The closed organization points at the shared file too (a content-addressed key two owners can hold).
    await addAnswer(mine.org, shared);

    assert.deepEqual(await purge.filesToDelete(mine.org.id), [mineOnly]);

    const deleted = [];
    await close(mine.org.id);
    const removed = await purge.purge(mine.org.id, {
      now: NOW,
      erase: { files: async (keys) => void deleted.push(...keys) },
    });
    assert.ok(removed);
    assert.deepEqual(deleted, [mineOnly]);
    assert.equal(removed.spaces_files, 1);
    assert.equal(await fx.count('organizations', { id: mine.org.id }), 0);

    // Once the other owner is purged too, nobody points at the shared file any more.
    await close(theirs.org.id);
    const later = [];
    await purge.purge(theirs.org.id, {
      now: NOW,
      erase: { files: async (keys) => void later.push(...keys) },
    });
    assert.deepEqual(later, [shared]);
  });

  test('a hook that fails stops the purge before any row is deleted, and the next run finishes it', async () => {
    const one = await withAnswer(`test/purge/fails-${unique()}.json`);
    await close(one.org.id);
    await assert.rejects(
      purge.purge(one.org.id, {
        now: NOW,
        erase: {
          files: async () => {
            throw new Error('Spaces is down');
          },
        },
      }),
      /Spaces is down/,
    );
    assert.equal(await fx.count('projects', { org_id: one.org.id }), 1, 'nothing was deleted');
    assert.equal(await fx.count('organizations', { id: one.org.id }), 1);

    const done = await purge.purge(one.org.id, { now: NOW, erase: { files: async () => 1 } });
    assert.ok(done);
    assert.equal(await fx.count('organizations', { id: one.org.id }), 0);
  });
});

describe('retention.purge: the people', () => {
  test('hands over only the members who belong to no other organization', async () => {
    const one = await fx.org();
    const alone = await fx.member(one.org, 'editor');
    const elsewhere = await fx.member(one.org, 'viewer');
    const other = await fx.org();
    await db.forOrg(other.org.id).memberships.add({ userId: elsewhere.user.id, role: 'viewer' });

    await close(one.org.id);
    let handed = [];
    const removed = await purge.purge(one.org.id, {
      now: NOW,
      erase: {
        users: async (members) => {
          handed = members;
        },
      },
    });
    assert.ok(removed);
    assert.deepEqual(
      handed.map((m) => m.clerkUserId).sort(),
      [one.owner.clerk_user_id, alone.user.clerk_user_id].sort(),
      'the owner and the editor, not the person who is also in another organization',
    );
  });

  test('the sweep deletes the Clerk accounts, anonymizes the people here, and keeps files outside this app’s prefix', async () => {
    const mineKey = `test/purge/own-${unique()}.json`;
    const strangerKey = `elsewhere/purge/${unique()}.json`;
    const one = await withAnswer(mineKey);
    await addAnswer(one.org, strangerKey);
    await close(one.org.id);

    const clerkDeleted = [];
    const fileDeleted = [];
    const result = await retentionSweep({
      db,
      logger: silent(),
      now: () => NOW,
      mail: null,
      retention: {
        store: { prefix: 'test/', delete: async (key) => void fileDeleted.push(key) },
        clerk: { configured: true, deleteUser: async (id) => void clerkDeleted.push(id) },
      },
    });
    assert.ok(result.purged >= 1);
    assert.deepEqual(
      fileDeleted.filter((k) => k === mineKey || k === strangerKey),
      [mineKey],
      'a key outside the app’s prefix is never deleted',
    );
    assert.ok(clerkDeleted.includes(one.owner.clerk_user_id));
    assert.equal(
      await fx.count('users', { id: one.owner.id, deleted_at: { not: null } }),
      1,
      'the local copy is anonymized',
    );
  });

  test('without Clerk keys or a storage prefix the rows are still purged, and the sweep says what it skipped', async () => {
    const one = await withAnswer(`test/purge/none-${unique()}.json`);
    await close(one.org.id);
    const warnings = [];
    const logger = silent();
    logger.warn = (...args) => void warnings.push(String(args.at(-1)));
    await retentionSweep({
      db,
      logger,
      now: () => NOW,
      mail: null,
      retention: { store: { delete: async () => {} }, clerk: { configured: false } },
    });
    assert.equal(await fx.count('organizations', { id: one.org.id }), 0);
    assert.ok(warnings.some((w) => /no storage prefix/.test(w)));
    assert.ok(warnings.some((w) => /Clerk is not configured/.test(w)));
    assert.equal(await fx.count('users', { id: one.owner.id, deleted_at: { not: null } }), 0);
  });
});

describe('webhook payloads', () => {
  test(`are emptied after ${WEBHOOK_PAYLOAD_DAYS} days, and the row stays so a repeat is still recognised`, async () => {
    const old = await fx.webhookWithPayload(addDays(NOW, -(WEBHOOK_PAYLOAD_DAYS + 1)));
    const fresh = await fx.webhookWithPayload(addDays(NOW, -(WEBHOOK_PAYLOAD_DAYS - 1)));
    const result = await retentionSweep({ db, logger: silent(), now: () => NOW, mail: null });
    assert.ok(result.payloadsEmptied >= 1);

    const again = await db.webhookEvents.receive({
      source: 'clerk',
      externalId: old.external_id,
      eventType: 'user.updated',
      payload: {},
    });
    assert.equal(again.duplicate, true, 'the delivery is still on record');
    assert.equal(again.event.payload, null, 'the old payload is gone');

    const kept = await db.webhookEvents.receive({
      source: 'clerk',
      externalId: fresh.external_id,
      eventType: 'user.updated',
      payload: {},
    });
    assert.ok(kept.event.payload, 'a recent payload is kept');
  });

  test(`the row itself goes after ${WEBHOOK_ROW_DAYS} days`, async () => {
    const ancient = await fx.webhookWithPayload(addDays(NOW, -(WEBHOOK_ROW_DAYS + 1)));
    const result = await retentionSweep({ db, logger: silent(), now: () => NOW, mail: null });
    assert.ok(result.webhooksDeleted >= 1);
    const again = await db.webhookEvents.receive({
      source: 'clerk',
      externalId: ancient.external_id,
      eventType: 'user.updated',
      payload: {},
    });
    assert.equal(again.duplicate, false, 'nothing is on record any more');
  });
});
