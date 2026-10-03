import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { authHarness, orgPathOf } from './auth-helpers.js';

/**
 * The dashboard screens (Milestone 5): sign-in, organization scoping, what a check that did not finish looks like, and
 * the "that's not us" feedback. The arithmetic is tested in src/core/dashboard.test.js and the reads in
 * tests/integration/dashboard-repo.test.js; here it is what a person is shown.
 */
const h = authHarness();
after(async () => {
  await h.fx.forgetDomains(hosts);
  await h.close();
});

const hosts = [];
let n = 0;
const unique = () => `${Date.now().toString(36)}${n++}`;

/** An organization with an owner, an editor and a viewer, and a project with tracking on and two questions. */
async function withProject({ tracking = true } = {}) {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Dash Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  const editor = await h.signedIn();
  await scoped.memberships.add({ userId: editor.user.id, role: 'editor' });
  const viewer = await h.signedIn();
  await scoped.memberships.add({ userId: viewer.user.id, role: 'viewer' });
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: `dash-${unique()}.example.test`,
      name: 'Dash Dental',
      country: 'US',
      language: 'en',
    })
    .expect(303);
  const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  await scoped.projectEngines.setEnabled(project.id, ['perplexity', 'gemini']);
  const q1 = (
    await scoped.prompts.add(project.id, {
      text: 'Who is the best dentist near me?',
      intent: 'discovery',
    })
  ).prompt;
  const q2 = (
    await scoped.prompts.add(project.id, {
      text: 'Which dentist is the cheapest?',
      intent: 'discovery',
    })
  ).prompt;
  const brand = (await scoped.entities.list(project.id, { kind: 'brand' }))[0];
  const rival = await h.fx.entity(project, { kind: 'competitor', name: 'Rival Smiles' });
  if (tracking) await scoped.projects.startTracking(project.id, { actorUserId: owner.user.id });
  return {
    owner,
    editor,
    viewer,
    orgId,
    scoped,
    project,
    base: `/app/o/${orgId}/projects/${pid}`,
    q1,
    q2,
    brand,
    rival,
  };
}

/**
 * One finished check, with a question that could not be fully read:
 *   question 1  perplexity  2 answers read: the brand named in one (rank 1, recommended), the rival in both
 *   question 2  perplexity  1 answer read (nobody named) and 1 collected but never read
 *               gemini      the one answer failed
 */
async function withCheck(ctx) {
  const { scoped, project, q1, q2, brand, rival } = ctx;
  const run = await h.fx.run(project, { status: 'rolling_up', trigger: 'schedule' });
  const g2 = `https://www.g2-${unique()}.example.test/reviews`;
  const site = `https://dash-site-${unique()}.example.test/`;
  hosts.push(new URL(g2).hostname.replace(/^www\./, ''), new URL(site).hostname);
  await h.fx.readAnswer(run, q1, {
    excerpt: 'Top picks: Dash Dental is the best choice, then Rival Smiles.',
    mentions: [
      { entity: brand, listRank: 1, stance: 'recommended', sentiment: 2 },
      { entity: rival, listRank: 2, stance: 'neutral', sentiment: 0 },
    ],
    citations: [{ url: g2 }, { url: site, isOwn: true, owner: brand }],
  });
  await h.fx.readAnswer(run, q1, {
    sampleIdx: 1,
    excerpt: 'Rival Smiles is the usual answer.',
    mentions: [{ entity: rival, listRank: 1, stance: 'recommended', sentiment: 1 }],
    citations: [{ url: g2 }],
  });
  await h.fx.readAnswer(run, q2, { excerpt: 'Prices vary a lot between practices.' });
  const failed = await scoped.snapshots.create({
    runId: run.id,
    promptId: q2.id,
    engineCode: 'gemini',
    sampleIdx: 0,
    providerCode: 'dataforseo',
    method: 'ui_capture',
  });
  await scoped.snapshots.fail(failed.snapshot.id, 'provider down');
  await h.fx.collectedAnswer(run, q2, { engine: 'perplexity', sampleIdx: 1 });
  const outcome = await scoped.runs.settle(run.id);
  // As the orchestrator does: settle the cells, roll the day up, then finish the run.
  await scoped.metrics.rollupDay(project.id, run.run_date);
  await scoped.runs.finish(run.id, outcome.status);
  return run;
}

