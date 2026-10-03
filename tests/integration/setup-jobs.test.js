import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { checkCoverage } from '../../src/core/prompt-rules.js';
import { createHostPacer } from '../../src/crawler/pacer.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { ProviderError } from '../../src/engines/contract.js';
import { createFileStore } from '../../src/integrations/spaces.js';
import { createLogger } from '../../src/lib/logger.js';
import { setupHandlers } from '../../src/worker/handlers/setup.js';
import { goodSite, serveRoutes } from '../helpers/fixture-sites.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';
import { generatedSet } from '../helpers/question-sets.js';

/**
 * The two setup jobs of a new project (Milestone 3): `brandkit.extract` and `questions.generate`. The handlers run
 * directly (the queue plumbing is proved elsewhere) against the real database, a fixture website and a stand-in for
 * Claude that records what it was asked and answers as the test says.
 */
const db = connectTestDb();
const fx = fixtures(db);
const logger = createLogger({ isTest: true, appEnv: 'test' });

let site;
let storeDir;
let fetcher;
let store;
let org;
let other;

const kitReply = (over = {}) => ({
  brand_name: 'Acme Dental',
  aliases: ['Acme'],
  legal_name: '',
  category: 'family dental practice',
  definition: 'A family dental practice in Austin.',
  geography: 'Austin, Texas',
  offerings: [{ name: 'Check-ups', url: '', description: 'Exams.', price: '' }],
  audiences: ['families'],
  differentiators: ['Open Saturdays'],
  facts: [{ label: 'Founded', value: '2009' }],
  voice: { tone: ['friendly'], reading_level: 'plain', use: [], avoid: [] },
  competitors: [
    { name: 'Bright Smiles', domain: 'brightsmiles.example' },
    { name: 'Lone Star Dental', domain: null },
  ],
  ...over,
});

const message = (json, over = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(json) }],
  usage: { input_tokens: 1200, output_tokens: 600 },
  ...over,
});

/** A stand-in for Claude: records each request, answers with `reply(request)`. */
function fakeClaude(reply) {
  const requests = [];
  return {
    requests,
    async extract(request) {
      requests.push(request);
      return reply(request);
    },
  };
}

/** The worker's `callProvider` reduced to what matters here: run the call, write its ledger row once per key. */
const callProvider = async (job, params, fn) => {
  const { value, usage } = await fn();
  if (usage && !usage.free) {
    await db.forOrg(BigInt(params.orgId)).usage.record({
      ...usage,
      projectId: BigInt(params.projectId),
      providerCode: params.provider,
      idempotencyKey: params.idempotencyKey,
    });
  }
  return { value };
};

const ctxWith = (claude, over = {}) => ({
  db,
  logger,
  now: () => new Date(),
  callProvider,
  crawler: { fetcher, store, renderer: null, targetFor: () => site.origin('good.test') },
  extraction: claude ? { claude } : null,
  audit: {},
  ...over,
});

let jobSeq = 0;
const job = () => ({ id: `test-${(jobSeq += 1)}`, attemptsMade: 0, opts: { attempts: 5 } });

const newProject = async (owner = org, name = 'Acme Dental', extra = {}) => {
  const project = await owner.scoped.projects.create({
    name,
    domain: `${fx.unique?.() ?? Math.random().toString(36).slice(2)}.example.test`,
    country: 'US',
    language: 'en',
    ...extra,
  });
  return project;
};

const payload = (owner, project, extra = {}) => ({
  orgId: String(owner.org.id),
  projectId: String(project.id),
  ...extra,
});

before(async () => {
  const holder = { routes: {} };
  site = await startServer((req, res) => serveRoutes(holder.routes)(req, res));
  holder.routes = goodSite(site.origin('good.test'));
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'aeo-setup-store-'));
  store = createFileStore({ dir: storeDir, prefix: 'test/' });
  fetcher = testFetcher({ ports: [site.port], pacer: createHostPacer({ minGapMs: 0 }) });
  org = await fx.org();
  other = await fx.org();
});

after(async () => {
  await site?.close();
  await rm(storeDir, { recursive: true, force: true });
  await fx.cleanup();
  await db.close();
});

