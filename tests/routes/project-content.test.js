import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createSecretBox } from '../../src/lib/secrets.js';
import { liveKey } from '../../src/worker/handlers/content.js';
import { startWordPressStub } from '../helpers/wordpress-stub.js';
import { testFetcher } from '../helpers/http-fixture.js';
import { authHarness, orgPathOf } from './auth-helpers.js';

/**
 * The Content Studio screens and the WordPress connection (Milestone 7): sign-in and scoping, the board, starting a
 * page, each state of an item, the editor and its saves, approval and who may do it, publishing, the export, the live
 * draft stream, and connecting WordPress. The rules are in src/core/content-*.test.js, the reads and writes in
 * tests/integration/content-repo.test.js and the jobs in content-jobs.test.js.
 */
const added = [];
let failQueue = false;
const jobs = {
  added,
  async add(name, data, options) {
    if (failQueue) throw new Error('redis is down');
    added.push({ name, data, options });
  },
};
const box = createSecretBox({ current: { version: 1, key: randomBytes(32) } });
const live = new Map();
const redis = {
  async get(key) {
    return live.get(key) ?? null;
  },
};
let stub;
let h;

before(async () => {
  stub = await startWordPressStub();
  h = authHarness({
    jobs,
    content: { redis, prefix: 'test', secrets: box, fetcher: testFetcher({ ports: [stub.port] }) },
  });
});
after(async () => {
  await h.close();
  await stub.close();
});

let n = 0;
const unique = () => `${Date.now().toString(36)}${n++}`;
const BRIEF = {
  format: 'faq',
  title: 'How much does a crown cost?',
  metaDescription: 'x'.repeat(40),
  audience: 'adults',
  outline: [
    {
      heading: 'How much?',
      directAnswer: 'Between $900 and $1,500, depending on the tooth.',
      points: [],
      factIds: [],
    },
  ],
  entities: [],
  internalLinks: [],
  schemaType: 'Article',
};
const HTML =
  '<h2>How much does a crown cost?</h2><p>Between $900 and $1,500, depending on the tooth.</p>';
const JSONLD = {
  '@context': 'https://schema.org',
  '@graph': [{ '@type': 'Article', headline: 'x' }],
};

/** An organization with an owner, an admin, an editor and a viewer, and a project with a question. */
async function world() {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Content Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  const admin = await h.signedIn();
  await scoped.memberships.add({ userId: admin.user.id, role: 'admin' });
  const editor = await h.signedIn();
  await scoped.memberships.add({ userId: editor.user.id, role: 'editor' });
  const viewer = await h.signedIn();
  await scoped.memberships.add({ userId: viewer.user.id, role: 'viewer' });
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: `ct-${unique()}.example.test`,
      name: 'Content Dental',
      country: 'US',
      language: 'en',
    })
    .expect(303);
  const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  const q = (
    await scoped.prompts.add(project.id, {
      text: 'How much does a crown cost?',
      intent: 'discovery',
    })
  ).prompt;
  const base = `/app/o/${orgId}/projects/${pid}`;
  const make = async (title = 'A page', opts = {}) =>
    scoped.content.create(project.id, { title, userId: owner.user.id, ...opts });
  /** An item taken to `ready` (or on to `approved`), the way the pipeline would. */
  const ready = async ({ approve = false, title } = {}) => {
    const item = await make(title ?? `Page ${unique()}`);
    await scoped.content.saveResearch(project.id, item.id, { research: { facts: [], pack: {} } });
    await scoped.content.saveBrief(project.id, item.id, { brief: BRIEF });
    const draft = await scoped.content.saveDraft(project.id, item.id, { html: HTML });
    await scoped.content.saveQc(project.id, item.id, {
      revisionId: draft.revisionId,
      qc: { version: 1, score: 90, ready: true, blocking: [], checks: [], words: 300 },
      jsonld: JSONLD,
    });
    if (approve)
      await scoped.content.approve(project.id, item.id, {
        userId: owner.user.id,
        revisionId: draft.revisionId,
      });
    return { item, draft, url: `${base}/content/${item.publicId}` };
  };
  return { owner, admin, editor, viewer, orgId, scoped, project, q, base, make, ready };
}

