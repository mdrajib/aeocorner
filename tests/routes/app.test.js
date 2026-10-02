import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import request from 'supertest';
import { loadConfig } from '../../src/lib/config.js';
import { createApp } from '../../src/web/app.js';
import { createUnconfiguredProvider } from '../../src/web/auth/provider.js';
import { authHarness, BASE, orgPathOf, tokenIn } from './auth-helpers.js';
import { silentLogger } from './helpers.js';

const h = authHarness();
after(() => h.close());

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';

describe('anonymous visitors', () => {
  const protectedPages = ['/app', '/app/new-org', `/app/o/${ULID}`, `/app/o/${ULID}/settings`];

  for (const path of protectedPages) {
    test(`GET ${path} sends a browser to sign in, remembering where it was going`, async () => {
      const res = await h.agent.get(path).set('Accept', 'text/html').expect(302);
      assert.equal(res.headers.location, `/sign-in?next=${encodeURIComponent(path)}`);
      assert.equal(res.headers['cache-control'], 'no-store');
    });

    test(`GET ${path} answers 401 to anything that is not a page request`, async () => {
      await h.agent.get(path).set('Accept', 'application/json').expect(401);
    });
  }

  test('state-changing requests are refused and create nothing', async () => {
    await h.agent.post('/app/new-org').type('form').send({ name: 'Sneaky Inc' }).expect(401);
    await h.agent
      .post(`/app/o/${ULID}/invitations`)
      .type('form')
      .send({ email: 'a@b.test' })
      .expect(401);
    await h.agent.post('/app/o/x/members/1/remove').expect(401);
  });

  test('an htmx request is told where to sign in', async () => {
    const res = await h.agent.post('/app/new-org').set('HX-Request', 'true').expect(401);
    assert.equal(res.headers['hx-redirect'], '/sign-in');
  });

  test('/sign-in goes to Clerk’s hosted page with a return address inside the app', async () => {
    const res = await h.agent.get('/sign-in?next=/app/o/abc/settings').expect(302);
    const url = new URL(res.headers.location);
    assert.equal(url.origin + url.pathname, 'https://accounts.example.test/sign-in');
    assert.equal(url.searchParams.get('redirect_url'), `${BASE}/app/o/abc/settings`);
    assert.equal(res.headers['cache-control'], 'no-store');

    const signUp = await h.agent.get('/sign-up').expect(302);
    assert.equal(new URL(signUp.headers.location).pathname, '/sign-up');
  });

  test('the return address can never point to another site', async () => {
    for (const next of [
      'https://evil.test/phish',
      '//evil.test',
      '/\\evil.test',
      'javascript:alert(1)',
      '/app/../../etc',
      '/application',
      '/sign-in',
    ]) {
      const res = await h.agent.get(`/sign-in?next=${encodeURIComponent(next)}`).expect(302);
      const target = new URL(res.headers.location).searchParams.get('redirect_url');
      assert.ok(target.startsWith(`${BASE}/app`), `${next} -> ${target}`);
      assert.ok(!target.includes('evil'), next);
    }
  });

  test('public pages never run the auth check, so they set no cookies and cost nothing', async () => {
    const res = await h.agent.get('/').expect(200);
    assert.equal(res.headers['set-cookie'], undefined);
  });
});

describe('a server with no Clerk keys', () => {
  const app = request(
    createApp({
      config: loadConfig({ NODE_ENV: 'test', APP_BASE_URL: BASE }),
      logger: silentLogger,
      db: h.db,
      provider: createUnconfiguredProvider(),
    }),
  );

  test('signed-in pages say sign-in is not available instead of redirecting into nothing', async () => {
    const res = await app.get('/app').expect(503);
    assert.match(res.text, /Sign-in isn’t available right now/);
    assert.match(res.text, /CLERK_PUBLISHABLE_KEY/, 'development shows the developer hint');
  });

  test('/sign-in explains the same, and the public header hides the Sign in link', async () => {
    await app.get('/sign-in').expect(503);
    const home = await app.get('/').expect(200);
    assert.doesNotMatch(home.text, />Sign in</);
  });
});

