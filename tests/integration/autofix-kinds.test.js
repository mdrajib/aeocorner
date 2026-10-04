import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  buildMetaFix,
  buildPageSchemaFix,
  buildRobotsFix,
  payloadOf,
} from '../../src/core/autofix-fixes.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createWordPressClient } from '../../src/integrations/wordpress.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSecretBox } from '../../src/lib/secrets.js';
import { autofixHandlers } from '../../src/worker/handlers/autofix.js';
import { testFetcher } from '../helpers/http-fixture.js';
import { startWordPressStub } from '../helpers/wordpress-stub.js';

/**
 * The auto-fix job for the kinds beyond the home page's graph (page-type schema, titles and descriptions, robots.txt)
 * against the real database and the WordPress stand-in: what the plugin held is read and saved before anything is written,
 * what it held for another purpose is kept, a failure part-way puts back what was written, and an undo puts back exactly
 * what was there.
 */
const db = connectTestDb();
const fx = fixtures(db);
const logger = createLogger({ isTest: true, appEnv: 'test' });
const box = createSecretBox({ current: { version: 1, key: randomBytes(32) } });
const SECRET = 'c'.repeat(64);
const apply = autofixHandlers['autofix.apply'];
const undo = autofixHandlers['autofix.undo'];

let stub;
let fetcher;
const stubs = [];
const startStub = async (options) => {
  const s = await startWordPressStub(options);
  stubs.push(s);
  return s;
};
before(async () => {
  stub = await startStub();
  fetcher = testFetcher({ ports: [stub.port] });
});
after(async () => {
  for (const s of stubs) await s.close();
  await fx.cleanup();
  await db.close();
});

const ctxFor = (over = {}) => ({
  db,
  logger,
  now: () => new Date(),
  jobs: {
    added: [],
    async add(name, data, opts) {
      this.added.push({ name, data, opts });
    },
  },
  crawler: { fetcher, store: null, renderer: null },
  content: { secrets: box },
  ...over,
});
const job = (attemptsMade = 0, attempts = 3) => ({ id: 'af', attemptsMade, opts: { attempts } });

const RULES = {
  'readiness.C2': { category: 'structured_data', title: 'Add the missing schema' },
  'readiness.F3': { category: 'technical', title: 'Write titles and descriptions' },
  'readiness.A1': { category: 'crawler_access', title: 'Let crawlers in' },
};

/** An organization with a project, a recommendation for `ruleCode` and a site with the plugin connected. */
async function world(ruleCode, { site = stub, siteFetcher = fetcher } = {}) {
  const o = await fx.org();
  const project = await fx.project(o.org.id);
  const rec = await fx.recommendation(project, {
    rule_code: ruleCode,
    fix_path: 'auto_fix',
    ...RULES[ruleCode],
  });
  const scoped = db.forOrg(o.org.id);
  await createWordPressClient({
    fetcher: siteFetcher,
    siteUrl: site.siteUrl,
    username: site.username,
    appPassword: site.appPassword,
  }).plugin.connect({ secret: SECRET });
  await scoped.integrations.saveWordpress(project.id, {
    config: {
      siteUrl: site.siteUrl,
      username: site.username,
      pluginConnected: true,
      pluginVersion: '1.1.0',
    },
    secret: box.encrypt(
      { appPassword: site.appPassword, hmacSecret: SECRET },
      `wordpress:${o.org.id}:${project.id}`,
    ),
    userId: o.owner.id,
  });
  const approve = async (built) => {
    const change = await scoped.autofix.approve(project.id, rec.id, {
      userId: o.owner.id,
      ruleCode,
      kind: built.kind,
      targetUrl: built.scope === 'home' ? built.targetUrl : null,
      payload: payloadOf(ruleCode, built),
    });
    return {
      ...change,
      data: {
        orgId: String(o.org.id),
        projectId: String(project.id),
        siteChangeId: String(change.siteChangeId),
      },
    };
  };
  return { o, project, rec, scoped, approve, site };
}

const brand = { name: 'Data Dental' };
const lacking = (url, pageType, basics) => ({
  url,
  pageType,
  expected: ['x'],
  found: [],
  ok: false,
  onlyAfterJavaScript: false,
  basics: {
    url,
    pageType,
    title: '',
    description: '',
    name: '',
    lead: '',
    published: '',
    modified: '',
    ...basics,
  },
});

