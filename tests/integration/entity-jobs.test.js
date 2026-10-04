import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { emptyBrandKit } from '../../src/core/brand-kit.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { WikidataError } from '../../src/integrations/wikidata.js';
import { createLogger } from '../../src/lib/logger.js';
import { refreshProject } from '../../src/worker/handlers/actions.js';
import { entityHandlers } from '../../src/worker/handlers/entity.js';

/**
 * A project's entity (Milestone 12): the profile and Wikidata checks the worker makes and saves, and the recommendations
 * the rules raise from them and from what the engines said. The profile checker and Wikidata are stand-ins that answer as
 * the test says (the real ones are proved in profile-check.test.js and wikidata.test.js); the database is real.
 */
const db = connectTestDb();
const fx = fixtures(db);
const logger = createLogger({ isTest: true, appEnv: 'test' });

let org;
let scoped;

before(async () => {
  org = await fx.org();
  scoped = org.scoped;
});
after(async () => {
  await fx.cleanup();
  await db.close();
});

const LINKEDIN = 'https://www.linkedin.com/company/data-dental';
const CRUNCHBASE = 'https://www.crunchbase.com/organization/data-dental';

/** A project that is tracking, with its brand and a Brand Kit that lists these profiles and facts. */
async function makeProject({ profiles = [], year = '2014', wikidataId = '' } = {}) {
  const project = await fx.project(org.org.id, 'Entity project', {
    status: 'active',
    slotHour: 163,
  });
  const brand = await fx.entity(project, { kind: 'brand', name: 'Data Dental' });
  await fx.engines(project, ['chatgpt', 'perplexity']);
  const kit = emptyBrandKit({ name: 'Data Dental', domain: 'datadental.test' });
  kit.entity = {
    foundingYear: year,
    headquarters: 'Austin, Texas',
    profiles: profiles.map((url) => ({
      platform: url.includes('linkedin') ? 'linkedin' : 'crunchbase',
      url,
    })),
    wikidataId,
  };
  await scoped.brandKits.save(project.id, { kit, source: 'edited', expectedVersion: null });
  return { project, brand };
}

const saveKit = async (project, change) => {
  const current = await scoped.brandKits.current(project.id);
  const kit = structuredClone(current.data);
  change(kit);
  await scoped.brandKits.save(project.id, {
    kit,
    source: 'edited',
    expectedVersion: current.version,
  });
};

function ctxFor({ profiles, wikidata } = {}) {
  const queued = [];
  return {
    queued,
    db,
    logger,
    now: () => new Date(),
    jobs: { add: async (name, data, opts) => queued.push({ name, data, opts }) },
    crawler: { fetcher: {} },
    entity: { profiles, wikidata },
  };
}

const profileResults = (byUrl) => ({
  check: async ({ url }) => ({
    httpStatus: 200,
    reachable: true,
    namesBrand: null,
    linksBack: null,
    ...byUrl[url],
  }),
});
const item = {
  id: 'Q7',
  labels: { en: { value: 'Data Dental' } },
  aliases: {},
  descriptions: {},
  claims: {},
};
const wikidataReturning = (items) => ({ lookup: async () => items });
const wikidataDown = {
  lookup: async () => {
    throw new WikidataError('down', { code: 'unreachable' });
  },
};
const check = (project) => (ctx) =>
  entityHandlers['entity.check'](ctx, { orgId: String(org.org.id), projectId: String(project.id) });
const stored = async (project) =>
  Object.fromEntries((await scoped.entityChecks.checks(project.id)).map((c) => [c.subject, c]));