describe('first sign-in → organization → empty shell', () => {
  test('a brand-new user is created from Clerk’s data, then sent to create an organization', async () => {
    const clerkUser = h.fx.clerkUser({ name: 'Maya Chen' });
    const me = h.provider.signIn(clerkUser);
    const headers = { 'X-Test-Session': me.session };

    assert.equal(await h.db.users.findByClerkId(clerkUser.id), null, 'no local copy yet');
    const res = await h.agent.get('/app').set(headers).expect(302);
    assert.equal(res.headers.location, '/app/new-org');

    const user = await h.db.users.findByClerkId(clerkUser.id);
    h.fx.trackUser(user.id);
    assert.equal(user.name, 'Maya Chen');
    assert.equal(user.email, clerkUser.email);
  });

  test('the create form carries a CSRF token and is never cached or indexed', async () => {
    const u = await h.signedIn();
    const res = await u.get('/app/new-org').expect(200);
    assert.match(res.text, /<input type="hidden" name="_csrf" value="[A-Za-z0-9_-]{20,}">/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['x-robots-tag'], /noindex/);
    assert.match(res.text, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(res.text, /Create your organization/);
  });

  test('the domain from a free audit pre-fills the name', async () => {
    const u = await h.signedIn();
    const res = await u.get('/app/new-org?domain=www.acme-dental.com').expect(200);
    assert.match(res.text, /value="Acme Dental"/);
    const junk = await u.get('/app/new-org?domain=not%20a%20site').expect(200);
    assert.match(junk.text, /id="org-name"[^>]*value=""|value="" /);
  });

  test('creating an organization makes the signed-in user its owner and opens the shell', async () => {
    const u = await h.signedIn({ name: 'Maya Chen' });
    const created = await u.post('/app/new-org', { name: 'Acme Dental' }).expect(303);
    const orgId = orgPathOf(created);
    assert.ok(orgId, created.headers.location);
    assert.match(created.headers.location, /\?notice=org-created$/);

    const found = await h.db.organizations.findForUser({ publicId: orgId, userId: u.user.id });
    assert.equal(found.org.name, 'Acme Dental');
    assert.equal(found.membership.role, 'owner');

    const shell = await u.get(created.headers.location).expect(200);
    assert.match(shell.text, /<h1[^>]*>Acme Dental<\/h1>/);
    assert.match(shell.text, /Your organization is ready\./);
    assert.match(shell.text, /signed in as <strong>Owner<\/strong>/);
    assert.match(shell.text, /No projects yet/);
    assert.match(shell.text, /Sign out/);
    assert.match(
      shell.text,
      /href="\/app\/o\/[0-9A-Z]{26}\/settings"/,
      'owner sees Team in the nav',
    );
  });

  test('/app opens the organization the user used last', async () => {
    const u = await h.signedIn();
    const first = orgPathOf(await u.post('/app/new-org', { name: 'First Co' }).expect(303));
    const second = orgPathOf(await u.post('/app/new-org', { name: 'Second Co' }).expect(303));
    assert.equal((await u.get('/app').expect(302)).headers.location, `/app/o/${second}`);
    await u.get(`/app/o/${first}`).expect(200);
    assert.equal((await u.get('/app').expect(302)).headers.location, `/app/o/${first}`);
  });

  test('a form without the right CSRF token is refused', async () => {
    const u = await h.signedIn();
    await u.post('/app/new-org', { name: 'No Token' }, { csrf: null }).expect(403);
    await u.post('/app/new-org', { name: 'Wrong Token' }, { csrf: 'nope' }).expect(403);
    // A token from someone else’s session doesn’t work either.
    const other = await h.signedIn();
    await u.post('/app/new-org', { name: 'Borrowed' }, { csrf: other.csrf }).expect(403);
    assert.deepEqual(await h.db.organizations.listForUser(u.user.id), []);
  });

  test('a cross-site post is refused before anything else', async () => {
    const u = await h.signedIn();
    await u
      .post('/app/new-org', { name: 'Evil' }, { extra: { 'Sec-Fetch-Site': 'cross-site' } })
      .expect(403);
  });

  test('bad names are explained on the form, with status 422', async () => {
    const u = await h.signedIn();
    const res = await u.post('/app/new-org', { name: ' a ' }).expect(422);
    assert.match(res.text, /Use between 2 and 128 characters\./);
    assert.match(res.text, /aria-invalid="true"/);
    await u.post('/app/new-org', {}).expect(422);
    assert.deepEqual(await h.db.organizations.listForUser(u.user.id), []);
  });

  test('a name with HTML in it is shown as text, never as markup', async () => {
    const u = await h.signedIn();
    const created = await u
      .post('/app/new-org', { name: '<img src=x onerror=alert(1)>' })
      .expect(303);
    const shell = await u.get(created.headers.location).expect(200);
    assert.doesNotMatch(shell.text, /<img src=x/);
    assert.match(shell.text, /&lt;img src=x/);
  });
});

describe('roles decide what a member sees', () => {
  async function team() {
    const owner = await h.signedIn();
    const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Role Co' }).expect(303));
    const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
    const members = {};
    for (const role of ['admin', 'editor', 'viewer']) {
      const m = await h.signedIn();
      await h.db.forOrg(found.org.id).memberships.add({ userId: m.user.id, role });
      members[role] = m;
    }
    return { owner, members, orgId, org: found.org };
  }

  test('owners and admins can open the team page; editors and viewers get a 403 page', async () => {
    const { owner, members, orgId } = await team();
    await owner.get(`/app/o/${orgId}/settings`).expect(200);
    await members.admin.get(`/app/o/${orgId}/settings`).expect(200);
    for (const role of ['editor', 'viewer']) {
      const res = await members[role].get(`/app/o/${orgId}/settings`).expect(403);
      assert.match(res.text, /You don’t have access to this page/);
      assert.doesNotMatch(res.text, /Invite a teammate/);
      const shell = await members[role].get(`/app/o/${orgId}`).expect(200);
      assert.doesNotMatch(shell.text, /\/settings"/, 'no Team link in their nav');
    }
  });

  test('editors and viewers cannot invite, change roles or remove anyone', async () => {
    const { members, orgId, owner } = await team();
    const target = await h.db
      .forOrg(
        (await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id })).org.id,
      )
      .memberships.getByUser(members.viewer.user.id);
    for (const role of ['editor', 'viewer']) {
      const m = members[role];
      await m
        .post(`/app/o/${orgId}/invitations`, { email: 'x@example.test', role: 'viewer' })
        .expect(403);
      await m.post(`/app/o/${orgId}/members/${target.id}/role`, { role: 'admin' }).expect(403);
      await m.post(`/app/o/${orgId}/members/${target.id}/remove`).expect(403);
    }
    assert.equal(h.mailer.sent.filter((s) => s.to === 'x@example.test').length, 0);
  });

  test('an admin cannot touch an owner or hand out the owner role', async () => {
    const { members, orgId, owner, org } = await team();
    const ownerMembership = await h.db.forOrg(org.id).memberships.getByUser(owner.user.id);
    const editorMembership = await h.db
      .forOrg(org.id)
      .memberships.getByUser(members.editor.user.id);

    const demote = await members.admin
      .post(`/app/o/${orgId}/members/${ownerMembership.id}/role`, { role: 'viewer' })
      .expect(303);
    assert.match(demote.headers.location, /notice=not-allowed/);
    const remove = await members.admin
      .post(`/app/o/${orgId}/members/${ownerMembership.id}/remove`)
      .expect(303);
    assert.match(remove.headers.location, /notice=not-allowed/);
    const promote = await members.admin
      .post(`/app/o/${orgId}/members/${editorMembership.id}/role`, { role: 'owner' })
      .expect(303);
    assert.match(promote.headers.location, /notice=not-allowed/);

    assert.equal((await h.db.forOrg(org.id).memberships.get(ownerMembership.id)).role, 'owner');
    assert.equal((await h.db.forOrg(org.id).memberships.get(editorMembership.id)).role, 'editor');
  });

  test('an admin can invite an editor but not an owner', async () => {
    const { members, orgId } = await team();
    await members.admin
      .post(`/app/o/${orgId}/invitations`, { email: 'new.editor@example.test', role: 'editor' })
      .expect(303);
    const bad = await members.admin
      .post(`/app/o/${orgId}/invitations`, { email: 'new.owner@example.test', role: 'owner' })
      .expect(422);
    assert.match(bad.text, /Choose a role you’re allowed to give/);
    assert.equal(h.mailer.sent.filter((s) => s.to === 'new.owner@example.test').length, 0);
  });

  test('an owner changes a role and removes a member; the page confirms each', async () => {
    const { owner, members, orgId, org } = await team();
    const viewer = await h.db.forOrg(org.id).memberships.getByUser(members.viewer.user.id);

    const changed = await owner
      .post(`/app/o/${orgId}/members/${viewer.id}/role`, { role: 'editor' })
      .expect(303);
    assert.match(changed.headers.location, /notice=role-changed/);
    const page = await owner.get(changed.headers.location).expect(200);
    assert.match(page.text, /Role updated\./);
    assert.equal((await h.db.forOrg(org.id).memberships.get(viewer.id)).role, 'editor');

    const removed = await owner.post(`/app/o/${orgId}/members/${viewer.id}/remove`).expect(303);
    assert.match(removed.headers.location, /notice=member-removed/);
    assert.equal(await h.db.forOrg(org.id).memberships.get(viewer.id), null);
    await members.viewer.get(`/app/o/${orgId}`).expect(404);
  });

  test('the only owner cannot be demoted or removed, and is told why', async () => {
    const { owner, orgId, org } = await team();
    const mine = await h.db.forOrg(org.id).memberships.getByUser(owner.user.id);
    const demote = await owner
      .post(`/app/o/${orgId}/members/${mine.id}/role`, { role: 'admin' })
      .expect(303);
    assert.match(demote.headers.location, /notice=last-owner/);
    const page = await owner.get(demote.headers.location).expect(200);
    assert.match(page.text, /needs at least one owner/);
    const remove = await owner.post(`/app/o/${orgId}/members/${mine.id}/remove`).expect(303);
    assert.match(remove.headers.location, /notice=last-owner/);
    assert.equal((await h.db.forOrg(org.id).memberships.get(mine.id)).role, 'owner');
  });

  test('a made-up role is refused', async () => {
    const { owner, members, orgId, org } = await team();
    const editor = await h.db.forOrg(org.id).memberships.getByUser(members.editor.user.id);
    const res = await owner
      .post(`/app/o/${orgId}/members/${editor.id}/role`, { role: 'superuser' })
      .expect(303);
    assert.match(res.headers.location, /notice=not-allowed/);
    assert.equal((await h.db.forOrg(org.id).memberships.get(editor.id)).role, 'editor');
  });

  test('a notice code that is not on our list shows nothing (no text from the URL)', async () => {
    const { owner, orgId } = await team();
    const res = await owner
      .get(`/app/o/${orgId}/settings?notice=<script>alert(1)</script>`)
      .expect(200);
    assert.doesNotMatch(res.text, /<script>alert/);
    assert.doesNotMatch(res.text, /role="status"[^>]*>[^<]*alert/);
  });

  test('ids in the URL that are not numbers or ULIDs are plain 404s', async () => {
    const { owner, orgId } = await team();
    await owner.post(`/app/o/${orgId}/members/abc/remove`).expect(404);
    await owner.post(`/app/o/${orgId}/members/99999999999999999999/remove`).expect(404);
    await owner.get('/app/o/not-an-id/settings').expect(404);
    await owner.get(`/app/o/${ULID}/settings`).expect(404);
  });
});

