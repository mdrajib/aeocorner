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

describe('auto-fix: preview and approve (D3)', () => {
  const secret = {
    ciphertext: Buffer.alloc(40, 1),
    wrappedDek: Buffer.alloc(60, 2),
    keyVersion: 1,
  };

  /** The usual project, with its WordPress connected (the plugin too, unless `plugin: false`). */
  async function withSite({ plugin = true } = {}) {
    const ctx = await withActions();
    await ctx.scoped.integrations.saveWordpress(ctx.project.id, {
      config: {
        siteUrl: 'https://www.act-site.example.test',
        username: 'editor',
        pluginConnected: plugin,
      },
      secret,
      userId: ctx.owner.user.id,
    });
    ctx.c1 = ctx.rec('readiness.C1');
    ctx.page = `${ctx.base}/actions/${ctx.c1.id}/autofix`;
    return ctx;
  }
  const hashOf = (html) => html.match(/name="hash" value="([0-9a-f]{64})"/)?.[1];
  const form = (extra = {}) => ({ ...extra });

  test('the preview shows the exact code, where it goes, and what was left out', async () => {
    const ctx = await withSite();
    const page = await ctx.owner.get(ctx.page).expect(200);
    assert.match(page.text, /Add Organization schema|Organization schema on/);
    assert.match(page.text, /https:\/\/www\.act-site\.example\.test\//);
    assert.match(page.text, /&#34;@type&#34;: &#34;Organization&#34;/);
    assert.match(page.text, /Not included/);
    assert.match(page.text, /Approve and apply/);
    assert.ok(hashOf(page.text), 'the approval carries a fingerprint of what was shown');
  });

  test('a logo and profile links change the preview, and a bad address is refused with a message', async () => {
    const ctx = await withSite();
    const logo = encodeURIComponent('https://www.act-site.example.test/logo.png');
    const ok = await ctx.owner.get(`${ctx.page}?logoUrl=${logo}`).expect(200);
    assert.match(ok.text, /logo\.png/);
    assert.notEqual(hashOf(ok.text), hashOf((await ctx.owner.get(ctx.page)).text));
    const bad = await ctx.owner.get(`${ctx.page}?logoUrl=javascript:alert(1)`).expect(200);
    assert.match(bad.text, /full https:\/\/ address/);
  });

  test('only a fix the plugin can write has a preview; a viewer can read it but not approve', async () => {
    const ctx = await withSite();
    // The sitemap keeps its steps: WordPress already serves its own, so there is nothing for the plugin to write.
    const sitemap = await h.fx.recommendation(ctx.project, {
      rule_code: 'readiness.A4',
      category: 'technical',
      fix_path: 'guidance',
      title: 'Add a sitemap',
    });
    await ctx.owner.get(`${ctx.base}/actions/${sitemap.id}/autofix`).expect(404);
    const asViewer = await ctx.viewer.get(ctx.page).expect(200);
    assert.match(asViewer.text, /owners, admins and editors/);
    assert.doesNotMatch(asViewer.text, /Approve and apply/);
    const detail = await ctx.owner.get(`${ctx.base}/actions/${ctx.c1.id}`).expect(200);
    assert.match(detail.text, /We can do this for you/);
    const a4 = await ctx.owner.get(`${ctx.base}/actions/${sitemap.id}`).expect(200);
    assert.doesNotMatch(a4.text, /We can do this for you/);
  });

  test('without the plugin the page says so and offers no approval', async () => {
    const ctx = await withSite({ plugin: false });
    const page = await ctx.owner.get(ctx.page).expect(200);
    assert.match(page.text, /plugin is not connected/);
    assert.doesNotMatch(page.text, /Approve and apply/);
    const res = await ctx.owner
      .post(`${ctx.page}/approve`, form({ hash: 'x'.repeat(64) }))
      .expect(303);
    assert.match(res.headers.location, /autofix-no-plugin/);
    assert.equal(await ctx.scoped.autofix.current(ctx.project.id, ctx.c1.id), null);
  });

  test('approving what was shown queues the write once and puts the fix in progress', async () => {
    const ctx = await withSite();
    const hash = hashOf((await ctx.owner.get(ctx.page)).text);
    const before = added.length;
    const res = await ctx.owner.post(`${ctx.page}/approve`, form({ hash })).expect(303);
    assert.match(res.headers.location, /autofix-applying/);
    const job = added.slice(before).find((j) => j.name === 'autofix.apply');
    assert.ok(job);
    const change = await ctx.scoped.autofix.current(ctx.project.id, ctx.c1.id);
    assert.equal(change.status, 'approved');
    assert.equal(change.approvedByUserId, ctx.owner.user.id);
    assert.equal(change.payload.hash, hash);
    assert.deepEqual(job.data, {
      orgId: String(
        (await h.db.organizations.findForUser({ publicId: ctx.orgId, userId: ctx.owner.user.id }))
          .org.id,
      ),
      projectId: String(ctx.project.id),
      siteChangeId: String(change.id),
    });
    const detail = await ctx.scoped.recommendations.get(ctx.project.id, ctx.c1.id);
    assert.equal(detail.recommendation.status, 'in_progress');
    const page = await ctx.owner.get(res.headers.location).expect(200);
    assert.match(page.text, /Writing it to your site now/);
    assert.doesNotMatch(page.text, /Approve and apply/);

    const again = await ctx.owner.post(`${ctx.page}/approve`, form({ hash })).expect(303);
    assert.match(again.headers.location, /autofix-already/);
    assert.equal(added.slice(before).filter((j) => j.name === 'autofix.apply').length, 1);
  });

  test('a change under the preview since it was shown is refused, not quietly sent', async () => {
    const ctx = await withSite();
    const before = added.length;
    const res = await ctx.owner
      .post(`${ctx.page}/approve`, form({ hash: 'a'.repeat(64) }))
      .expect(303);
    assert.match(res.headers.location, /autofix-changed/);
    assert.equal(added.length, before);
    assert.equal(await ctx.scoped.autofix.current(ctx.project.id, ctx.c1.id), null);
  });

  test('a viewer cannot approve, and another organization cannot reach the page', async () => {
    const ctx = await withSite();
    const hash = hashOf((await ctx.owner.get(ctx.page)).text);
    const before = added.length;
    const asViewer = await ctx.viewer.post(`${ctx.page}/approve`, form({ hash }));
    assert.notEqual(asViewer.status, 303);
    assert.equal(added.length, before);
    const other = await withActions();
    await other.owner.get(`${ctx.base}/actions/${ctx.c1.id}/autofix`).expect(404);
    await other.owner.post(`${ctx.page}/approve`, form({ hash })).expect(404);
    assert.equal(await ctx.scoped.autofix.current(ctx.project.id, ctx.c1.id), null);
  });

  test('a queue that is down leaves nothing half-done and says so', async () => {
    const ctx = await withSite();
    const hash = hashOf((await ctx.owner.get(ctx.page)).text);
    failQueue = true;
    try {
      const res = await ctx.owner.post(`${ctx.page}/approve`, form({ hash })).expect(303);
      assert.match(res.headers.location, /autofix-queue-failed/);
    } finally {
      failQueue = false;
    }
    const change = await ctx.scoped.autofix.current(ctx.project.id, ctx.c1.id);
    assert.equal(change.status, 'failed');
    const page = await ctx.owner.get(ctx.page).expect(200);
    assert.match(page.text, /Nothing was changed on your site/);
    assert.match(page.text, /Approve and apply/, 'and it can be tried again');
  });
});

describe('auto-fix: pages, titles and robots.txt (D3)', () => {
  const secret = {
    ciphertext: Buffer.alloc(40, 1),
    wrappedDek: Buffer.alloc(60, 2),
    keyVersion: 1,
  };
  const site = 'https://www.act-site.example.test';

  /** A project with its site connected, the plugin at `pluginVersion`, and a newer scan that carries the evidence a fix is built from. */
  async function withEvidence({ pluginVersion = '1.1.0', evidence = {} } = {}) {
    const ctx = await withActions();
    await ctx.scoped.integrations.saveWordpress(ctx.project.id, {
      config: { siteUrl: site, username: 'editor', pluginConnected: true, pluginVersion },
      secret,
      userId: ctx.owner.user.id,
    });
    const checks = Object.entries(evidence).map(([code, e]) => ({
      code,
      status: 'fail',
      points: 0,
      possible: 4,
      evidence: e,
    }));
    if (checks.length)
      await h.fx.scan(ctx.project, { checks, finishedAt: new Date(Date.now() + 1000) });
    const make = (rule, category, title) =>
      h.fx.recommendation(ctx.project, {
        rule_code: rule,
        category,
        fix_path: 'auto_fix',
        title,
      });
    ctx.a1 = ctx.rec('readiness.A1');
    ctx.f3 = await make('readiness.F3', 'technical', 'Write titles and descriptions');
    ctx.c2 = await make('readiness.C2', 'structured_data', 'Add page-type schema');
    ctx.page = (rec) => `${ctx.base}/actions/${rec.id}/autofix`;
    return ctx;
  }
  const hashOf = (html) => html.match(/name="hash" value="([0-9a-f]{64})"/)?.[1];

  const robotsEvidence = {
    robotsFile: true,
    bots: [
      { agent: 'OAI-SearchBot', verdict: 'blocked' },
      { agent: 'Googlebot', verdict: 'partly', rule: 'Disallow: /private/' },
    ],
  };
  const metaEvidence = {
    pages: [
      {
        url: `${site}/whitening`,
        pageType: 'service',
        title: '',
        description: '',
        name: 'Teeth whitening',
        lead: 'Our in-office whitening takes about an hour and lightens teeth several shades in one visit.',
        problems: ['no_title', 'no_description'],
      },
    ],
  };
  const schemaEvidence = {
    pages: [
      {
        url: `${site}/about`,
        pageType: 'about',
        expected: ['AboutPage'],
        found: [],
        ok: false,
        onlyAfterJavaScript: false,
        basics: {
          url: `${site}/about`,
          pageType: 'about',
          name: 'About Action Dental',
          description: '',
          lead: '',
        },
      },
    ],
  };

  test('robots.txt: shows the exact lines, what is left to the customer, and offers no logo or profile form', async () => {
    const ctx = await withEvidence({ evidence: { A1: robotsEvidence } });
    const page = await ctx.owner.get(ctx.page(ctx.a1)).expect(200);
    assert.match(page.text, /The exact lines/);
    assert.match(page.text, /User-agent: OAI-SearchBot\nAllow: \//);
    assert.match(page.text, /Googlebot is blocked from only part of the site/);
    assert.doesNotMatch(page.text, /Add more to it/);
    assert.ok(hashOf(page.text));
  });

  test('titles and descriptions: a table of what each page says now and what it would say', async () => {
    const ctx = await withEvidence({ evidence: { F3: metaEvidence } });
    const page = await ctx.owner.get(ctx.page(ctx.f3)).expect(200);
    assert.match(page.text, /What each page says now, and what it would say/);
    assert.match(page.text, /Teeth whitening \| Action Dental/);
    assert.match(page.text, /whitening takes about an hour/);
  });

  test('page schema: one block per page, with its type', async () => {
    const ctx = await withEvidence({ evidence: { C2: schemaEvidence } });
    const page = await ctx.owner.get(ctx.page(ctx.c2)).expect(200);
    assert.match(page.text, /The exact code, page by page/);
    assert.match(page.text, /AboutPage on https:\/\/www\.act-site\.example\.test\/about/);
  });

  test('approving a title fix stores exactly what was shown, as a meta change, and queues the write', async () => {
    const ctx = await withEvidence({ evidence: { F3: metaEvidence } });
    const hash = hashOf((await ctx.owner.get(ctx.page(ctx.f3))).text);
    const before = added.length;
    const res = await ctx.owner.post(`${ctx.page(ctx.f3)}/approve`, { hash }).expect(303);
    assert.match(res.headers.location, /autofix-applying/);
    assert.ok(added.slice(before).find((j) => j.name === 'autofix.apply'));
    const change = await ctx.scoped.autofix.current(ctx.project.id, ctx.f3.id);
    assert.equal(change.kind, 'meta');
    assert.equal(change.targetUrl, null);
    assert.equal(change.payload.hash, hash);
    assert.deepEqual(Object.keys(change.payload.items[0]).sort(), ['description', 'title', 'url']);
    assert.equal(change.payload.items[0].title, 'Teeth whitening | Action Dental');
  });

  test('a scan that changed since the preview is refused, not quietly sent', async () => {
    const ctx = await withEvidence({ evidence: { A1: robotsEvidence } });
    const hash = hashOf((await ctx.owner.get(ctx.page(ctx.a1))).text);
    await h.fx.scan(ctx.project, {
      checks: [
        {
          code: 'A1',
          status: 'fail',
          points: 0,
          possible: 8,
          evidence: {
            robotsFile: true,
            bots: [
              { agent: 'OAI-SearchBot', verdict: 'blocked' },
              { agent: 'PerplexityBot', verdict: 'blocked' },
            ],
          },
        },
      ],
      finishedAt: new Date(Date.now() + 5000),
    });
    const before = added.length;
    const res = await ctx.owner.post(`${ctx.page(ctx.a1)}/approve`, { hash }).expect(303);
    assert.match(res.headers.location, /autofix-changed/);
    assert.equal(added.length, before);
    assert.equal(await ctx.scoped.autofix.current(ctx.project.id, ctx.a1.id), null);
  });

  test('a plugin from before these routes is asked to be updated, and nothing can be approved', async () => {
    const ctx = await withEvidence({ pluginVersion: '1.0.0', evidence: { A1: robotsEvidence } });
    const page = await ctx.owner.get(ctx.page(ctx.a1)).expect(200);
    assert.match(page.text, /Update the AEO Corner plugin first/);
    assert.match(page.text, /needs 1\.1\.0 or newer/);
    assert.doesNotMatch(page.text, /Approve and apply/);
    const res = await ctx.owner
      .post(`${ctx.page(ctx.a1)}/approve`, { hash: 'a'.repeat(64) })
      .expect(303);
    assert.match(res.headers.location, /autofix-invalid/);
    assert.equal(await ctx.scoped.autofix.current(ctx.project.id, ctx.a1.id), null);
  });

  test('with no finished scan carrying this check, it says so', async () => {
    const ctx = await withEvidence({ evidence: {} });
    const page = await ctx.owner.get(ctx.page(ctx.f3)).expect(200);
    assert.match(page.text, /finished scan of your site/);
    assert.doesNotMatch(page.text, /Approve and apply/);
  });

  test('the recommendation page offers the fix, and a viewer can read the preview but not approve', async () => {
    const ctx = await withEvidence({ evidence: { A1: robotsEvidence } });
    const detail = await ctx.owner.get(`${ctx.base}/actions/${ctx.a1.id}`).expect(200);
    assert.match(detail.text, /We can do this for you/);
    assert.match(detail.text, /Preview the exact lines we would add to your robots.txt/);
    const asViewer = await ctx.viewer.get(ctx.page(ctx.a1)).expect(200);
    assert.doesNotMatch(asViewer.text, /Approve and apply/);
    const denied = await ctx.viewer.post(`${ctx.page(ctx.a1)}/approve`, { hash: 'x' });
    assert.notEqual(denied.status, 303);
  });
});

describe('sharing a proven win (D4)', () => {
  /** A project with a measured result: `verdict` is what the test said about the A1 fix. */
  async function withOutcome(verdict = 'proven_win') {
    const ctx = await withActions();
    const rec = ctx.rec('readiness.A1');
    await ctx.scoped.recommendations.markDone(ctx.project.id, rec.id, {
      userId: ctx.owner.user.id,
    });
    await ctx.scoped.recommendations.settleVerification(ctx.project.id, rec.id, {
      verdict: 'verified',
      reason: 'passed',
    });
    const outcome = await h.fx.forceOutcome(
      { ...rec, org_id: ctx.project.org_id, project_id: ctx.project.id },
      { verdict },
    );
    const page = `${ctx.base}/actions/${rec.id}`;
    return {
      ...ctx,
      rec,
      outcome,
      page,
      post: (who, move) => ctx[who].post(`${page}/proof/${outcome.id}/${move}`),
    };
  }
  const linkOf = (html) => html.match(/value="[^"]*(\/p\/[0-9A-Z]{26})"/)?.[1] ?? null;

  test('the owner shares a win, the link works for anyone, and says only what was promised', async () => {
    const ctx = await withOutcome();
    const before = await ctx.owner.get(ctx.page).expect(200);
    assert.match(before.text, /Share this result/);
    assert.match(
      before.text,
      /It never shows your questions, the engines’ answers, your competitors/,
    );
    assert.equal(linkOf(before.text), null, 'nothing is shared until someone does it');

    const res = await ctx.post('owner', 'share').expect(303);
    assert.match(res.headers.location, /notice=proof-shared/);
    const after = await ctx.owner.get(ctx.page).expect(200);
    const path = linkOf(after.text);
    assert.ok(path, 'the link is on the card');
    assert.match(after.text, /Copy link/);
    assert.match(after.text, /Stop sharing/);

    // Anyone, with no sign-in at all.
    const shared = await h.agent.get(path).expect(200);
    assert.match(shared.text, /Action Dental/);
    assert.match(shared.text, /from 10 of 120 to 40 of 118 answers/);
    assert.match(shared.text, /Proven win/);
    assert.match(shared.text, /How sure are we\?/);
    assert.doesNotMatch(shared.text, /Best family dentist\?/, 'no question is ever shown');
    assert.doesNotMatch(shared.text, /csrf|\/app\/o\//i, 'nothing of the signed-in area');
    assert.equal(shared.headers['cache-control'], 'no-store');
    assert.equal(shared.headers['referrer-policy'], 'no-referrer');
    assert.match(shared.headers['x-robots-tag'], /noindex/);
    assert.doesNotMatch(shared.text, /posthog/i, 'no analytics on a private address');
  });

  test('sharing twice keeps one link', async () => {
    const ctx = await withOutcome();
    await ctx.post('owner', 'share').expect(303);
    const first = linkOf((await ctx.owner.get(ctx.page)).text);
    await ctx.post('owner', 'share').expect(303);
    assert.equal(linkOf((await ctx.owner.get(ctx.page)).text), first);
  });

  test('stopping sharing kills the link; sharing again makes a different one', async () => {
    const ctx = await withOutcome();
    await ctx.post('owner', 'share').expect(303);
    const old = linkOf((await ctx.owner.get(ctx.page)).text);
    const res = await ctx.post('owner', 'unshare').expect(303);
    assert.match(res.headers.location, /notice=proof-unshared/);
    await h.agent.get(old).expect(404);
    const page = await ctx.owner.get(ctx.page).expect(200);
    assert.equal(linkOf(page.text), null);
    assert.match(page.text, /Share this result/);

    await ctx.post('owner', 'share').expect(303);
    const fresh = linkOf((await ctx.owner.get(ctx.page)).text);
    assert.notEqual(fresh, old);
    await h.agent.get(old).expect(404);
    await h.agent.get(fresh).expect(200);
  });

  test('owners, admins and editors may share (as they may publish); a viewer may read the link and nothing more', async () => {
    const ctx = await withOutcome();
    const refused = await ctx.post('viewer', 'share');
    assert.notEqual(refused.status, 303);
    const viewerPage = await ctx.viewer.get(ctx.page).expect(200);
    assert.doesNotMatch(viewerPage.text, /Share this result/);
    assert.deepEqual(
      await ctx.scoped.proofShares.forRecommendation(ctx.project.id, ctx.rec.id),
      [],
    );

    await ctx.post('editor', 'share').expect(303);
    const viewerSees = await ctx.viewer.get(ctx.page).expect(200);
    assert.ok(linkOf(viewerSees.text), 'a viewer may read the link');
    assert.doesNotMatch(viewerSees.text, /Stop sharing/);
    const stop = await ctx.post('viewer', 'unshare');
    assert.notEqual(stop.status, 303);
    assert.equal(
      (await ctx.scoped.proofShares.forRecommendation(ctx.project.id, ctx.rec.id)).length,
      1,
    );
  });

  test('a result that is not a win offers no share button, and a forged request is refused', async () => {
    const ctx = await withOutcome('no_change');
    const page = await ctx.owner.get(ctx.page).expect(200);
    assert.doesNotMatch(page.text, /Share this result/);
    const res = await ctx.post('owner', 'share').expect(303);
    assert.match(res.headers.location, /notice=proof-not-shareable/);
    assert.deepEqual(
      await ctx.scoped.proofShares.forRecommendation(ctx.project.id, ctx.rec.id),
      [],
    );
  });

  test('another organization cannot share or stop this one’s result, and a bad address is a plain 404', async () => {
    const mine = await withOutcome();
    const other = await withActions({ raise: false });
    await mine.post('owner', 'share').expect(303);
    await other.owner.post(`${mine.page}/proof/${mine.outcome.id}/share`).expect(404);
    await other.owner.post(`${mine.page}/proof/${mine.outcome.id}/unshare`).expect(404);
    assert.equal(
      (await mine.scoped.proofShares.forRecommendation(mine.project.id, mine.rec.id)).length,
      1,
    );

    const unknown = await h.agent.get(`/p/${'0'.repeat(26)}`).expect(404);
    const malformed = await h.agent.get('/p/not-an-address').expect(404);
    assert.equal(unknown.text, malformed.text, 'a wrong address says nothing about what exists');
    assert.match(unknown.headers['cache-control'], /no-store/);
  });

  test('a form without the CSRF token is refused', async () => {
    const ctx = await withOutcome();
    const res = await ctx.owner.post(
      `${ctx.page}/proof/${ctx.outcome.id}/share`,
      {},
      { csrf: null },
    );
    assert.notEqual(res.status, 303);
    assert.deepEqual(
      await ctx.scoped.proofShares.forRecommendation(ctx.project.id, ctx.rec.id),
      [],
    );
  });
});

describe('auto-fix: take it off the site (D3)', () => {
  const secret = {
    ciphertext: Buffer.alloc(40, 1),
    wrappedDek: Buffer.alloc(60, 2),
    keyVersion: 1,
  };

  /** A fix that was approved and written: the change is `applied` and the recommendation is done. */
  async function withWrittenFix() {
    const ctx = await withActions();
    await ctx.scoped.integrations.saveWordpress(ctx.project.id, {
      config: {
        siteUrl: 'https://www.undo-site.example.test',
        username: 'editor',
        pluginConnected: true,
      },
      secret,
      userId: ctx.owner.user.id,
    });
    const c1 = ctx.rec('readiness.C1');
    const page = `${ctx.base}/actions/${c1.id}/autofix`;
    const hash = (await ctx.owner.get(page)).text.match(/name="hash" value="([0-9a-f]{64})"/)[1];
    await ctx.owner.post(`${page}/approve`, { hash }).expect(303);
    const change = await ctx.scoped.autofix.current(ctx.project.id, c1.id);
    await h.fx.forceSiteChange(change.id, { status: 'applied', applied_at: new Date() });
    await ctx.scoped.recommendations.markDone(ctx.project.id, c1.id, { userId: ctx.owner.user.id });
    return { ...ctx, c1, page, change };
  }

  test('a written fix offers to be removed, and says what will be put back', async () => {
    const ctx = await withWrittenFix();
    const page = await ctx.owner.get(ctx.page).expect(200);
    assert.match(page.text, /Take it off your site/);
    assert.match(page.text, /no structured data of ours at all/);
    assert.match(page.text, /Remove it from my site/);
    assert.doesNotMatch(page.text, /Approve and apply/);
    const viewer = await ctx.viewer.get(ctx.page).expect(200);
    assert.doesNotMatch(viewer.text, /Remove it from my site/);
  });

  test('asking queues one removal, claims the fix, and the page says it is being removed', async () => {
    const ctx = await withWrittenFix();
    const before = added.length;
    const res = await ctx.owner.post(`${ctx.page}/undo`).expect(303);
    assert.match(res.headers.location, /autofix-undoing/);
    const job = added.slice(before).find((j) => j.name === 'autofix.undo');
    assert.ok(job);
    assert.deepEqual(job.data, {
      orgId: String(ctx.project.org_id),
      projectId: String(ctx.project.id),
      siteChangeId: String(ctx.change.id),
    });
    const page = await ctx.owner.get(ctx.page).expect(200);
    assert.match(page.text, /Removing it from your site now/);
    assert.doesNotMatch(page.text, /Remove it from my site/);

    const again = await ctx.owner.post(`${ctx.page}/undo`).expect(303);
    assert.match(again.headers.location, /autofix-undo-already/);
    assert.equal(added.slice(before).filter((j) => j.name === 'autofix.undo').length, 1);
  });

  test('a viewer cannot ask, another organization gets a 404, and a missing token is refused', async () => {
    const ctx = await withWrittenFix();
    const other = await withActions();
    const before = added.length;
    assert.notEqual((await ctx.viewer.post(`${ctx.page}/undo`)).status, 303);
    await other.owner.post(`${ctx.page}/undo`).expect(404);
    assert.notEqual((await ctx.owner.post(`${ctx.page}/undo`, {}, { csrf: null })).status, 303);
    assert.equal(added.length, before);
    assert.equal(
      (await ctx.scoped.autofix.current(ctx.project.id, ctx.c1.id)).undoRequestedByUserId,
      null,
    );
  });

  test('a queue that is down releases the claim, so it can be asked for again', async () => {
    const ctx = await withWrittenFix();
    failQueue = true;
    try {
      const res = await ctx.owner.post(`${ctx.page}/undo`).expect(303);
      assert.match(res.headers.location, /autofix-queue-failed/);
    } finally {
      failQueue = false;
    }
    const change = await ctx.scoped.autofix.current(ctx.project.id, ctx.c1.id);
    assert.equal(change.status, 'applied');
    assert.equal(change.undoRequestedByUserId, null);
    assert.match((await ctx.owner.get(ctx.page)).text, /We could not remove it/);
    await ctx.owner.post(`${ctx.page}/undo`).expect(303);
  });

  test('once removed, the page says so and the fix can be previewed and approved again', async () => {
    const ctx = await withWrittenFix();
    await ctx.owner.post(`${ctx.page}/undo`).expect(303);
    await h.fx.forceSiteChange(ctx.change.id, {
      status: 'rolled_back',
      rolled_back_at: new Date(),
    });
    await ctx.scoped.recommendations.fixRemoved(ctx.project.id, ctx.c1.id);
    const page = await ctx.owner.get(ctx.page).expect(200);
    assert.match(page.text, /Removed from your site/);
    assert.match(page.text, /back to how it was/);
    assert.match(page.text, /Approve and apply/);
    assert.doesNotMatch(page.text, /Remove it from my site/);
    assert.equal(
      (await ctx.scoped.recommendations.get(ctx.project.id, ctx.c1.id)).recommendation.status,
      'in_progress',
    );
  });
});