describe('entity.check', () => {
  test('saves what it found for each profile and for Wikidata, and asks for a refresh', async () => {
    const { project } = await makeProject({ profiles: [LINKEDIN, CRUNCHBASE] });
    const ctx = ctxFor({
      profiles: profileResults({
        [LINKEDIN]: { status: 'passed', finding: 'names_brand', namesBrand: true, linksBack: true },
        [CRUNCHBASE]: {
          status: 'failed',
          finding: 'brand_not_named',
          namesBrand: false,
          linksBack: false,
        },
      }),
      // Two items with the name and no website: Wikidata cannot say which is theirs.
      wikidata: wikidataReturning([item, { ...item, id: 'Q8' }]),
    });
    const result = await check(project)(ctx);
    assert.deepEqual(result.profiles, { passed: 1, failed: 1, error: 0 });
    assert.equal(result.wikidata, 'ambiguous');

    const saved = await stored(project);
    assert.deepEqual([saved[LINKEDIN].status, saved[LINKEDIN].finding], ['passed', 'names_brand']);
    assert.equal(saved[LINKEDIN].platform, 'linkedin');
    assert.deepEqual(
      [saved[CRUNCHBASE].status, saved[CRUNCHBASE].finding],
      ['failed', 'brand_not_named'],
    );
    assert.deepEqual([saved.wikidata.status, saved.wikidata.finding], ['failed', 'ambiguous']);
    assert.ok(ctx.queued.some((j) => j.name === 'recommendations.refresh'));
  });

  test('is safe to repeat: the second run replaces the same rows', async () => {
    const { project } = await makeProject({ profiles: [LINKEDIN] });
    const ctx = ctxFor({
      profiles: profileResults({ [LINKEDIN]: { status: 'passed', finding: 'names_brand' } }),
      wikidata: wikidataReturning([]),
    });
    await check(project)(ctx);
    await check(project)(ctx);
    assert.equal((await scoped.entityChecks.checks(project.id)).length, 2);
  });

  test('a profile taken out of the Brand Kit is forgotten', async () => {
    const { project } = await makeProject({ profiles: [LINKEDIN, CRUNCHBASE] });
    const ctx = ctxFor({
      profiles: profileResults({
        [LINKEDIN]: { status: 'passed', finding: 'names_brand' },
        [CRUNCHBASE]: { status: 'passed', finding: 'names_brand' },
      }),
      wikidata: wikidataReturning([]),
    });
    await check(project)(ctx);
    await saveKit(project, (kit) => {
      kit.entity.profiles = kit.entity.profiles.filter((p) => p.url === LINKEDIN);
    });
    await check(project)(ctx);
    const saved = await stored(project);
    assert.ok(saved[LINKEDIN] && !saved[CRUNCHBASE]);
  });

  test('a check that could not look never overwrites a real result from the last month', async () => {
    const { project } = await makeProject({ profiles: [LINKEDIN] });
    await check(project)(
      ctxFor({
        profiles: profileResults({
          [LINKEDIN]: { status: 'passed', finding: 'names_brand', namesBrand: true },
        }),
        wikidata: wikidataReturning([
          {
            ...item,
            claims: { P856: [{ mainsnak: { datavalue: { value: 'https://datadental.test' } } }] },
          },
        ]),
      }),
    );
    // The project's domain is "<n>.example.test", so the item above is a name match only: ambiguous.
    const before = await stored(project);
    assert.equal(before[LINKEDIN].status, 'passed');

    const blocked = ctxFor({
      profiles: profileResults({ [LINKEDIN]: { status: 'error', finding: 'blocked' } }),
      wikidata: wikidataDown,
    });
    const result = await check(project)(blocked);
    assert.deepEqual(result.profiles, { passed: 0, failed: 0, error: 1 });
    assert.equal(result.wikidata, 'lookup_failed');
    const after = await stored(project);
    assert.deepEqual([after[LINKEDIN].status, after[LINKEDIN].finding], ['passed', 'names_brand']);
    assert.equal(after[LINKEDIN].details.lastAttempt.finding, 'blocked');
    assert.equal(after.wikidata.status, before.wikidata.status);
  });

  test('a first check that could not look is saved as "couldn\'t check", never as a failure', async () => {
    const { project } = await makeProject({ profiles: [LINKEDIN] });
    await check(project)(
      ctxFor({
        profiles: profileResults({ [LINKEDIN]: { status: 'error', finding: 'needs_login' } }),
        wikidata: wikidataDown,
      }),
    );
    const saved = await stored(project);
    assert.deepEqual([saved[LINKEDIN].status, saved[LINKEDIN].finding], ['error', 'needs_login']);
    assert.deepEqual([saved.wikidata.status, saved.wikidata.finding], ['error', 'lookup_failed']);
  });

  test('skips a project with no Brand Kit, and one that is not this organization’s is simply not found', async () => {
    const bare = await fx.project(org.org.id, 'No kit', { status: 'active', slotHour: 163 });
    const ctx = ctxFor({ profiles: profileResults({}), wikidata: wikidataReturning([]) });
    assert.deepEqual(await check(bare)(ctx), { skipped: 'no_brand_kit' });
    const other = await fx.org();
    const theirs = await fx.project(other.org.id, 'Theirs', { status: 'active', slotHour: 163 });
    assert.deepEqual(await check(theirs)(ctx), { skipped: 'project_gone' });
  });
});

describe('entity.sweep', () => {
  test('queues one check for each active project whose checks are older than a week, or missing', async () => {
    const stale = await makeProject({ profiles: [LINKEDIN] });
    const fresh = await makeProject({ profiles: [LINKEDIN] });
    await scoped.entityChecks.saveCheck(fresh.project.id, {
      kind: 'wikidata',
      subject: 'wikidata',
      status: 'failed',
      finding: 'not_in_wikidata',
    });
    await scoped.entityChecks.saveCheck(stale.project.id, {
      kind: 'wikidata',
      subject: 'wikidata',
      status: 'failed',
      finding: 'not_in_wikidata',
      now: new Date(Date.now() - 8 * 86_400_000),
    });
    const ctx = ctxFor();
    await entityHandlers['entity.sweep'](ctx);
    const projects = ctx.queued
      .filter((j) => j.name === 'entity.check')
      .map((j) => j.data.projectId);
    assert.ok(projects.includes(String(stale.project.id)));
    assert.ok(!projects.includes(String(fresh.project.id)));
    const again = ctxFor();
    await entityHandlers['entity.sweep'](again);
    const ids = ctx.queued.map((j) => j.opts.jobId);
    assert.deepEqual(
      again.queued.map((j) => j.opts.jobId).sort(),
      ids.sort(),
      'the same job IDs on the same day',
    );
  });
});

