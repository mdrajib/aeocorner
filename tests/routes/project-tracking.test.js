import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { isoWeekKey } from '../../src/core/slots.js';
import { RUNS_NOW_PLACEHOLDER } from '../../src/db/index.js';
import { authHarness, orgPathOf } from './auth-helpers.js';

/** Switching tracking on, "Check now", and what the project page says about the latest check (Milestone 4: 4.10, 4.11). */
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
const site = () => `tracking-${Date.now().toString(36)}-${n++}.example.test`;

/** An organization with an owner and a viewer, and one project with a question to track. */
async function withProject({ withQuestion = true } = {}) {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Tracking Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const viewer = await h.signedIn();
  await h.db.forOrg(found.org.id).memberships.add({ userId: viewer.user.id, role: 'viewer' });
  const scoped = h.db.forOrg(found.org.id);
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: site(),
      name: 'Tracking Dental',
      country: 'US',
      language: 'en',
    })
    .expect(303);
  const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  if (withQuestion) {
    await scoped.prompts.add(project.id, {
      text: 'Who is the best dentist near me?',
      intent: 'discovery',
    });
  }
  added.length = 0;
  return { owner, viewer, orgId, scoped, project, base: `/app/o/${orgId}/projects/${pid}` };
}

const queuedPlans = () => added.filter((j) => j.name === 'tracking.run');

describe('Start tracking', () => {
  test('the last setup step offers it, and starting switches tracking on and queues the first check', async () => {
    const { owner, base, scoped, project } = await withProject();
    const page = await owner.get(`${base}/setup/start`).expect(200);
    assert.match(page.text, /Start tracking/);
    assert.match(page.text, /name="_csrf"/);

    const started = await owner.post(`${base}/setup/start`, {}).expect(303);
    assert.match(started.headers.location, /\?notice=tracking-started$/);
    assert.equal((await scoped.projects.get(project.id)).status, 'active');

    const [run] = await scoped.runs.recent(project.id);
    assert.equal(run.trigger_type, 'onboarding');
    assert.equal(run.extraction_mode, 'sync', 'a person is waiting: read the answers at once');
    assert.equal(run.slot_key, isoWeekKey(new Date()), 'it is this week’s run');
    assert.equal(run.requested_by_user_id, owner.user.id);
    assert.equal(run.status, 'queued');

    assert.equal(queuedPlans().length, 1);
    assert.deepEqual(queuedPlans()[0].data, {
      orgId: String(project.org_id),
      runId: String(run.id),
    });
    assert.equal(queuedPlans()[0].options.jobId, `plan-${run.id}`);

    const home = await owner.get(started.headers.location).expect(200);
    assert.match(home.text, /Tracking is on\. Your first check is running/);
    assert.match(home.text, /Your first check is running/);
    assert.match(home.text, /data-auto-refresh="10"/, 'a running check refreshes the page');
    assert.match(home.text, /Stop updating/, 'and the visitor can stop it');
    const log = await scoped.activity.recent();
    assert.ok(log.some((a) => a.action === 'project.tracking_started'));
  });

  test('pressing it twice is still one check', async () => {
    const { owner, base, scoped, project } = await withProject();
    await owner.post(`${base}/setup/start`, {}).expect(303);
    await owner.post(`${base}/setup/start`, {}).expect(303);
    assert.equal((await scoped.runs.recent(project.id)).length, 1);
    // The second job has the first's ID, so the queue refuses it.
    assert.equal(new Set(queuedPlans().map((j) => j.options.jobId)).size, 1);
  });

  test('a project with no questions is not started, and nothing is queued or charged', async () => {
    const { owner, base, scoped, project } = await withProject({ withQuestion: false });
    const page = await owner.get(`${base}/setup/start`).expect(200);
    assert.match(page.text, /Not ready to start/);
    assert.doesNotMatch(page.text, />Start tracking</);
    const refused = await owner.post(`${base}/setup/start`, {}).expect(303);
    assert.match(refused.headers.location, /setup\/start\?notice=tracking-not-ready$/);
    assert.equal((await scoped.projects.get(project.id)).status, 'onboarding');
    assert.deepEqual(await scoped.runs.recent(project.id), []);
    assert.equal(added.length, 0);
  });

  test('if the queue is down tracking still switches on, and the page says the first check didn’t start', async () => {
    const { owner, base, scoped, project } = await withProject();
    failQueue = true;
    try {
      const res = await owner.post(`${base}/setup/start`, {}).expect(303);
      assert.match(res.headers.location, /\?notice=tracking-on-no-first-run$/);
    } finally {
      failQueue = false;
    }
    assert.equal((await scoped.projects.get(project.id)).status, 'active');
    const home = await owner.get(`${base}?notice=tracking-on-no-first-run`).expect(200);
    assert.match(home.text, /couldn’t start the first check just now/);
  });

  test('a viewer can neither see the button’s result nor start tracking', async () => {
    const { viewer, base, scoped, project } = await withProject();
    await viewer.post(`${base}/setup/start`, {}).expect(403);
    assert.equal((await scoped.projects.get(project.id)).status, 'onboarding');
    const page = await viewer.get(`${base}/setup/start`).expect(200);
    assert.match(page.text, /Someone who can edit this project needs to start tracking/);
    assert.doesNotMatch(page.text, />Start tracking</);
  });
});