describe('sign-in and scoping', () => {
  test('every screen and move needs a signed-in person', async () => {
    const w = await world();
    const { url } = await w.ready();
    for (const path of [
      '/content',
      `/content/${url.split('/').pop()}`,
      '/integrations/wordpress',
    ]) {
      const res = await h.agent.get(`${w.base}${path}`);
      assert.equal(res.status, 302, path);
      assert.match(res.headers.location, /sign-in/);
    }
    for (const move of ['save', 'approve', 'publish', 'retry', 'archive']) {
      const res = await h.agent.post(`${url}/${move}`).type('form').send({});
      assert.notEqual(res.status, 303, move);
    }
  });

  test('another organization’s project and item are a plain 404; so is a malformed address', async () => {
    const mine = await world();
    const theirs = await world();
    const { item, url } = await theirs.ready();
    await theirs.owner.get(url).expect(200);
    await mine.owner.get(`${theirs.base}/content`).expect(404);
    await mine.owner.get(url).expect(404);
    await mine.owner.get(`${mine.base}/content/${item.publicId}`).expect(404);
    await mine.owner.get(`${mine.base}/content/not-a-ulid`).expect(404);
    await mine.owner.post(`${mine.base}/content/${item.publicId}/archive`, {}).expect(404);
    await mine.owner
      .post(`${mine.base}/content/${item.publicId}/save`, { html: '<p>x</p>' })
      .expect(404);
    await mine.owner.get(`${mine.base}/content/${item.publicId}/events`).expect(404);
    assert.equal(
      (await theirs.scoped.content.get(theirs.project.id, item.publicId)).status,
      'ready',
    );
  });

  test('a client seat sees the Content Studio only for its own projects', async () => {
    const w = await world();
    const { url } = await w.ready();
    const elsewhere = await h.fx.project(w.project.org_id, 'Elsewhere');
    const membership = await w.scoped.memberships.getByUser(w.viewer.user.id);
    await w.scoped.memberships.setProjectAccess({
      membershipId: membership.id,
      access: 'selected',
      projectIds: [elsewhere.id],
    });
    await w.viewer.get(`${w.base}/content`).expect(404);
    await w.viewer.get(url).expect(404);
    await w.viewer.get(`${w.base}/integrations/wordpress`).expect(404);
  });
});

describe('the board and starting a page', () => {
  test('an empty board says why and what to do; the project has a Content tab', async () => {
    const w = await world();
    const res = await w.owner.get(`${w.base}/content`).expect(200);
    assert.match(res.text, /No pages yet/);
    assert.match(res.text, /Write a page/);
    assert.match(res.text, new RegExp(`href="${w.base}/content"[^>]*>Content<`));
    assert.match(res.text, /Drafts this month/);
    assert.match(res.text, /0 of 4 used/);
  });

  test('a question starts a page: an item is made, the research job is queued, the person lands on it', async () => {
    const w = await world();
    const before = added.length;
    const res = await w.editor
      .post(`${w.base}/content`, { promptId: String(w.q.id), title: '' })
      .expect(303);
    const [, publicId] = res.headers.location.match(/content\/([0-9A-Z]{26})/);
    assert.match(res.headers.location, /notice=content-started/);
    const item = await w.scoped.content.get(w.project.id, publicId);
    assert.deepEqual(
      [item.status, item.title, item.promptIds],
      ['researching', 'How much does a crown cost?', [String(w.q.id)]],
    );
    assert.equal(added.length, before + 1);
    assert.equal(added.at(-1).name, 'content.research');
    assert.equal(added.at(-1).data.itemId, String(item.id));
    assert.match(added.at(-1).options.jobId, /^content-research-\d+-r\d+$/);
    assert.ok(
      !JSON.stringify(added.at(-1).data).includes('crown'),
      'the payload carries ids and nothing else',
    );
    const page = await w.editor.get(`${w.base}/content/${publicId}`).expect(200);
    assert.match(page.text, /Reading what the engines answer today/);
    assert.match(page.text, /data-content-live/);
    assert.match(page.text, /data-auto-refresh/);
    assert.doesNotMatch(page.text, /vendor\/editor\.js/);
  });

  test('a typed topic works; neither a topic nor a question is refused; a viewer cannot start one', async () => {
    const w = await world();
    const ok = await w.owner
      .post(`${w.base}/content`, { title: 'Teeth whitening aftercare' })
      .expect(303);
    assert.match(ok.headers.location, /content-started/);
    const none = await w.owner.post(`${w.base}/content`, { title: '  ' }).expect(303);
    assert.match(none.headers.location, /content-needs-topic/);
    const foreign = await w.owner.post(`${w.base}/content`, { promptId: '99999999' }).expect(303);
    assert.match(foreign.headers.location, /content-needs-topic/);
    await w.viewer.post(`${w.base}/content`, { title: 'x' }).expect(403);
    assert.equal((await w.scoped.content.list(w.project.id)).length, 1);
  });

  test('a queue that is down fails the item plainly and gives the draft back; the month limit is explained', async () => {
    const w = await world();
    failQueue = true;
    const res = await w.owner.post(`${w.base}/content`, { title: 'Queue down' }).expect(303);
    failQueue = false;
    assert.match(res.headers.location, /content-queue-failed/);
    const [item] = await w.scoped.content.list(w.project.id);
    assert.equal(item.status, 'failed');
    assert.equal((await w.scoped.draftQuota.draftsUsed()).used, 0);
    for (let i = 0; i < 4; i += 1)
      await w.owner.post(`${w.base}/content`, { title: `Page ${i}` }).expect(303);
    const blocked = await w.owner.post(`${w.base}/content`, { title: 'One too many' }).expect(303);
    assert.match(blocked.headers.location, /content-quota/);
    const board = await w.owner.get(blocked.headers.location).expect(200);
    assert.match(board.text, /drafts are used up/);
  });

  test('the board groups pages by where they are', async () => {
    const w = await world();
    await w.make('Being written');
    const { item } = await w.ready({ title: 'Waiting for review' });
    const board = (await w.owner.get(`${w.base}/content`).expect(200)).text;
    assert.match(board, /Being written <span[^>]*>\(1\)/);
    assert.match(board, /In review <span[^>]*>\(1\)/);
    assert.match(board, new RegExp(`/content/${item.publicId}`));
    assert.match(board, /Quality check: 90 out of 100/);
  });
});

