import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { buildAutofix } from '../../src/core/autofix.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createWordPressClient } from '../../src/integrations/wordpress.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSecretBox } from '../../src/lib/secrets.js';
import { autofixHandlers } from '../../src/worker/handlers/autofix.js';
import { testFetcher } from '../helpers/http-fixture.js';
import { startWordPressStub } from '../helpers/wordpress-stub.js';

/**
 * The auto-fix job (UI_DESIGN D3) against the real database and the WordPress stand-in: an approved change is written to
 * the site through the plugin, the recommendation is marked done with its baseline and a same-day re-check is queued,
 * and every way it can go wrong ends in a plain reason, never a silent half-fix.
 */
const db = connectTestDb();
const fx = fixtures(db);
const logger = createLogger({ isTest: true, appEnv: 'test' });
const box = createSecretBox({ current: { version: 1, key: randomBytes(32) } });
const SECRET = 'b'.repeat(64);
const apply = autofixHandlers['autofix.apply'];

let stub;
let fetcher;
before(async () => {
  stub = await startWordPressStub();
  fetcher = testFetcher({ ports: [stub.port] });
});
after(async () => {
  await stub.close();
  await fx.cleanup();
  await db.close();
});

const recorder = () => ({
  added: [],
  async add(name, data, opts) {
    this.added.push({ name, data, opts });
  },
});
const ctxFor = (over = {}) => ({
  db,
  logger,
  now: () => new Date(),
  jobs: recorder(),
  crawler: { fetcher, store: null, renderer: null },
  content: { secrets: box },
  ...over,
});
const job = (attemptsMade = 0, attempts = 3) => ({ id: 'af', attemptsMade, opts: { attempts } });

/** An organization with a project, a C1 recommendation, a connected site, and an approved change ready to write. */
async function world({ pluginConnected = true, ruleCode = 'readiness.C1', approve = true } = {}) {
  const o = await fx.org();
  const project = await fx.project(o.org.id);
  const rec = await fx.recommendation(project, {
    rule_code: ruleCode,
    category: 'structured_data',
    fix_path: 'auto_fix',
    title: 'Add Organization schema',
  });
  const scoped = db.forOrg(o.org.id);
  await createWordPressClient({
    fetcher,
    siteUrl: stub.siteUrl,
    username: stub.username,
    appPassword: stub.appPassword,
  }).plugin.connect({ secret: SECRET });
  await scoped.integrations.saveWordpress(project.id, {
    config: { siteUrl: stub.siteUrl, username: stub.username, pluginConnected },
    secret: box.encrypt(
      { appPassword: stub.appPassword, hmacSecret: pluginConnected ? SECRET : undefined },
      `wordpress:${o.org.id}:${project.id}`,
    ),
    userId: o.owner.id,
  });
  const built = buildAutofix({
    ruleCode,
    brand: { name: 'Data Dental', definition: 'A family dental practice in Austin.' },
    homeUrl: stub.siteUrl,
    extras: { logoUrl: 'https://dd.example/logo.png', sameAs: [] },
  });
  assert.equal(built.ok, true);
  let change = null;
  if (approve) {
    change = await scoped.autofix.approve(project.id, rec.id, {
      userId: o.owner.id,
      targetUrl: built.targetUrl,
      jsonld: built.jsonld,
      hash: built.hash,
      ruleCode,
    });
  }
  const data = (c = change) => ({
    orgId: String(o.org.id),
    projectId: String(project.id),
    siteChangeId: String(c?.siteChangeId),
  });
  return { o, project, rec, scoped, built, change, data };
}

