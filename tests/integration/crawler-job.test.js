import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createHostPacer } from '../../src/crawler/pacer.js';
import { createRenderer } from '../../src/crawler/render.js';
import { requestScan } from '../../src/crawler/request-scan.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createFileStore } from '../../src/integrations/spaces.js';
import { closedSite, goodSite, serveRoutes } from '../helpers/fixture-sites.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';
import { startRuntime, waitForJob } from '../helpers/worker.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A website scan as a queued job, against real Redis, MySQL and a fixture website (BUILD_PLAN Phase 4 + the
 * Phase 3 path: queue -> retry -> ledger). Shows the scan saved for the right organization, retried safely,
 * marked failed when it cannot succeed, and unable to cross organizations.
 */
const db = connectTestDb();
const fx = fixtures(db);

let site;
let closed; // a site whose robots.txt shuts every crawler out
const targets = new Map(); // project domain -> where its fixture website really is
let storeDir;
let store;
let renderer;
let org;
let other;
let project;
let h;
let failStoreWrites = 0; // make the next N raw-page writes fail, to exercise retries

before(async () => {
  const holder = { routes: {} };
  site = await startServer((req, res) => serveRoutes(holder.routes)(req, res));
  holder.routes = goodSite(site.origin('good.test'));
  const closedHolder = { routes: {} };
  closed = await startServer((req, res) => serveRoutes(closedHolder.routes)(req, res));
  closedHolder.routes = closedSite(closed.origin('closed.test'));

  storeDir = await mkdtemp(path.join(os.tmpdir(), 'aeo-job-store-'));
  const real = createFileStore({ dir: storeDir, prefix: 'test/' });
  store = {
    ...real,
    async put(args) {
      if (failStoreWrites > 0) {
        failStoreWrites -= 1;
        throw new Error('the bucket is having a bad moment');
      }
      return real.put(args);
    },
  };
  const fetcher = testFetcher({
    ports: [site.port, closed.port],
    pacer: createHostPacer({ minGapMs: 0 }),
  });
  renderer = createRenderer({ fetcher });

  org = await fx.org();
  other = await fx.org();
  project = await fx.project(org.org.id, 'Scanned site');
  h = await startRuntime({
    db,
    queueNames: ['crawl'],
    crawler: {
      fetcher,
      renderer,
      store,
      // The project's domain is just a name; the fixture site lives on a port, which a domain cannot carry.
      targetFor: (domain) => targets.get(domain) ?? site.origin('good.test'),
    },
  });
});

after(async () => {
  await h?.stop();
  await renderer?.close();
  await site?.close();
  await closed?.close();
  await rm(storeDir, { recursive: true, force: true });
  await fx.cleanup();
  await db.close();
});

const queue = () => h.queue('crawl');
const ask = (orgRow = org, projectRow = project) =>
  requestScan({ db, jobs: h.runtime.jobs }, { orgId: orgRow.org.id, projectId: projectRow.id });
const ledgerFor = async (scan) =>
  (await org.scoped.usage.recent({ limit: 500 })).filter(
    (r) => r.ref_type === 'scan' && r.ref_id === scan.id,
  );

describe('a scan as a job', () => {
  test('is read, saved for the organization and its project, and put on the record', async () => {
    const scan = await ask();
    assert.equal(scan.status, 'queued');
    const job = await waitForJob(queue(), `scan-${scan.id}`, ['completed'], { timeoutMs: 60_000 });
    assert.equal(job.returnvalue.status, 'complete');

    const done = await org.scoped.scans.get(scan.id);
    assert.equal(done.status, 'complete');
    assert.ok(done.readiness_score >= 70, `score ${done.readiness_score}`);
    assert.equal(done.rubric_version, 'v0.1');
    assert.ok(done.started_at && done.finished_at);
    assert.equal(done.category_scores.platform, 'wordpress');
    assert.equal(done.pages_fetched, done.pages_planned);

    const checks = await org.scoped.scans.checks(scan.id);
    assert.equal(checks.length, 24);
    assert.ok(checks.every((c) => c.org_id === org.org.id));
    assert.match(
      checks.find((c) => c.check_code === 'A1').evidence.summary,
      /answer and search crawlers/,
    );

    const pages = await org.scoped.scans.pages(scan.id);
    assert.ok(pages.length >= 6 && pages.every((p) => p.raw_uri?.startsWith('test/crawl/')));
    const known = await org.scoped.scans.knownPages(project.id);
    assert.equal(known.length, pages.length);
    assert.ok(known.some((k) => k.page_type === 'pricing' && k.is_key_page));

    // The record of what the scan did: requests made, at no cost.
    const [row, ...extra] = await ledgerFor(scan);
    assert.equal(extra.length, 0);
    assert.deepEqual(
      [row.meter, row.provider_code, row.unit, String(row.cost_usd)],
      ['crawl', 'crawler', 'request', '0'],
    );
    assert.ok(Number(row.quantity) > 10, `requests recorded: ${row.quantity}`);
  });

  test('asking twice for the same scan is one job', async () => {
    const scan = await ask();
    await h.runtime.jobs.add(
      'crawl.readiness',
      { orgId: String(org.org.id), projectId: String(project.id), scanId: String(scan.id) },
      { jobId: `scan-${scan.id}` },
    );
    await waitForJob(queue(), `scan-${scan.id}`, ['completed'], { timeoutMs: 60_000 });
    assert.equal((await ledgerFor(scan)).length, 1);
    assert.equal((await org.scoped.scans.checks(scan.id)).length, 24);
  });

  test('a job that fails once is retried, and the results are not doubled', async () => {
    failStoreWrites = 1; // the first raw page cannot be saved
    const scan = await ask();
    const job = await waitForJob(queue(), `scan-${scan.id}`, ['completed'], { timeoutMs: 60_000 });
    assert.ok(job.attemptsMade >= 2, `attempts: ${job.attemptsMade}`);
    assert.equal((await org.scoped.scans.get(scan.id)).status, 'complete');
    assert.equal((await org.scoped.scans.checks(scan.id)).length, 24, 'one set of results');
    const pages = await org.scoped.scans.pages(scan.id);
    assert.equal(new Set(pages.map((p) => String(p.url_hash))).size, pages.length);
    assert.equal((await ledgerFor(scan)).length, 1, 'one ledger row');
  });

  test('a job that can never succeed ends in the dead-letter set, and the scan is marked failed', async () => {
    failStoreWrites = 1000;
    const scan = await ask();
    const job = await waitForJob(queue(), `scan-${scan.id}`, ['failed'], { timeoutMs: 60_000 });
    failStoreWrites = 0;
    assert.equal(job.attemptsMade, 5);
    assert.match(job.failedReason, /bad moment/);
    const row = await org.scoped.scans.get(scan.id);
    assert.equal(row.status, 'failed', 'not left looking busy');
    assert.equal(row.readiness_score, null);
    assert.equal((await ledgerFor(scan)).length, 0, 'nothing was scanned, nothing is recorded');
  });
});