describe('one page', () => {
  test('ready: the editor, the check, the plan and the approval are on the page; the editor script loads only for someone who can edit', async () => {
    const w = await world();
    const { url, draft } = await w.ready();
    const page = (await w.editor.get(url).expect(200)).text;
    assert.match(page, /data-editor/);
    assert.match(page, /vendor\/editor\.js/);
    assert.match(page, /name="html"/);
    assert.match(page, new RegExp(`name="revision" value="1"`));
    assert.match(page, /Quality check/);
    assert.match(page, /90 \/ 100/);
    assert.match(page, /The plan this page was written from/);
    assert.match(page, /Structured data \(JSON-LD\)/);
    assert.match(page, new RegExp(`name="revisionId" value="${draft.revisionId}"`));
    assert.match(page, /I have read it: approve/);
    const asViewer = (await w.viewer.get(url).expect(200)).text;
    assert.doesNotMatch(asViewer, /vendor\/editor\.js/);
    assert.doesNotMatch(asViewer, /name="html"/);
    assert.match(asViewer, /Approving is for owners, admins and editors/);
    assert.match(asViewer, /<h2>How much does a crown cost\?<\/h2>/, 'a viewer reads the page');
  });

  test('failed: the reason is shown with a way to try again', async () => {
    const w = await world();
    const item = await w.make('Broken');
    await w.scoped.content.fail(w.project.id, item.id, {
      stage: 'researching',
      reason: 'The writing service was busy or unavailable. Try again in a few minutes.',
    });
    const page = (await w.owner.get(`${w.base}/content/${item.publicId}`).expect(200)).text;
    assert.match(page, /This stopped while researching/);
    assert.match(page, /busy or unavailable/);
    const before = added.length;
    const res = await w.owner.post(`${w.base}/content/${item.publicId}/retry`, {}).expect(303);
    assert.match(res.headers.location, /content-retried/);
    assert.equal(added.at(-1).name, 'content.research');
    assert.equal(added.length, before + 1);
    assert.equal((await w.scoped.content.get(w.project.id, item.id)).status, 'researching');
  });

  test('saving the text sanitizes it, makes a new version, takes approval away and queues a new check', async () => {
    const w = await world();
    const { url, item } = await w.ready({ approve: true });
    const before = added.length;
    const res = await w.editor
      .post(`${url}/save`, {
        revision: '1',
        html: '<h2>How much?</h2><p onclick="x()">Edited <script>alert(1)</script>text.</p><img src=x onerror=alert(1)>',
      })
      .expect(303);
    assert.match(res.headers.location, /content-saved/);
    const got = await w.scoped.content.get(w.project.id, item.id);
    assert.deepEqual([got.status, got.current.revision, got.approvedRevisionId], ['qc', 2, null]);
    assert.equal(got.current.bodyHtml, '<h2>How much?</h2>\n<p>Edited text.</p>');
    assert.equal(added.length, before + 1);
    assert.deepEqual(
      [added.at(-1).name, added.at(-1).options.jobId.endsWith('-r2')],
      ['content.qc', true],
    );
  });

  test('a page written to win citations shows what makes it easy to cite, as advice that never blocks approval', async () => {
    const w = await world();
    const { url, item } = await w.ready();
    const plain = (await w.editor.get(url).expect(200)).text;
    assert.doesNotMatch(plain, /Easy to cite/);
    // An edit sends the page back through the check (status qc); the check then saves its result.
    await w.scoped.content.saveEdit(w.project.id, item.id, {
      html: '<p>Edited for the check.</p>',
    });
    await w.scoped.content.saveQc(w.project.id, item.id, {
      revisionId: (await w.scoped.content.get(w.project.id, item.id)).currentRevisionId,
      qc: {
        version: 1,
        score: 90,
        ready: true,
        blocking: [],
        checks: [],
        words: 300,
        citable: [
          { code: 'sources_linked', label: 'Sources are linked', status: 'pass', finding: null },
          {
            code: 'author',
            label: 'Names who wrote it',
            status: 'warn',
            finding: 'No author is named. We never make up a person.',
          },
        ],
      },
      jsonld: JSONLD,
    });
    const page = (await w.editor.get(url).expect(200)).text;
    assert.match(page, /Easy to cite/);
    assert.match(page, /do not change the score and never stop you approving/);
    assert.match(page, /Names who wrote it/);
    assert.match(page, /We never make up a person/);
    assert.match(page, /90 \/ 100/);
  });

  test('a save from an out-of-date page is refused with an explanation, and nothing changes', async () => {
    const w = await world();
    const { url, item } = await w.ready();
    await w.scoped.content.saveEdit(w.project.id, item.id, {
      html: '<p>Someone else edited this page first.</p>',
    });
    await w.scoped.content.saveQc(w.project.id, item.id, {
      revisionId: (await w.scoped.content.get(w.project.id, item.id)).currentRevisionId,
      qc: { version: 1, score: 80, ready: true, blocking: [], checks: [], words: 9 },
      jsonld: JSONLD,
    });
    const res = await w.editor
      .post(`${url}/save`, { revision: '1', html: '<p>My edit.</p>' })
      .expect(303);
    assert.match(res.headers.location, /content-stale-text/);
    assert.equal(
      (await w.scoped.content.get(w.project.id, item.id)).current.bodyHtml,
      '<p>Someone else edited this page first.</p>',
    );
    const empty = await w.editor
      .post(`${url}/save`, { revision: '2', html: '<script>x</script>' })
      .expect(303);
    assert.match(empty.headers.location, /content-empty/);
    const same = await w.editor
      .post(`${url}/save`, { revision: '2', html: '<p>Someone else edited this page first.</p>' })
      .expect(303);
    assert.match(same.headers.location, /content-unchanged/);
    await w.viewer.post(`${url}/save`, { revision: '2', html: '<p>x</p>' }).expect(403);
  });

  test('the plan can be edited; broken rules are shown and nothing is saved; "save and write again" queues a draft', async () => {
    const w = await world();
    const { url, item } = await w.ready();
    const form = (over = {}) => ({
      title: 'A better title for the page',
      metaDescription: 'What a crown costs in Austin and what changes the price of it.',
      audience: 'adults',
      format: 'faq',
      schemaType: 'Article',
      outline_heading: [
        'How much does a crown cost?',
        'Is it covered by insurance?',
        'How long does it last?',
      ],
      outline_answer: ['Between $900 and $1,500.', 'Often in part.', 'About fifteen years.'],
      outline_points: ['', '', ''],
      outline_facts: ['', '', ''],
      entities: 'Austin',
      ...over,
    });
    const bad = await w.editor
      .post(
        `${url}/brief`,
        form({ outline_heading: ['Crown pricing overview', 'Is it covered?', 'How long?'] }),
      )
      .expect(422);
    assert.match(bad.text, /is not a question/);
    assert.match(bad.text, /The plan was not saved/);
    assert.equal((await w.scoped.content.get(w.project.id, item.id)).title, BRIEF.title);
    const saved = await w.editor.post(`${url}/brief`, form()).expect(303);
    assert.match(saved.headers.location, /content-brief-saved/);
    assert.equal(
      (await w.scoped.content.get(w.project.id, item.id)).title,
      'A better title for the page',
    );
    const before = added.length;
    const again = await w.editor.post(`${url}/brief`, form({ then: 'redraft' })).expect(303);
    assert.match(again.headers.location, /content-redrafting/);
    assert.equal((await w.scoped.content.get(w.project.id, item.id)).status, 'drafting');
    assert.equal(added.at(-1).name, 'content.draft');
    assert.equal(added.length, before + 1);
    const ghost = await w.editor
      .post(`${url}/brief`, form({ outline_facts: ['r9', '', ''] }))
      .expect(303);
    assert.match(ghost.headers.location, /content-stale/, 'no longer ready: refused, not a 500');
  });
});