const SCREENS = ['dashboard', 'answers', 'compare', 'citations'];

describe('sign-in and organization scoping', () => {
  test('every dashboard screen needs a signed-in person', async () => {
    const ctx = await withProject();
    for (const screen of SCREENS) {
      const res = await h.agent.get(`${ctx.base}/${screen}`);
      assert.equal(res.status, 302, screen);
      assert.match(res.headers.location, /sign-in/, screen);
    }
    const detail = await h.agent.get(`${ctx.base}/answers/${ctx.q1.id}`);
    assert.equal(detail.status, 302);
    const report = await h.agent
      .post(`${ctx.base}/answers/${ctx.q1.id}/report`)
      .type('form')
      .send({});
    assert.notEqual(report.status, 303, 'an anonymous report is not accepted');
  });

  test('another organization’s project is a plain 404 on every screen', async () => {
    const mine = await withProject();
    const theirs = await withProject();
    await withCheck(theirs);
    for (const screen of SCREENS) {
      await theirs.owner.get(`${theirs.base}/${screen}`).expect(200);
      await mine.owner.get(`${mine.base}/${screen}`).expect(200);
      await mine.owner
        .get(`/app/o/${mine.orgId}/projects/${theirs.base.split('/').pop()}/${screen}`)
        .expect(404);
      await mine.owner.get(`${theirs.base}/${screen}`).expect(404);
    }
    await mine.owner.get(`${theirs.base}/answers/${theirs.q1.id}`).expect(404);
  });

  test('a question of another project is a 404, not an empty page', async () => {
    const a = await withProject();
    const b = await withProject();
    await a.owner.get(`${a.base}/answers/${b.q1.id}`).expect(404);
    await a.owner.get(`${a.base}/answers/nope`).expect(404);
  });

  test('a client seat sees the dashboard only for its own projects', async () => {
    const ctx = await withProject();
    const elsewhere = await h.fx.project(ctx.project.org_id, 'Elsewhere');
    const membership = await ctx.scoped.memberships.getByUser(ctx.viewer.user.id);
    await ctx.scoped.memberships.setProjectAccess({
      membershipId: membership.id,
      access: 'selected',
      projectIds: [elsewhere.id],
    });
    for (const screen of SCREENS) await ctx.viewer.get(`${ctx.base}/${screen}`).expect(404);
    await ctx.viewer.get(`${ctx.base}/answers/${ctx.q1.id}`).expect(404);
  });
});

describe('before tracking is on', () => {
  test('each screen says why it is empty and offers the next step', async () => {
    const ctx = await withProject({ tracking: false });
    for (const screen of SCREENS) {
      const page = await ctx.owner.get(`${ctx.base}/${screen}`).expect(200);
      assert.match(page.text, /appear once tracking is on/, screen);
      assert.match(page.text, /Finish setup and start tracking/, screen);
    }
    const viewer = await ctx.viewer.get(`${ctx.base}/dashboard`).expect(200);
    assert.doesNotMatch(viewer.text, /Finish setup and start tracking/);
  });

  test('a project that is tracking but has no finished check says so, and shows no figures', async () => {
    const ctx = await withProject();
    const page = await ctx.owner.get(`${ctx.base}/dashboard`).expect(200);
    assert.match(page.text, /No results in this period yet/);
    assert.match(page.text, /No check has finished yet/);
    assert.doesNotMatch(page.text, /class="stat-value"/);
  });
});

