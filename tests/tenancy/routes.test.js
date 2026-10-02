import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { hashToken, newToken } from '../../src/lib/tokens.js';
import { authHarness, orgPathOf } from '../routes/auth-helpers.js';

/**
 * Cross-tenant leak suite for the web routes (DATABASE_SCHEMA §6, layer 4). Organization A's owner is signed in
 * and tries every organization route against organization B, both through B's URL and through A's URL with B's
 * IDs. Every attempt must be a plain 404 that mentions nothing of B, and B must be exactly as it was.
 */
const h = authHarness();
after(() => h.close());

let a; // { owner, orgId, org }
let b; // same, for the other organization
let bMember; // a membership of B
let bInvitation; // a waiting invitation of B
let bToken; // the emailed token for it

const MARKERS = { orgName: 'Zeta Secret Holdings', memberEmail: 'zeta.member@example.test' };

async function makeOrg(name, ownerOverrides) {
  const owner = await h.signedIn(ownerOverrides);
  const orgId = orgPathOf(await owner.post('/app/new-org', { name }).expect(303));
  const org = (await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id }))
    .org;
  return { owner, orgId, org };
}

before(async () => {
  a = await makeOrg('Alpha Co', { name: 'Alice Owner' });
  b = await makeOrg(MARKERS.orgName, { name: 'Bob Owner' });

  const member = await h.fx.user({ email: MARKERS.memberEmail, name: 'Zeta Member' });
  bMember = await h.db.forOrg(b.org.id).memberships.add({ userId: member.id, role: 'editor' });

  bToken = newToken();
  bInvitation = await h.db.forOrg(b.org.id).invitations.create({
    email: 'zeta.pending@example.test',
    role: 'viewer',
    inviterUserId: b.owner.user.id,
    tokenHash: hashToken(bToken),
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });
});

async function snapshotB() {
  const scoped = h.db.forOrg(b.org.id);
  return JSON.stringify(
    {
      members: await scoped.memberships.list(),
      invites: await scoped.invitations.listPending(),
      log: (await scoped.activity.recent()).length,
    },
    (_k, v) => (typeof v === 'bigint' ? String(v) : v),
  );
}

function assertNothingOfB(res, label) {
  assert.equal(res.status, 404, `${label}: expected a plain 404, got ${res.status}`);
  for (const marker of [...Object.values(MARKERS), b.orgId, 'Bob Owner', 'zeta.pending']) {
    assert.ok(!res.text.includes(marker), `${label}: the response mentions "${marker}"`);
  }
}

describe('A’s owner tries organization B’s pages', () => {
  test('every page under B’s URL is a plain 404', async () => {
    for (const path of [`/app/o/${b.orgId}`, `/app/o/${b.orgId}/settings`]) {
      assertNothingOfB(await a.owner.get(path), `GET ${path}`);
    }
  });

  test('every action under B’s URL is a plain 404 and changes nothing', async () => {
    const before = await snapshotB();
    const base = `/app/o/${b.orgId}`;
    const attempts = [
      [`${base}/invitations`, { email: 'planted@example.test', role: 'viewer' }],
      [`${base}/invitations/${bInvitation.id}/cancel`, {}],
      [`${base}/invitations/${bInvitation.id}/resend`, {}],
      [`${base}/members/${bMember.id}/role`, { role: 'admin' }],
      [`${base}/members/${bMember.id}/remove`, {}],
    ];
    const mailBefore = h.mailer.sent.length;
    for (const [path, body] of attempts)
      assertNothingOfB(await a.owner.post(path, body), `POST ${path}`);
    assert.equal(await snapshotB(), before);
    assert.equal(h.mailer.sent.length, mailBefore, 'no email went out');
  });

  test('B’s IDs used under A’s own URL are not found either', async () => {
    const before = await snapshotB();
    const base = `/app/o/${a.orgId}`;
    const attempts = [
      [`${base}/invitations/${bInvitation.id}/cancel`, {}],
      [`${base}/invitations/${bInvitation.id}/resend`, {}],
      [`${base}/members/${bMember.id}/role`, { role: 'admin' }],
      [`${base}/members/${bMember.id}/remove`, {}],
      [`${base}/members/${b.owner.user.id}/remove`, {}],
    ];
    for (const [path, body] of attempts)
      assertNothingOfB(await a.owner.post(path, body), `POST ${path}`);
    assert.equal(await snapshotB(), before);
    assert.equal(
      (await h.db.invitationLinks.find(bToken)).state,
      'pending',
      'B’s invitation still works',
    );
  });

  test('A’s own pages never mention B', async () => {
    for (const path of [`/app/o/${a.orgId}`, `/app/o/${a.orgId}/settings`, '/app/new-org']) {
      const res = await a.owner.get(path).expect(200);
      for (const marker of [...Object.values(MARKERS), b.orgId]) {
        assert.ok(!res.text.includes(marker), `${path} mentions "${marker}"`);
      }
    }
  });

  test('the organization switcher lists only organizations the user belongs to', async () => {
    const res = await a.owner.get(`/app/o/${a.orgId}`).expect(200);
    const links = [...res.text.matchAll(/href="\/app\/o\/([0-9A-Z]{26})"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(links)], [a.orgId]);
  });

  test('B’s invitation link cannot be used by A’s owner to join B', async () => {
    await a.owner.post(`/invite/${bToken}/accept`).expect(303);
    assert.equal(await h.db.forOrg(b.org.id).memberships.getByUser(a.owner.user.id), null);
  });
});

describe('coverage: no organization route without a leak test', () => {
  // Update in the same commit that adds a route to the `org` router in src/web/routes/app.js.
  const COVERED = [
    'GET /',
    'GET /settings',
    'POST /members/:id/role',
    'POST /members/:id/remove',
    'POST /invitations',
    'POST /invitations/:id/cancel',
    'POST /invitations/:id/resend',
  ];

  test('every route on the organization router is exercised above', () => {
    const source = readFileSync(new URL('../../src/web/routes/app.js', import.meta.url), 'utf8');
    const found = [...source.matchAll(/\borg\.(get|post)\(\s*'([^']+)'/g)].map(
      (m) => `${m[1].toUpperCase()} ${m[2]}`,
    );
    assert.deepEqual(found.sort(), [...COVERED].sort());
  });
});
