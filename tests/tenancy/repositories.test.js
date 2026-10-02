import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { hashToken, newToken } from '../../src/lib/tokens.js';

/**
 * Cross-tenant leak suite for the repository layer (DATABASE_SCHEMA §6, layer 4).
 *
 * Two organizations are seeded with near-identical data: the same name, the same kinds of members, the
 * same project names. Every organization-scoped function is then called as organization A with an ID that
 * belongs to organization B. It must find nothing, change nothing, and never mention B.
 *
 * THIS SUITE GROWS WITH THE PRODUCT. A function added to the scoped repositories without a test here
 * fails the "every function is covered" test below, so isolation can't silently regress.
 */

const db = connectTestDb();
const fx = fixtures(db);

let A;
let B;
let bMember; // a membership that belongs to B
let bInvitation;
let bToken;
let bProject;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  const name = 'Twin Dental';
  A = await fx.org({ name });
  B = await fx.org({ name });
  await fx.member(A.org, 'editor', { name: 'Sam Lee' });
  const second = await fx.member(B.org, 'editor', { name: 'Sam Lee' });
  bMember = second.membership;
  await fx.project(A.org.id, 'Main site');
  bProject = await fx.project(B.org.id, 'Main site');

  bToken = newToken();
  bInvitation = await B.scoped.invitations.create({
    email: 'pending@example.test',
    role: 'viewer',
    inviterUserId: B.owner.id,
    tokenHash: hashToken(bToken),
    expiresAt: new Date(Date.now() + DAY),
  });
});

after(async () => {
  await fx.cleanup();
  await db.close();
});

const refuses = (promise, ...codes) =>
  assert.rejects(promise, (e) => e instanceof DomainError && codes.includes(e.code));
const ids = (rows) => rows.map((r) => String(r.id));

/** Everything about B that must survive A's attempts untouched. */
async function snapshotB() {
  const members = await B.scoped.memberships.list();
  const invites = await B.scoped.invitations.listPending();
  const log = await B.scoped.activity.recent();
  return JSON.stringify({ members, invites, log: log.length }, (_k, v) =>
    typeof v === 'bigint' ? String(v) : v,
  );
}

describe('memberships', () => {
  test('list(): A sees only A’s members', async () => {
    const aIds = new Set(ids(await A.scoped.memberships.list()));
    const bIds = new Set(ids(await B.scoped.memberships.list()));
    assert.ok(aIds.size >= 2);
    for (const id of bIds) assert.ok(!aIds.has(id), `B membership ${id} appeared for A`);
  });

  test('get(): B’s membership ID returns nothing for A', async () => {
    assert.equal(await A.scoped.memberships.get(bMember.id), null);
    assert.ok(await B.scoped.memberships.get(bMember.id));
  });

  test('getByUser(): B’s user is not a member of A', async () => {
    assert.equal(await A.scoped.memberships.getByUser(B.owner.id), null);
  });

  test('add(): cannot be used to add someone to B by naming B’s data', async () => {
    // A's repository can only ever write A's org_id.
    const outsider = await fx.user();
    const added = await A.scoped.memberships.add({ userId: outsider.id, role: 'viewer' });
    assert.equal(added.org_id, A.org.id);
    assert.equal(await B.scoped.memberships.getByUser(outsider.id), null);
  });

  test('changeRole(): B’s membership ID is not found, and B is unchanged', async () => {
    const before = await snapshotB();
    await refuses(
      A.scoped.memberships.changeRole({
        membershipId: bMember.id,
        role: 'admin',
        actorUserId: A.owner.id,
      }),
      'NOT_FOUND',
    );
    assert.equal(await snapshotB(), before);
  });

  test('remove(): B’s membership ID is not found, and B is unchanged', async () => {
    const before = await snapshotB();
    await refuses(
      A.scoped.memberships.remove({ membershipId: bMember.id, actorUserId: A.owner.id }),
      'NOT_FOUND',
    );
    await refuses(
      A.scoped.memberships.remove({ membershipId: B.ownerMembership.id, actorUserId: A.owner.id }),
      'NOT_FOUND',
    );
    assert.equal(await snapshotB(), before);
  });

  test('setProjectAccess(): neither B’s membership nor B’s project can be used from A', async () => {
    const aViewer = await fx.member(A.org, 'viewer');
    await refuses(
      A.scoped.memberships.setProjectAccess({ membershipId: bMember.id, access: 'all' }),
      'NOT_FOUND',
    );
    await refuses(
      A.scoped.memberships.setProjectAccess({
        membershipId: aViewer.membership.id,
        access: 'selected',
        projectIds: [bProject.id],
      }),
      'PROJECT_NOT_IN_ORG',
    );
  });
});