describe('page-type schema (readiness.C2)', () => {
  const build = (site) =>
    buildPageSchemaFix({
      brand,
      homeUrl: `${site.siteUrl}/`,
      evidence: {
        pages: [
          lacking(`${site.siteUrl}/about`, 'about', { name: 'About Data Dental' }),
          lacking(`${site.siteUrl}/services/whitening`, 'service', {
            name: 'Teeth whitening',
            description: 'In-office whitening in one visit.',
          }),
        ],
      },
    });

  test('keeps what a page already holds, adds the new block, marks the fix done and queues the re-check', async () => {
    const w = await world('readiness.C2');
    const aboutUrl = `${stub.siteUrl}/about`;
    const existing = {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebPage', name: 'Old', url: aboutUrl }],
    };
    stub.state.schemas.set(aboutUrl, existing);
    const built = build(stub);
    assert.equal(built.ok, true, built.reason);
    const change = await w.approve(built);
    const ctx = ctxFor();

    const result = await apply(ctx, change.data, job());
    assert.equal(result.applied, true);
    assert.equal(result.recommendation, 'done');

    const about = stub.state.schemas.get(aboutUrl);
    assert.deepEqual(
      about['@graph'].map((n) => n['@type']),
      ['WebPage', 'AboutPage'],
    );
    const service = stub.state.schemas.get(`${stub.siteUrl}/services/whitening`);
    assert.deepEqual(
      service['@graph'].map((n) => n['@type']),
      ['Service'],
    );
    assert.deepEqual(
      ctx.jobs.added.map((j) => j.name),
      ['fix.verify'],
    );

    const saved = await w.scoped.autofix.current(w.project.id, w.rec.id);
    assert.equal(saved.status, 'applied');
    assert.equal(saved.previous.captured, true);
    assert.deepEqual(
      saved.previous.pages.map((p) => [p.url, p.jsonld ? 'held' : 'none']),
      [
        [aboutUrl, 'held'],
        [`${stub.siteUrl}/services/whitening`, 'none'],
      ],
    );
  });

  test('a repeat after the write changes nothing, and does not read our own change back as "before"', async () => {
    const w = await world('readiness.C2');
    const change = await w.approve(build(stub));
    await apply(ctxFor(), change.data, job());
    const before = (await w.scoped.autofix.current(w.project.id, w.rec.id)).previous;
    const again = await apply(ctxFor(), change.data, job());
    assert.equal(again.repeated, true);
    assert.deepEqual((await w.scoped.autofix.current(w.project.id, w.rec.id)).previous, before);
    // The job itself repeated mid-way (status applying): the saved "before" stays the first reading.
    assert.equal(
      await w.scoped.autofix.savePrevious(w.project.id, change.siteChangeId, { pages: [] }),
      false,
    );
  });

  test('undo puts back exactly what each page held, and steps the recommendation back', async () => {
    const w = await world('readiness.C2');
    const aboutUrl = `${stub.siteUrl}/about`;
    const existing = {
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebPage', name: 'Old', url: aboutUrl }],
    };
    stub.state.schemas.set(aboutUrl, existing);
    stub.state.schemas.delete(`${stub.siteUrl}/services/whitening`);
    const change = await w.approve(build(stub));
    await apply(ctxFor(), change.data, job());

    await w.scoped.autofix.requestUndo(w.project.id, change.siteChangeId, { userId: w.o.owner.id });
    const result = await undo(ctxFor(), change.data, job());
    assert.equal(result.undone, true);
    assert.deepEqual(stub.state.schemas.get(aboutUrl), existing);
    assert.equal(stub.state.schemas.has(`${stub.siteUrl}/services/whitening`), false);
    const detail = await w.scoped.recommendations.get(w.project.id, w.rec.id);
    assert.equal(detail.recommendation.status, 'in_progress');
  });

  test('a write that fails part-way puts back the pages already written and says so', async () => {
    const w = await world('readiness.C2');
    const first = `${stub.siteUrl}/about`;
    const second = `${stub.siteUrl}/services/whitening`;
    stub.state.schemas.delete(first);
    stub.state.schemas.delete(second);
    stub.state.rejectSchemaFor.add(second);
    try {
      const change = await w.approve(build(stub));
      const result = await apply(ctxFor(), change.data, job(2, 3));
      assert.equal(result.failed, true);
      assert.equal(stub.state.schemas.has(first), false, 'the first page was put back');
      assert.equal(stub.state.schemas.has(second), false);
      const saved = await w.scoped.autofix.current(w.project.id, w.rec.id);
      assert.equal(saved.status, 'failed');
      const detail = await w.scoped.recommendations.get(w.project.id, w.rec.id);
      assert.notEqual(detail.recommendation.status, 'done');
    } finally {
      stub.state.rejectSchemaFor.clear();
    }
  });
});

