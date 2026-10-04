import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { emptyBrandKit } from '../../src/core/brand-kit.js';
import { authHarness, orgPathOf } from './auth-helpers.js';

/**
 * The Entity screen and the Brand Kit's entity tab (Milestone 12): who can see and use them, what each state says, and
 * that nothing a profile check could not read is shown as a failure.
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
const LI = 'https://www.linkedin.com/company/entity-co';
const CB = 'https://www.crunchbase.com/organization/entity-co';

async function world() {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Entity Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  const viewer = await h.signedIn();
  await scoped.memberships.add({ userId: viewer.user.id, role: 'viewer' });
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: `entity-${unique()}.example.test`,
      name: 'Entity Co',
      country: 'US',
      language: 'en',
    })
    .expect(303);
  const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  return { owner, viewer, scoped, project, orgId, base: `/app/o/${orgId}/projects/${pid}` };
}

const saveEntity = (ctx, body) =>
  ctx.owner.post(`${ctx.base}/brand`, { section: 'entity', expectedVersion: '', ...body });

describe('the screen', () => {
  test('is for people who can see the project, and another organization gets a plain 404', async () => {
    const ctx = await world();
    await ctx.owner.get(`${ctx.base}/entity`).expect(200);
    await ctx.viewer.get(`${ctx.base}/entity`).expect(200);
    const other = await world();
    await other.owner.get(`${ctx.base}/entity`).expect(404);
  });

  test('with no profiles it says where to add them, and nothing is invented', async () => {
    const ctx = await world();
    const page = await ctx.owner.get(`${ctx.base}/entity`).expect(200);
    assert.match(page.text, /You haven’t listed any profiles yet/);
    assert.match(page.text, /Couldn’t check/, 'figures with nothing behind them are unknown');
    assert.match(page.text, /What to put on each profile/);
    assert.match(page.text, /Google Business Profile/);
    assert.doesNotMatch(page.text, /undefined|NaN/);
  });

  test('shows each result in words: confirmed, does not name you, and could not check', async () => {
    const ctx = await world();
    const current = await ctx.scoped.brandKits.current(ctx.project.id);
    const kit = structuredClone(
      current?.data ?? emptyBrandKit({ name: 'Entity Co', domain: ctx.project.domain }),
    );
    kit.entity = {
      foundingYear: '2014',
      headquarters: 'Austin, Texas',
      profiles: [
        { platform: 'linkedin', url: LI },
        { platform: 'crunchbase', url: CB },
      ],
      wikidataId: '',
    };
    await ctx.scoped.brandKits.save(ctx.project.id, {
      kit,
      source: 'edited',
      expectedVersion: current?.version ?? null,
    });
    await ctx.scoped.entityChecks.saveCheck(ctx.project.id, {
      kind: 'profile',
      subject: LI,
      platform: 'linkedin',
      status: 'passed',
      finding: 'names_brand',
      details: { linksBack: true },
    });
    await ctx.scoped.entityChecks.saveCheck(ctx.project.id, {
      kind: 'profile',
      subject: CB,
      platform: 'crunchbase',
      status: 'error',
      finding: 'blocked',
    });
    await ctx.scoped.entityChecks.saveCheck(ctx.project.id, {
      kind: 'wikidata',
      subject: 'wikidata',
      status: 'failed',
      finding: 'ambiguous',
      details: { candidates: 2 },
    });
    const page = await ctx.owner.get(`${ctx.base}/entity`).expect(200);
    assert.match(page.text, /Confirmed/);
    assert.match(page.text, /1 of 2/);
    assert.match(page.text, /turned our crawler away/);
    assert.doesNotMatch(page.text, /Doesn’t name you/, 'a blocked profile is not a failed one');
    assert.match(page.text, /Can’t tell which is yours/);
  });

  test('"Check now" queues one check for the ten minutes, for an editor; a viewer cannot', async () => {
    const ctx = await world();
    const before = added.length;
    const res = await ctx.owner.post(`${ctx.base}/entity/check`, {}).expect(303);
    assert.match(res.headers.location, /entity-checking|entity/);
    await ctx.owner.post(`${ctx.base}/entity/check`, {}).expect(303);
    const queued = added.slice(before).filter((j) => j.name === 'entity.check');
    assert.equal(queued.length, 2, 'both are asked for, with the same job ID');
    assert.equal(queued[0].options.jobId, queued[1].options.jobId);
    assert.deepEqual(Object.keys(queued[0].data).sort(), ['orgId', 'projectId']);
    const asViewer = await ctx.viewer.post(`${ctx.base}/entity/check`, {});
    assert.notEqual(asViewer.status, 303);
    assert.equal(added.slice(before).filter((j) => j.name === 'entity.check').length, 2);
    failQueue = true;
    try {
      const down = await ctx.owner.post(`${ctx.base}/entity/check`, {}).expect(303);
      assert.match(down.headers.location, /queue-down/);
    } finally {
      failQueue = false;
    }
  });
});

describe('the Brand Kit entity tab', () => {
  test('saves the facts and profiles, queues a check, and keeps what was typed when a line is wrong', async () => {
    const ctx = await world();
    const before = added.length;
    const ok = await saveEntity(ctx, {
      foundingYear: '2014',
      headquarters: 'Austin, Texas',
      profiles: `${LI}\n${CB}`,
      wikidataId: 'q42',
    }).expect(303);
    assert.match(ok.headers.location, /brand-saved/);
    const kit = (await ctx.scoped.brandKits.current(ctx.project.id)).data;
    assert.equal(kit.entity.foundingYear, '2014');
    assert.deepEqual(
      kit.entity.profiles.map((p) => p.platform),
      ['linkedin', 'crunchbase'],
    );
    assert.equal(kit.entity.wikidataId, 'Q42');
    assert.ok(added.slice(before).some((j) => j.name === 'entity.check'));

    const bad = await saveEntity(ctx, {
      expectedVersion: String((await ctx.scoped.brandKits.current(ctx.project.id)).version),
      foundingYear: '19x4',
      profiles: 'acme on linkedin',
    });
    assert.equal(bad.status, 422);
    assert.match(bad.text, /four-digit year/);
    assert.match(bad.text, /acme on linkedin/, 'what was typed is shown again');
    assert.equal(
      (await ctx.scoped.brandKits.current(ctx.project.id)).data.entity.foundingYear,
      '2014',
    );
  });

  test('a Wikidata address pasted among the profiles becomes the item number, not a profile', async () => {
    const ctx = await world();
    await saveEntity(ctx, { profiles: `${LI}\nhttps://www.wikidata.org/wiki/Q7` }).expect(303);
    const kit = (await ctx.scoped.brandKits.current(ctx.project.id)).data;
    assert.equal(kit.entity.wikidataId, 'Q7');
    assert.equal(kit.entity.profiles.length, 1);
  });
});