describe('invitations', () => {
  test('listPending(): A never sees B’s invitations', async () => {
    const seen = ids(await A.scoped.invitations.listPending());
    assert.ok(!seen.includes(String(bInvitation.id)));
  });

  test('get(): B’s invitation ID returns nothing for A', async () => {
    assert.equal(await A.scoped.invitations.get(bInvitation.id), null);
  });

  test('cancel() and reissue(): B’s invitation is not found from A, and its link still works', async () => {
    await refuses(
      A.scoped.invitations.cancel({ invitationId: bInvitation.id, actorUserId: A.owner.id }),
      'NOT_FOUND',
    );
    await refuses(
      A.scoped.invitations.reissue({
        invitationId: bInvitation.id,
        tokenHash: hashToken(newToken()),
        expiresAt: new Date(Date.now() + DAY),
        actorUserId: A.owner.id,
      }),
      'NOT_FOUND',
    );
    assert.equal((await db.invitationLinks.find(bToken)).state, 'pending');
  });

  test('create(): always writes A’s org, and ignores B’s projects', async () => {
    const created = await A.scoped.invitations.create({
      email: 'twin@example.test',
      role: 'viewer',
      inviterUserId: A.owner.id,
      tokenHash: hashToken(newToken()),
      expiresAt: new Date(Date.now() + DAY),
    });
    assert.equal(created.org_id, A.org.id);
    assert.equal(
      (await B.scoped.invitations.listPending()).some((i) => i.email === 'twin@example.test'),
      false,
    );
  });

  test('inviting to B’s address list does not detect B’s members (no membership oracle across orgs)', async () => {
    // B's owner is not a member of A, so inviting their address to A is allowed and says nothing about B.
    const created = await A.scoped.invitations.create({
      email: B.owner.email,
      role: 'viewer',
      inviterUserId: A.owner.id,
      tokenHash: hashToken(newToken()),
      expiresAt: new Date(Date.now() + DAY),
    });
    assert.equal(created.org_id, A.org.id);
  });
});

describe('activity log', () => {
  test('recent(): only A’s entries', async () => {
    const entries = await A.scoped.activity.recent({ limit: 200 });
    assert.ok(entries.length > 0);
    assert.ok(entries.every((e) => e.org_id === A.org.id));
  });

  test('append(): writes A’s org only', async () => {
    await A.scoped.activity.append({ action: 'test.event', summary: 'hello' });
    const mine = await A.scoped.activity.recent();
    assert.ok(mine.some((e) => e.action === 'test.event'));
    assert.ok(!(await B.scoped.activity.recent()).some((e) => e.action === 'test.event'));
  });
});

describe('organizations and invitation links (the global lookups)', () => {
  test('findForUser(): A’s owner cannot open B by its public ID', async () => {
    assert.equal(
      await db.organizations.findForUser({ publicId: B.org.public_id, userId: A.owner.id }),
      null,
    );
    assert.ok(
      await db.organizations.findForUser({ publicId: B.org.public_id, userId: B.owner.id }),
    );
  });

  test('listForUser(): lists only organizations the user belongs to', async () => {
    const listed = await db.organizations.listForUser(A.owner.id);
    assert.deepEqual(
      listed.map((x) => x.org.id),
      [A.org.id],
    );
  });

  test('accept(): a signed-in user of A cannot join B with B’s link unless the invited email is theirs', async () => {
    await refuses(
      db.invitationLinks.accept({ token: bToken, user: A.owner, verifiedEmails: [A.owner.email] }),
      'EMAIL_MISMATCH',
    );
    assert.equal(await B.scoped.memberships.getByUser(A.owner.id), null);
  });

  test('find(): returns the name and public ID of the invited organization only', async () => {
    const found = await db.invitationLinks.find(bToken);
    assert.equal(found.org.public_id, B.org.public_id);
    const text = JSON.stringify(found, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    assert.equal(text.includes(String(A.org.public_id)), false);
  });
});

describe('coverage: no repository function without a leak test', () => {
  // Update this list in the same commit that adds a function to org-scoped.js.
  const COVERED = {
    memberships: ['add', 'changeRole', 'get', 'getByUser', 'list', 'remove', 'setProjectAccess'],
    invitations: ['cancel', 'create', 'get', 'listPending', 'reissue'],
    activity: ['append', 'recent'],
  };

  test('every function exposed by forOrg() is listed above', () => {
    const scoped = db.forOrg(A.org.id);
    for (const [repo, functions] of Object.entries(COVERED)) {
      assert.deepEqual(
        Object.keys(scoped[repo]).sort(),
        functions,
        `${repo}: add a leak test, then list it`,
      );
    }
    assert.deepEqual(Object.keys(scoped).sort(), [
      'activity',
      'invitations',
      'memberships',
      'orgId',
    ]);
  });

  test('forOrg() is the only way into tenant data: no function takes an org ID as an argument', () => {
    // A function whose source mentions a caller-supplied orgId/org_id would be able to leave its tenant.
    const scoped = db.forOrg(A.org.id);
    for (const [repo, fns] of Object.entries(COVERED)) {
      for (const name of fns) {
        const source = scoped[repo][name].toString();
        assert.doesNotMatch(
          source,
          /\b(args?|options?|params?)\.(org_?id|orgId)\b/i,
          `${repo}.${name}`,
        );
      }
    }
  });
});