describe('Check now', () => {
  async function activeProject() {
    const ctx = await withProject();
    await ctx.owner.post(`${ctx.base}/setup/start`, {}).expect(303);
    const [first] = await ctx.scoped.runs.recent(ctx.project.id);
    // The first check is over, so an extra one can be asked for.
    await ctx.scoped.runs.finish(first.id, 'complete');
    added.length = 0;
    return ctx;
  }

  test('starts a manual check, read at once, and takes one from the month’s allowance', async () => {
    const { owner, base, scoped, project } = await activeProject();
    const res = await owner.post(`${base}/run-now`, {}).expect(303);
    assert.match(res.headers.location, /\?notice=run-started$/);
    const runs = await scoped.runs.recent(project.id);
    assert.equal(runs.length, 2);
    const manual = runs.find((r) => r.trigger_type === 'manual');
    assert.match(manual.slot_key, /^m-[0-9A-Z]{26}$/);
    assert.equal(manual.extraction_mode, 'sync');
    assert.equal(queuedPlans().length, 1);
    assert.deepEqual(await scoped.quota.runNowUsage(), { used: 1, limit: RUNS_NOW_PLACEHOLDER });
    const home = await owner.get(`${base}`).expect(200);
    assert.match(home.text, /A check is running/);
    assert.match(home.text, /A check is running\.<\/span>/, 'and the button says why it is off');
  });

  test('a second click while one is running starts nothing and costs nothing', async () => {
    const { owner, base, scoped, project } = await activeProject();
    await owner.post(`${base}/run-now`, {}).expect(303);
    const again = await owner.post(`${base}/run-now`, {}).expect(303);
    assert.match(again.headers.location, /\?notice=run-in-progress$/);
    assert.equal((await scoped.runs.recent(project.id)).length, 2);
    assert.equal((await scoped.quota.runNowUsage()).used, 1);
  });

  test('when the month’s allowance is used up it says so and starts nothing', async () => {
    const { owner, base, scoped, project } = await activeProject();
    for (let i = 0; i < RUNS_NOW_PLACEHOLDER; i += 1) {
      await owner.post(`${base}/run-now`, {}).expect(303);
      const [latest] = await scoped.runs.recent(project.id);
      await scoped.runs.finish(latest.id, 'complete');
    }
    const runsBefore = (await scoped.runs.recent(project.id)).length;
    const refused = await owner.post(`${base}/run-now`, {}).expect(303);
    assert.match(refused.headers.location, /\?notice=run-now-limit$/);
    assert.equal((await scoped.runs.recent(project.id)).length, runsBefore);
    const home = await owner.get(base).expect(200);
    assert.match(home.text, /0 extra checks left this month/);
  });

  test('a check that could not be queued gives the allowance back', async () => {
    const { owner, base, scoped } = await activeProject();
    failQueue = true;
    try {
      const res = await owner.post(`${base}/run-now`, {}).expect(303);
      assert.match(res.headers.location, /\?notice=queue-down$/);
    } finally {
      failQueue = false;
    }
    assert.equal((await scoped.quota.runNowUsage()).used, 0);
  });

  test('is not offered while tracking is off, and a viewer cannot ask', async () => {
    const { owner, viewer, base, scoped, project } = await withProject();
    const off = await owner.post(`${base}/run-now`, {}).expect(303);
    assert.match(off.headers.location, /\?notice=run-now-inactive$/);
    assert.deepEqual(await scoped.runs.recent(project.id), []);
    const home = await owner.get(base).expect(200);
    assert.match(home.text, /Tracking is switched off while you set up/);
    await viewer.post(`${base}/run-now`, {}).expect(403);
  });
});

