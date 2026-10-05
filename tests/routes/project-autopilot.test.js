import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { authHarness, orgPathOf } from './auth-helpers.js';

/**
 * The Autopilot screen (Milestone 15, ADR-0016): who can see it and who can change it, what each state says, and above all that
 * it has no way to approve anything. Items are written through the repository, as the tick does; the tick itself is tested in
 * tests/integration/autopilot-jobs.test.js.
 */
const h = authHarness({});
after(() => h.close());

let n = 0;
const unique = () => `${Date.now().toString(36)}${n++}`;

async function world({ plan = null } = {}) {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Autopilot Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  if (plan) await h.fx.setOrg(found.org.id, { plan_code: plan, billing_status: 'active' });
  const admin = await h.signedIn();
  await scoped.memberships.add({ userId: admin.user.id, role: 'admin' });
  const editor = await h.signedIn();
  await scoped.memberships.add({ userId: editor.user.id, role: 'editor' });
  const viewer = await h.signedIn();
  await scoped.memberships.add({ userId: viewer.user.id, role: 'viewer' });
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: `autopilot-${unique()}.example.test`,
      name: 'Autopilot Dental',
      country: 'US',
      language: 'en',
    })
    .expect(303);
  const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  return {
    owner,
    admin,
    editor,
    viewer,
    orgId,
    scoped,
    project,
    base: `/app/o/${orgId}/projects/${pid}`,
  };
}

const ON = { enabled: true, allowAutoFix: true, allowContent: true, weeklyDrafts: 2 };

/** A fix Autopilot prepared: the recommendation and its ready item. */
async function prepared(ctx, over = {}) {
  const rec = await h.fx.recommendation(ctx.project, {
    rule_code: 'readiness.C1',
    category: 'structured_data',
    fix_path: 'auto_fix',
    title: 'Add Organization schema',
    ...over,
  });
  const { item } = await ctx.scoped.autopilot.prepare(ctx.project.id, {
    recommendationId: rec.id,
    kind: 'auto_fix',
    basisHash: String(unique()).padEnd(64, 'a'),
    weekKey: '2026-W41',
    title: 'Add Organization schema to your home page',
    summary: 'The name “Autopilot Dental”; The address https://autopilot.example.test/.',
    preparedHash: 'c'.repeat(64),
    prepared: { kind: 'jsonld', scope: 'home' },
  });
  return { rec, item };
}

describe('who can see it', () => {
  test('anyone who can see the project; another organization gets a plain 404; a stranger is sent to sign in', async () => {
    const ctx = await world();
    for (const who of ['owner', 'admin', 'editor', 'viewer']) {
      await ctx[who].get(`${ctx.base}/autopilot`).expect(200);
    }
    const other = await world();
    await other.owner.get(`${ctx.base}/autopilot`).expect(404);
    const stranger = await h.agent.get(`${ctx.base}/autopilot`);
    assert.equal(stranger.status, 302);
    assert.match(stranger.headers.location, /sign-in/);
  });

  test('it is a tab of the project', async () => {
    const ctx = await world();
    const page = await ctx.owner.get(`${ctx.base}/actions`).expect(200);
    assert.match(page.text, new RegExp(`href="${ctx.base}/autopilot"`));
  });
});