describe('approval, publishing and export', () => {
  test('an editor can approve; a viewer cannot; a blocking problem stops it and says why; the text must be the one that was read', async () => {
    const w = await world();
    const { url, item, draft } = await w.ready();
    await w.viewer.post(`${url}/approve`, { revisionId: String(draft.revisionId) }).expect(403);
    const stale = await w.editor
      .post(`${url}/approve`, { revisionId: String(draft.revisionId + 5n) })
      .expect(303);
    assert.match(stale.headers.location, /content-blocked/);
    await h.fx.forceContent(item.id, {
      qc: {
        version: 1,
        score: 90,
        ready: false,
        blocking: ['unsupported_claims'],
        checks: [],
        words: 3,
        revisionId: String(draft.revisionId),
      },
    });
    const blocked = await w.editor
      .post(`${url}/approve`, { revisionId: String(draft.revisionId) })
      .expect(303);
    assert.match(blocked.headers.location, /content-blocked/);
    const page = (await w.editor.get(`${url}`).expect(200)).text;
    assert.match(page, /needs source/);
    assert.match(page, /disabled/);
    await h.fx.forceContent(item.id, {
      qc: {
        version: 1,
        score: 90,
        ready: true,
        blocking: [],
        checks: [],
        words: 3,
        revisionId: String(draft.revisionId),
      },
    });
    const ok = await w.editor
      .post(`${url}/approve`, { revisionId: String(draft.revisionId) })
      .expect(303);
    assert.match(ok.headers.location, /content-approved/);
    const done = await w.scoped.content.get(w.project.id, item.id);
    assert.deepEqual([done.status, done.approvedByUserId], ['approved', w.editor.user.id]);
    const missing = await w.editor.post(`${url}/approve`, {}).expect(303);
    assert.match(missing.headers.location, /content-stale-text/);
  });

  test('publishing needs an approved page and a connected site; the job carries ids only; a viewer cannot', async () => {
    const w = await world();
    const { url, item } = await w.ready({ approve: true });
    const noSite = await w.owner.post(`${url}/publish`, { mode: 'publish' }).expect(303);
    assert.match(noSite.headers.location, /content-no-wordpress/);
    assert.equal((await w.scoped.content.get(w.project.id, item.id)).status, 'approved');
    await w.scoped.integrations.saveWordpress(w.project.id, {
      config: { siteUrl: stub.siteUrl, username: stub.username, pluginConnected: false },
      secret: box.encrypt(
        { appPassword: stub.appPassword },
        `wordpress:${w.project.org_id}:${w.project.id}`,
      ),
      userId: w.owner.user.id,
    });
    await w.viewer.post(`${url}/publish`, { mode: 'publish' }).expect(403);
    const before = added.length;
    const res = await w.owner.post(`${url}/publish`, { mode: 'draft' }).expect(303);
    assert.match(res.headers.location, /content-publishing-draft/);
    assert.equal((await w.scoped.content.get(w.project.id, item.id)).status, 'publishing');
    const queued = added.at(-1);
    assert.equal(added.length, before + 1);
    assert.equal(queued.name, 'content.publish');
    assert.deepEqual(Object.keys(queued.data).sort(), [
      'itemId',
      'orgId',
      'projectId',
      'siteChangeId',
    ]);
    const page = (await w.owner.get(url).expect(200)).text;
    assert.match(page, /Sending the page to WordPress/);
  });

  test('a queue that is down when publishing leaves the site untouched and the item failed with a reason', async () => {
    const w = await world();
    const { url, item } = await w.ready({ approve: true });
    await w.scoped.integrations.saveWordpress(w.project.id, {
      config: { siteUrl: stub.siteUrl, username: stub.username },
      secret: box.encrypt(
        { appPassword: stub.appPassword },
        `wordpress:${w.project.org_id}:${w.project.id}`,
      ),
    });
    failQueue = true;
    const res = await w.owner.post(`${url}/publish`, { mode: 'publish' }).expect(303);
    failQueue = false;
    assert.match(res.headers.location, /content-queue-failed/);
    const got = await w.scoped.content.get(w.project.id, item.id);
    assert.deepEqual([got.status, got.failedStage], ['failed', 'publishing']);
    assert.match(got.failureReason, /Nothing was changed on your site/);
    assert.deepEqual(await w.scoped.content.retry(w.project.id, item.id), { to: 'approved' });
  });

  test('the export is only for an approved page, and is the approved version, with its structured data escaped', async () => {
    const w = await world();
    const unapproved = await w.ready();
    await w.owner.get(`${unapproved.url}/export.html`).expect(404);
    await w.owner.get(`${unapproved.url}/export.md`).expect(404);
    const { url, item } = await w.ready({ approve: true, title: 'Crown costs in Austin' });
    await w.scoped.content.unapprove(w.project.id, item.id).catch(() => {});
    await w.scoped.content.approve(w.project.id, item.id, {
      userId: w.owner.user.id,
      revisionId: (await w.scoped.content.get(w.project.id, item.id)).currentRevisionId,
    });
    const html = await w.viewer.get(`${url}/export.html`).expect(200);
    assert.match(html.headers['content-type'], /text\/html/);
    assert.match(html.headers['content-disposition'], /attachment; filename="[a-z0-9-]+\.html"/);
    assert.equal(html.headers['x-content-type-options'], 'nosniff');
    assert.match(html.text, /<h2>How much does a crown cost\?<\/h2>/);
    assert.match(html.text, /<script type="application\/ld\+json">\{/);
    assert.ok(
      html.text.includes('"@context":"https://schema.org"'),
      'the structured data is in the download',
    );
    const md = await w.viewer.get(`${url}/export.md`).expect(200);
    assert.match(md.headers['content-type'], /markdown/);
    assert.match(md.text, /^## How much does a crown cost\?/);
    await w.viewer.get(`${w.base}/content/${item.publicId}/export.pdf`).expect(404);
    // structured data that no longer validates is never written into a download
    await h.fx.forceContent(item.id, {
      jsonld: { '@context': 'https://schema.org', '@type': 'Article' },
    });
    const refused = await w.viewer.get(`${url}/export.html`).expect(409);
    assert.match(refused.text, /did not pass its check/);
    assert.ok(!refused.text.includes('ld+json'));
  });

  test('archiving puts a page away: it is gone from the board and its address is a 404', async () => {
    const w = await world();
    const { url, item } = await w.ready();
    const res = await w.editor.post(`${url}/archive`, {}).expect(303);
    assert.match(res.headers.location, /content-archived/);
    await w.editor.get(url).expect(404);
    assert.equal((await w.scoped.content.list(w.project.id)).length, 0);
    const again = await w.editor.post(`${url}/archive`, {}).expect(303);
    assert.match(again.headers.location, /content-stale/);
    assert.ok(item);
  });

  test('every move needs the CSRF token', async () => {
    const w = await world();
    const { url } = await w.ready();
    for (const move of ['save', 'approve', 'archive']) {
      const res = await w.editor.post(`${url}/${move}`, { html: '<p>x</p>' }, { csrf: null });
      assert.equal(res.status, 403, move);
    }
    assert.equal(
      (await w.editor.post(`${w.base}/integrations/wordpress`, {}, { csrf: null })).status,
      403,
    );
  });
});

describe('the draft as it is written', () => {
  test('the stream sends the sanitized text so far, then the new status when the item moves on, then ends', async () => {
    const w = await world();
    const item = await w.make('Streaming');
    await w.scoped.content.saveResearch(w.project.id, item.id, { research: {} });
    await w.scoped.content.saveBrief(w.project.id, item.id, { brief: BRIEF });
    live.set(
      liveKey('test', item.id),
      JSON.stringify({
        at: Date.now(),
        text: '<h2>Is it safe?</h2><p onclick="x()">Yes <script>alert(1)</script>mostly.</p>',
      }),
    );
    setTimeout(() => {
      w.scoped.content.saveDraft(w.project.id, item.id, { html: HTML }).catch(() => {});
    }, 700);
    const res = await w.owner
      .get(`${w.base}/content/${item.publicId}/events`)
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (c) => {
          data += c;
        });
        r.on('end', () => cb(null, data));
      });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.equal(res.headers['x-accel-buffering'], 'no');
    const body = res.body;
    assert.match(body, /event: draft\ndata: .*Is it safe\?/);
    assert.ok(!/alert\(1\)|onclick/.test(body), 'model output is sanitized before it leaves');
    assert.match(body, /event: status\ndata: {"status":"qc"}/);
  });
});

