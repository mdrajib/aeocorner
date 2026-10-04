import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { refreshProject } from '../../src/worker/handlers/actions.js';
import { authHarness, orgPathOf } from './auth-helpers.js';

/**
 * The Action Center screens (Milestone 6): sign-in and scoping, the list and its empty states, one recommendation, the
 * moves a person can make and who may make them, and what a result looks like. The rules are tested in
 * src/core/*.test.js and the reads and writes in tests/integration/actions-repo.test.js.
 */
const added = [];
let failQueue = false;
const jobs = {
  added,
  async add(name, data, options) {
    if (failQueue) throw new Error('redis is down');
    added.push({ name, data, options });
  },
};
const h = authHarness({ jobs });
after(() => h.close());

let n = 0;
const unique = () => `${Date.now().toString(36)}${n++}`;

/** An organization with an owner, an editor and a viewer, and a project with one question and a scan that found two things. */
async function withActions({ raise = true } = {}) {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Action Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  const editor = await h.signedIn();
  await scoped.memberships.add({ userId: editor.user.id, role: 'editor' });
  const viewer = await h.signedIn();
  await scoped.memberships.add({ userId: viewer.user.id, role: 'viewer' });
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: `act-${unique()}.example.test`,
      name: 'Action Dental',
      country: 'US',
      language: 'en',
    })
    .expect(303);
  const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  const q = (
    await scoped.prompts.add(project.id, { text: 'Best family dentist?', intent: 'discovery' })
  ).prompt;
  await h.fx.scan(project, {
    checks: [
      {
        code: 'A1',
        status: 'fail',
        points: 0,
        possible: 8,
        summary: 'robots.txt blocks OAI-SearchBot',
      },
      { code: 'C1', status: 'partial', points: 3, possible: 6 },
    ],
  });
  if (raise) await refreshProject({ db: h.db, scoped }, { projectId: project.id, now: new Date() });
  const list = raise ? await scoped.recommendations.list(project.id, { view: 'todo' }) : [];
  const rec = (code) => list.find((r) => r.ruleCode === code);
  return {
    owner,
    editor,
    viewer,
    orgId,
    scoped,
    project,
    q,
    rec,
    base: `/app/o/${orgId}/projects/${pid}`,
  };
}

describe('sign-in and scoping', () => {
  test('every screen and every move needs a signed-in person', async () => {
    const ctx = await withActions();
    const a1 = ctx.rec('readiness.A1');
    for (const path of ['/actions', `/actions/${a1.id}`]) {
      const res = await h.agent.get(`${ctx.base}${path}`);
      assert.equal(res.status, 302, path);
      assert.match(res.headers.location, /sign-in/, path);
    }
    for (const move of ['start', 'stop', 'done', 'dismiss', 'confirm', 'redo']) {
      const res = await h.agent.post(`${ctx.base}/actions/${a1.id}/${move}`).type('form').send({});
      assert.notEqual(res.status, 303, move);
    }
  });

  test('another organization’s project and recommendation are a plain 404', async () => {
    const mine = await withActions({ raise: false });
    const theirs = await withActions();
    const rec = theirs.rec('readiness.A1');
    await theirs.owner.get(`${theirs.base}/actions`).expect(200);
    await theirs.owner.get(`${theirs.base}/actions/${rec.id}`).expect(200);
    await mine.owner.get(`${theirs.base}/actions`).expect(404);
    await mine.owner.get(`${theirs.base}/actions/${rec.id}`).expect(404);
    // their recommendation's ID, asked for through my own project
    await mine.owner.get(`${mine.base}/actions/${rec.id}`).expect(404);
    await mine.owner.get(`${mine.base}/actions/nope`).expect(404);
    await mine.owner.post(`${mine.base}/actions/${rec.id}/start`, {}).expect(404);
    await mine.owner.post(`${mine.base}/actions/${rec.id}/done`, {}).expect(404);
    const still = await theirs.scoped.recommendations.get(theirs.project.id, rec.id);
    assert.equal(still.recommendation.status, 'open');
  });

  test('a client seat sees the Action Center only for its own projects', async () => {
    const ctx = await withActions();
    const elsewhere = await h.fx.project(ctx.project.org_id, 'Elsewhere');
    const membership = await ctx.scoped.memberships.getByUser(ctx.viewer.user.id);
    await ctx.scoped.memberships.setProjectAccess({
      membershipId: membership.id,
      access: 'selected',
      projectIds: [elsewhere.id],
    });
    await ctx.viewer.get(`${ctx.base}/actions`).expect(404);
    await ctx.viewer.get(`${ctx.base}/actions/${ctx.rec('readiness.A1').id}`).expect(404);
  });
});