describe('what the project page says about the latest check', () => {
  async function activeWith(run) {
    const ctx = await withProject();
    await ctx.owner.post(`${ctx.base}/setup/start`, {}).expect(303);
    const [first] = await ctx.scoped.runs.recent(ctx.project.id);
    await ctx.scoped.runs.begin(first.id, { promptsCount: 1, tasksPlanned: run.planned });
    await ctx.scoped.runs.finish(first.id, run.status);
    return ctx;
  }

  test('a partial check says how many answers were left out, and never calls them “not mentioned”', async () => {
    const { owner, base, scoped, project } = await activeWith({ status: 'partial', planned: 6 });
    // The counts come from settle(); a run finished by hand has none, so state them here.
    const [run] = await scoped.runs.recent(project.id);
    assert.equal(run.status, 'partial');
    const home = await owner.get(base).expect(200);
    assert.match(home.text, /The last check is incomplete/);
    assert.match(home.text, /not counted as “not mentioned”/);
    assert.doesNotMatch(
      home.text,
      /data-auto-refresh="10"/,
      'a finished check does not refresh the page',
    );
  });

  test('a failed check shows no figure and promises none', async () => {
    const { owner, base } = await activeWith({ status: 'failed', planned: 6 });
    const home = await owner.get(base).expect(200);
    assert.match(home.text, /couldn’t read any answers/);
    assert.match(home.text, /no number is guessed/);
  });

  test('a check whose job was lost is shown as stalled, and does not block another', async () => {
    const { owner, base, scoped, project } = await withProject();
    await owner.post(`${base}/setup/start`, {}).expect(303);
    const [first] = await scoped.runs.recent(project.id);
    await scoped.runs.finish(first.id, 'failed');
    await h.fx.run(project, {
      status: 'collecting',
      queuedAt: new Date(Date.now() - 31 * 3_600_000),
    });
    const home = await owner.get(base).expect(200);
    assert.match(home.text, /The last check didn’t finish/);
    assert.doesNotMatch(home.text, /data-auto-refresh="10"/);
    const res = await owner.post(`${base}/run-now`, {}).expect(303);
    assert.match(res.headers.location, /\?notice=run-started$/);
  });

  test('a viewer sees the check but not the button', async () => {
    const { viewer, base } = await activeWith({ status: 'complete', planned: 6 });
    const home = await viewer.get(base).expect(200);
    assert.match(home.text, /The last check finished/);
    assert.doesNotMatch(home.text, />Run a check now</);
  });

  test('the last setup step of a project that is tracking says so, and offers no second start', async () => {
    const { owner, base } = await activeWith({ status: 'complete', planned: 6 });
    const page = await owner.get(`${base}/setup/start`).expect(200);
    assert.match(page.text, /Tracking is on\./);
    assert.doesNotMatch(page.text, />Start tracking</);
  });
});
