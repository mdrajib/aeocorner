import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/**
 * A person confirming a profile our crawler could not read (Entity screen): what the repository allows, when a later
 * check ends the confirmation, and the audit trail. The database is real.
 */
const db = connectTestDb();
const fx = fixtures(db);
let A;
let project;

const refuses = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof DomainError && e.code === code);

before(async () => {
  A = await fx.org();
  project = await fx.project(A.org.id, 'Confirm Co', { status: 'active', slotHour: 7 });
});
after(async () => {
  await fx.cleanup();
  await db.close();
});

let n = 0;
const address = () => `https://www.linkedin.com/company/confirm-${Date.now().toString(36)}-${n++}`;
const save = (subject, status, finding, extra = {}) =>
  A.scoped.entityChecks.saveCheck(project.id, {
    kind: 'profile',
    subject,
    platform: 'linkedin',
    status,
    finding,
    ...extra,
  });
const row = async (subject) =>
  (await A.scoped.entityChecks.checks(project.id)).find((c) => c.subject === subject);

describe('confirming a profile', () => {
  test('a profile that could not be read can be confirmed, once, with who and when', async () => {
    const url = address();
    await save(url, 'error', 'robots');
    const at = new Date('2026-10-06T10:00:00Z');
    const first = await A.scoped.entityChecks.confirmProfile(project.id, url, {
      userId: A.owner.id,
      now: at,
    });
    assert.deepEqual(first.confirmedAt, at);
    assert.equal(first.confirmedByUserId, A.owner.id);
    assert.equal(first.status, 'error', 'our finding is never rewritten');
    // Pressing it again keeps the first confirmation.
    const again = await A.scoped.entityChecks.confirmProfile(project.id, url, {
      userId: A.owner.id,
      now: new Date('2026-10-07T10:00:00Z'),
    });
    assert.deepEqual(again.confirmedAt, at);
    const log = await A.scoped.activity.recent({ limit: 50 });
    assert.equal(
      log.filter((l) => l.action === 'entity.profile_confirmed' && l.target_id === project.id)
        .length,
      1,
    );
  });

  test('only a listed profile whose latest check could not look: a read page is not confirmed away', async () => {
    const readFailed = address();
    await save(readFailed, 'failed', 'brand_not_named');
    await refuses(
      A.scoped.entityChecks.confirmProfile(project.id, readFailed, { userId: A.owner.id }),
      'NOT_CONFIRMABLE',
    );
    const passed = address();
    await save(passed, 'passed', 'names_brand');
    await refuses(
      A.scoped.entityChecks.confirmProfile(project.id, passed, { userId: A.owner.id }),
      'NOT_CONFIRMABLE',
    );
    await refuses(
      A.scoped.entityChecks.confirmProfile(project.id, address(), { userId: A.owner.id }),
      'NOT_FOUND',
    );
  });

  test('a later "couldn’t check" keeps the confirmation; a page we can read ends it', async () => {
    const url = address();
    await save(url, 'error', 'robots');
    await A.scoped.entityChecks.confirmProfile(project.id, url, { userId: A.owner.id });
    await save(url, 'error', 'blocked');
    assert.ok((await row(url)).confirmedAt, 'still could not look: the statement stands');
    await save(url, 'failed', 'brand_not_named');
    const read = await row(url);
    assert.equal(read.confirmedAt, null, 'we read the page: what we read decides');
    assert.equal(read.confirmedByUserId, null);

    const other = address();
    await save(other, 'error', 'robots');
    await A.scoped.entityChecks.confirmProfile(project.id, other, { userId: A.owner.id });
    await save(other, 'passed', 'names_brand');
    assert.equal((await row(other)).confirmedAt, null);
    assert.equal((await row(other)).status, 'passed');
  });

  test('a person can take their confirmation back, and a removed profile takes it with it', async () => {
    const url = address();
    await save(url, 'error', 'robots');
    await A.scoped.entityChecks.confirmProfile(project.id, url, { userId: A.owner.id });
    assert.equal(
      await A.scoped.entityChecks.unconfirmProfile(project.id, url, { userId: A.owner.id }),
      true,
    );
    assert.equal((await row(url)).confirmedAt, null);
    assert.equal(
      await A.scoped.entityChecks.unconfirmProfile(project.id, url),
      false,
      'nothing left to remove',
    );

    await save(url, 'error', 'robots');
    await A.scoped.entityChecks.confirmProfile(project.id, url, { userId: A.owner.id });
    await A.scoped.entityChecks.forgetProfilesExcept(project.id, ['https://x.test/keep']);
    assert.equal(await row(url), undefined);
  });
});
