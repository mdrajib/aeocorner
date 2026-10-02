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

const rejects = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof DomainError && err.code === code);

describe('users copied from Clerk', () => {
  test('the first request creates the user; a second finds the same row', async () => {
    const clerkUser = fx.clerkUser({ name: 'Maya Chen', email: 'Maya@Example.TEST' });
    const first = await db.users.getOrCreateFromClerk(clerkUser);
    fx.trackUser(first.id);
    const second = await db.users.getOrCreateFromClerk(clerkUser);
    assert.equal(second.id, first.id);
    assert.equal(first.email, 'maya@example.test', 'emails are stored lowercase');
    assert.equal(first.name, 'Maya Chen');
  });

  test('the webhook and the first request racing never create two rows or throw', async () => {
    const clerkUser = fx.clerkUser();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        i % 2 ? db.users.applyClerkUpdate(clerkUser) : db.users.getOrCreateFromClerk(clerkUser),
      ),
    );
    const row = await db.users.findByClerkId(clerkUser.id);
    fx.trackUser(row.id);
    assert.ok(row);
    assert.equal(
      results.filter((r) => r && typeof r === 'object').every((u) => u.id === row.id),
      true,
    );
  });

  test('an update older than what we hold is dropped; a newer one is applied', async () => {
    const t = Date.now();
    const user = await fx.user({ name: 'Original', updatedAt: t });

    assert.equal(
      await db.users.applyClerkUpdate({
        id: user.clerk_user_id,
        email: user.email,
        name: 'Older',
        updatedAt: t - 5000,
      }),
      'stale',
    );
    assert.equal((await db.users.findById(user.id)).name, 'Original');

    assert.equal(
      await db.users.applyClerkUpdate({
        id: user.clerk_user_id,
        email: user.email,
        name: 'Newer',
        updatedAt: t + 5000,
      }),
      'applied',
    );
    assert.equal((await db.users.findById(user.id)).name, 'Newer');
  });

  test('an update that arrives before the user exists creates the user', async () => {
    const clerkUser = fx.clerkUser({ name: 'Early' });
    assert.equal(await db.users.applyClerkUpdate(clerkUser), 'created');
    const row = await db.users.findByClerkId(clerkUser.id);
    fx.trackUser(row.id);
    assert.equal(row.name, 'Early');
  });

  test('deleting a user anonymizes the row, removes memberships, and a late update cannot revive it', async () => {
    const { org, owner } = await fx.org();
    const { user: other } = await fx.member(org, 'admin');

    const result = await db.users.markDeleted(other.clerk_user_id);
    assert.deepEqual(result, { status: 'deleted', orphanedOrgIds: [] });

    const row = await db.users.findById(other.id);
    assert.ok(row.deleted_at);
    assert.equal(row.name, '');
    assert.match(row.email, /^deleted-\d+@deleted\.invalid$/);
    assert.equal(await db.forOrg(org.id).memberships.getByUser(other.id), null);
    assert.ok(await db.forOrg(org.id).memberships.getByUser(owner.id), 'the owner is untouched');

    assert.equal(
      await db.users.applyClerkUpdate({
        id: other.clerk_user_id,
        email: 'x@example.test',
        name: 'Zombie',
        updatedAt: Date.now() + 99999,
      }),
      'deleted',
    );
    assert.equal((await db.users.findById(other.id)).name, '');
    assert.equal(
      await db.users.getOrCreateFromClerk({ id: other.clerk_user_id, email: 'y@example.test' }),
      null,
    );
    assert.equal((await db.users.markDeleted(other.clerk_user_id)).status, 'already');
  });

  test('deleting an organization’s only owner reports the organization as orphaned', async () => {
    const { org, owner } = await fx.org();
    const result = await db.users.markDeleted(owner.clerk_user_id);
    assert.deepEqual(result.orphanedOrgIds, [org.id]);
  });
});

