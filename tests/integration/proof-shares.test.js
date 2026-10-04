import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/**
 * Sharing a proven win (UI_DESIGN D4) against the real database: who may share what, that stopping a share kills the old
 * address for good, and what the public lookup returns (and refuses).
 */
const db = connectTestDb();
const fx = fixtures(db);
after(async () => {
  await fx.cleanup();
  await db.close();
});

async function world(verdict = 'proven_win') {
  const o = await fx.org();
  const project = await fx.project(o.org.id);
  const rec = await fx.recommendation(project, { title: 'Allow AI crawlers' });
  const outcome = await fx.forceOutcome(
    { ...rec, org_id: o.org.id, project_id: project.id },
    { verdict },
  );
  return { o, project, rec, outcome, scoped: db.forOrg(o.org.id) };
}

describe('proofShares', () => {
  test('a proven win is shared once: a second click keeps the link someone just copied', async () => {
    const w = await world();
    const first = await w.scoped.proofShares.share(w.project.id, w.rec.id, w.outcome.id, {
      userId: w.o.owner.id,
    });
    assert.equal(first.created, true);
    assert.match(first.publicId, /^[0-9A-Z]{26}$/);
    const again = await w.scoped.proofShares.share(w.project.id, w.rec.id, w.outcome.id, {
      userId: w.o.owner.id,
    });
    assert.deepEqual(again, { publicId: first.publicId, created: false });
    const live = await w.scoped.proofShares.forRecommendation(w.project.id, w.rec.id);
    assert.deepEqual(
      live.map((s) => [s.outcomeId, s.publicId]),
      [[w.outcome.id, first.publicId]],
    );
  });

  test('a result that is not a proven win cannot be shared, whatever the screen says', async () => {
    for (const verdict of ['no_change', 'declined', 'insufficient_data']) {
      const w = await world(verdict);
      await assert.rejects(
        () => w.scoped.proofShares.share(w.project.id, w.rec.id, w.outcome.id, { userId: null }),
        { code: 'NOT_SHAREABLE' },
        verdict,
      );
      assert.deepEqual(await w.scoped.proofShares.forRecommendation(w.project.id, w.rec.id), []);
    }
  });

  test('stopping ends the old address for good; sharing again makes a new one', async () => {
    const w = await world();
    const { publicId } = await w.scoped.proofShares.share(w.project.id, w.rec.id, w.outcome.id, {
      userId: w.o.owner.id,
    });
    assert.ok(await db.system.proofShares.byPublicId(publicId));

    assert.deepEqual(await w.scoped.proofShares.revoke(w.project.id, w.rec.id, w.outcome.id), {
      revoked: true,
    });
    assert.deepEqual(await w.scoped.proofShares.revoke(w.project.id, w.rec.id, w.outcome.id), {
      revoked: false,
    });
    assert.equal(await db.system.proofShares.byPublicId(publicId), null);
    assert.deepEqual(await w.scoped.proofShares.forRecommendation(w.project.id, w.rec.id), []);

    const next = await w.scoped.proofShares.share(w.project.id, w.rec.id, w.outcome.id, {
      userId: w.o.owner.id,
    });
    assert.equal(next.created, true);
    assert.notEqual(next.publicId, publicId, 'a stopped link never comes back');
    assert.equal(await db.system.proofShares.byPublicId(publicId), null);
    assert.ok(await db.system.proofShares.byPublicId(next.publicId));
  });

  test('an outcome that belongs to another recommendation is not found', async () => {
    const w = await world();
    const other = await fx.recommendation(w.project, { title: 'Something else' });
    await assert.rejects(
      () => w.scoped.proofShares.share(w.project.id, other.id, w.outcome.id, { userId: null }),
      { code: 'OUTCOME_NOT_FOUND' },
    );
  });
});

describe('the public lookup', () => {
  test('returns the figures, the title, the brand and the domain, and nothing else', async () => {
    const w = await world();
    const { publicId } = await w.scoped.proofShares.share(w.project.id, w.rec.id, w.outcome.id, {
      userId: w.o.owner.id,
    });
    const found = await db.system.proofShares.byPublicId(publicId);
    assert.deepEqual(Object.keys(found).sort(), [
      'brandName',
      'domain',
      'outcome',
      'startedAt',
      'title',
    ]);
    assert.equal(found.title, 'Allow AI crawlers');
    assert.equal(found.outcome.kAfter, 40);
    assert.ok(!('baselineRunIds' in found.outcome) && !('recommendationId' in found.outcome));
  });

  test('an unknown address and a closed organization are both null', async () => {
    assert.equal(await db.system.proofShares.byPublicId('0'.repeat(26)), null);
    const w = await world();
    const { publicId } = await w.scoped.proofShares.share(w.project.id, w.rec.id, w.outcome.id, {
      userId: w.o.owner.id,
    });
    await fx.setOrg(w.o.org.id, { deleted_at: new Date() });
    assert.equal(await db.system.proofShares.byPublicId(publicId), null);
  });
});
