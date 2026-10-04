import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { DRAFTS_PLACEHOLDER, DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createSecretBox } from '../../src/lib/secrets.js';

/**
 * The Content Studio against the real database (Milestone 7): creating an item and the month's draft allowance, the
 * pipeline's one-way steps, edits and the approval that pins one revision, publishing as a recorded change, and the
 * WordPress connection with its encrypted credentials. Cross-organization checks are in
 * tests/tenancy/repositories.test.js; the rules themselves are in src/core/content-*.test.js.
 */

const db = connectTestDb();
const fx = fixtures(db);
let org;
let editor;
const scoped = () => db.forOrg(org.org.id);
const unique = () => Math.random().toString(36).slice(2, 8);
const box = createSecretBox({ current: { version: 1, key: randomBytes(32) } });

before(async () => {
  org = await fx.org();
  editor = org.owner;
});
after(async () => {
  await fx.cleanup();
  await db.close();
});

const refuses = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof DomainError && e.code === code, `expected ${code}`);

const GOOD_QC = { version: 1, score: 88, ready: true, blocking: [], checks: [], words: 400 };
const BRIEF = {
  format: 'faq',
  title: 'How much does a crown cost?',
  metaDescription: 'x'.repeat(40),
  audience: 'adults',
  outline: [],
  entities: [],
  internalLinks: [],
  schemaType: 'FAQPage',
};
const JSONLD = { '@context': 'https://schema.org', '@type': 'Article', headline: 'x' };

/** A project in an organization of its own (each has its own month of draft allowance), which becomes `org`. */
async function project() {
  org = await fx.org({ owner: editor });
  return fx.project(org.org.id, `Content ${unique()}`);
}

/** An item taken through the pipeline to `ready` with a good check. */
async function readyItem(p, extra = {}) {
  const item = await scoped().content.create(p.id, {
    title: `Item ${unique()}`,
    userId: editor.id,
    ...extra,
  });
  await scoped().content.saveResearch(p.id, item.id, { research: { facts: [] } });
  await scoped().content.saveBrief(p.id, item.id, { brief: BRIEF });
  const draft = await scoped().content.saveDraft(p.id, item.id, {
    html: '<h2>How much?</h2><p>Between $900 and $1,500.</p>',
  });
  await scoped().content.saveQc(p.id, item.id, {
    revisionId: draft.revisionId,
    qc: GOOD_QC,
    jsonld: JSONLD,
  });
  return { item, revisionId: draft.revisionId };
}

