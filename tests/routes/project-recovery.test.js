import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { authHarness, orgPathOf } from './auth-helpers.js';

/**
 * The Recovery screens (Milestone 14): who can see them, what each state says, and that the page never claims more than the
 * case holds. Cases are written through the repository, as the worker does; nothing here can open, change or close one.
 */
const h = authHarness({});
after(() => h.close());

let n = 0;
const unique = () => `${Date.now().toString(36)}${n++}`;
const DAY = 86_400_000;
const day = (offset) =>
  new Date(Date.parse('2026-09-30T00:00:00Z') + offset * DAY).toISOString().slice(0, 10);
const decline = {
  metric: 'mention_rate',
  engineCode: 'chatgpt',
  baseline: { window: [day(-55), day(-28)], n: 280, k: 168 },
  decline: { window: [day(-27), day(0)], n: 280, k: 100 },
  recent: { n: 140, k: 28 },
  deltaPp: -24.29,
  p: 0.001,
};

async function world() {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Recovery Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  const viewer = await h.signedIn();
  await scoped.memberships.add({ userId: viewer.user.id, role: 'viewer' });
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: `recovery-${unique()}.example.test`,
      name: 'Recovery Co',
      country: 'US',
      language: 'en',
    })
    .expect(303);
  const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  return { owner, viewer, scoped, project, orgId, base: `/app/o/${orgId}/projects/${pid}` };
}

const open = (ctx, extra = {}) =>
  ctx.scoped.recovery.open(
    ctx.project.id,
    { ...decline, ...extra },
    { asOf: day(0), onset: day(-20), now: new Date('2026-09-30T10:00:00Z') },
  );

describe('the recovery list', () => {
  test('is for people who can see the project; another organization gets a plain 404', async () => {
    const ctx = await world();
    await ctx.owner.get(`${ctx.base}/recovery`).expect(200);
    await ctx.viewer.get(`${ctx.base}/recovery`).expect(200);
    const other = await world();
    await other.owner.get(`${ctx.base}/recovery`).expect(404);
  });

  test('with no case it says nothing has dropped, and offers nothing to press', async () => {
    const ctx = await world();
    const page = await ctx.owner.get(`${ctx.base}/recovery`).expect(200);
    assert.match(page.text, /Nothing has dropped and stayed down/);
    assert.doesNotMatch(page.text, /action="[^"]*\/recovery/);
    assert.doesNotMatch(page.text, /undefined|NaN/);
  });

  test('lists an open case with its status and the numbers it was opened on', async () => {
    const ctx = await world();
    const { case: kase } = await open(ctx);
    const page = await ctx.owner.get(`${ctx.base}/recovery`).expect(200);
    assert.match(page.text, /AI answers name you less often on ChatGPT/);
    assert.match(page.text, /Finding the cause/);
    assert.match(page.text, /60% \(280 answers\)/);
    assert.match(page.text, new RegExp(`/recovery/${kase.publicId}`));
  });
});