describe('what it says', () => {
  test('off by default: says what it is, that a person approves, and that nothing is waiting', async () => {
    const ctx = await world();
    const page = await ctx.owner.get(`${ctx.base}/autopilot`).expect(200);
    assert.match(page.text, /Fixes and drafts, prepared for you/);
    assert.match(page.text, /You review and approve every one/);
    assert.match(page.text, /never changes your site and never publishes by itself/);
    assert.match(page.text, /Autopilot is off for this project/);
    assert.match(page.text, /Nothing is waiting for you/);
    assert.doesNotMatch(page.text, /undefined|NaN/);
    assert.doesNotMatch(page.text, /<script(?![^>]*(?:src=|application\/ld\+json))[^>]*>/);
    assert.doesNotMatch(page.text, /\sstyle="/);
  });

  test('a ready item links to the screen where the exact code is shown and approved, and says nothing was sent', async () => {
    const ctx = await world();
    const { rec } = await prepared(ctx);
    const page = await ctx.owner.get(`${ctx.base}/autopilot`).expect(200);
    assert.match(page.text, /Add Organization schema to your home page/);
    assert.match(page.text, /Fix for your site/);
    assert.match(page.text, /Nothing has been sent to your site/);
    assert.match(page.text, new RegExp(`href="${ctx.base}/actions/${rec.id}/autofix"`));
    assert.match(page.text, /Review the code and approve/);
  });

  test('there is no way to approve from here: no approve form, no approve route', async () => {
    const ctx = await world();
    const { item } = await prepared(ctx);
    const page = await ctx.owner.get(`${ctx.base}/autopilot`).expect(200);
    assert.doesNotMatch(page.text, /action="[^"]*\/approve"/);
    assert.doesNotMatch(page.text, />\s*Approve\s*</);
    await ctx.owner.post(`${ctx.base}/autopilot/${item.publicId}/approve`, {}).expect(404);
    await ctx.owner.post(`${ctx.base}/autopilot/${item.publicId}`, {}).expect(404);
    assert.equal((await ctx.scoped.autopilot.get(ctx.project.id, item.publicId)).status, 'ready');
  });

  test('a draft still being written says where it stands and the page keeps looking', async () => {
    const ctx = await world();
    const rec = await h.fx.recommendation(ctx.project, { title: 'Write about whitening' });
    const draft = await h.fx.contentItem(ctx.project, {
      status: 'drafting',
      recommendationId: rec.id,
    });
    await ctx.scoped.autopilot.prepare(ctx.project.id, {
      recommendationId: rec.id,
      kind: 'content',
      basisHash: 'd'.repeat(64),
      weekKey: '2026-W41',
      title: 'Write about whitening',
      summary: 'A draft new page.',
      contentItemId: draft.id,
    });
    const page = await ctx.owner.get(`${ctx.base}/autopilot`).expect(200);
    assert.match(page.text, /Draft page/);
    assert.match(page.text, /Writing/);
    assert.match(page.text, /See how it is going/);
    assert.match(page.text, /data-auto-refresh/);
    assert.match(page.text, new RegExp(`/content/${draft.public_id}`));
  });

  test('a plan without Autopilot says so, and the switch is refused', async () => {
    const ctx = await world({ plan: 'starter' });
    const page = await ctx.owner.get(`${ctx.base}/autopilot`).expect(200);
    assert.match(page.text, /Not in your plan/);
    const res = await ctx.owner
      .post(`${ctx.base}/autopilot/settings`, { enabled: 'on', weeklyDrafts: '2' })
      .expect(303);
    assert.match(res.headers.location, /notice=autopilot-plan/);
    assert.equal((await ctx.scoped.autopilot.settings(ctx.project.id)).enabled, false);
  });
});

describe('the settings', () => {
  test('an owner or admin turns it on and chooses what it may do; an editor and a viewer cannot', async () => {
    const ctx = await world();
    const body = { enabled: 'on', allowAutoFix: 'on', weeklyDrafts: '3' };
    for (const who of ['editor', 'viewer']) {
      await ctx[who].post(`${ctx.base}/autopilot/settings`, body).expect(403);
    }
    assert.equal((await ctx.scoped.autopilot.settings(ctx.project.id)).enabled, false);

    const res = await ctx.admin.post(`${ctx.base}/autopilot/settings`, body).expect(303);
    assert.match(res.headers.location, /notice=autopilot-saved/);
    const saved = await ctx.scoped.autopilot.settings(ctx.project.id);
    assert.deepEqual(
      [saved.enabled, saved.allowAutoFix, saved.allowContent, saved.weeklyDrafts],
      [true, true, false, 3],
    );
    assert.equal(saved.updatedByUserId, ctx.admin.user.id);
    const page = await ctx.owner.get(`${ctx.base}/autopilot`).expect(200);
    assert.match(page.text, /Autopilot is on/);
    assert.match(page.text, /At most 3 drafts a week/);
  });

  test('a budget that is not a whole number from 0 to 10 is refused, not clipped', async () => {
    const ctx = await world();
    for (const bad of ['11', '-1', '2.5', 'lots']) {
      const res = await ctx.owner
        .post(`${ctx.base}/autopilot/settings`, { enabled: 'on', weeklyDrafts: bad })
        .expect(303);
      assert.match(res.headers.location, /notice=autopilot-invalid/, bad);
    }
    assert.equal((await ctx.scoped.autopilot.settings(ctx.project.id)).exists, false);
  });

  test('pausing and resuming are for an owner or admin, and stop everything new', async () => {
    const ctx = await world();
    await ctx.scoped.autopilot.saveSettings(ctx.project.id, ON, { userId: ctx.owner.user.id });
    await ctx.editor.post(`${ctx.base}/autopilot/pause`, {}).expect(403);
    const res = await ctx.owner.post(`${ctx.base}/autopilot/pause`, {}).expect(303);
    assert.match(res.headers.location, /notice=autopilot-paused/);
    let page = await ctx.viewer.get(`${ctx.base}/autopilot`).expect(200);
    assert.match(page.text, /Paused/);
    assert.match(page.text, /Only an owner or admin can change these settings/);
    await ctx.owner.post(`${ctx.base}/autopilot/resume`, {}).expect(303);
    page = await ctx.owner.get(`${ctx.base}/autopilot`).expect(200);
    assert.match(page.text, /Autopilot is on/);
  });

  test('a settings change without the CSRF token is refused', async () => {
    const ctx = await world();
    const res = await ctx.owner.post(
      `${ctx.base}/autopilot/settings`,
      { enabled: 'on', weeklyDrafts: '2' },
      { csrf: 'wrong' },
    );
    assert.equal(res.status, 403);
    assert.equal((await ctx.scoped.autopilot.settings(ctx.project.id)).enabled, false);
  });
});

describe('rejecting', () => {
  test('an editor or above rejects with a reason; it is kept and shown; a viewer cannot', async () => {
    const ctx = await world();
    const { item } = await prepared(ctx);
    const page = await ctx.viewer.get(`${ctx.base}/autopilot`).expect(200);
    assert.doesNotMatch(page.text, /\/reject"/, 'a viewer is offered no form');
    await ctx.viewer
      .post(`${ctx.base}/autopilot/${item.publicId}/reject`, { reason: 'not_now' })
      .expect(403);

    const res = await ctx.editor
      .post(`${ctx.base}/autopilot/${item.publicId}/reject`, {
        reason: 'wrong_content',
        note: 'Wrong logo',
      })
      .expect(303);
    assert.match(res.headers.location, /notice=autopilot-rejected/);
    const stored = await ctx.scoped.autopilot.get(ctx.project.id, item.publicId);
    assert.deepEqual(
      [stored.status, stored.rejectReason, stored.rejectNote, stored.decidedByUserId],
      ['rejected', 'wrong_content', 'Wrong logo', ctx.editor.user.id],
    );
    const after = await ctx.owner.get(`${ctx.base}/autopilot`).expect(200);
    assert.match(after.text, /Rejected/);
    assert.match(after.text, /What was prepared is wrong: Wrong logo/);
    assert.match(after.text, /Nothing is waiting for you/);
  });

  test('a reason from the list is required, and a decided item cannot be rejected again', async () => {
    const ctx = await world();
    const { item } = await prepared(ctx);
    for (const body of [{}, { reason: 'because' }]) {
      const res = await ctx.editor
        .post(`${ctx.base}/autopilot/${item.publicId}/reject`, body)
        .expect(303);
      assert.match(res.headers.location, /notice=autopilot-reason/);
    }
    await ctx.editor
      .post(`${ctx.base}/autopilot/${item.publicId}/reject`, { reason: 'not_now' })
      .expect(303);
    const again = await ctx.editor
      .post(`${ctx.base}/autopilot/${item.publicId}/reject`, { reason: 'other' })
      .expect(303);
    assert.match(again.headers.location, /notice=autopilot-stale/);
  });

  test('an unknown, malformed or other organization’s item is the same plain 404', async () => {
    const ctx = await world();
    const { item } = await prepared(ctx);
    await ctx.editor
      .post(`${ctx.base}/autopilot/${'0'.repeat(26)}/reject`, { reason: 'not_now' })
      .expect(404);
    await ctx.editor.post(`${ctx.base}/autopilot/nope/reject`, { reason: 'not_now' }).expect(404);
    const other = await world();
    await other.editor
      .post(`${ctx.base}/autopilot/${item.publicId}/reject`, { reason: 'not_now' })
      .expect(404);
    await other.editor
      .post(`${other.base}/autopilot/${item.publicId}/reject`, { reason: 'not_now' })
      .expect(404);
    assert.equal((await ctx.scoped.autopilot.get(ctx.project.id, item.publicId)).status, 'ready');
  });

  test('rejecting a draft takes it off the Content board', async () => {
    const ctx = await world();
    const rec = await h.fx.recommendation(ctx.project, { title: 'Write about whitening' });
    const draft = await h.fx.contentItem(ctx.project, {
      status: 'ready',
      html: '<p>x</p>',
      recommendationId: rec.id,
    });
    const { item } = await ctx.scoped.autopilot.prepare(ctx.project.id, {
      recommendationId: rec.id,
      kind: 'content',
      basisHash: 'e'.repeat(64),
      weekKey: '2026-W41',
      title: 'Write about whitening',
      contentItemId: draft.id,
    });
    await ctx.editor
      .post(`${ctx.base}/autopilot/${item.publicId}/reject`, { reason: 'not_useful' })
      .expect(303);
    const got = await ctx.scoped.content.get(ctx.project.id, draft.public_id);
    assert.equal(got.status, 'archived');
  });
});

describe('the fix screen says where the fix came from', () => {
  test('a fix Autopilot prepared carries a note on its own preview screen', async () => {
    const ctx = await world();
    const { rec } = await prepared(ctx);
    const page = await ctx.owner.get(`${ctx.base}/actions/${rec.id}/autofix`).expect(200);
    assert.match(page.text, /Autopilot prepared this on/);
    assert.match(page.text, /it waits for you/);
    const plain = await h.fx.recommendation(ctx.project, {
      rule_code: 'readiness.C4',
      fix_path: 'auto_fix',
      stable_key: 'x4',
      title: 'WebSite schema',
    });
    const other = await ctx.owner.get(`${ctx.base}/actions/${plain.id}/autofix`).expect(200);
    assert.doesNotMatch(other.text, /Autopilot prepared this/);
  });
});