describe('the recommendations the entity rules raise', () => {
  /** Three readable brand answers that state the founding year wrongly (and one that gets it right). */
  async function brandAnswers(project, brand, years) {
    const prompt = await fx.prompt(project, {
      text: `Tell me about Data Dental ${years.join('')}`,
      intent: 'brand',
    });
    const run = await fx.run(project, { status: 'complete' });
    for (const [i, year] of years.entries()) {
      await fx.readAnswer(run, prompt, {
        engine: i % 2 ? 'chatgpt' : 'perplexity',
        sampleIdx: i,
        mentions: [{ entity: brand }],
        claims: [{ entity: brand, value: `Data Dental was founded in ${year}.` }],
      });
    }
  }
  const refresh = (project) => refreshProject({ db, scoped }, { projectId: project.id });
  const live = async (project) =>
    (await scoped.recommendations.list(project.id, { view: 'todo' })).filter((r) =>
      r.ruleCode.startsWith('entity.'),
    );

  test('a wrong fact raises one recommendation, and the same condition never a second', async () => {
    const { project, brand } = await makeProject({ year: '2014' });
    await brandAnswers(project, brand, ['2011', '2012', '2014']);
    const first = await refresh(project);
    assert.equal(first.created.length, 1);
    const [rec] = await live(project);
    assert.equal(rec.ruleCode, 'entity.wrong_fact');
    assert.equal(rec.evidence.type, 'entity_fact');
    assert.equal(rec.evidence.wrong, 2);
    assert.match(rec.whyMd, /2014/);

    const second = await refresh(project);
    assert.equal(second.created.length, 0);
    assert.equal((await live(project)).length, 1);
  });

  test('when the Brand Kit and the answers agree again, the issue is marked as no longer found', async () => {
    const { project, brand } = await makeProject({ year: '2014' });
    await brandAnswers(project, brand, ['2011', '2012']);
    await refresh(project);
    assert.equal((await live(project)).length, 1);
    // The customer was wrong, not the engines: the fact in their Brand Kit changes.
    await saveKit(project, (kit) => {
      kit.entity.foundingYear = '2011';
    });
    const next = await refresh(project);
    assert.equal(next.cleared, 1);
    const [rec] = await live(project);
    assert.ok(rec.signalClearedAt);
  });

  test('a stored failed profile raises one; a "couldn\'t check" opens nothing and does not clear it', async () => {
    const { project } = await makeProject({ profiles: [LINKEDIN] });
    await scoped.entityChecks.saveCheck(project.id, {
      kind: 'profile',
      subject: LINKEDIN,
      platform: 'linkedin',
      status: 'failed',
      finding: 'brand_not_named',
      details: { namesBrand: false, linksBack: false },
    });
    const first = await refresh(project);
    assert.equal(first.created.length, 1);
    const [rec] = await live(project);
    assert.equal(rec.ruleCode, 'entity.profile');
    assert.deepEqual(rec.affectedUrls, [LINKEDIN]);

    // A week later the platform blocks us. The profile is not "fixed".
    await scoped.entityChecks.saveCheck(project.id, {
      kind: 'profile',
      subject: LINKEDIN,
      platform: 'linkedin',
      status: 'error',
      finding: 'blocked',
      now: new Date(Date.now() + 40 * 86_400_000),
    });
    const blocked = await refresh(project);
    assert.equal(blocked.cleared, 0);
    assert.equal((await live(project))[0].signalClearedAt, null);

    // Then it passes: the issue is no longer found.
    await scoped.entityChecks.saveCheck(project.id, {
      kind: 'profile',
      subject: LINKEDIN,
      platform: 'linkedin',
      status: 'passed',
      finding: 'names_brand',
    });
    assert.equal((await refresh(project)).cleared, 1);
  });

  test('no Wikidata item is one low-priority recommendation, and an error raises none', async () => {
    const { project } = await makeProject();
    await scoped.entityChecks.saveCheck(project.id, {
      kind: 'wikidata',
      subject: 'wikidata',
      status: 'failed',
      finding: 'not_in_wikidata',
      details: { candidates: 0 },
    });
    await refresh(project);
    const [rec] = await live(project);
    assert.equal(rec.ruleCode, 'entity.wikidata');
    assert.match(rec.stepsMd, /independent sources/);

    const { project: other } = await makeProject();
    await scoped.entityChecks.saveCheck(other.id, {
      kind: 'wikidata',
      subject: 'wikidata',
      status: 'error',
      finding: 'lookup_failed',
    });
    await refresh(other);
    assert.equal((await live(other)).length, 0);
  });
});