describe('creating an item', () => {
  test('starts in researching, takes one draft from the month and records the target questions', async () => {
    const p = await project();
    const prompt = await fx.prompt(p, { text: `Best dentist? ${unique()}` });
    const before = await scoped().draftQuota.draftsUsed();
    const item = await scoped().content.create(p.id, {
      title: 'Crowns',
      promptIds: [prompt.id],
      userId: editor.id,
    });
    assert.equal(item.status, 'researching');
    assert.equal(item.quotaUnits, 1);
    assert.match(item.publicId, /^[0-9A-Z]{26}$/);
    const after = await scoped().draftQuota.draftsUsed();
    assert.equal(after.used, before.used + 1);
    const got = await scoped().content.get(p.id, item.publicId);
    assert.deepEqual(got.promptIds, [String(prompt.id)]);
    assert.equal(
      (await scoped().content.get(p.id, String(item.id))).id,
      item.id,
      'a job finds it by number',
    );
  });

  test('a refresh counts half, and a question from another project is refused', async () => {
    const other = await project();
    const p = await project();
    const foreign = await fx.prompt(other, { text: `Other ${unique()}` });
    await refuses(
      scoped().content.create(p.id, { title: 't', promptIds: [foreign.id] }),
      'PROMPT_NOT_IN_PROJECT',
    );
    const before = await scoped().draftQuota.draftsUsed();
    const item = await scoped().content.create(p.id, {
      title: 'Refresh',
      kind: 'refresh',
      targetUrl: 'https://x.test/a',
    });
    assert.equal(item.quotaUnits, 0.5);
    assert.equal((await scoped().draftQuota.draftsUsed()).used, before.used + 0.5);
    await refuses(scoped().content.create(p.id, { title: '  ' }), 'TITLE_REQUIRED');
  });

  test('when the month is used up nothing is created and the allowance is not changed', async () => {
    const o = await fx.org();
    const p = await fx.project(o.org.id, `Quota ${unique()}`);
    const s = db.forOrg(o.org.id);
    for (let i = 0; i < DRAFTS_PLACEHOLDER; i += 1)
      assert.equal((await s.content.create(p.id, { title: `d${i}` })).status, 'researching');
    const blocked = await s.content.create(p.id, { title: 'one too many' });
    assert.deepEqual(
      [blocked.blocked, blocked.used, blocked.limit],
      ['quota', DRAFTS_PLACEHOLDER, DRAFTS_PLACEHOLDER],
    );
    assert.equal((await s.content.list(p.id)).length, DRAFTS_PLACEHOLDER);
    assert.equal((await s.draftQuota.draftsUsed()).used, DRAFTS_PLACEHOLDER);
  });

  test('two requests at once for the last draft make one item', async () => {
    const o = await fx.org();
    const p = await fx.project(o.org.id, `Race ${unique()}`);
    const s = db.forOrg(o.org.id);
    for (let i = 0; i < DRAFTS_PLACEHOLDER - 1; i += 1)
      await s.content.create(p.id, { title: `d${i}` });
    const results = await Promise.all([
      s.content.create(p.id, { title: 'a' }),
      s.content.create(p.id, { title: 'b' }),
    ]);
    assert.equal(results.filter((r) => r.blocked).length, 1);
    assert.equal((await s.draftQuota.draftsUsed()).used, DRAFTS_PLACEHOLDER);
  });

  test('a recommendation has at most one open item; an archived one frees it', async () => {
    const p = await project();
    const rec = await fx.recommendation(p);
    const first = await scoped().content.create(p.id, { title: 'First', recommendationId: rec.id });
    await refuses(
      scoped().content.create(p.id, { title: 'Second', recommendationId: rec.id }),
      'CONTENT_ALREADY_OPEN',
    );
    await scoped().content.archive(p.id, first.id);
    assert.equal(
      (await scoped().content.create(p.id, { title: 'Third', recommendationId: rec.id })).status,
      'researching',
    );
    await refuses(
      scoped().content.create(p.id, { title: 'x', recommendationId: 999_999_999 }),
      'RECOMMENDATION_NOT_FOUND',
    );
    const map = await scoped().content.forRecommendations(p.id, [rec.id]);
    assert.equal(map.get(rec.id).status, 'researching');
  });
});