describe('brandkit.extract', () => {
  test('saves the draft kit as the first version, suggests the competitors, and puts the cost on the record', async () => {
    const project = await newProject();
    const claude = fakeClaude(() => message(kitReply()));
    const result = await setupHandlers['brandkit.extract'](
      ctxWith(claude),
      payload(org, project, { baseVersion: 0 }),
      job(),
    );
    assert.deepEqual(result, { projectId: String(project.id), saved: true, suggested: 2 });

    const kit = await org.scoped.brandKits.current(project.id);
    assert.equal(kit.version, 1);
    assert.equal(kit.source, 'extracted');
    assert.equal(kit.data.identity.brandName, 'Acme Dental');
    assert.deepEqual(kit.data.identity.aliases, ['Acme']);

    const entities = await org.scoped.entities.list(project.id);
    const suggested = entities.filter((e) => e.kind === 'competitor');
    assert.deepEqual(suggested.map((e) => e.status).sort(), ['suggested', 'suggested']);
    assert.ok(suggested.every((e) => e.source === 'brand_kit'));

    // What Claude was shown: pages of the fixture website, fenced as data.
    assert.equal(claude.requests.length, 1);
    assert.match(claude.requests[0].messages[0].content[0].text, /<page url=/);

    const ledger = (await org.scoped.usage.recent({ limit: 500 })).filter(
      (r) => r.project_id === project.id,
    );
    assert.deepEqual(ledger.map((r) => r.meter).sort(), ['crawl', 'llm_brand_kit']);
    const paid = ledger.find((r) => r.meter === 'llm_brand_kit');
    assert.equal(paid.provider_code, 'anthropic');
    assert.ok(Number(paid.cost_usd) > 0);
  });

  test('is a no-op once the kit has moved on: a person who saved first is never overwritten', async () => {
    const project = await newProject();
    const mine = (await org.scoped.brandKits.current(project.id)) ?? null;
    assert.equal(mine, null);
    await org.scoped.brandKits.save(project.id, {
      kit: { identity: { brandName: 'My own edit' } },
      source: 'edited',
      expectedVersion: null,
    });
    const claude = fakeClaude(() => message(kitReply()));
    const result = await setupHandlers['brandkit.extract'](
      ctxWith(claude),
      payload(org, project, { baseVersion: 0 }),
      job(),
    );
    assert.equal(result.skipped, 'kit_changed');
    assert.equal(claude.requests.length, 0, 'nothing was asked, nothing was paid');
    const kit = await org.scoped.brandKits.current(project.id);
    assert.equal(kit.version, 1);
    assert.equal(kit.data.identity.brandName, 'My own edit');
  });

  test('a kit saved while Claude was working wins over the draft', async () => {
    const project = await newProject();
    const claude = fakeClaude(async () => {
      await org.scoped.brandKits.save(project.id, {
        kit: { identity: { brandName: 'Saved meanwhile' } },
        source: 'edited',
        expectedVersion: null,
      });
      return message(kitReply());
    });
    const result = await setupHandlers['brandkit.extract'](
      ctxWith(claude),
      payload(org, project, { baseVersion: 0 }),
      job(),
    );
    assert.equal(result.skipped, 'kit_changed');
    assert.equal(
      (await org.scoped.brandKits.current(project.id)).data.identity.brandName,
      'Saved meanwhile',
    );
    assert.equal(
      (await org.scoped.entities.list(project.id)).filter((e) => e.kind === 'competitor').length,
      0,
      'no competitors were suggested from a dropped draft',
    );
  });

  test('a reply that cannot be used is a retryable error and saves nothing', async () => {
    const project = await newProject();
    const claude = fakeClaude(() => message(kitReply({ brand_name: '  ' })));
    await assert.rejects(
      setupHandlers['brandkit.extract'](
        ctxWith(claude),
        payload(org, project, { baseVersion: 0 }),
        job(),
      ),
      (err) => err instanceof ProviderError && err.status === 'unusable_invalid_shape',
    );
    assert.equal(await org.scoped.brandKits.current(project.id), null);
  });

  test('a site that cannot be read ends quietly: the customer fills the kit in by hand', async () => {
    const project = await newProject();
    const claude = fakeClaude(() => message(kitReply()));
    const result = await setupHandlers['brandkit.extract'](
      ctxWith(claude, {
        crawler: { fetcher, store, renderer: null, targetFor: () => `http://127.0.0.1:1/` },
      }),
      payload(org, project, { baseVersion: 0 }),
      job(),
    );
    assert.equal(result.skipped, 'site_unreadable');
    assert.equal(claude.requests.length, 0);
    assert.equal(await org.scoped.brandKits.current(project.id), null);
  });

  test('another organization’s project is not found, and Claude is never asked', async () => {
    const theirs = await newProject(other, 'Theirs');
    const claude = fakeClaude(() => message(kitReply()));
    await assert.rejects(
      setupHandlers['brandkit.extract'](
        ctxWith(claude),
        payload(org, theirs, { baseVersion: 0 }),
        job(),
      ),
      UnrecoverableError,
    );
    assert.equal(claude.requests.length, 0);
    assert.equal(await other.scoped.brandKits.current(theirs.id), null);
  });

  test('without Claude configured it fails for good, not forever', async () => {
    const project = await newProject();
    await assert.rejects(
      setupHandlers['brandkit.extract'](
        ctxWith(null),
        payload(org, project, { baseVersion: 0 }),
        job(),
      ),
      UnrecoverableError,
    );
  });
});

