import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { hashToken, newToken } from '../../src/lib/tokens.js';

const db = connectTestDb();
const fx = fixtures(db);
after(async () => {
  await fx.cleanup();
  await db.close();
});

const DAY = 24 * 60 * 60 * 1000;
const rejects = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof DomainError && err.code === code);

/** An org, its owner, a fresh invitee user, and a live invitation to that user's email. */
async function setup({
  role = 'editor',
  projectAccess = 'all',
  projectIds = [],
  ttl = 7 * DAY,
} = {}) {
  const ctx = await fx.org();
  const invitee = await fx.user();
  const token = newToken();
  const invitation = await ctx.scoped.invitations.create({
    email: invitee.email.toUpperCase(),
    role,
    projectAccess,
    projectIds,
    inviterUserId: ctx.owner.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttl),
  });
  return { ...ctx, invitee, token, invitation };
}

describe('sending invitations', () => {
  test('stores a hash of the token, never the token, and lowercases the address', async () => {
    const { invitation, token, invitee } = await setup();
    assert.equal(invitation.email, invitee.email);
    assert.deepEqual(Buffer.from(invitation.token_hash), hashToken(token));
    assert.equal(invitation.status, 'pending');
    assert.ok(
      !JSON.stringify(invitation, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(
        token,
      ),
    );
  });

  test('inviting the same address again cancels the earlier link', async () => {
    const { scoped, owner, invitee, token } = await setup();
    const newer = newToken();
    await scoped.invitations.create({
      email: invitee.email,
      role: 'viewer',
      inviterUserId: owner.id,
      tokenHash: hashToken(newer),
      expiresAt: new Date(Date.now() + DAY),
    });
    const pending = await scoped.invitations.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].role, 'viewer');

    const old = await db.invitationLinks.find(token);
    assert.equal(old.state, 'canceled');
    assert.equal((await db.invitationLinks.find(newer)).state, 'pending');
  });

  test('inviting someone who is already a member is refused', async () => {
    const { org, scoped, owner } = await fx.org();
    const { user } = await fx.member(org, 'viewer');
    await rejects(
      scoped.invitations.create({
        email: user.email,
        role: 'editor',
        inviterUserId: owner.id,
        tokenHash: hashToken(newToken()),
        expiresAt: new Date(Date.now() + DAY),
      }),
      'ALREADY_MEMBER',
    );
  });

  test('cancel and reissue only touch pending invitations of this organization', async () => {
    const { scoped, owner, invitation, token } = await setup();
    const fresh = newToken();
    const reissued = await scoped.invitations.reissue({
      invitationId: invitation.id,
      tokenHash: hashToken(fresh),
      expiresAt: new Date(Date.now() + 3 * DAY),
      actorUserId: owner.id,
    });
    assert.equal(reissued.id, invitation.id);
    assert.equal(await db.invitationLinks.find(token), null, 'the old link stops working');
    assert.equal((await db.invitationLinks.find(fresh)).state, 'pending');

    await scoped.invitations.cancel({ invitationId: invitation.id, actorUserId: owner.id });
    assert.equal((await db.invitationLinks.find(fresh)).state, 'canceled');
    await rejects(
      scoped.invitations.cancel({ invitationId: invitation.id, actorUserId: owner.id }),
      'NOT_FOUND',
    );
  });
});

describe('looking up an invitation by its link', () => {
  test('a token that was never issued finds nothing', async () => {
    assert.equal(await db.invitationLinks.find(newToken()), null);
    assert.equal(await db.invitationLinks.find('short'), null);
    assert.equal(await db.invitationLinks.find(undefined), null);
  });

  test('an expired invitation is reported as expired', async () => {
    const { token } = await setup({ ttl: -1000 });
    assert.equal((await db.invitationLinks.find(token)).state, 'expired');
  });

  test('the page can show the organization name and nothing about its members', async () => {
    const { token, org } = await setup();
    const found = await db.invitationLinks.find(token);
    assert.deepEqual(Object.keys(found.org).sort(), ['deleted_at', 'name', 'public_id']);
    assert.equal(found.org.public_id, org.public_id);
  });
});

