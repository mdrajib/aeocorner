import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import pino from 'pino';
import { KEPT_AFTER_PURGE } from '../../src/core/org-purge.js';
import { addDays } from '../../src/core/entitlements.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { retentionSweep } from '../../src/worker/handlers/billing.js';

/**
 * The purge of closed organizations (docs/DATABASE_SCHEMA.md §8) against the real database: every row of the closed
 * organization is gone, nothing of its neighbour is touched, and what must wait does wait.
 */

const db = connectTestDb();
const fx = fixtures(db);
after(async () => {
  await fx.cleanup();
  await db.close();
});

const purge = db.system.billing.retention;
const NOW = new Date();

/** An organization with a bit of everything: a project, a question, a check, a fix, a page, a scan, a claimed audit. */
async function populated() {
  const { org, owner } = await fx.org();
  const project = await fx.project(org.id);
  await fx.engines(project);
  const prompt = await fx.prompt(project);
  const run = await fx.run(project, { status: 'complete' });
  await fx.cell(run, prompt, { brandK: 3, nOk: 10 });
  await fx.recommendation(project);
  await fx.contentItem(project);
  await fx.scan(project, { checks: [{ code: 'A1', status: 'pass', possible: 5, points: 5 }] });

  // A free audit the organization claimed, with a scan that carries no org_id of its own.
  const audit = await fx.audit();
  await fx.claimAuditWithScan(audit.id, org.id);
  return { org, owner, project, audit };
}

const leftovers = (orgId) =>
  fx.tenantRows(orgId, { skip: ['organizations', ...Object.keys(KEPT_AFTER_PURGE)] });

describe('retention.purge', () => {
  test('deletes every row of a closed organization and leaves its neighbour alone', async () => {
    const mine = await populated();
    const other = await populated();
    const before = await leftovers(other.org.id);
    assert.ok(Object.keys(before).length > 5, 'the neighbour has rows in several tables');

    await fx.setOrg(mine.org.id, { deleted_at: addDays(NOW, -31), purge_after: addDays(NOW, -1) });
    const removed = await purge.purge(mine.org.id, { now: NOW });

    assert.ok(removed, 'the organization was purged');
    assert.equal(removed.organizations, 1);
    assert.ok(removed.projects >= 1);
    assert.deepEqual(await leftovers(mine.org.id), {}, 'no tenant row is left');
    assert.equal(
      await fx.count('organizations', { id: mine.org.id }),
      0,
      'the organization is gone',
    );
    assert.equal(
      await fx.count('site_scans', { audit_id: mine.audit.id }),
      0,
      'the claimed audit’s scan went before the audit',
    );
    assert.equal(await fx.count('audits', { id: mine.audit.id }), 0);
    assert.equal(
      await fx.count('leads', { id: mine.audit.lead_id }),
      1,
      'the lead is not the organization’s',
    );

    assert.deepEqual(await leftovers(other.org.id), before, 'the other organization is untouched');

    assert.equal(
      await fx.count('org_activity_log', { org_id: mine.org.id, action: 'org.purged' }),
      1,
      'the proof that it happened stays',
    );

    assert.equal(
      await purge.purge(mine.org.id, { now: NOW }),
      null,
      'a second purge finds nothing to do',
    );
  });

  test('an organization that is open, or closed less than 30 days ago, is not touched', async () => {
    const open = await populated();
    assert.equal(await purge.purge(open.org.id, { now: NOW }), null);

    const recent = await populated();
    await fx.setOrg(recent.org.id, { deleted_at: NOW, purge_after: addDays(NOW, 29) });
    assert.equal(await purge.purge(recent.org.id, { now: NOW }), null);

    for (const { org } of [open, recent]) {
      assert.equal(await fx.count('organizations', { id: org.id }), 1);
      assert.ok(Object.keys(await leftovers(org.id)).length > 5);
    }
  });

  test('an organization whose deletion was undone is not purged', async () => {
    const one = await populated();
    await fx.setOrg(one.org.id, { deleted_at: addDays(NOW, -40), purge_after: addDays(NOW, -10) });
    await fx.setOrg(one.org.id, { deleted_at: null, purge_after: null });
    assert.equal(await purge.purge(one.org.id, { now: NOW }), null);
    assert.equal(await fx.count('projects', { org_id: one.org.id }), 1);
  });

  test('purgeDue lists closed organizations past their date, and only those', async () => {
    const due = await populated();
    const waiting = await populated();
    await fx.setOrg(due.org.id, { deleted_at: addDays(NOW, -31), purge_after: addDays(NOW, -1) });
    await fx.setOrg(waiting.org.id, { deleted_at: NOW, purge_after: addDays(NOW, 29) });
    const ids = (await purge.purgeDue({ now: NOW, limit: 1000 })).map(String);
    assert.ok(ids.includes(String(due.org.id)));
    assert.ok(!ids.includes(String(waiting.org.id)));
  });

  test('the nightly sweep purges what is due and reports it', async () => {
    const one = await populated();
    await fx.setOrg(one.org.id, { deleted_at: addDays(NOW, -31), purge_after: addDays(NOW, -1) });
    const logger = pino({ level: 'silent' });
    const result = await retentionSweep({ db, logger, now: () => NOW, mail: null });
    assert.ok(result.purged >= 1);
    assert.equal(await fx.count('organizations', { id: one.org.id }), 0);
  });
});
