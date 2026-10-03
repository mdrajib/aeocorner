import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/**
 * The free-audit repository (Milestone 1, tasks 1.01, 1.03, 1.09), against the real test database: the audit's life,
 * its scan stored with no organization, and answers that a retried job replaces instead of doubling.
 */
const db = connectTestDb();
const fx = fixtures(db);

after(async () => {
  await fx.cleanup();
  await db.close();
});

/** What `runSiteScan` hands back, cut down to what the writer stores. */
const scanResult = (overrides = {}) => ({
  status: 'complete',
  rubricVersion: 'r-test',
  readinessScore: 72,
  categoryScores: {},
  coverage: 1,
  counts: { pass: 1, fail: 0, error: 0 },
  notes: [],
  site: { platform: 'custom', origin: 'https://example.test' },
  robots: { key: null },
  sitemaps: { found: [] },
  pagesPlanned: 1,
  pagesFetched: 1,
  finishedAt: new Date().toISOString(),
  pages: [{ url: 'https://example.test/', status: 200, isKey: true, jsonLdTypes: [] }],
  checks: [{ code: 'A1', status: 'pass', points: 5, possible: 5, summary: 'ok', evidence: {} }],
  ...overrides,
});

const answer = (overrides = {}) => ({
  promptIdx: 0,
  engineCode: 'chatgpt',
  providerCode: 'dataforseo',
  method: 'serp',
  status: 'ok',
  brandPresent: true,
  ...overrides,
});

describe('an audit’s life', () => {
  test('it waits for verification, is queued by it once, runs, and finishes once', async () => {
    const audit = await fx.audit();
    assert.equal(audit.status, 'awaiting_verification');
    assert.equal(audit.public_id.length, 26);

    assert.equal(await db.audits.start(audit.id), false, 'an unverified audit does not run');
    assert.equal(await db.audits.verify(audit.id), true);
    assert.equal(await db.audits.verify(audit.id), false, 'a second click changes nothing');
    assert.equal(await db.audits.start(audit.id), true);

    const done = {
      status: 'complete',
      visibilityScore: 40,
      readinessScore: 72,
      aeoScore: 55,
      costUsd: '0.31',
    };
    assert.equal(await db.audits.finish(audit.id, done), true);
    assert.equal(
      await db.audits.finish(audit.id, { ...done, aeoScore: 1 }),
      false,
      'finished audits are final',
    );

    const saved = await db.audits.getByPublicId(audit.public_id);
    assert.equal(saved.status, 'complete');
    assert.equal(saved.aeo_score, 55);
    assert.equal(saved.cost_usd.toString(), '0.31');
  });

  test('scores that could not be worked out stay empty, not 0', async () => {
    const audit = await fx.audit();
    await db.audits.verify(audit.id);
    await db.audits.finish(audit.id, { status: 'partial', readinessScore: 50 });
    const saved = await db.audits.get(audit.id);
    assert.equal(saved.visibility_score, null);
    assert.equal(saved.aeo_score, null);
  });

  test('a failed audit is marked failed, but a finished one is not overwritten by a late failure', async () => {
    const failing = await fx.audit();
    await db.audits.verify(failing.id);
    assert.equal(await db.audits.fail(failing.id), true);
    assert.equal((await db.audits.get(failing.id)).status, 'failed');

    const finished = await fx.audit();
    await db.audits.verify(finished.id);
    await db.audits.finish(finished.id, { status: 'complete' });
    assert.equal(await db.audits.fail(finished.id), false);
    assert.equal((await db.audits.get(finished.id)).status, 'complete');
  });

  test('an unknown report address finds nothing', async () => {
    assert.equal(await db.audits.getByPublicId('01ARZ3NDEKTSV4RRFFQ69G5FAV'), null);
  });
});

describe('the audit’s own scan (no organization)', () => {
  test('is stored once against the audit, even when the job runs twice', async () => {
    const audit = await fx.audit();
    const first = await db.audits.scans.start({ auditId: audit.id, rubricVersion: 'r-test' });
    const again = await db.audits.scans.start({ auditId: audit.id, rubricVersion: 'r-test' });
    assert.equal(again.id, first.id, 'a retry gets the scan it already made');
    assert.equal(first.org_id, null);
    assert.equal(first.trigger_type, 'audit');

    await db.audits.scans.finish(first.id, scanResult());
    await db.audits.scans.finish(first.id, scanResult({ readinessScore: 80 }));

    const scan = await db.audits.scans.forAudit(audit.id);
    assert.equal(scan.readiness_score, 80);
    assert.equal(scan.status, 'complete');
    assert.equal((await db.audits.scans.checks(scan.id)).length, 1, 'one set of checks, not two');
  });

  test('a scan that belongs to an organization cannot be written through the audit door', async () => {
    const { org, scoped } = await fx.org();
    const project = await fx.project(org.id);
    const scan = await scoped.scans.create({ projectId: project.id, rubricVersion: 'r-test' });
    await assert.rejects(db.audits.scans.finish(scan.id, scanResult()), { code: 'NOT_FOUND' });
  });
});

describe('answers', () => {
  test('one row per question and engine: saving again replaces it', async () => {
    const audit = await fx.audit();
    await db.audits.saveAnswer(audit.id, answer({ brandPresent: false, status: 'pending' }));
    await db.audits.saveAnswer(audit.id, answer({ costUsd: '0.004', textExcerpt: 'final' }));
    await db.audits.saveAnswer(
      audit.id,
      answer({ engineCode: 'gemini', status: 'failed', brandPresent: null }),
    );

    const rows = await db.audits.answers(audit.id);
    assert.equal(rows.length, 2);
    const [chatgpt, gemini] = rows;
    assert.equal(chatgpt.status, 'ok');
    assert.equal(chatgpt.brand_present, true);
    assert.equal(chatgpt.text_excerpt, 'final');
    assert.equal(gemini.status, 'failed');
    assert.equal(gemini.brand_present, null, 'a failed answer is not "not mentioned"');
  });
});
