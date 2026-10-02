import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

const db = connectTestDb();
const fx = fixtures(db);
after(async () => {
  await fx.cleanup();
  await db.close();
});

const id = () => `msg_test_${Math.random().toString(36).slice(2)}`;

describe('webhook inbox', () => {
  test('a delivery is stored once; the same ID again is recognised as a duplicate', async () => {
    const externalId = id();
    const first = await db.webhookEvents.receive({
      source: 'clerk',
      externalId,
      eventType: 'user.created',
      payload: { a: 1 },
    });
    fx.trackWebhook(first.event.id);
    assert.equal(first.duplicate, false);

    const second = await db.webhookEvents.receive({
      source: 'clerk',
      externalId,
      eventType: 'user.created',
      payload: { a: 1 },
    });
    assert.equal(second.duplicate, true);
    assert.equal(second.event.id, first.event.id);
  });

  test('only one caller claims an unprocessed event; a processed event cannot be claimed again', async () => {
    const { event } = await db.webhookEvents.receive({
      source: 'clerk',
      externalId: id(),
      eventType: 'user.updated',
      payload: {},
    });
    fx.trackWebhook(event.id);

    assert.equal(await db.webhookEvents.begin(event.id), true);
    await db.webhookEvents.finish(event.id);
    assert.equal(await db.webhookEvents.begin(event.id), false);
    const row = await db.webhookEvents.find('clerk', event.external_id);
    assert.equal(row.status, 'processed');
    assert.equal(row.attempts, 1);
  });

  test('a failed event can be claimed again, and keeps its error', async () => {
    const { event } = await db.webhookEvents.receive({
      source: 'clerk',
      externalId: id(),
      eventType: 'user.updated',
      payload: {},
    });
    fx.trackWebhook(event.id);
    await db.webhookEvents.begin(event.id);
    await db.webhookEvents.fail(event.id, 'x'.repeat(5000));
    const failed = await db.webhookEvents.find('clerk', event.external_id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.length, 1000, 'long errors are cut to fit the column');

    assert.equal(await db.webhookEvents.begin(event.id), true);
    assert.equal((await db.webhookEvents.find('clerk', event.external_id)).attempts, 2);
  });
});

describe('staff accounts', () => {
  test('an invited staff member is bound to a Clerk user by a verified email, once', async () => {
    const staff = await fx.staff({ roles: ['support', 'reviewer'] });

    assert.equal(
      await db.staff.bindByVerifiedEmail({
        clerkUserId: 'staff_x',
        verifiedEmails: ['nobody@example.test'],
      }),
      null,
      'no invitation under that address',
    );

    const bound = await db.staff.bindByVerifiedEmail({
      clerkUserId: `staff_${staff.id}`,
      verifiedEmails: [staff.email.toUpperCase()],
    });
    assert.equal(bound.id, staff.id);
    assert.deepEqual([...bound.roles].sort(), ['reviewer', 'support']);
    assert.equal((await db.staff.findByClerkId(`staff_${staff.id}`)).id, staff.id);

    // A second Clerk account with the same verified email cannot take over the row.
    assert.equal(
      await db.staff.bindByVerifiedEmail({
        clerkUserId: 'someone_else',
        verifiedEmails: [staff.email],
      }),
      null,
    );
  });

  test('a suspended staff member cannot be bound', async () => {
    const staff = await fx.staff();
    await fx.suspendStaff(staff.id);
    assert.equal(
      await db.staff.bindByVerifiedEmail({ clerkUserId: 'c_1', verifiedEmails: [staff.email] }),
      null,
    );
  });

  test('inviting needs a role and a new address', async () => {
    const staff = await fx.staff();
    await assert.rejects(
      db.staff.invite({ email: 'x@example.test', name: 'X', roles: [] }),
      (e) => e instanceof DomainError && e.code === 'ROLE_REQUIRED',
    );
    await assert.rejects(
      db.staff.invite({ email: staff.email, name: 'Dup', roles: ['ops'] }),
      (e) => e instanceof DomainError && e.code === 'ALREADY_INVITED',
    );
  });
});