describe('titles and descriptions (readiness.F3)', () => {
  const build = (site, extra = {}) =>
    buildMetaFix({
      brand,
      homeUrl: `${site.siteUrl}/`,
      evidence: {
        pages: [
          {
            url: `${site.siteUrl}/whitening`,
            pageType: 'service',
            title: '',
            description: '',
            name: 'Teeth whitening',
            lead: 'Our in-office whitening takes about an hour and lightens teeth several shades in one visit.',
            problems: ['no_title', 'no_description'],
            ...extra,
          },
        ],
      },
    });

  test('writes the proposal, and a part we did not propose keeps what the plugin already held', async () => {
    const w = await world('readiness.F3');
    const url = `${stub.siteUrl}/whitening`;
    stub.state.meta.set(url, { title: 'Kept title', description: '' });
    const built = build(stub, { problems: ['no_description'], title: 'Kept title' });
    assert.equal(built.items[0].title, null);
    const change = await w.approve(built);
    const result = await apply(ctxFor(), change.data, job());
    assert.equal(result.applied, true);
    assert.equal(stub.state.meta.get(url).title, 'Kept title');
    assert.match(stub.state.meta.get(url).description, /whitening takes about an hour/);
  });

  test('undo puts back the title and description the plugin held, or forgets ours when it held none', async () => {
    const w = await world('readiness.F3');
    const url = `${stub.siteUrl}/whitening`;
    stub.state.meta.delete(url);
    const change = await w.approve(build(stub));
    await apply(ctxFor(), change.data, job());
    assert.equal(stub.state.meta.get(url).title, 'Teeth whitening | Data Dental');

    await w.scoped.autofix.requestUndo(w.project.id, change.siteChangeId, { userId: w.o.owner.id });
    assert.equal((await undo(ctxFor(), change.data, job())).undone, true);
    assert.equal(stub.state.meta.has(url), false, 'the site’s own title and description are back');
  });

  test('only the latest change for a page can be taken back; a change to another page is not in the way', async () => {
    const w = await world('readiness.F3');
    stub.state.meta.clear();
    const change = async (built) => {
      const rec = await fx.recommendation(w.project, {
        rule_code: 'readiness.F3',
        fix_path: 'auto_fix',
        ...RULES['readiness.F3'],
      });
      const begun = await w.scoped.autofix.approve(w.project.id, rec.id, {
        userId: w.o.owner.id,
        ruleCode: 'readiness.F3',
        kind: 'meta',
        payload: payloadOf('readiness.F3', built),
      });
      const data = { ...w.data, siteChangeId: String(begun.siteChangeId) };
      await apply(ctxFor(), data, job());
      return begun.siteChangeId;
    };
    w.data = { orgId: String(w.o.org.id), projectId: String(w.project.id) };
    const first = await change(build(stub));
    const second = await change(build(stub, { name: 'Whitening, rewritten' }));
    const elsewhere = await change(
      build(stub, { url: `${stub.siteUrl}/other`, name: 'Other page' }),
    );

    const ask = (id) => w.scoped.autofix.requestUndo(w.project.id, id, { userId: w.o.owner.id });
    await assert.rejects(() => ask(first), { code: 'NOT_LATEST' });
    assert.deepEqual(
      await ask(second),
      { siteChangeId: second },
      'the page after it is another page',
    );
    assert.deepEqual(await ask(elsewhere), { siteChangeId: elsewhere });
  });
});