describe('the pipeline', () => {
  test('goes one stage at a time; repeating a finished stage does nothing', async () => {
    const p = await project();
    const item = await scoped().content.create(p.id, { title: 'Flow' });
    assert.deepEqual(
      await scoped().content.saveBrief(p.id, item.id, { brief: BRIEF }),
      { skipped: true },
      'not before research',
    );
    assert.deepEqual(
      await scoped().content.saveResearch(p.id, item.id, {
        research: { facts: [{ claim: 'c' }] },
        costUsd: 0.25,
      }),
      { skipped: false },
    );
    assert.deepEqual(await scoped().content.saveResearch(p.id, item.id, { research: {} }), {
      skipped: true,
    });
    assert.deepEqual(
      await scoped().content.saveBrief(p.id, item.id, { brief: BRIEF, costUsd: 0.1 }),
      { skipped: false },
    );
    const afterBrief = await scoped().content.get(p.id, item.id);
    assert.equal(afterBrief.status, 'drafting');
    assert.equal(afterBrief.title, BRIEF.title);
    assert.equal(afterBrief.format, 'faq');
    const draft = await scoped().content.saveDraft(p.id, item.id, {
      html: '<p>One two three</p>',
      costUsd: 0.5,
    });
    assert.equal(draft.revision, 1);
    assert.deepEqual(await scoped().content.saveDraft(p.id, item.id, { html: '<p>again</p>' }), {
      skipped: true,
    });
    const got = await scoped().content.get(p.id, item.id);
    assert.equal(got.status, 'qc');
    assert.equal(got.current.bodyHtml, '<p>One two three</p>');
    assert.equal(got.current.wordCount, 3);
    assert.equal(got.current.source, 'ai_draft');
    assert.ok(Math.abs(got.llmCostUsd - 0.85) < 1e-9);
  });

  test('a check for an older revision is ignored; for the current one the item is ready', async () => {
    const p = await project();
    const item = await scoped().content.create(p.id, { title: 'Qc' });
    await scoped().content.saveResearch(p.id, item.id, { research: {} });
    await scoped().content.saveBrief(p.id, item.id, { brief: BRIEF });
    const draft = await scoped().content.saveDraft(p.id, item.id, { html: '<p>x</p>' });
    assert.deepEqual(
      await scoped().content.saveQc(p.id, item.id, {
        revisionId: draft.revisionId + 1000n,
        qc: GOOD_QC,
        jsonld: JSONLD,
      }),
      { skipped: true },
    );
    assert.deepEqual(
      await scoped().content.saveQc(p.id, item.id, {
        revisionId: draft.revisionId,
        qc: GOOD_QC,
        jsonld: JSONLD,
      }),
      { skipped: false },
    );
    const got = await scoped().content.get(p.id, item.id);
    assert.equal(got.status, 'ready');
    assert.equal(got.qcScore, 88);
    assert.equal(got.qc.revisionId, String(draft.revisionId));
    assert.deepEqual(got.jsonld, JSONLD);
  });

  test('a failure says where it stopped; with no draft written the allowance comes back, and a retry takes it again', async () => {
    const o = await fx.org();
    const p = await fx.project(o.org.id, `Fail ${unique()}`);
    const s = db.forOrg(o.org.id);
    const item = await s.content.create(p.id, { title: 'Will fail' });
    assert.equal((await s.draftQuota.draftsUsed()).used, 1);
    await s.content.fail(p.id, item.id, {
      stage: 'researching',
      reason: 'The research service was unavailable.',
      costUsd: 0.02,
    });
    const failed = await s.content.get(p.id, item.id);
    assert.deepEqual(
      [failed.status, failed.failedStage, failed.failureReason],
      ['failed', 'researching', 'The research service was unavailable.'],
    );
    assert.equal((await s.draftQuota.draftsUsed()).used, 0, 'given back');
    assert.deepEqual(
      await s.content.fail(p.id, item.id, { stage: 'researching', reason: 'again' }),
      { skipped: true },
    );
    assert.deepEqual(await s.content.retry(p.id, item.id), { to: 'researching' });
    assert.equal((await s.draftQuota.draftsUsed()).used, 1);
    assert.equal((await s.content.get(p.id, item.id)).failedStage, null);
  });

  test('a retry after the draft failed starts again from the draft, and nothing is given back once a draft exists', async () => {
    const o = await fx.org();
    const p = await fx.project(o.org.id, `Fail2 ${unique()}`);
    const s = db.forOrg(o.org.id);
    const item = await s.content.create(p.id, { title: 'Two' });
    await s.content.saveResearch(p.id, item.id, { research: {} });
    await s.content.saveBrief(p.id, item.id, { brief: BRIEF });
    await s.content.fail(p.id, item.id, { stage: 'drafting', reason: 'Claude was busy.' });
    assert.deepEqual(await s.content.retry(p.id, item.id), { to: 'drafting' });
    const draft = await s.content.saveDraft(p.id, item.id, { html: '<p>x</p>' });
    await s.content.fail(p.id, item.id, { stage: 'qc', reason: 'broke' });
    assert.equal(
      (await s.draftQuota.draftsUsed()).used,
      0 + 1 + 0,
      'the first failure gave one back, the retry took one, the second failure keeps it',
    );
    assert.ok(draft.revisionId);
  });
});