describe('the list', () => {
  test('ranked best first, with what each is, how hard, and how much it touches', async () => {
    const ctx = await withActions();
    const page = await ctx.owner.get(`${ctx.base}/actions`).expect(200);
    assert.match(page.text, /Action Center/);
    assert.match(page.text, /Priority 1/);
    assert.match(page.text, /Priority 2/);
    assert.match(page.text, /Let AI search crawlers read your site/);
    assert.match(page.text, /Quick fix/);
    assert.match(page.text, /Effort: Low/);
    assert.match(page.text, /Affects all your questions/);
    assert.match(page.text, /Proven wins/);
    assert.match(page.text, /To do <span[^>]*>\(2\)/);
    // the A1 fix (impact 100, effort 1) outranks the half-lost C1 one
    assert.ok(
      page.text.indexOf('Let AI search crawlers') < page.text.indexOf('Add Organization schema'),
    );
  });

  test('an editor can start from the list, a viewer cannot', async () => {
    const ctx = await withActions();
    const editor = await ctx.editor.get(`${ctx.base}/actions`).expect(200);
    assert.match(editor.text, /action="[^"]*\/start"/);
    assert.match(editor.text, /name="_csrf"/);
    const viewer = await ctx.viewer.get(`${ctx.base}/actions`).expect(200);
    assert.doesNotMatch(viewer.text, /action="[^"]*\/start"/);
  });

  test('each empty view says why it is empty', async () => {
    const ctx = await withActions({ raise: false });
    const todo = await ctx.owner.get(`${ctx.base}/actions`).expect(200);
    assert.match(todo.text, /Nothing to fix right now/);
    for (const [view, words] of [
      ['progress', /Nothing is being checked or measured/],
      ['results', /No results yet/],
      ['dismissed', /Nothing dismissed/],
    ]) {
      assert.match(
        (await ctx.owner.get(`${ctx.base}/actions?view=${view}`).expect(200)).text,
        words,
        view,
      );
    }
    assert.match(
      (await ctx.owner.get(`${ctx.base}/actions?view=nonsense`).expect(200)).text,
      /Nothing to fix right now/,
    );
  });

  test('uses no inline script or style', async () => {
    const ctx = await withActions();
    const page = await ctx.owner.get(`${ctx.base}/actions`).expect(200);
    assert.doesNotMatch(page.text, /<script(?![^>]*(?:src=|application\/ld\+json))[^>]*>/);
    assert.doesNotMatch(page.text, /\sstyle="/);
  });
});

describe('one recommendation', () => {
  test('shows why, the evidence, the steps, the questions and the history', async () => {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.A1');
    const page = await ctx.owner.get(`${ctx.base}/actions/${rec.id}`).expect(200);
    assert.match(page.text, /Why this matters/);
    assert.match(page.text, /robots\.txt blocks OAI-SearchBot/);
    assert.match(page.text, /The evidence/);
    assert.match(page.text, /points/);
    assert.match(page.text, /How to fix it/);
    assert.match(page.text, /Mark as done/);
    assert.match(page.text, /Best family dentist\?/);
    assert.match(page.text, /Raised from evidence/);
    assert.match(page.text, /can be applied for you once your WordPress site is connected/);
    assert.match(page.text, /Ready when you are/);
  });

  test('a viewer sees it, with no buttons and a word about who may change it', async () => {
    const ctx = await withActions();
    const page = await ctx.viewer
      .get(`${ctx.base}/actions/${ctx.rec('readiness.A1').id}`)
      .expect(200);
    assert.match(page.text, /Why this matters/);
    assert.doesNotMatch(page.text, />Mark as done</);
    assert.match(page.text, /owners, admins and editors/);
  });
});

describe('the moves', () => {
  const move = (ctx, who, rec, name, body = {}) =>
    ctx[who].post(`${ctx.base}/actions/${rec.id}/${name}`, body);
  const statusOf = async (ctx, rec) =>
    (await ctx.scoped.recommendations.get(ctx.project.id, rec.id)).recommendation.status;

  test('start and stop', async () => {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.C1');
    const res = await move(ctx, 'editor', rec, 'start').expect(303);
    assert.match(res.headers.location, /notice=action-started/);
    assert.equal(await statusOf(ctx, rec), 'in_progress');
    await move(ctx, 'editor', rec, 'stop').expect(303);
    assert.equal(await statusOf(ctx, rec), 'open');
  });

  test('a viewer cannot make any move', async () => {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.C1');
    for (const name of ['start', 'stop', 'done', 'dismiss', 'confirm', 'redo']) {
      await move(ctx, 'viewer', rec, name, { reason: 'wont_do' }).expect(403);
    }
    assert.equal(await statusOf(ctx, rec), 'open');
  });

  test('a move without the CSRF token is refused', async () => {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.C1');
    const res = await ctx.editor.post(`${ctx.base}/actions/${rec.id}/start`, {}, { csrf: 'wrong' });
    assert.equal(res.status, 403);
    assert.equal(await statusOf(ctx, rec), 'open');
  });

  test('marking a readiness fix done queues the re-check at once, and the page says it is checking', async () => {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.A1');
    added.length = 0;
    const res = await move(ctx, 'editor', rec, 'done').expect(303);
    assert.match(res.headers.location, /notice=action-done-checking/);
    assert.equal(await statusOf(ctx, rec), 'done');
    const queued = added.find((j) => j.name === 'fix.verify');
    assert.deepEqual(queued.data, {
      orgId: String(ctx.scoped.orgId),
      recommendationId: String(rec.id),
      attempt: 1,
    });
    assert.match(queued.options.jobId, /^fixverify-\d+-a1$/);
    const page = await ctx.owner.get(`${ctx.base}/actions/${rec.id}`).expect(200);
    assert.match(page.text, /We are checking your site/);
    assert.match(page.text, /data-auto-refresh="15"/);
    assert.match(page.text, /Check 1 of 3: <\/dt><dd[^>]*>waiting|Check 1 of 3:/);
    const list = await ctx.owner.get(`${ctx.base}/actions?view=progress`).expect(200);
    assert.match(list.text, /Add Organization schema|Let AI search crawlers/);
  });

  test('a queue that is down does not lose the fix', async () => {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.A1');
    failQueue = true;
    try {
      await move(ctx, 'editor', rec, 'done').expect(303);
    } finally {
      failQueue = false;
    }
    assert.equal(await statusOf(ctx, rec), 'done');
    const overdueSoon = await ctx.scoped.recommendations.verificationsOf(ctx.project.id, rec.id);
    assert.equal(
      overdueSoon.length,
      3,
      'the re-checks are planned; the daily sweep asks for the first',
    );
  });

  test('a fix that cannot be checked by machine goes straight to measuring', async () => {
    const ctx = await withActions();
    const run = await h.fx.run(ctx.project, { status: 'complete' });
    const brand = (await ctx.scoped.entities.list(ctx.project.id, { kind: 'brand' }))[0];
    const rival = await h.fx.entity(ctx.project, { kind: 'competitor', name: 'Rival Smiles' });
    await ctx.scoped.projectEngines.setEnabled(ctx.project.id, ['perplexity']);
    await h.fx.cell(run, ctx.q, {
      engine: 'perplexity',
      brand,
      brandK: 0,
      nOk: 10,
      rivals: [{ entity: rival, k: 6 }],
    });
    await refreshProject(
      { db: h.db, scoped: ctx.scoped },
      { projectId: ctx.project.id, now: new Date() },
    );
    const lost = (await ctx.scoped.recommendations.list(ctx.project.id)).find(
      (r) => r.ruleCode === 'visibility.lost_prompt',
    );
    assert.ok(lost);
    added.length = 0;
    const res = await move(ctx, 'owner', lost, 'done').expect(303);
    assert.match(res.headers.location, /notice=action-done-measuring/);
    assert.equal(added.filter((j) => j.name === 'fix.verify').length, 0);
    assert.equal(await statusOf(ctx, lost), 'measuring');
    const page = await ctx.owner.get(`${ctx.base}/actions/${lost.id}`).expect(200);
    assert.match(page.text, /We are measuring the effect/);
    assert.match(page.text, /cannot check this kind of fix automatically/);
    assert.match(page.text, /Check at 2 weeks/);
    assert.match(page.text, /0 of 10 answers named you/);
  });

  test('dismissing needs a reason, and moves it to Dismissed', async () => {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.C1');
    const bad = await move(ctx, 'editor', rec, 'dismiss', { reason: '' }).expect(303);
    assert.match(bad.headers.location, /notice=action-reason/);
    assert.equal(await statusOf(ctx, rec), 'open');
    const ok = await move(ctx, 'editor', rec, 'dismiss', {
      reason: 'wont_do',
      note: 'Not now',
    }).expect(303);
    assert.match(ok.headers.location, /notice=action-dismissed/);
    assert.equal(await statusOf(ctx, rec), 'dismissed');
    const list = await ctx.owner.get(`${ctx.base}/actions?view=dismissed`).expect(200);
    assert.match(list.text, /Add Organization schema/);
    const page = await ctx.owner.get(`${ctx.base}/actions/${rec.id}`).expect(200);
    assert.match(page.text, /We won’t do this\. “Not now”/);
  });

  test('a move the page is out of date for says so and changes nothing', async () => {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.C1');
    await move(ctx, 'editor', rec, 'start').expect(303);
    const again = await move(ctx, 'editor', rec, 'start').expect(303);
    assert.match(again.headers.location, /notice=action-stale/);
    const confirm = await move(ctx, 'editor', rec, 'confirm').expect(303);
    assert.match(
      confirm.headers.location,
      /notice=action-stale/,
      'a person cannot start measuring from in progress',
    );
    assert.equal(await statusOf(ctx, rec), 'in_progress');
  });

  test('an unverified fix can be confirmed or fixed again', async () => {
    const ctx = await withActions();
    const a = ctx.rec('readiness.A1');
    const c = ctx.rec('readiness.C1');
    for (const rec of [a, c]) {
      await ctx.scoped.recommendations.markDone(ctx.project.id, rec.id, {
        userId: ctx.owner.user.id,
      });
      await ctx.scoped.recommendations.settleVerification(ctx.project.id, rec.id, {
        verdict: 'unverified',
        reason: 'still_failing',
      });
    }
    const page = await ctx.owner.get(`${ctx.base}/actions/${a.id}`).expect(200);
    assert.match(page.text, /We could not confirm the fix/);
    assert.match(page.text, /The change is live: start measuring/);
    assert.match(page.text, /Fix it again/);
    await move(ctx, 'editor', a, 'confirm').expect(303);
    assert.equal(await statusOf(ctx, a), 'measuring');
    await move(ctx, 'editor', c, 'redo').expect(303);
    assert.equal(await statusOf(ctx, c), 'in_progress');
  });
});

describe('results', () => {
  async function withResult(verdict, extra = {}) {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.A1');
    await ctx.scoped.recommendations.markDone(ctx.project.id, rec.id, {
      userId: ctx.owner.user.id,
    });
    await ctx.scoped.recommendations.settleVerification(ctx.project.id, rec.id, {
      verdict: 'verified',
      reason: 'passed',
    });
    const row = await h.fx.forceOutcome(
      { ...rec, org_id: ctx.project.org_id, project_id: ctx.project.id },
      { verdict, ...extra },
    );
    const end = {
      proven_win: 'proven_win',
      declined: 'declined',
      no_change: 'no_change',
      insufficient_data: 'no_change',
    }[verdict];
    await h.fx.forceRecommendation(rec.id, { status: end });
    return { ...ctx, rec, row };
  }

  test('a proven win says what happened, in numbers, and how sure we are', async () => {
    const ctx = await withResult('proven_win');
    const page = await ctx.owner.get(`${ctx.base}/actions/${ctx.rec.id}`).expect(200);
    assert.match(page.text, /What happened/);
    assert.match(page.text, /Proven win/);
    assert.match(page.text, /from 10 of 120 to 40 of 118 answers/);
    assert.match(page.text, /How sure are we\?/);
    assert.match(page.text, /p &lt; 0\.001/);
    const list = await ctx.owner.get(`${ctx.base}/actions?view=results`).expect(200);
    assert.match(list.text, /from 10 of 120 to 40 of 118 answers/);
    assert.match(list.text, /Proven wins<\/p>\s*<p[^>]*>[^<]*1</);
  });

  test('"not enough data" is not "no change", and shows no change figure', async () => {
    const ctx = await withResult('insufficient_data', {
      nBefore: 5,
      kBefore: 1,
      nAfter: 8,
      kAfter: 3,
    });
    const page = await ctx.owner.get(`${ctx.base}/actions/${ctx.rec.id}`).expect(200);
    assert.match(page.text, /Not enough data/);
    assert.match(page.text, /at least 20 readable answers/);
    assert.doesNotMatch(page.text, /percentage points/);
    assert.doesNotMatch(page.text, /Within normal variation/);
  });

  test('a decline is stated plainly', async () => {
    const ctx = await withResult('declined', {
      kBefore: 40,
      nBefore: 120,
      kAfter: 10,
      nAfter: 118,
    });
    const page = await ctx.owner.get(`${ctx.base}/actions/${ctx.rec.id}`).expect(200);
    assert.match(page.text, /Declined/);
    assert.match(page.text, /drop is bigger than normal variation/);
  });
});

describe('on the dashboard', () => {
  test('the best three actions are there, with the way into the Action Center', async () => {
    const ctx = await withActions();
    await ctx.scoped.projects.startTracking(ctx.project.id, { actorUserId: ctx.owner.user.id });
    const page = await ctx.owner.get(`${ctx.base}/dashboard`).expect(200);
    assert.match(page.text, /Top actions/);
    assert.match(page.text, /Let AI search crawlers read your site/);
    assert.match(page.text, new RegExp(`${ctx.base}/actions`));
  });

  test('the project nav has an Actions tab', async () => {
    const ctx = await withActions();
    const page = await ctx.owner.get(`${ctx.base}/actions`).expect(200);
    assert.match(page.text, /aria-current="page">Actions</);
  });
});