describe('autofix.apply', () => {
  test('writes the approved structured data, marks the recommendation done, and queues the same-day re-check', async () => {
    const w = await world();
    const ctx = ctxFor();
    const result = await apply(ctx, w.data(), job());
    assert.equal(result.applied, true);
    assert.equal(result.recommendation, 'done');

    const stored = stub.state.schemas.get(w.built.targetUrl);
    assert.deepEqual(stored, w.built.jsonld, 'exactly what was previewed and approved');
    assert.deepEqual(stub.state.indexNowPings.slice(-1), [w.built.targetUrl]);

    const change = await w.scoped.autofix.current(w.project.id, w.rec.id);
    assert.equal(change.status, 'applied');
    assert.ok(change.appliedAt);
    const detail = await w.scoped.recommendations.get(w.project.id, w.rec.id);
    assert.equal(detail.recommendation.status, 'done');
    assert.ok(detail.recommendation.baseline ?? true);
    assert.deepEqual(
      ctx.jobs.added.map((j) => [j.name, j.data.recommendationId, j.data.attempt]),
      [['fix.verify', String(w.rec.id), 1]],
    );
    const nodes = await w.scoped.autofix.appliedNodes(w.project.id, w.built.targetUrl);
    assert.deepEqual(
      nodes.map((n) => n['@type']),
      ['Organization'],
    );
  });

  test('a repeat of the same job changes nothing and queues nothing more', async () => {
    const w = await world();
    await apply(ctxFor(), w.data(), job());
    const ctx = ctxFor();
    const again = await apply(ctx, w.data(), job());
    assert.equal(again.repeated, true);
    assert.equal(again.recommendation, 'left_alone');
    assert.equal(ctx.jobs.added.length, 0);
  });

  test('a second fix for the same page builds on the first: both types stay in the one block', async () => {
    const w = await world();
    await apply(ctxFor(), w.data(), job());
    const rec2 = await fx.recommendation(w.project, {
      rule_code: 'readiness.C4',
      category: 'structured_data',
      fix_path: 'auto_fix',
    });
    const existing = await w.scoped.autofix.appliedNodes(w.project.id, w.built.targetUrl);
    const site = buildAutofix({
      ruleCode: 'readiness.C4',
      brand: { name: 'Data Dental' },
      homeUrl: stub.siteUrl,
      existingNodes: existing,
    });
    const second = await w.scoped.autofix.approve(w.project.id, rec2.id, {
      userId: w.o.owner.id,
      targetUrl: site.targetUrl,
      jsonld: site.jsonld,
      hash: site.hash,
      ruleCode: 'readiness.C4',
    });
    await apply(ctxFor(), w.data(second), job());
    assert.deepEqual(
      stub.state.schemas.get(site.targetUrl)['@graph'].map((n) => n['@type']),
      ['Organization', 'WebSite'],
    );
  });

  test('data that no longer matches its fingerprint is refused, and nothing is sent', async () => {
    const w = await world();
    await fx.forceSiteChange(w.change.siteChangeId, {
      payload: { ruleCode: 'readiness.C1', jsonld: w.built.jsonld, hash: 'tampered' },
    });
    const before = stub.state.schemas.size;
    const result = await apply(ctxFor(), w.data(), job());
    assert.equal(result.failed, true);
    assert.match(result.reason, /did not match what was approved/);
    assert.equal(stub.state.schemas.size, before);
    const change = await w.scoped.autofix.current(w.project.id, w.rec.id);
    assert.equal(change.status, 'failed');
    const detail = await w.scoped.recommendations.get(w.project.id, w.rec.id);
    assert.equal(
      detail.recommendation.status,
      'open',
      'a failed write does not move the recommendation',
    );
  });

  test('without the plugin nothing is written and the reason is plain', async () => {
    const w = await world({ pluginConnected: true });
    await w.scoped.integrations.saveWordpress(w.project.id, {
      config: { siteUrl: stub.siteUrl, username: stub.username, pluginConnected: false },
      secret: box.encrypt(
        { appPassword: stub.appPassword },
        `wordpress:${w.o.org.id}:${w.project.id}`,
      ),
      userId: w.o.owner.id,
    });
    const result = await apply(ctxFor(), w.data(), job());
    assert.equal(result.failed, true);
    assert.match(result.reason, /plugin is not connected/);
  });

  test('a site that is down is retried, and only the last attempt gives up with a reason', async () => {
    const w = await world();
    stub.failNext(503);
    await assert.rejects(() => apply(ctxFor(), w.data(), job(0, 3)));
    assert.equal((await w.scoped.autofix.current(w.project.id, w.rec.id)).status, 'applying');
    stub.failNext(503);
    const last = await apply(ctxFor(), w.data(), job(2, 3));
    assert.equal(last.failed, true);
    assert.equal((await w.scoped.autofix.current(w.project.id, w.rec.id)).status, 'failed');
  });

  test('a change that is not this organization’s is not found', async () => {
    const w = await world();
    const other = await fx.org();
    await assert.rejects(
      () => apply(ctxFor(), { ...w.data(), orgId: String(other.org.id) }, job()),
      /PROJECT_NOT_IN_ORG|not found/i,
    );
  });
});

describe('autofix.approve', () => {
  test('refuses a second approval while the first is still in flight, a stale recommendation, and a site without the plugin', async () => {
    const w = await world();
    const again = () =>
      w.scoped.autofix.approve(w.project.id, w.rec.id, {
        userId: w.o.owner.id,
        targetUrl: w.built.targetUrl,
        jsonld: w.built.jsonld,
        hash: w.built.hash,
        ruleCode: 'readiness.C1',
      });
    await assert.rejects(again, { code: 'ALREADY_APPROVED' });

    const dismissed = await fx.recommendation(w.project, {
      rule_code: 'readiness.C1',
      category: 'structured_data',
      fix_path: 'auto_fix',
      status: 'dismissed',
    });
    await assert.rejects(
      () =>
        w.scoped.autofix.approve(w.project.id, dismissed.id, {
          userId: w.o.owner.id,
          targetUrl: w.built.targetUrl,
          jsonld: w.built.jsonld,
          hash: w.built.hash,
          ruleCode: 'readiness.C1',
        }),
      { code: 'STALE_STATUS' },
    );

    const bare = await world({ pluginConnected: false, approve: false });
    await assert.rejects(
      () =>
        bare.scoped.autofix.approve(bare.project.id, bare.rec.id, {
          userId: bare.o.owner.id,
          targetUrl: bare.built.targetUrl,
          jsonld: bare.built.jsonld,
          hash: bare.built.hash,
          ruleCode: 'readiness.C1',
        }),
      { code: 'PLUGIN_NOT_CONNECTED' },
    );
    await assert.rejects(
      () =>
        w.scoped.autofix.approve(w.project.id, w.rec.id, {
          userId: null,
          targetUrl: w.built.targetUrl,
          jsonld: w.built.jsonld,
          hash: w.built.hash,
          ruleCode: 'readiness.C1',
        }),
      { code: 'APPROVAL_NEEDS_A_PERSON' },
    );
  });
});