describe('robots.txt (readiness.A1)', () => {
  const build = (site, agents = ['OAI-SearchBot']) =>
    buildRobotsFix({
      homeUrl: `${site.siteUrl}/`,
      evidence: { robotsFile: true, bots: agents.map((agent) => ({ agent, verdict: 'blocked' })) },
    });

  test('adds the lines to the robots.txt WordPress builds, keeps groups saved by an earlier fix, and undo removes them', async () => {
    const site = await startStub();
    const siteFetcher = testFetcher({ ports: [site.port] });
    const w = await world('readiness.A1', { site, siteFetcher });
    const ctx = ctxFor({ crawler: { fetcher: siteFetcher, store: null, renderer: null } });
    site.state.robots = 'User-agent: PerplexityBot\nAllow: /';

    const change = await w.approve(build(site, ['OAI-SearchBot', 'PerplexityBot']));
    const result = await apply(ctx, change.data, job());
    assert.equal(result.applied, true);
    assert.equal(
      site.state.robots,
      'User-agent: PerplexityBot\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /',
      'one group per crawler, none repeated',
    );
    const res = await siteFetcher.fetch(`${site.siteUrl}/robots.txt`, {
      accept: ['text/plain'],
      bodyTypes: [/text/i],
    });
    const live = res.body.toString('utf8');
    assert.match(live, /User-agent: OAI-SearchBot\nAllow: \//);

    await w.scoped.autofix.requestUndo(w.project.id, change.siteChangeId, { userId: w.o.owner.id });
    assert.equal((await undo(ctx, change.data, job())).undone, true);
    assert.equal(
      site.state.robots,
      'User-agent: PerplexityBot\nAllow: /',
      'back to what was saved before',
    );
  });

  test('a site with a real robots.txt file is refused in plain words, and nothing is saved', async () => {
    const site = await startStub({ robotsFile: true });
    const w = await world('readiness.A1', {
      site,
      siteFetcher: testFetcher({ ports: [site.port] }),
    });
    const ctx = ctxFor({
      crawler: { fetcher: testFetcher({ ports: [site.port] }), store: null, renderer: null },
    });
    const change = await w.approve(build(site));
    const result = await apply(ctx, change.data, job());
    assert.equal(result.failed, true);
    assert.match(result.reason, /real robots\.txt file/);
    assert.equal(site.state.robots, null);
    const saved = await w.scoped.autofix.current(w.project.id, w.rec.id);
    assert.equal(saved.status, 'failed');
  });

  test('a plugin from before the new routes says it is out of date, not "not installed"', async () => {
    const site = await startStub({ pluginVersion: '1.0.0' });
    const w = await world('readiness.A1', {
      site,
      siteFetcher: testFetcher({ ports: [site.port] }),
    });
    const ctx = ctxFor({
      crawler: { fetcher: testFetcher({ ports: [site.port] }), store: null, renderer: null },
    });
    const change = await w.approve(build(site));
    const result = await apply(ctx, change.data, job(2, 3));
    assert.equal(result.failed, true);
    assert.match(result.reason, /out of date/);
  });
});

describe('approval', () => {
  test('refuses a kind that does not belong to the rule, or a payload of another rule', async () => {
    const w = await world('readiness.F3');
    const built = buildMetaFix({
      brand,
      homeUrl: `${stub.siteUrl}/`,
      evidence: {
        pages: [
          {
            url: `${stub.siteUrl}/a`,
            pageType: 'other',
            title: '',
            description: '',
            name: 'A page',
            lead: '',
            problems: ['no_title'],
          },
        ],
      },
    });
    const payload = payloadOf('readiness.F3', built);
    const common = { userId: w.o.owner.id, targetUrl: null };
    await assert.rejects(
      () =>
        w.scoped.autofix.approve(w.project.id, w.rec.id, {
          ...common,
          ruleCode: 'readiness.F3',
          kind: 'robots_txt',
          payload,
        }),
      { code: 'STALE_STATUS' },
    );
    await assert.rejects(
      () =>
        w.scoped.autofix.approve(w.project.id, w.rec.id, {
          ...common,
          ruleCode: 'readiness.F3',
          kind: 'meta',
          payload: { ...payload, ruleCode: 'readiness.A1' },
        }),
      { code: 'STALE_STATUS' },
    );
  });
});