describe('sign-up → organization → owner membership', () => {
  test('creating an organization makes the creator its owner, with an activity entry', async () => {
    const user = await fx.user({ name: 'Maya Chen' });
    const { org, membership } = await db.organizations.createWithOwner({
      user,
      name: 'Maya’s Dental',
    });
    fx.trackOrg(org.id);

    assert.equal(membership.role, 'owner');
    assert.equal(membership.project_access, 'all');
    assert.equal(membership.user_id, user.id);
    assert.match(org.public_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(org.slug, 'maya-s-dental');
    assert.equal((await db.users.findById(user.id)).last_org_id, org.id, 'opens here next time');

    const found = await db.organizations.findForUser({ publicId: org.public_id, userId: user.id });
    assert.equal(found.org.id, org.id);
    assert.equal(found.membership.role, 'owner');

    const log = await db.forOrg(org.id).activity.recent();
    assert.deepEqual(
      log.map((l) => l.action),
      ['org.created'],
    );

    const listed = await db.organizations.listForUser(user.id);
    assert.deepEqual(
      listed.map((x) => x.org.id),
      [org.id],
    );
  });

  test('two organizations with the same name get different slugs', async () => {
    const a = await fx.org({ name: 'Acme Dental' });
    const b = await fx.org({ name: 'Acme Dental' });
    assert.notEqual(a.org.slug, b.org.slug);
    assert.match(b.org.slug, /^acme-dental-[0-9a-f]{4}$/);
  });

  test('simultaneous creations with the same name all succeed', async () => {
    const users = await Promise.all([fx.user(), fx.user(), fx.user()]);
    const created = await Promise.all(
      users.map((user) => db.organizations.createWithOwner({ user, name: 'Same Name Ltd' })),
    );
    for (const { org } of created) fx.trackOrg(org.id);
    assert.equal(new Set(created.map((c) => c.org.slug)).size, 3);
  });

  test('a non-member gets nothing, the same as for an ID that does not exist', async () => {
    const { org } = await fx.org();
    const stranger = await fx.user();
    assert.equal(
      await db.organizations.findForUser({ publicId: org.public_id, userId: stranger.id }),
      null,
    );
    assert.equal(
      await db.organizations.findForUser({ publicId: '0'.repeat(26), userId: stranger.id }),
      null,
    );
  });

  test('names that are too short or too long are refused', async () => {
    const user = await fx.user();
    await rejects(db.organizations.createWithOwner({ user, name: ' a ' }), 'INVALID_NAME');
    await rejects(
      db.organizations.createWithOwner({ user, name: 'x'.repeat(129) }),
      'INVALID_NAME',
    );
  });
});

describe('roles and the last-owner rule', () => {
  test('changing and removing members works, and is logged', async () => {
    const { org, owner, scoped } = await fx.org();
    const { membership } = await fx.member(org, 'viewer');

    const promoted = await scoped.memberships.changeRole({
      membershipId: membership.id,
      role: 'editor',
      actorUserId: owner.id,
    });
    assert.equal(promoted.role, 'editor');
    await scoped.memberships.remove({ membershipId: membership.id, actorUserId: owner.id });
    assert.equal(await scoped.memberships.get(membership.id), null);

    const actions = (await scoped.activity.recent()).map((l) => l.action);
    assert.deepEqual(actions.slice(0, 2), ['member.removed', 'member.role_changed']);
  });

  test('the only owner cannot be demoted or removed', async () => {
    const { owner, ownerMembership, scoped } = await fx.org();
    await rejects(
      scoped.memberships.changeRole({
        membershipId: ownerMembership.id,
        role: 'admin',
        actorUserId: owner.id,
      }),
      'LAST_OWNER',
    );
    await rejects(
      scoped.memberships.remove({ membershipId: ownerMembership.id, actorUserId: owner.id }),
      'LAST_OWNER',
    );
  });

  test('with two owners, one can leave — but two owners demoting each other at once cannot leave zero', async () => {
    const { org, owner, ownerMembership, scoped } = await fx.org();
    const { user: second, membership: secondMembership } = await fx.member(org, 'owner');

    const results = await Promise.allSettled([
      scoped.memberships.changeRole({
        membershipId: ownerMembership.id,
        role: 'viewer',
        actorUserId: second.id,
      }),
      scoped.memberships.changeRole({
        membershipId: secondMembership.id,
        role: 'viewer',
        actorUserId: owner.id,
      }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected')[0].reason.code, 'LAST_OWNER');

    const owners = (await scoped.memberships.list()).filter((m) => m.role === 'owner');
    assert.equal(owners.length, 1);
  });

  test('removing a member clears their "last opened" organization', async () => {
    const { org, owner, scoped } = await fx.org();
    const { user, membership } = await fx.member(org, 'editor');
    await db.users.setLastOrg(user.id, org.id);
    await scoped.memberships.remove({ membershipId: membership.id, actorUserId: owner.id });
    assert.equal((await db.users.findById(user.id)).last_org_id, null);
  });

  test('adding the same person twice is refused', async () => {
    const { org, owner, scoped } = await fx.org();
    await rejects(scoped.memberships.add({ userId: owner.id, role: 'viewer' }), 'ALREADY_MEMBER');
    assert.ok(org);
  });
});

describe('project access for client seats', () => {
  test('a viewer can be limited to selected projects, and set back to all', async () => {
    const { org, scoped } = await fx.org();
    const p1 = await fx.project(org.id);
    const p2 = await fx.project(org.id);
    const { membership } = await fx.member(org, 'viewer');

    await scoped.memberships.setProjectAccess({
      membershipId: membership.id,
      access: 'selected',
      projectIds: [p1.id],
    });
    let row = (await scoped.memberships.list()).find((m) => m.id === membership.id);
    assert.equal(row.project_access, 'selected');
    assert.deepEqual(row.projectIds, [p1.id]);

    await scoped.memberships.setProjectAccess({
      membershipId: membership.id,
      access: 'selected',
      projectIds: [p2.id],
    });
    row = (await scoped.memberships.list()).find((m) => m.id === membership.id);
    assert.deepEqual(row.projectIds, [p2.id], 'the earlier choice is replaced');

    await scoped.memberships.setProjectAccess({ membershipId: membership.id, access: 'all' });
    row = (await scoped.memberships.list()).find((m) => m.id === membership.id);
    assert.deepEqual([row.project_access, row.projectIds], ['all', []]);
  });

  test('a project from another organization is refused (the composite foreign key backs this up)', async () => {
    const a = await fx.org();
    const b = await fx.org();
    const foreign = await fx.project(b.org.id);
    const { membership } = await fx.member(a.org, 'viewer');
    await rejects(
      a.scoped.memberships.setProjectAccess({
        membershipId: membership.id,
        access: 'selected',
        projectIds: [foreign.id],
      }),
      'PROJECT_NOT_IN_ORG',
    );

    // Bypass the repository check and prove the database itself refuses the row.
    await assert.rejects(
      fx.forceMembershipProject({
        membershipId: membership.id,
        projectId: foreign.id,
        orgId: a.org.id,
      }),
      (err) => err.code === 'P2003',
    );
  });

  test('owners and admins always see every project', async () => {
    const { org, scoped } = await fx.org();
    const project = await fx.project(org.id);
    const { membership } = await fx.member(org, 'admin');
    await rejects(
      scoped.memberships.setProjectAccess({
        membershipId: membership.id,
        access: 'selected',
        projectIds: [project.id],
      }),
      'ACCESS_NEEDS_ALL',
    );
  });

  test('promoting a limited viewer to admin restores access to everything', async () => {
    const { org, owner, scoped } = await fx.org();
    const project = await fx.project(org.id);
    const { membership } = await fx.member(org, 'viewer');
    await scoped.memberships.setProjectAccess({
      membershipId: membership.id,
      access: 'selected',
      projectIds: [project.id],
    });
    await scoped.memberships.changeRole({
      membershipId: membership.id,
      role: 'admin',
      actorUserId: owner.id,
    });
    const row = (await scoped.memberships.list()).find((m) => m.id === membership.id);
    assert.deepEqual([row.role, row.project_access, row.projectIds], ['admin', 'all', []]);
  });
});
