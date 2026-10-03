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

  test('a failed audit keeps the reason, and the report email is marked once', async () => {
    const audit = await fx.audit();
    await db.audits.verify(audit.id);
    assert.equal(await db.audits.fail(audit.id, 'site_unreadable'), true);
    assert.deepEqual((await db.audits.get(audit.id)).sub_scores, { failure: 'site_unreadable' });

    assert.equal(await db.audits.markReportEmailed(audit.id), true);
    const first = (await db.audits.get(audit.id)).report_emailed_at;
    assert.ok(first);
    assert.equal(await db.audits.markReportEmailed(audit.id), false, 'the first time stays');
    assert.deepEqual((await db.audits.get(audit.id)).report_emailed_at, first);
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

describe('what an audit costs', () => {
  const entry = (key, costUsd) => ({
    meter: 'answer_collect',
    providerCode: 'dataforseo',
    unit: 'request',
    costUsd,
    idempotencyKey: key,
  });

  test('a retried job writes the same key and the cost is counted once', async () => {
    const audit = await fx.audit();
    const key = `audit-run.${audit.id}.chatgpt.0`;
    const first = await db.audits.ledger.record(audit.id, entry(key, '0.004'));
    const again = await db.audits.ledger.record(audit.id, entry(key, '0.004'));
    assert.equal(first.recorded, true);
    assert.equal(again.recorded, false);
    assert.equal(again.entry.id, first.entry.id);
    await db.audits.ledger.record(audit.id, entry(`${key}.b`, '0.25'));
    assert.equal(await db.audits.ledger.costMicros(audit.id), 254_000);
  });

  test('a key another audit used is a clash, not that audit’s row', async () => {
    const [one, two] = [await fx.audit(), await fx.audit()];
    const key = `audit-run.shared.${one.id}`;
    await db.audits.ledger.record(one.id, entry(key, '0.004'));
    await assert.rejects(db.audits.ledger.record(two.id, entry(key, '0.004')), {
      code: 'KEY_IN_USE',
    });
  });

  test('a negative cost and an unknown audit are refused', async () => {
    const audit = await fx.audit();
    await assert.rejects(db.audits.ledger.record(audit.id, entry('neg-1', '-0.1')), {
      code: 'INVALID',
    });
    await assert.rejects(db.audits.ledger.record(999_999_999n, entry('nobody-1', '0.1')), {
      code: 'NOT_FOUND',
    });
  });
});

describe('serving a repeat audit from an earlier one', () => {
  const finished = async (domain, over = {}) => {
    const audit = await fx.audit({ domain, inputUrl: `https://${domain}/`, ...over });
    await db.audits.verify(audit.id);
    await db.audits.saveSetup(audit.id, {
      brandKitLite: { brand_name: 'Acme' },
      prompts: [{ promptIdx: 0, text: 'q' }],
      suggestedCompetitors: [],
    });
    await db.audits.saveAnswer(audit.id, answer());
    await db.audits.finish(audit.id, {
      status: 'complete',
      readinessScore: 70,
      visibilityScore: 40,
      aeoScore: 58,
      topFixes: [{ rank: 1, id: 'check-A1' }],
      costUsd: '0.42',
    });
    return db.audits.get(audit.id);
  };
  const domainName = () => `reuse-${Math.random().toString(36).slice(2)}.example.test`;

  test('finds the latest complete audit of the same domain within a day, and nothing else', async () => {
    const domain = domainName();
    const source = await finished(domain);
    const found = await db.audits.findReusable({ domain });
    assert.equal(found.id, source.id);

    const later = new Date(Date.now() + 25 * 3_600_000);
    assert.equal(await db.audits.findReusable({ domain, now: later }), null, 'older than 24 hours');
    assert.equal(await db.audits.findReusable({ domain: domainName() }), null, 'another domain');
    assert.equal(
      await db.audits.findReusable({ domain, competitorDomain: 'rival.example' }),
      null,
      'a different competitor was asked for',
    );
    assert.equal(await db.audits.findReusable({ domain, excludeAuditId: source.id }), null);
  });

  test('a partial, failed or still-running audit is never a source', async () => {
    const domain = domainName();
    const partial = await fx.audit({ domain, inputUrl: `https://${domain}/` });
    await db.audits.verify(partial.id);
    await db.audits.finish(partial.id, { status: 'partial', readinessScore: 50 });
    const failed = await fx.audit({ domain, inputUrl: `https://${domain}/` });
    await db.audits.verify(failed.id);
    await db.audits.fail(failed.id, 'site_unreadable');
    const running = await fx.audit({ domain, inputUrl: `https://${domain}/` });
    await db.audits.verify(running.id);
    await db.audits.start(running.id);
    assert.equal(await db.audits.findReusable({ domain }), null);
  });

  test('a served audit has the same results, no cost of its own, and shows the source’s answers and scan', async () => {
    const domain = domainName();
    const source = await finished(domain);
    const scan = await db.audits.scans.start({ auditId: source.id, rubricVersion: 'r-test' });
    await db.audits.scans.finish(scan.id, scanResult());

    const copy = await fx.audit({ domain, inputUrl: `https://${domain}/` });
    await db.audits.verify(copy.id);
    assert.equal(await db.audits.completeFromCache(copy.id, source), true);
    assert.equal(await db.audits.completeFromCache(copy.id, source), false, 'once');

    const served = await db.audits.get(copy.id);
    assert.equal(served.status, 'complete');
    assert.equal(served.cached_from_audit_id, source.id);
    assert.deepEqual(
      [served.readiness_score, served.visibility_score, served.aeo_score],
      [70, 40, 58],
    );
    assert.deepEqual(served.top_fixes, [{ rank: 1, id: 'check-A1' }]);
    assert.deepEqual(served.prompts, source.prompts);
    assert.equal(served.cost_usd.toString(), '0', 'the copy cost nothing');
    assert.equal((await db.audits.answers(copy.id)).length, 1);
    assert.equal((await db.audits.scans.forAudit(copy.id)).id, scan.id);

    // A copy is never the source of a later copy: the cache does not outlive its 24 hours by being copied.
    assert.equal((await db.audits.findReusable({ domain })).id, source.id);
  });
});