describe('the dashboard after a check that did not finish cleanly', () => {
  test('shows the figures it could read, the banner, and "Couldn’t check": never zeros', async () => {
    const ctx = await withProject();
    await withCheck(ctx);
    const page = await ctx.owner.get(`${ctx.base}/dashboard`).expect(200);

    // 1 of the 3 readable answers named the brand.
    assert.match(page.text, /Mention rate/);
    assert.match(page.text, /33%/);
    assert.match(page.text, /1 of 3 answers named the brand/);
    // The banner says what is left out, and that it is not "not mentioned".
    assert.match(page.text, /Some checks are incomplete\./);
    assert.match(page.text, /Gemini and Perplexity data are incomplete\./);
    assert.match(page.text, /2 of 3 question-and-engine checks did not finish/);
    assert.match(page.text, /not counted as “not mentioned”/);
    // Gemini read nothing: it says so; it does not say 0%.
    assert.match(page.text, /Couldn’t check/);
    assert.doesNotMatch(page.text, /\b0%/);
    // One check is a baseline, not a trend.
    assert.match(page.text, /This is your baseline\./);
    // The chart arrives with its data table, and loads Chart.js on this page only.
    assert.match(page.text, /data-chart=/);
    assert.match(page.text, /Values as a table/);
    assert.match(page.text, /vendor\/chart\.umd\.min\.js/);
    assert.doesNotMatch(
      page.text,
      /<script(?![^>]*(?:src=|application\/ld\+json))[^>]*>/,
      'no inline script',
    );
    assert.doesNotMatch(page.text, /\sstyle="/, 'no inline style');
  });

  test('a period with no readable answer at all is "Couldn’t check" everywhere, with no figure', async () => {
    const ctx = await withProject();
    const run = await h.fx.run(ctx.project, { status: 'rolling_up', trigger: 'schedule' });
    const failed = await ctx.scoped.snapshots.create({
      runId: run.id,
      promptId: ctx.q1.id,
      engineCode: 'perplexity',
      sampleIdx: 0,
      providerCode: 'perplexity_api',
      method: 'api_grounded',
    });
    await ctx.scoped.snapshots.fail(failed.snapshot.id, 'provider down');
    const outcome = await ctx.scoped.runs.settle(run.id);
    await ctx.scoped.metrics.rollupDay(ctx.project.id, run.run_date);
    await ctx.scoped.runs.finish(run.id, outcome.status);

    const page = await ctx.owner.get(`${ctx.base}/dashboard`).expect(200);
    assert.match(page.text, /Couldn’t check/);
    assert.doesNotMatch(page.text, /\b0%/);
    assert.doesNotMatch(page.text, /33%/);
    const matrix = await ctx.owner.get(`${ctx.base}/answers`).expect(200);
    assert.match(matrix.text, /Couldn’t check/);
    assert.doesNotMatch(matrix.text, /Not mentioned/);
  });

  test('a longer period is offered, and an unknown one is the default', async () => {
    const ctx = await withProject();
    await withCheck(ctx);
    const page = await ctx.owner.get(`${ctx.base}/dashboard?range=12w`).expect(200);
    assert.match(page.text, /aria-current="true">Last 12 weeks/);
    const odd = await ctx.owner.get(`${ctx.base}/dashboard?range=forever`).expect(200);
    assert.match(odd.text, /aria-current="true">Last 4 weeks/);
  });

  test('a running check refreshes the page by itself', async () => {
    const ctx = await withProject();
    await h.fx.run(ctx.project, { status: 'collecting', trigger: 'onboarding' });
    const page = await ctx.owner.get(`${ctx.base}/dashboard`).expect(200);
    assert.match(page.text, /data-auto-refresh="10"/);
    assert.match(page.text, /Your first check is running/);
  });
});

describe('the question matrix and one question', () => {
  test('the matrix never calls an unreadable cell "not mentioned"', async () => {
    const ctx = await withProject();
    await withCheck(ctx);
    const page = await ctx.owner.get(`${ctx.base}/answers`).expect(200);
    assert.match(page.text, /Who is the best dentist near me\?/);
    // Question 1 on Perplexity: named. Question 2 on Perplexity: partial and never named → couldn’t check.
    assert.match(page.text, /data-state="mentioned"/);
    assert.match(page.text, /data-state="unknown"/);
    assert.doesNotMatch(page.text, /data-state="absent"/);
    assert.match(page.text, new RegExp(`/answers/${ctx.q1.id}`));
  });

  test('a question shows its answers, who was named, the sources, and what could not be read', async () => {
    const ctx = await withProject();
    await withCheck(ctx);
    const one = await ctx.owner.get(`${ctx.base}/answers/${ctx.q1.id}`).expect(200);
    assert.match(one.text, /Who is the best dentist near me\?/);
    assert.match(one.text, /Top picks: <mark class="mark-brand"[^>]*>Dash Dental<\/mark>/);
    assert.match(one.text, /mark-competitor[^>]*>Rival Smiles<\/mark>/);
    assert.match(one.text, /Named in this answer/);
    assert.match(one.text, /Recommended/);
    assert.match(one.text, /number 1 in a list/);
    assert.match(one.text, /Sources cited/);
    assert.match(one.text, /Your site/);
    assert.match(one.text, /Sample 1 of 2/);
    assert.match(one.text, /Rival Smiles/);

    const two = await ctx.owner.get(`${ctx.base}/answers/${ctx.q2.id}`).expect(200);
    assert.match(two.text, /We could not read this answer, so it is left out of your numbers/);
    assert.match(two.text, /None of the brands we track was named in this answer/);
    assert.doesNotMatch(two.text, /provider down/, 'an internal failure reason is never shown');
  });

  test('a question that has never been checked says so', async () => {
    const ctx = await withProject();
    const page = await ctx.owner.get(`${ctx.base}/answers/${ctx.q1.id}`).expect(200);
    assert.match(page.text, /This question has not been checked yet/);
  });
});

describe('"That’s not us" and "This answer was misread"', () => {
  async function checked() {
    const ctx = await withProject();
    await withCheck(ctx);
    const answers = await ctx.scoped.dashboard.answers(ctx.project.id, ctx.q1.id);
    return { ...ctx, snapshot: answers.snapshots[0], answers };
  }

  test('an editor sees the buttons and a viewer does not', async () => {
    const ctx = await checked();
    const editor = await ctx.editor.get(`${ctx.base}/answers/${ctx.q1.id}`).expect(200);
    assert.match(editor.text, /That’s not us/);
    assert.match(editor.text, /This answer was misread/);
    assert.match(editor.text, /name="_csrf"/);
    const viewer = await ctx.viewer.get(`${ctx.base}/answers/${ctx.q1.id}`).expect(200);
    assert.doesNotMatch(viewer.text, /That’s not us/);
    assert.doesNotMatch(viewer.text, /This answer was misread/);
    await ctx.viewer
      .post(`${ctx.base}/answers/${ctx.q1.id}/report`, {
        snapshot: String(ctx.snapshot.id),
        kind: 'misread',
      })
      .expect(403);
  });

  test('a report goes to the review queue once, and the page shows it was sent', async () => {
    const ctx = await checked();
    const url = `${ctx.base}/answers/${ctx.q1.id}/report`;
    const sent = await ctx.editor
      .post(url, {
        snapshot: String(ctx.snapshot.id),
        kind: 'not_us',
        comment: 'That is another dentist.',
      })
      .expect(303);
    assert.match(sent.headers.location, /\/answers\/\d+\?notice=report-sent$/);
    const reports = await ctx.scoped.dashboard.reportsFor(ctx.project.id, [ctx.snapshot.id]);
    assert.deepEqual(
      reports.map((r) => [r.kind, r.status]),
      [['not_us', 'open']],
    );

    const again = await ctx.editor
      .post(url, { snapshot: String(ctx.snapshot.id), kind: 'not_us' })
      .expect(303);
    assert.match(again.headers.location, /notice=report-repeat$/);
    assert.equal(
      (await ctx.scoped.dashboard.reportsFor(ctx.project.id, [ctx.snapshot.id])).length,
      1,
    );

    const page = await ctx.editor.get(sent.headers.location).expect(200);
    assert.match(page.text, /A person will check that answer/);
    assert.match(page.text, /You reported: that’s not us/);
  });

  test('a bad kind, a missing answer, or an answer of another question is refused', async () => {
    const ctx = await checked();
    const url = `${ctx.base}/answers/${ctx.q1.id}/report`;
    const bad = await ctx.editor
      .post(url, { snapshot: String(ctx.snapshot.id), kind: 'spam' })
      .expect(303);
    assert.match(bad.headers.location, /notice=report-invalid$/);
    const none = await ctx.editor.post(url, { kind: 'misread' }).expect(303);
    assert.match(none.headers.location, /notice=report-invalid$/);
    // An answer of question 2 sent to question 1's address.
    const other = (await ctx.scoped.dashboard.answers(ctx.project.id, ctx.q2.id)).snapshots[0];
    await ctx.editor.post(url, { snapshot: String(other.id), kind: 'misread' }).expect(404);
    assert.deepEqual(
      await ctx.scoped.dashboard.reportsFor(ctx.project.id, [ctx.snapshot.id, other.id]),
      [],
    );
  });

  test('a form without the token is refused', async () => {
    const ctx = await checked();
    await ctx.editor
      .post(
        `${ctx.base}/answers/${ctx.q1.id}/report`,
        { snapshot: String(ctx.snapshot.id), kind: 'misread' },
        { csrf: null },
      )
      .expect(403);
  });
});

describe('competitors and sources', () => {
  test('the comparison shows share of voice, win rate and how to read it', async () => {
    const ctx = await withProject();
    await withCheck(ctx);
    const page = await ctx.owner.get(`${ctx.base}/compare`).expect(200);
    assert.match(page.text, /Rival Smiles/);
    assert.match(page.text, /Share of voice/);
    // Only question 1 named anyone. Both were named in it, and the brand ranked higher on average (1 against 1.5),
    // so it wins the one question that was decided.
    assert.match(page.text, /100% \(1 of 1\)/);
    assert.match(page.text, /data-chart=/);
    assert.match(page.text, /Some checks are incomplete\./);
  });

  test('with no competitors it offers to add some', async () => {
    const ctx = await withProject();
    await withCheck(ctx);
    // Remove the competitor made by the fixture.
    await ctx.scoped.entities.setStatus(ctx.rival.id, 'ignored');
    const page = await ctx.owner.get(`${ctx.base}/compare`).expect(200);
    assert.match(page.text, /No competitors are tracked yet/);
  });

  test('sources list who is cited, mark the brand’s own site, and show where it is missing', async () => {
    const ctx = await withProject();
    await withCheck(ctx);
    const page = await ctx.owner.get(`${ctx.base}/citations`).expect(200);
    assert.match(page.text, /3 citations in this period/);
    assert.match(page.text, /Where you are not present/);
    assert.match(page.text, /Your site/);
    assert.match(page.text, /g2-/);
    // g2 was cited in two answers and the brand was named in one of them.
    assert.match(page.text, /1 of 2/);
    assert.match(page.text, /Most cited pages/);
  });

  test('a project nobody has cited yet says so', async () => {
    const ctx = await withProject();
    const page = await ctx.owner.get(`${ctx.base}/citations`).expect(200);
    assert.match(page.text, /No sources were cited in this period/);
  });
});

test('the project tabs link to every dashboard screen', async () => {
  const ctx = await withProject();
  const page = await ctx.owner.get(ctx.base).expect(200);
  for (const screen of SCREENS) assert.match(page.text, new RegExp(`${ctx.base}/${screen}"`));
});