describe('edits and approval', () => {
  test('approving pins the revision that was checked; only a person can', async () => {
    const p = await project();
    const { item, revisionId } = await readyItem(p);
    await refuses(
      scoped().content.approve(p.id, item.id, { userId: null, revisionId }),
      'APPROVAL_NEEDS_A_PERSON',
    );
    assert.deepEqual(
      await scoped().content.approve(p.id, item.id, {
        userId: editor.id,
        revisionId: revisionId + 99n,
      }),
      {
        approved: false,
        blockers: ['The text changed since you opened it: reload and check it again.'],
      },
    );
    assert.deepEqual(
      await scoped().content.approve(p.id, item.id, { userId: editor.id, revisionId }),
      { approved: true },
    );
    const got = await scoped().content.get(p.id, item.id);
    assert.equal(got.status, 'approved');
    assert.equal(got.approvedRevisionId, revisionId);
    assert.ok(got.approvedAt);
    assert.equal(got.approvedByUserId, editor.id);
    await refuses(
      scoped().content.approve(p.id, item.id, { userId: editor.id, revisionId }),
      'INVALID_TRANSITION',
    );
  });

  test('a blocking problem or missing structured data stops approval and says why', async () => {
    const p = await project();
    const { item, revisionId } = await readyItem(p);
    await fx.forceContent(item.id, {
      qc: { ...GOOD_QC, blocking: ['unsupported_claims'], revisionId: String(revisionId) },
    });
    const blocked = await scoped().content.approve(p.id, item.id, {
      userId: editor.id,
      revisionId,
    });
    assert.equal(blocked.approved, false);
    assert.match(blocked.blockers[0], /needs source/);
    await fx.forceContent(item.id, {
      qc: { ...GOOD_QC, revisionId: String(revisionId) },
      jsonld: null,
    });
    assert.match(
      (await scoped().content.approve(p.id, item.id, { userId: editor.id, revisionId }))
        .blockers[0],
      /no structured data/,
    );
    assert.equal((await scoped().content.get(p.id, item.id)).status, 'ready');
  });

  test('an edit makes a new revision, takes the approval away and asks for a new check', async () => {
    const p = await project();
    const { item, revisionId } = await readyItem(p);
    await scoped().content.approve(p.id, item.id, { userId: editor.id, revisionId });
    const saved = await scoped().content.saveEdit(p.id, item.id, {
      html: '<h2>How much?</h2><p>Edited.</p>',
      expectedRevision: 1,
      userId: editor.id,
    });
    assert.equal(saved.revision, 2);
    const got = await scoped().content.get(p.id, item.id);
    assert.deepEqual(
      [got.status, got.approvedRevisionId, got.approvedAt, got.qc],
      ['qc', null, null, null],
    );
    assert.equal(got.current.source, 'user_edit');
    assert.equal(got.revisions.length, 2);
    assert.equal(
      (await scoped().content.revision(p.id, item.id, 1)).bodyHtml,
      '<h2>How much?</h2><p>Between $900 and $1,500.</p>',
      'the old text is kept',
    );
    // the old check cannot make the new text ready
    assert.deepEqual(
      await scoped().content.saveQc(p.id, item.id, { revisionId, qc: GOOD_QC, jsonld: JSONLD }),
      { skipped: true },
    );
    assert.deepEqual(
      await scoped().content.saveQc(p.id, item.id, {
        revisionId: saved.revisionId,
        qc: GOOD_QC,
        jsonld: JSONLD,
      }),
      { skipped: false },
    );
  });

  test('saving with a stale revision, or the same text, or while a check runs', async () => {
    const p = await project();
    const { item } = await readyItem(p);
    await refuses(
      scoped().content.saveEdit(p.id, item.id, { html: '<p>x</p>', expectedRevision: 5 }),
      'STALE_REVISION',
    );
    assert.deepEqual(
      await scoped().content.saveEdit(p.id, item.id, {
        html: '<h2>How much?</h2><p>Between $900 and $1,500.</p>',
        expectedRevision: 1,
      }),
      { unchanged: true, revision: 1 },
    );
    await scoped().content.saveEdit(p.id, item.id, { html: '<p>new</p>', expectedRevision: 1 });
    await refuses(
      scoped().content.saveEdit(p.id, item.id, { html: '<p>newer</p>', expectedRevision: 2 }),
      'INVALID_TRANSITION',
    );
  });

  test('two approvals at once: one wins', async () => {
    const p = await project();
    const { item, revisionId } = await readyItem(p);
    const results = await Promise.allSettled([
      scoped().content.approve(p.id, item.id, { userId: editor.id, revisionId }),
      scoped().content.approve(p.id, item.id, { userId: editor.id, revisionId }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.approved).length, 1);
    assert.equal((await scoped().content.get(p.id, item.id)).status, 'approved');
  });

  test('the database itself refuses an approved item with no approval pinned', async () => {
    const p = await project();
    const { item } = await readyItem(p);
    await assert.rejects(
      fx.forceContent(item.id, { status: 'approved' }),
      /ck_content_items_approval|CHECK|constraint/i,
    );
  });

  test('unapprove, redraft (a new revision, not an overwrite) and archive', async () => {
    const p = await project();
    const { item, revisionId } = await readyItem(p);
    await scoped().content.approve(p.id, item.id, { userId: editor.id, revisionId });
    await scoped().content.unapprove(p.id, item.id);
    assert.equal((await scoped().content.get(p.id, item.id)).status, 'ready');
    await scoped().content.editBrief(p.id, item.id, {
      brief: { ...BRIEF, title: 'A better title for the page' },
      userId: editor.id,
    });
    assert.equal((await scoped().content.get(p.id, item.id)).title, 'A better title for the page');
    await scoped().content.redraft(p.id, item.id);
    const again = await scoped().content.saveDraft(p.id, item.id, { html: '<p>fresh draft</p>' });
    assert.equal(again.revision, 2);
    assert.equal((await scoped().content.revision(p.id, item.id, 1)).source, 'ai_draft');
    assert.equal((await scoped().content.revision(p.id, item.id, 2)).source, 'ai_revision');
    await refuses(
      scoped().content.editBrief(p.id, item.id, { brief: BRIEF }),
      'INVALID_TRANSITION',
    );
    await scoped().content.archive(p.id, item.id);
    assert.equal(
      (await scoped().content.list(p.id)).some((i) => i.id === item.id),
      false,
    );
    assert.equal((await scoped().content.list(p.id, { statuses: ['archived'] })).length, 1);
    await refuses(scoped().content.archive(p.id, item.id), 'INVALID_TRANSITION');
  });
});

describe('publishing', () => {
  const connect = (p) =>
    scoped().integrations.saveWordpress(p.id, {
      config: { siteUrl: 'https://wp.example.test', username: 'editor' },
      secret: box.encrypt({ appPassword: 'p' }, `wordpress:${org.org.id}:${p.id}`),
      userId: editor.id,
    });

  async function approved(p) {
    const made = await readyItem(p);
    await scoped().content.approve(p.id, made.item.id, {
      userId: editor.id,
      revisionId: made.revisionId,
    });
    return made;
  }

  test('needs an approval and a connected site', async () => {
    const p = await project();
    const { item, revisionId } = await readyItem(p);
    await refuses(
      scoped().content.beginPublish(p.id, item.id, { userId: editor.id, mode: 'publish' }),
      'NOT_APPROVED',
    );
    await scoped().content.approve(p.id, item.id, { userId: editor.id, revisionId });
    await refuses(
      scoped().content.beginPublish(p.id, item.id, { userId: editor.id, mode: 'publish' }),
      'WORDPRESS_NOT_CONNECTED',
    );
    await refuses(
      scoped().content.beginPublish(p.id, item.id, { userId: editor.id, mode: 'weird' }),
      'BAD_MODE',
    );
    await connect(p);
    await refuses(
      scoped().content.beginPublish(p.id, item.id, { userId: null, mode: 'publish' }),
      'APPROVAL_NEEDS_A_PERSON',
    );
  });

  test('publish: the change is recorded, the approved revision is what is sent, the item ends published', async () => {
    const p = await project();
    const { item, revisionId } = await approved(p);
    await connect(p);
    const begun = await scoped().content.beginPublish(p.id, item.id, {
      userId: editor.id,
      mode: 'publish',
    });
    assert.equal((await scoped().content.get(p.id, item.id)).status, 'publishing');
    const job = await scoped().content.forPublish(p.id, item.id);
    assert.equal(job.revisionId, revisionId);
    assert.match(job.bodyHtml, /Between \$900/);
    assert.equal(job.integration.config.siteUrl, 'https://wp.example.test');
    assert.equal(
      box.decryptJson(job.integration.secret, `wordpress:${org.org.id}:${p.id}`).appPassword,
      'p',
    );
    assert.equal(job.siteChange.id, begun.siteChangeId);
    assert.equal(job.siteChange.status, 'approved');
    assert.equal(await scoped().content.markApplying(p.id, begun.siteChangeId), true);
    const done = await scoped().content.finishPublish(p.id, item.id, {
      siteChangeId: begun.siteChangeId,
      outcome: 'published',
      cmsRef: '123',
      url: 'https://wp.example.test/crowns/',
    });
    assert.deepEqual(done, { skipped: false });
    const got = await scoped().content.get(p.id, item.id);
    assert.deepEqual(
      [got.status, got.cmsRef, got.publishedUrl],
      ['published', '123', 'https://wp.example.test/crowns/'],
    );
    assert.ok(got.publishedAt);
    const [change] = await scoped().content.siteChanges(p.id, item.id);
    assert.deepEqual(
      [change.kind, change.status, change.remoteRef],
      ['post_create', 'applied', '123'],
    );
    assert.equal(change.payload.mode, 'publish');
    assert.deepEqual(
      await scoped().content.finishPublish(p.id, item.id, {
        siteChangeId: begun.siteChangeId,
        outcome: 'published',
        cmsRef: '999',
        url: 'x',
      }),
      { skipped: true },
    );
  });

  test('a draft saved in WordPress leaves the item approved and a later publish updates the same post', async () => {
    const p = await project();
    const { item } = await approved(p);
    await connect(p);
    const first = await scoped().content.beginPublish(p.id, item.id, {
      userId: editor.id,
      mode: 'draft',
    });
    await scoped().content.finishPublish(p.id, item.id, {
      siteChangeId: first.siteChangeId,
      outcome: 'drafted',
      cmsRef: '55',
      url: 'https://wp.example.test/?p=55',
    });
    const mid = await scoped().content.get(p.id, item.id);
    assert.deepEqual([mid.status, mid.cmsRef, mid.publishedAt], ['approved', '55', null]);
    const second = await scoped().content.beginPublish(p.id, item.id, {
      userId: editor.id,
      mode: 'publish',
    });
    const [latest] = await scoped().content.siteChanges(p.id, item.id);
    assert.equal(latest.kind, 'post_update');
    assert.equal(latest.payload.cmsRef, '55');
    await scoped().content.finishPublish(p.id, item.id, {
      siteChangeId: second.siteChangeId,
      outcome: 'published',
      cmsRef: '55',
      url: 'https://wp.example.test/crowns/',
    });
    assert.equal((await scoped().content.get(p.id, item.id)).status, 'published');
  });

  test('a failed publish records the error, sends the item to failed, and a retry returns it to approved', async () => {
    const p = await project();
    const { item, revisionId } = await approved(p);
    await connect(p);
    const begun = await scoped().content.beginPublish(p.id, item.id, {
      userId: editor.id,
      mode: 'publish',
    });
    await scoped().content.finishPublish(p.id, item.id, {
      siteChangeId: begun.siteChangeId,
      outcome: 'failed',
      error: 'WordPress did not accept that user name and application password.',
    });
    const failed = await scoped().content.get(p.id, item.id);
    assert.deepEqual([failed.status, failed.failedStage], ['failed', 'publishing']);
    assert.equal(failed.approvedRevisionId, revisionId, 'the approval is still pinned');
    const [change] = await scoped().content.siteChanges(p.id, item.id);
    assert.equal(change.status, 'failed');
    assert.match(change.lastError, /application password/);
    assert.deepEqual(await scoped().content.retry(p.id, item.id), { to: 'approved' });
    assert.equal((await scoped().content.get(p.id, item.id)).status, 'approved');
  });
});

describe('the WordPress connection', () => {
  test('saved with encrypted credentials; the screen read has no secret; disconnect erases them', async () => {
    const p = await project();
    assert.equal(await scoped().integrations.wordpress(p.id), null);
    const sealed = box.encrypt(
      { appPassword: 'secret-app-password' },
      `wordpress:${org.org.id}:${p.id}`,
    );
    const saved = await scoped().integrations.saveWordpress(p.id, {
      config: { siteUrl: 'https://wp.example.test', username: 'editor' },
      secret: sealed,
      userId: editor.id,
    });
    assert.deepEqual(
      [saved.status, saved.hasSecret, saved.config.username],
      ['connected', true, 'editor'],
    );
    assert.ok(
      !JSON.stringify(saved, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(
        'secret-app-password',
      ),
    );
    const row = await fx.integrationRow(p.id);
    assert.ok(
      !Buffer.from(row.secret_ciphertext).includes('secret-app-password'),
      'stored encrypted',
    );
    const opened = await scoped().integrations.wordpressSecret(p.id);
    assert.equal(
      box.decryptJson(opened.secret, `wordpress:${org.org.id}:${p.id}`).appPassword,
      'secret-app-password',
    );
    assert.ok(await scoped().integrations.wordpressResult(p.id, { ok: false, error: 'It broke.' }));
    assert.deepEqual(
      [
        (await scoped().integrations.wordpress(p.id)).status,
        (await scoped().integrations.wordpress(p.id)).lastError,
      ],
      ['broken', 'It broke.'],
    );
    assert.ok(
      await scoped().integrations.wordpressResult(p.id, {
        ok: true,
        config: { pluginVersion: '1.0.0' },
      }),
    );
    assert.equal((await scoped().integrations.wordpress(p.id)).config.pluginVersion, '1.0.0');
    assert.equal(await scoped().integrations.disconnectWordpress(p.id), true);
    const after = await fx.integrationRow(p.id);
    assert.deepEqual(
      [after.status, after.secret_ciphertext, after.secret_wrapped_dek, after.secret_key_version],
      ['disconnected', null, null, null],
    );
    assert.equal(await scoped().integrations.wordpressSecret(p.id), null);
    assert.equal(
      await scoped().integrations.wordpressResult(p.id, { ok: true }),
      false,
      'a disconnected site is not revived by a late result',
    );
  });

  test('connecting again replaces the connection, including two saves at once', async () => {
    const p = await project();
    const save = (user) =>
      scoped().integrations.saveWordpress(p.id, {
        config: { siteUrl: 'https://wp.example.test', username: user },
        secret: box.encrypt({ appPassword: user }, `wordpress:${org.org.id}:${p.id}`),
      });
    await Promise.all([save('one'), save('two')]);
    assert.equal(await fx.integrationCount(p.id), 1);
    await save('three');
    assert.equal((await scoped().integrations.wordpress(p.id)).config.username, 'three');
  });
});