describe('invitations by email', () => {
  async function owned() {
    const owner = await h.signedIn({ name: 'Maya Chen' });
    const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Invite Co' }).expect(303));
    const org = (await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id }))
      .org;
    return { owner, orgId, org };
  }

  test('inviting sends one email with a link, and stores only a hash of the token', async () => {
    const { owner, orgId, org } = await owned();
    const before = h.mailer.sent.length;
    const res = await owner
      .post(`/app/o/${orgId}/invitations`, { email: ' Sam@Example.TEST ', role: 'editor' })
      .expect(303);
    assert.match(res.headers.location, /notice=invite-sent/);

    const sent = h.mailer.sent.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'sam@example.test');
    assert.match(sent[0].email.subject, /Maya Chen invited you to Invite Co/);
    const token = tokenIn(sent[0].email.text);
    assert.ok(token, 'the plain-text email has the link');
    assert.ok(sent[0].email.html.includes(`${BASE}/invite/${token}`));

    const [pending] = await h.db.forOrg(org.id).invitations.listPending();
    assert.equal(pending.email, 'sam@example.test');
    assert.equal(pending.role, 'editor');
    assert.notEqual(Buffer.from(pending.token_hash).toString('utf8'), token);

    const page = await owner.get(`/app/o/${orgId}/settings`).expect(200);
    assert.match(page.text, /sam@example\.test/);
  });

  test('a bad address or an existing member is explained on the form', async () => {
    const { owner, orgId } = await owned();
    const bad = await owner
      .post(`/app/o/${orgId}/invitations`, { email: 'not-an-email', role: 'viewer' })
      .expect(422);
    assert.match(bad.text, /Enter a valid email address\./);
    const self = await owner
      .post(`/app/o/${orgId}/invitations`, { email: owner.user.email, role: 'viewer' })
      .expect(422);
    assert.match(self.text, /already a member/);
  });

  test('if the email cannot be sent the invitation is kept and the page says so', async () => {
    const { owner, orgId, org } = await owned();
    const original = h.mailer.send;
    h.mailer.send = async () => {
      throw new Error('provider down');
    };
    try {
      const res = await owner
        .post(`/app/o/${orgId}/invitations`, { email: 'late@example.test', role: 'viewer' })
        .expect(303);
      assert.match(res.headers.location, /notice=invite-email-failed/);
      assert.match((await owner.get(res.headers.location)).text, /could not be sent/);
    } finally {
      h.mailer.send = original;
    }
    assert.equal((await h.db.forOrg(org.id).invitations.listPending()).length, 1);
  });

  test('send again replaces the link; cancel withdraws it', async () => {
    const { owner, orgId, org } = await owned();
    await owner
      .post(`/app/o/${orgId}/invitations`, { email: 'again@example.test', role: 'viewer' })
      .expect(303);
    const firstToken = tokenIn(h.mailer.sent.at(-1).email.text);
    const [invitation] = await h.db.forOrg(org.id).invitations.listPending();

    await owner.post(`/app/o/${orgId}/invitations/${invitation.id}/resend`).expect(303);
    const secondToken = tokenIn(h.mailer.sent.at(-1).email.text);
    assert.notEqual(firstToken, secondToken);
    assert.equal((await h.agent.get(`/invite/${firstToken}`)).status, 404);
    assert.equal((await h.agent.get(`/invite/${secondToken}`)).status, 200);

    await owner.post(`/app/o/${orgId}/invitations/${invitation.id}/cancel`).expect(303);
    assert.deepEqual(await h.db.forOrg(org.id).invitations.listPending(), []);
    await owner.post(`/app/o/${orgId}/invitations/${invitation.id}/cancel`).expect(404);
  });

  test('the invite page: signed out, it asks them to sign in with the invited address', async () => {
    const { owner, orgId } = await owned();
    await owner
      .post(`/app/o/${orgId}/invitations`, { email: 'sam.lee@example.test', role: 'editor' })
      .expect(303);
    const token = tokenIn(h.mailer.sent.at(-1).email.text);

    const page = await h.agent.get(`/invite/${token}`).expect(200);
    assert.match(page.text, /Join Invite Co/);
    assert.match(page.text, /Editor/);
    assert.match(page.text, /s•••@example\.test/);
    assert.doesNotMatch(
      page.text,
      /sam\.lee@example\.test/,
      'the full address is not shown to a link holder',
    );
    assert.ok(page.text.includes(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`));
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
  });

  test('signed in with the invited address: accept creates the membership and opens the organization', async () => {
    const { owner, orgId, org } = await owned();
    const invitee = await h.signedIn({ name: 'Sam Lee' });
    await owner
      .post(`/app/o/${orgId}/invitations`, { email: invitee.user.email, role: 'editor' })
      .expect(303);
    const token = tokenIn(h.mailer.sent.at(-1).email.text);

    const page = await invitee.get(`/invite/${token}`).expect(200);
    assert.match(page.text, /Accept invitation/);

    const accepted = await invitee.post(`/invite/${token}/accept`).expect(303);
    assert.equal(accepted.headers.location, `/app/o/${orgId}?notice=joined`);
    const membership = await h.db.forOrg(org.id).memberships.getByUser(invitee.user.id);
    assert.equal(membership.role, 'editor');

    const again = await invitee.get(`/invite/${token}`).expect(200);
    assert.match(again.text, /already used/);
    const shell = await invitee.get(accepted.headers.location).expect(200);
    assert.match(shell.text, /You’ve joined the organization/);
  });

  test('signed in as a different person: the page refuses and offers to sign out', async () => {
    const { owner, orgId, org } = await owned();
    await owner
      .post(`/app/o/${orgId}/invitations`, { email: 'someone.else@example.test', role: 'admin' })
      .expect(303);
    const token = tokenIn(h.mailer.sent.at(-1).email.text);

    const stranger = await h.signedIn();
    const page = await stranger.get(`/invite/${token}`).expect(200);
    assert.match(page.text, /This isn’t the right account/);
    assert.doesNotMatch(page.text, /Accept invitation/);

    await stranger.post(`/invite/${token}/accept`).expect(303);
    assert.equal(await h.db.forOrg(org.id).memberships.getByUser(stranger.user.id), null);
  });

  test('an address Clerk has not verified does not count, even if it matches', async () => {
    const { owner, orgId, org } = await owned();
    const impostor = await h.signedIn(
      {},
      { emails: [{ address: 'victim@example.test', verified: false, primary: true }] },
    );
    await owner
      .post(`/app/o/${orgId}/invitations`, { email: 'victim@example.test', role: 'admin' })
      .expect(303);
    const token = tokenIn(h.mailer.sent.at(-1).email.text);

    const page = await impostor.get(`/invite/${token}`).expect(200);
    assert.match(page.text, /This isn’t the right account/);
    await impostor.post(`/invite/${token}/accept`).expect(303);
    assert.equal(await h.db.forOrg(org.id).memberships.getByUser(impostor.user.id), null);
  });

  test('accepting needs the CSRF token and a signed-in user', async () => {
    const { owner, orgId } = await owned();
    const invitee = await h.signedIn();
    await owner
      .post(`/app/o/${orgId}/invitations`, { email: invitee.user.email, role: 'viewer' })
      .expect(303);
    const token = tokenIn(h.mailer.sent.at(-1).email.text);
    await h.agent.post(`/invite/${token}/accept`).type('form').send({}).expect(401);
    await invitee.post(`/invite/${token}/accept`, {}, { csrf: null }).expect(403);
  });

  test('unknown and expired links get clear pages', async () => {
    const { owner, orgId, org } = await owned();
    const missing = await h.agent.get(`/invite/${'x'.repeat(43)}`).expect(404);
    assert.match(missing.text, /We can’t find that invitation/);

    await owner
      .post(`/app/o/${orgId}/invitations`, { email: 'old@example.test', role: 'viewer' })
      .expect(303);
    const token = tokenIn(h.mailer.sent.at(-1).email.text);
    const [inv] = await h.db.forOrg(org.id).invitations.listPending();
    await h.db.forOrg(org.id).invitations.reissue({
      invitationId: inv.id,
      tokenHash: (await import('../../src/lib/tokens.js')).hashToken(token),
      expiresAt: new Date(Date.now() - 1000),
      actorUserId: owner.user.id,
    });
    const expired = await h.agent.get(`/invite/${token}`).expect(200);
    assert.match(expired.text, /This invitation has expired/);
  });
});

describe('signing out', () => {
  test('revokes the Clerk session, clears Clerk cookies and goes home', async () => {
    const u = await h.signedIn();
    const res = await u
      .post('/sign-out', {}, { extra: { Cookie: '__session=abc; __client_uat=1; theme=dark' } })
      .expect(303);
    assert.equal(res.headers.location, '/');
    assert.ok(h.provider.revoked.includes(u.sessionId));
    const cleared = res.headers['set-cookie'].join(' ');
    assert.match(cleared, /__session=;/);
    assert.match(cleared, /__client_uat=;/);
    assert.doesNotMatch(cleared, /theme/);
  });

  test('needs the CSRF token', async () => {
    const u = await h.signedIn();
    await u.post('/sign-out', {}, { csrf: null }).expect(403);
    assert.ok(!h.provider.revoked.includes(u.sessionId));
  });

  test('still signs the browser out if Clerk cannot be reached', async () => {
    const u = await h.signedIn();
    const original = h.provider.endSession;
    h.provider.endSession = async () => {
      throw new Error('Clerk is down');
    };
    try {
      await u.post('/sign-out').expect(303);
    } finally {
      h.provider.endSession = original;
    }
  });
});