describe('robots.txt and the project owner', () => {
  test('a project whose owner has not proven the site obeys robots.txt, like any other site', async () => {
    const mine = await fx.project(org.org.id, 'Unverified shut-out site');
    targets.set(mine.domain, closed.origin('closed.test'));
    const scan = await ask(org, mine);
    await waitForJob(queue(), `scan-${scan.id}`, ['completed'], { timeoutMs: 60_000 });
    const done = await org.scoped.scans.get(scan.id);
    assert.doesNotMatch((done.category_scores?.notes ?? []).join(' '), /project owner asked/);
    const pages = await org.scoped.scans.pages(scan.id);
    assert.ok(
      pages.some((p) => p.error === 'disallowed_by_robots'),
      'robots.txt was obeyed',
    );
    assert.ok(pages.length < 6, 'the pages it forbids were not fetched');
  });

  test('a verified project is scanned even when robots.txt shuts every crawler out, because its owner asked', async () => {
    const mine = await fx.project(org.org.id, 'Verified shut-out site');
    await org.scoped.projects.markVerified(mine.id, 'dns');
    targets.set(mine.domain, closed.origin('closed.test'));
    const scan = await ask(org, mine);
    const job = await waitForJob(queue(), `scan-${scan.id}`, ['completed'], {
      timeoutMs: 60_000,
    });
    assert.notEqual(job.returnvalue.status, 'failed');
    const done = await org.scoped.scans.get(scan.id);
    assert.ok(done.readiness_score !== null);
    assert.match(done.category_scores.notes.join(' '), /project owner asked/);
    const pages = await org.scoped.scans.pages(scan.id);
    assert.ok(pages.length >= 6 && pages.every((p) => p.error !== 'disallowed_by_robots'));
  });
});

describe('a scan stays inside its organization', () => {
  test('a payload naming another organization’s scan is refused, and that scan is untouched', async () => {
    const scan = await ask();
    // Hold the real job back so we can compare, then send a forged one.
    const forged = await h.runtime.jobs.add(
      'crawl.readiness',
      { orgId: String(other.org.id), projectId: String(project.id), scanId: String(scan.id) },
      { jobId: `forged-${scan.id}` },
    );
    const failed = await waitForJob(queue(), forged.id, ['failed'], { timeoutMs: 30_000 });
    assert.match(failed.failedReason, /not found/);
    assert.equal(failed.attemptsMade, 1, 'refused outright, not retried');
    await waitForJob(queue(), `scan-${scan.id}`, ['completed'], { timeoutMs: 60_000 });
    assert.deepEqual(await other.scoped.scans.recent({ projectId: project.id }), []);
    assert.deepEqual(await other.scoped.usage.recent({ limit: 50 }), []);
  });

  test('a project that belongs to someone else cannot be scanned', async () => {
    await assert.rejects(ask(other, project), (e) => e.code === 'PROJECT_NOT_IN_ORG');
  });

  test('a payload with a project that does not match the scan is refused', async () => {
    const second = await fx.project(org.org.id, 'Another site');
    const scan = await ask(org, project);
    const mismatched = await h.runtime.jobs.add(
      'crawl.readiness',
      { orgId: String(org.org.id), projectId: String(second.id), scanId: String(scan.id) },
      { jobId: `mismatch-${scan.id}` },
    );
    const failed = await waitForJob(queue(), mismatched.id, ['failed'], { timeoutMs: 30_000 });
    assert.match(failed.failedReason, /not found/);
  });
});

describe('a worker without a crawler', () => {
  test('refuses the job at once instead of retrying it five times', async () => {
    const bare = await startRuntime({ db, queueNames: ['crawl'] });
    try {
      const scan = await org.scoped.scans.create({ projectId: project.id, rubricVersion: 'v0.1' });
      const job = await bare.runtime.jobs.add(
        'crawl.readiness',
        { orgId: String(org.org.id), projectId: String(project.id), scanId: String(scan.id) },
        { jobId: `bare-${scan.id}` },
      );
      const failed = await waitForJob(bare.queue('crawl'), job.id, ['failed'], {
        timeoutMs: 30_000,
      });
      assert.match(failed.failedReason, /not configured/);
      assert.equal(failed.attemptsMade, 1);
    } finally {
      await bare.stop();
    }
  });
});