describe('questions.generate', () => {
  test('saves a set that meets the intent coverage rules, as active generated questions grouped by topic', async () => {
    const project = await newProject(org, 'Acme Dental', { city: 'Austin' });
    await org.scoped.entities.addCompetitor(project.id, { name: 'Bright Smiles' });
    const claude = fakeClaude((request) => {
      const wanted = Number(request.messages[0].content[0].text.match(/Write (\d+) questions/)[1]);
      return message({ questions: generatedSet(wanted, { hasCity: true }) });
    });
    const result = await setupHandlers['questions.generate'](
      ctxWith(claude),
      payload(org, project, { count: 30 }),
      job(),
    );
    assert.equal(result.added, 30);

    const prompts = await org.scoped.prompts.list(project.id);
    assert.equal(prompts.length, 30);
    assert.ok(prompts.every((p) => p.status === 'active' && p.source === 'generated'));
    assert.ok(prompts.every((p) => p.city === 'Austin'));
    assert.deepEqual(checkCoverage(prompts, { hasCity: true }).problems, []);
    assert.ok(
      prompts.every((p) => p.clusterName),
      'each question has its topic',
    );

    const text = claude.requests[0].messages[0].content[0].text;
    assert.match(text, /competitors: Bright Smiles/);
    assert.match(text, /place: Austin/);

    const ledger = (await org.scoped.usage.recent({ limit: 500 })).filter(
      (r) => r.project_id === project.id && r.meter === 'llm_prompts',
    );
    assert.equal(ledger.length, 1);
  });

  test('a second run never duplicates what is there, and never goes past the plan’s 50', async () => {
    const project = await newProject();
    const claude = fakeClaude((request) => {
      const wanted = Number(request.messages[0].content[0].text.match(/Write (\d+) questions/)[1]);
      return message({ questions: generatedSet(wanted) });
    });
    const run = () =>
      setupHandlers['questions.generate'](
        ctxWith(claude),
        payload(org, project, { count: 50 }),
        job(),
      );
    assert.equal((await run()).added, 50);
    assert.equal((await run()).skipped, 'full');
    assert.equal(claude.requests.length, 1, 'a full set is not paid for again');
    assert.equal((await org.scoped.prompts.list(project.id)).length, 50);
  });

  test('a set that lacks an intent is refused as a whole, and nothing is saved', async () => {
    const project = await newProject();
    const claude = fakeClaude(() =>
      message({ questions: generatedSet(30).filter((q) => q.intent !== 'comparison') }),
    );
    await assert.rejects(
      setupHandlers['questions.generate'](
        ctxWith(claude),
        payload(org, project, { count: 30 }),
        job(),
      ),
      (err) => err instanceof ProviderError && err.status === 'unusable_bad_set',
    );
    assert.equal((await org.scoped.prompts.list(project.id)).length, 0);
  });

  test('another organization’s project is not found', async () => {
    const theirs = await newProject(other, 'Theirs');
    const claude = fakeClaude(() => message({ questions: generatedSet(30) }));
    await assert.rejects(
      setupHandlers['questions.generate'](
        ctxWith(claude),
        payload(org, theirs, { count: 30 }),
        job(),
      ),
      UnrecoverableError,
    );
    assert.equal(claude.requests.length, 0);
    assert.equal((await other.scoped.prompts.list(theirs.id)).length, 0);
  });
});