describe('one case', () => {
  test('before the diagnosis it says it is looking, and refreshes itself', async () => {
    const ctx = await world();
    const { case: kase } = await open(ctx);
    const page = await ctx.owner.get(`${ctx.base}/recovery/${kase.publicId}`).expect(200);
    assert.match(page.text, /Looking for the cause/);
    assert.match(page.text, /data-auto-refresh/);
    assert.match(page.text, /How the figure moved/);
    assert.match(page.text, /We opened this case/);
  });

  test('"can’t tell" is said in those words, and is not a guess', async () => {
    const ctx = await world();
    const { case: kase } = await open(ctx);
    await ctx.scoped.recovery.saveDiagnosis(ctx.project.id, kase.id, {
      diagnosis: {
        outcome: 'cant_tell',
        onset: day(-20),
        causes: [],
        considered: [],
        reason: 'We found nothing in our records that lines up with the fall.',
      },
      repairs: [],
    });
    const page = await ctx.owner.get(`${ctx.base}/recovery/${kase.publicId}`).expect(200);
    assert.match(page.text, /We can’t tell what caused this/);
    assert.match(page.text, /nothing to repair yet/);
    assert.doesNotMatch(page.text, /Strong evidence|Likely/);
  });

  test('a named cause shows the facts it stands on, the repairs and the SEO-safe promise', async () => {
    const ctx = await world();
    const { case: kase } = await open(ctx);
    const rec = await h.fx.recommendation(ctx.project, {
      rule_code: 'readiness.A1',
      stable_key: 'readiness.a1:a1',
      title: 'Let answer crawlers in',
    });
    await ctx.scoped.recovery.saveDiagnosis(ctx.project.id, kase.id, {
      diagnosis: {
        outcome: 'named',
        onset: day(-20),
        causes: [
          {
            code: 'readiness_regression',
            label: 'Your site got harder for engines to read',
            band: 'strong',
            facts: [
              {
                id: 'readiness.regressed',
                text: 'A1 (Answer and search crawlers are allowed) passed in the check on Aug 20 and does not now.',
              },
              {
                id: 'readiness.reach',
                text: 'A1 decides whether engines can reach or read your pages at all.',
              },
            ],
            against: [],
          },
        ],
        considered: [],
      },
      repairs: [
        {
          cause: 'readiness_regression',
          kind: 'rules',
          ruleCodes: ['readiness.A1'],
          text: 'Fix the checks that stopped passing.',
        },
      ],
    });
    const page = await ctx.owner.get(`${ctx.base}/recovery/${kase.publicId}`).expect(200);
    assert.match(page.text, /Your site got harder for engines to read/);
    assert.match(page.text, /Strong evidence/);
    assert.match(page.text, /A1 \(Answer and search crawlers are allowed\) passed/);
    assert.match(page.text, /Repairs in progress/);
    assert.match(page.text, new RegExp(`/actions/${rec.id}`));
    assert.match(page.text, /Let answer crawlers in/);
    assert.match(
      page.text,
      /never blocks crawlers, removes noindex handling or changes a canonical/,
    );
  });

  test('a fix we could not look at is "Couldn’t check", never gone', async () => {
    const ctx = await world();
    const { case: kase } = await open(ctx);
    const rec = await h.fx.recommendation(ctx.project, {
      title: 'Add Organization schema',
      status: 'done',
    });
    await ctx.scoped.recovery.saveRecheck(ctx.project.id, kase.id, {
      scanId: null,
      scanStatus: 'failed',
      fixes: [{ recommendationId: String(rec.id), live: 'unknown', via: null }],
    });
    const page = await ctx.owner.get(`${ctx.base}/recovery/${kase.publicId}`).expect(200);
    assert.match(page.text, /Add Organization schema/);
    assert.match(page.text, /Couldn’t check/);
    assert.doesNotMatch(page.text, /No longer on your site/);
    assert.match(page.text, /We could not scan your site again/);
  });

  test('a closed case shows how it ended; only a real recovery gets the "Recovered" card', async () => {
    const ctx = await world();
    const { case: kase } = await open(ctx);
    await ctx.scoped.recovery.close(ctx.project.id, kase.id, {
      status: 'recovered',
      recent: { n: 140, k: 84, window: [day(-13), day(0)] },
      now: new Date('2026-10-20T10:00:00Z'),
    });
    const page = await ctx.owner.get(`${ctx.base}/recovery/${kase.publicId}`).expect(200);
    assert.match(page.text, />Recovered</);
    assert.match(page.text, /is 60% over the last 14 days \(140 answers\)/);
    assert.match(page.text, /The figure recovered/);

    const quiet = await world();
    const { case: other } = await open(quiet);
    await quiet.scoped.recovery.close(quiet.project.id, other.id, {
      status: 'closed_unknown',
      recent: { n: 140, k: 28 },
      now: new Date('2026-11-30T00:00:00Z'),
    });
    const text = (await quiet.owner.get(`${quiet.base}/recovery/${other.publicId}`).expect(200))
      .text;
    assert.match(text, /Closed, cause unknown/);
    assert.doesNotMatch(text, /Recovered by itself|You made changes while it was down/);
  });

  test('an unknown, malformed or other organization’s case is the same plain 404', async () => {
    const ctx = await world();
    const { case: kase } = await open(ctx);
    await ctx.owner.get(`${ctx.base}/recovery/${'0'.repeat(26)}`).expect(404);
    await ctx.owner.get(`${ctx.base}/recovery/not-an-id`).expect(404);
    const other = await world();
    await other.owner.get(`${ctx.base}/recovery/${kase.publicId}`).expect(404);
    // The address works only inside its own project.
    await other.owner.get(`${other.base}/recovery/${kase.publicId}`).expect(404);
  });

  test('has no way to change a case: nothing to post to', async () => {
    const ctx = await world();
    const { case: kase } = await open(ctx);
    const page = await ctx.owner.get(`${ctx.base}/recovery/${kase.publicId}`).expect(200);
    assert.doesNotMatch(page.text, /action="[^"]*\/recovery/);
    await ctx.owner.post(`${ctx.base}/recovery/${kase.publicId}`, {}).expect(404);
  });
});