describe('WordPress', () => {
  const connectForm = (extra = {}) => ({
    siteUrl: stub.siteUrl,
    username: stub.username,
    appPassword: stub.appPassword,
    ...extra,
  });

  test('the screen is for everyone who can see the project, the controls for owners and admins', async () => {
    const w = await world();
    const owner = (await w.owner.get(`${w.base}/integrations/wordpress`).expect(200)).text;
    assert.match(owner, /Connect your site/);
    assert.match(owner, /name="appPassword"/);
    assert.match(owner, /type="password"/);
    assert.match(owner, /plugin\.zip/);
    const editor = (await w.editor.get(`${w.base}/integrations/wordpress`).expect(200)).text;
    assert.doesNotMatch(editor, /name="appPassword"/);
    assert.match(editor, /Connecting WordPress is for owners and admins/);
    await w.editor.post(`${w.base}/integrations/wordpress`, connectForm()).expect(403);
    await w.editor.post(`${w.base}/integrations/wordpress/test`, {}).expect(403);
    await w.editor.post(`${w.base}/integrations/wordpress/disconnect`, {}).expect(403);
    await w.editor.get(`${w.base}/integrations/wordpress/plugin.zip`).expect(403);
  });

  test('connecting checks the site and the login, does the plugin handshake, and keeps the password only encrypted', async () => {
    const w = await world();
    const res = await w.admin.post(`${w.base}/integrations/wordpress`, connectForm()).expect(303);
    assert.match(res.headers.location, /wp-connected/);
    const seen = await w.scoped.integrations.wordpress(w.project.id);
    assert.deepEqual(
      [seen.status, seen.config.pluginConnected, seen.config.siteName, seen.config.username],
      ['connected', true, 'Stub Site', stub.username],
    );
    assert.ok(
      stub.state.secret && stub.state.secret.length === 64,
      'the plugin was handed a signing secret',
    );
    const row = await h.fx.integrationRow(w.project.id);
    assert.ok(!Buffer.from(row.secret_ciphertext).includes(stub.appPassword));
    const creds = box.decryptJson(
      {
        ciphertext: Buffer.from(row.secret_ciphertext),
        wrappedDek: Buffer.from(row.secret_wrapped_dek),
        keyVersion: row.secret_key_version,
      },
      `wordpress:${w.project.org_id}:${w.project.id}`,
    );
    assert.deepEqual([creds.appPassword, creds.hmacSecret], [stub.appPassword, stub.state.secret]);
    const page = (await w.admin.get(`${w.base}/integrations/wordpress`).expect(200)).text;
    assert.match(page, /Connected/);
    assert.match(page, /Stub Site/);
    assert.ok(!page.includes(stub.appPassword), 'the password is never shown again');
  });

  test('a wrong password, a site that is not WordPress and a private address are explained, and nothing is saved', async () => {
    const w = await world();
    const wrong = await w.admin
      .post(`${w.base}/integrations/wordpress`, connectForm({ appPassword: 'not the password' }))
      .expect(422);
    assert.match(wrong.text, /did not accept that user name and application password/);
    assert.ok(
      !wrong.text.includes('not the password'),
      'a typed password is not sent back to the page',
    );
    assert.match(
      wrong.text,
      new RegExp(`value="${stub.username}"`),
      'but the address and user name are',
    );
    const missing = await w.admin
      .post(`${w.base}/integrations/wordpress`, { siteUrl: '', username: '', appPassword: '' })
      .expect(422);
    assert.match(missing.text, /Fill in the site address/);
    const private_ = await w.admin
      .post(`${w.base}/integrations/wordpress`, connectForm({ siteUrl: 'http://169.254.169.254' }))
      .expect(422);
    assert.match(private_.text, /not a public website/);
    const bad = await w.admin
      .post(`${w.base}/integrations/wordpress`, connectForm({ siteUrl: 'ftp://x' }))
      .expect(422);
    assert.match(bad.text, /https:\/\//);
    assert.equal(await w.scoped.integrations.wordpress(w.project.id), null);
    assert.equal(await h.fx.integrationCount(w.project.id), 0);
  });

  test('an editor-only login connects without the plugin, and the screen says what that costs', async () => {
    const w = await world();
    const only = await startWordPressStub({
      capabilities: { edit_posts: true, publish_posts: true },
    });
    const own = authHarness({
      jobs,
      content: {
        redis,
        prefix: 'test',
        secrets: box,
        fetcher: testFetcher({ ports: [only.port] }),
      },
    });
    try {
      const owner = await own.signedIn();
      const orgId = orgPathOf(
        await owner.post('/app/new-org', { name: 'Editor Login Co' }).expect(303),
      );
      const created = await owner
        .post(`/app/o/${orgId}/projects`, {
          website: `el-${unique()}.example.test`,
          name: 'EL',
          country: 'US',
          language: 'en',
        })
        .expect(303);
      const base = created.headers.location
        .replace(/\/(setup|dashboard).*$/, '')
        .replace(/\?.*$/, '');
      const res = await owner
        .post(`${base}/integrations/wordpress`, {
          siteUrl: only.siteUrl,
          username: only.username,
          appPassword: only.appPassword,
        })
        .expect(303);
      assert.match(res.headers.location, /wp-connected-no-plugin/);
      assert.equal(only.state.secret, null, 'no handshake without an administrator');
      const page = (await owner.get(`${base}/integrations/wordpress`).expect(200)).text;
      assert.match(page, /The plugin makes structured data reliable/);
    } finally {
      await own.close();
      await only.close();
    }
    assert.ok(w);
  });

  test('check again queues the test job; disconnect erases the saved password', async () => {
    const w = await world();
    await w.admin.post(`${w.base}/integrations/wordpress`, connectForm()).expect(303);
    const before = added.length;
    const res = await w.admin.post(`${w.base}/integrations/wordpress/test`, {}).expect(303);
    assert.match(res.headers.location, /wp-testing/);
    assert.equal(added.at(-1).name, 'wordpress.test');
    assert.deepEqual(Object.keys(added.at(-1).data).sort(), ['orgId', 'projectId']);
    assert.equal(added.length, before + 1);
    const gone = await w.admin.post(`${w.base}/integrations/wordpress/disconnect`, {}).expect(303);
    assert.match(gone.headers.location, /wp-disconnected/);
    const row = await h.fx.integrationRow(w.project.id);
    assert.deepEqual([row.status, row.secret_ciphertext], ['disconnected', null]);
    assert.equal(
      (await w.admin.get(`${w.base}/integrations/wordpress`).expect(200)).text.includes(
        'Connect your site',
      ),
      true,
    );
  });

  test('the plugin is downloaded as a zip of its folder, for owners and admins only', async () => {
    const w = await world();
    const res = await w.admin
      .get(`${w.base}/integrations/wordpress/plugin.zip`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(res.headers['content-disposition'], /aeo-corner-connector\.zip/);
    assert.equal(res.body.subarray(0, 2).toString(), 'PK');
    const names = res.body.toString('latin1');
    for (const file of [
      'aeo-corner-connector/aeo-corner-connector.php',
      'aeo-corner-connector/includes/class-aeo-rest.php',
      'aeo-corner-connector/uninstall.php',
      'aeo-corner-connector/readme.txt',
    ]) {
      assert.ok(names.includes(file), file);
    }
  });
});

describe('from a recommendation', () => {
  test('a page-shaped fix offers the Content Studio, starts an item linked to it, and shows the link afterwards', async () => {
    const w = await world();
    const rec = await h.fx.recommendation(w.project, {
      stable_key: `lost-${unique()}`,
      evidence: {
        type: 'lost_prompt',
        promptId: String(w.q.id),
        question: w.q.text,
        competitors: [],
      },
      title: 'Get Content Dental into the answer to “How much does a crown cost?”',
    });
    const detail = `${w.base}/actions/${rec.id}`;
    const before = (await w.editor.get(detail).expect(200)).text;
    assert.match(before, /Write it in the Content Studio/);
    const res = await w.editor.post(`${detail}/content`, {}).expect(303);
    const [, publicId] = res.headers.location.match(/content\/([0-9A-Z]{26})/);
    const item = await w.scoped.content.get(w.project.id, publicId);
    assert.deepEqual(
      [item.recommendationId, item.promptIds, item.kind],
      [rec.id, [String(w.q.id)], 'new'],
    );
    assert.equal(added.at(-1).name, 'content.research');
    const after = (await w.editor.get(detail).expect(200)).text;
    assert.match(after, /A page for this is in the Content Studio/);
    assert.match(after, new RegExp(`/content/${publicId}`));
    assert.doesNotMatch(after, /Write it in the Content Studio/);
    const again = await w.editor.post(`${detail}/content`, {}).expect(303);
    assert.ok(
      again.headers.location.includes(`/content/${publicId}`),
      'one page per recommendation: the same one',
    );
    const page = (await w.editor.get(`${w.base}/content/${publicId}`).expect(200)).text;
    assert.match(page, /the fix for the recommendation/);
  });

  test('a readiness fix that is not a page does not offer it, and a viewer does not see it', async () => {
    const w = await world();
    const guidance = await h.fx.recommendation(w.project, {
      stable_key: `a1-${unique()}`,
      rule_code: 'readiness.A1',
      category: 'crawler_access',
      fix_path: 'auto_fix',
      title: 'Allow the crawlers',
    });
    assert.doesNotMatch(
      (await w.editor.get(`${w.base}/actions/${guidance.id}`).expect(200)).text,
      /Write it in the Content Studio/,
    );
    const refused = await w.editor.post(`${w.base}/actions/${guidance.id}/content`, {}).expect(303);
    assert.match(refused.headers.location, /action-stale/);
    const content = await h.fx.recommendation(w.project, {
      stable_key: `e4-${unique()}`,
      rule_code: 'readiness.E4',
      category: 'content_refresh',
      fix_path: 'content',
      title: 'Add FAQ sections',
      affected_urls: ['https://example.test/services'],
    });
    assert.doesNotMatch(
      (await w.viewer.get(`${w.base}/actions/${content.id}`).expect(200)).text,
      /Write it in the Content Studio/,
    );
    await w.viewer.post(`${w.base}/actions/${content.id}/content`, {}).expect(403);
    const made = await w.editor.post(`${w.base}/actions/${content.id}/content`, {}).expect(303);
    const item = await w.scoped.content.get(
      w.project.id,
      made.headers.location.match(/content\/([0-9A-Z]{26})/)[1],
    );
    assert.deepEqual(
      [item.kind, item.targetUrl, item.quotaUnits],
      ['refresh', 'https://example.test/services', 0.5],
    );
  });

  test('a citation gap on a competitor starts a NEW page in the format its pages have, for the questions it was cited on', async () => {
    const w = await world();
    const rec = await h.fx.recommendation(w.project, {
      stable_key: `citation.gap:rival-${unique()}.test`,
      rule_code: 'citation.gap',
      category: 'content_new',
      fix_path: 'content',
      metric: 'citation_share',
      title: 'Publish a comparison to compete with rival.test',
      // The addresses it names are somebody else's: the new page must not target them.
      affected_urls: ['https://rival.test/compare'],
      evidence: {
        type: 'citation_gap',
        domain: 'rival.test',
        path: 'content',
        contentFormat: 'comparison',
        questions: [{ promptId: String(w.q.id), text: w.q.text, answersWithoutBrand: 3 }],
        pages: [{ url: 'https://rival.test/compare', title: null, format: 'comparison' }],
      },
    });
    const res = await w.editor.post(`${w.base}/actions/${rec.id}/content`, {}).expect(303);
    const item = await w.scoped.content.get(
      w.project.id,
      res.headers.location.match(/content\/([0-9A-Z]{26})/)[1],
    );
    assert.deepEqual(
      [item.kind, item.format, item.targetUrl, item.promptIds, item.quotaUnits],
      ['new', 'comparison', null, [String(w.q.id)], 1],
    );
  });

  test('a key page of the site that was never cited is refreshed in place', async () => {
    const w = await world();
    const rec = await h.fx.recommendation(w.project, {
      stable_key: `citation.own_page_uncited:p-${unique()}`,
      rule_code: 'citation.own_page_uncited',
      category: 'content_refresh',
      fix_path: 'content',
      metric: 'citation_share',
      title: 'Make example.test/services easier for AI to cite',
      affected_urls: ['https://example.test/services'],
      evidence: {
        type: 'citation_own_page',
        url: 'https://example.test/services',
        ownCitations: 14,
        pagesCited: 1,
      },
    });
    const res = await w.editor.post(`${w.base}/actions/${rec.id}/content`, {}).expect(303);
    const item = await w.scoped.content.get(
      w.project.id,
      res.headers.location.match(/content\/([0-9A-Z]{26})/)[1],
    );
    assert.deepEqual(
      [item.kind, item.targetUrl, item.quotaUnits],
      ['refresh', 'https://example.test/services', 0.5],
    );
  });
});