describe('accepting an invitation', () => {
  test('creates the membership with the invited role, once, and opens that organization next time', async () => {
    const { token, invitee, org, scoped } = await setup({ role: 'editor' });
    const accepted = await db.invitationLinks.accept({
      token,
      user: invitee,
      verifiedEmails: [invitee.email],
    });

    assert.equal(accepted.alreadyMember, false);
    assert.equal(accepted.orgPublicId, org.public_id);
    assert.equal(accepted.membership.role, 'editor');
    assert.equal((await db.users.findById(invitee.id)).last_org_id, org.id);
    assert.equal((await db.invitationLinks.find(token)).state, 'accepted');
    assert.equal((await scoped.invitations.listPending()).length, 0);
    assert.ok((await scoped.activity.recent()).some((l) => l.action === 'invitation.accepted'));
  });

  test('accepting again is harmless and does not duplicate the membership', async () => {
    const { token, invitee, scoped } = await setup();
    await db.invitationLinks.accept({ token, user: invitee, verifiedEmails: [invitee.email] });
    const again = await db.invitationLinks.accept({
      token,
      user: invitee,
      verifiedEmails: [invitee.email],
    });
    assert.equal(again.alreadyMember, true);
    const rows = (await scoped.memberships.list()).filter((m) => m.user_id === invitee.id);
    assert.equal(rows.length, 1);
  });

  test('two tabs accepting at the same moment create one membership', async () => {
    const { token, invitee, scoped } = await setup();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        db.invitationLinks.accept({ token, user: invitee, verifiedEmails: [invitee.email] }),
      ),
    );
    assert.equal(results.filter((r) => !r.alreadyMember).length, 1);
    assert.equal(
      (await scoped.memberships.list()).filter((m) => m.user_id === invitee.id).length,
      1,
    );
  });

  test('a signed-in user whose verified email differs cannot use the link', async () => {
    const { token, scoped } = await setup();
    const intruder = await fx.user();
    await rejects(
      db.invitationLinks.accept({ token, user: intruder, verifiedEmails: [intruder.email] }),
      'EMAIL_MISMATCH',
    );
    assert.equal(
      (await scoped.memberships.list()).some((m) => m.user_id === intruder.id),
      false,
    );
  });

  test('the match is on any of the user’s verified addresses, ignoring case', async () => {
    const { token, invitee } = await setup();
    const user = await fx.user();
    const accepted = await db.invitationLinks.accept({
      token,
      user,
      verifiedEmails: ['work@elsewhere.test', invitee.email.toUpperCase()],
    });
    assert.equal(accepted.alreadyMember, false);
  });

  test('an unverified address does not count: with no verified emails nothing matches', async () => {
    const { token, invitee } = await setup();
    await rejects(
      db.invitationLinks.accept({ token, user: invitee, verifiedEmails: [] }),
      'EMAIL_MISMATCH',
    );
  });

  test('expired, canceled and unknown links are refused', async () => {
    const expired = await setup({ ttl: -1000 });
    await rejects(
      db.invitationLinks.accept({
        token: expired.token,
        user: expired.invitee,
        verifiedEmails: [expired.invitee.email],
      }),
      'INVITE_EXPIRED',
    );

    const canceled = await setup();
    await canceled.scoped.invitations.cancel({
      invitationId: canceled.invitation.id,
      actorUserId: canceled.owner.id,
    });
    await rejects(
      db.invitationLinks.accept({
        token: canceled.token,
        user: canceled.invitee,
        verifiedEmails: [canceled.invitee.email],
      }),
      'INVITE_USED',
    );

    const user = await fx.user();
    await rejects(
      db.invitationLinks.accept({ token: newToken(), user, verifiedEmails: [user.email] }),
      'INVITE_NOT_FOUND',
    );
  });

  test('a limited-project seat gets exactly the invited projects', async () => {
    const ctx = await fx.org();
    const p1 = await fx.project(ctx.org.id);
    await fx.project(ctx.org.id);
    const invitee = await fx.user();
    const token = newToken();
    await ctx.scoped.invitations.create({
      email: invitee.email,
      role: 'viewer',
      projectAccess: 'selected',
      projectIds: [p1.id],
      inviterUserId: ctx.owner.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + DAY),
    });
    const { membership } = await db.invitationLinks.accept({
      token,
      user: invitee,
      verifiedEmails: [invitee.email],
    });
    assert.equal(membership.project_access, 'selected');
    const row = (await ctx.scoped.memberships.list()).find((m) => m.id === membership.id);
    assert.deepEqual(row.projectIds, [p1.id]);
  });

  test('inviting to selected projects needs real projects of this organization', async () => {
    const a = await fx.org();
    const b = await fx.org();
    const foreign = await fx.project(b.org.id);
    const base = {
      email: 'someone@example.test',
      role: 'viewer',
      projectAccess: 'selected',
      inviterUserId: a.owner.id,
      tokenHash: hashToken(newToken()),
      expiresAt: new Date(Date.now() + DAY),
    };
    await rejects(
      a.scoped.invitations.create({ ...base, projectIds: [foreign.id] }),
      'PROJECT_NOT_IN_ORG',
    );
    await rejects(a.scoped.invitations.create({ ...base, projectIds: [] }), 'PROJECT_NOT_IN_ORG');
    await rejects(
      a.scoped.invitations.create({ ...base, role: 'admin', projectIds: [foreign.id] }),
      'ACCESS_NEEDS_ALL',
    );
  });
});
