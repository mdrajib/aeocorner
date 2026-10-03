import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { runReadinessChecks } from '../../src/crawler/readiness/index.js';
import { hashToken, newToken } from '../../src/lib/tokens.js';
import { context } from '../helpers/readiness.js';

/**
 * Cross-tenant leak suite for the repository layer (DATABASE_SCHEMA §6, layer 4).
 *
 * Two organizations are seeded with near-identical data: the same name, the same kinds of members, the
 * same project names. Every organization-scoped function is then called as organization A with an ID that
 * belongs to organization B. It must find nothing, change nothing, and never mention B.
 *
 * THIS SUITE GROWS WITH THE PRODUCT. A function added to the scoped repositories without a test here
 * fails the "every function is covered" test below, so isolation can't silently regress.
 */

const db = connectTestDb();
const fx = fixtures(db);

let A;
let B;
let bMember; // a membership that belongs to B
let bInvitation;
let bToken;
let bProject;

const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  const name = 'Twin Dental';
  A = await fx.org({ name });
  B = await fx.org({ name });
  await fx.member(A.org, 'editor', { name: 'Sam Lee' });
  const second = await fx.member(B.org, 'editor', { name: 'Sam Lee' });
  bMember = second.membership;
  await fx.project(A.org.id, 'Main site');
  bProject = await fx.project(B.org.id, 'Main site');

  bToken = newToken();
  bInvitation = await B.scoped.invitations.create({
    email: 'pending@example.test',
    role: 'viewer',
    inviterUserId: B.owner.id,
    tokenHash: hashToken(bToken),
    expiresAt: new Date(Date.now() + DAY),
  });
});

after(async () => {
  await fx.cleanup();
  await db.close();
});

const refuses = (promise, ...codes) =>
  assert.rejects(promise, (e) => e instanceof DomainError && codes.includes(e.code));
const ids = (rows) => rows.map((r) => String(r.id));

/** Everything about B that must survive A's attempts untouched. */
async function snapshotB() {
  const members = await B.scoped.memberships.list();
  const invites = await B.scoped.invitations.listPending();
  const log = await B.scoped.activity.recent();
  return JSON.stringify({ members, invites, log: log.length }, (_k, v) =>
    typeof v === 'bigint' ? String(v) : v,
  );
}

describe('memberships', () => {
  test('list(): A sees only A’s members', async () => {
    const aIds = new Set(ids(await A.scoped.memberships.list()));
    const bIds = new Set(ids(await B.scoped.memberships.list()));
    assert.ok(aIds.size >= 2);
    for (const id of bIds) assert.ok(!aIds.has(id), `B membership ${id} appeared for A`);
  });

  test('get(): B’s membership ID returns nothing for A', async () => {
    assert.equal(await A.scoped.memberships.get(bMember.id), null);
    assert.ok(await B.scoped.memberships.get(bMember.id));
  });

  test('getByUser(): B’s user is not a member of A', async () => {
    assert.equal(await A.scoped.memberships.getByUser(B.owner.id), null);
  });

  test('add(): cannot be used to add someone to B by naming B’s data', async () => {
    // A's repository can only ever write A's org_id.
    const outsider = await fx.user();
    const added = await A.scoped.memberships.add({ userId: outsider.id, role: 'viewer' });
    assert.equal(added.org_id, A.org.id);
    assert.equal(await B.scoped.memberships.getByUser(outsider.id), null);
  });

  test('changeRole(): B’s membership ID is not found, and B is unchanged', async () => {
    const before = await snapshotB();
    await refuses(
      A.scoped.memberships.changeRole({
        membershipId: bMember.id,
        role: 'admin',
        actorUserId: A.owner.id,
      }),
      'NOT_FOUND',
    );
    assert.equal(await snapshotB(), before);
  });

  test('remove(): B’s membership ID is not found, and B is unchanged', async () => {
    const before = await snapshotB();
    await refuses(
      A.scoped.memberships.remove({ membershipId: bMember.id, actorUserId: A.owner.id }),
      'NOT_FOUND',
    );
    await refuses(
      A.scoped.memberships.remove({ membershipId: B.ownerMembership.id, actorUserId: A.owner.id }),
      'NOT_FOUND',
    );
    assert.equal(await snapshotB(), before);
  });

  test('setProjectAccess(): neither B’s membership nor B’s project can be used from A', async () => {
    const aViewer = await fx.member(A.org, 'viewer');
    await refuses(
      A.scoped.memberships.setProjectAccess({ membershipId: bMember.id, access: 'all' }),
      'NOT_FOUND',
    );
    await refuses(
      A.scoped.memberships.setProjectAccess({
        membershipId: aViewer.membership.id,
        access: 'selected',
        projectIds: [bProject.id],
      }),
      'PROJECT_NOT_IN_ORG',
    );
  });
});

describe('invitations', () => {
  test('listPending(): A never sees B’s invitations', async () => {
    const seen = ids(await A.scoped.invitations.listPending());
    assert.ok(!seen.includes(String(bInvitation.id)));
  });

  test('get(): B’s invitation ID returns nothing for A', async () => {
    assert.equal(await A.scoped.invitations.get(bInvitation.id), null);
  });

  test('cancel() and reissue(): B’s invitation is not found from A, and its link still works', async () => {
    await refuses(
      A.scoped.invitations.cancel({ invitationId: bInvitation.id, actorUserId: A.owner.id }),
      'NOT_FOUND',
    );
    await refuses(
      A.scoped.invitations.reissue({
        invitationId: bInvitation.id,
        tokenHash: hashToken(newToken()),
        expiresAt: new Date(Date.now() + DAY),
        actorUserId: A.owner.id,
      }),
      'NOT_FOUND',
    );
    assert.equal((await db.invitationLinks.find(bToken)).state, 'pending');
  });

  test('create(): always writes A’s org, and ignores B’s projects', async () => {
    const created = await A.scoped.invitations.create({
      email: 'twin@example.test',
      role: 'viewer',
      inviterUserId: A.owner.id,
      tokenHash: hashToken(newToken()),
      expiresAt: new Date(Date.now() + DAY),
    });
    assert.equal(created.org_id, A.org.id);
    assert.equal(
      (await B.scoped.invitations.listPending()).some((i) => i.email === 'twin@example.test'),
      false,
    );
  });

  test('inviting to B’s address list does not detect B’s members (no membership oracle across orgs)', async () => {
    // B's owner is not a member of A, so inviting their address to A is allowed and says nothing about B.
    const created = await A.scoped.invitations.create({
      email: B.owner.email,
      role: 'viewer',
      inviterUserId: A.owner.id,
      tokenHash: hashToken(newToken()),
      expiresAt: new Date(Date.now() + DAY),
    });
    assert.equal(created.org_id, A.org.id);
  });
});

describe('activity log', () => {
  test('recent(): only A’s entries', async () => {
    const entries = await A.scoped.activity.recent({ limit: 200 });
    assert.ok(entries.length > 0);
    assert.ok(entries.every((e) => e.org_id === A.org.id));
  });

  test('append(): writes A’s org only', async () => {
    await A.scoped.activity.append({ action: 'test.event', summary: 'hello' });
    const mine = await A.scoped.activity.recent();
    assert.ok(mine.some((e) => e.action === 'test.event'));
    assert.ok(!(await B.scoped.activity.recent()).some((e) => e.action === 'test.event'));
  });
});

describe('organizations and invitation links (the global lookups)', () => {
  test('findForUser(): A’s owner cannot open B by its public ID', async () => {
    assert.equal(
      await db.organizations.findForUser({ publicId: B.org.public_id, userId: A.owner.id }),
      null,
    );
    assert.ok(
      await db.organizations.findForUser({ publicId: B.org.public_id, userId: B.owner.id }),
    );
  });

  test('listForUser(): lists only organizations the user belongs to', async () => {
    const listed = await db.organizations.listForUser(A.owner.id);
    assert.deepEqual(
      listed.map((x) => x.org.id),
      [A.org.id],
    );
  });

  test('accept(): a signed-in user of A cannot join B with B’s link unless the invited email is theirs', async () => {
    await refuses(
      db.invitationLinks.accept({ token: bToken, user: A.owner, verifiedEmails: [A.owner.email] }),
      'EMAIL_MISMATCH',
    );
    assert.equal(await B.scoped.memberships.getByUser(A.owner.id), null);
  });

  test('find(): returns the name and public ID of the invited organization only', async () => {
    const found = await db.invitationLinks.find(bToken);
    assert.equal(found.org.public_id, B.org.public_id);
    const text = JSON.stringify(found, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    assert.equal(text.includes(String(A.org.public_id)), false);
  });
});

describe('usage ledger', () => {
  const entry = (key, costUsd = '0.25') => ({
    meter: 'other',
    providerCode: 'noop',
    unit: 'request',
    costUsd,
    idempotencyKey: key,
  });
  const since = new Date(Date.now() - 3_600_000);

  test('record(): writes A’s org only, and reading it back as B finds nothing', async () => {
    const { entry: row } = await A.scoped.usage.record(entry(`tenancy.a.${A.org.id}`));
    assert.equal(row.org_id, A.org.id);
    assert.ok(!(await B.scoped.usage.recent({ limit: 500 })).some((r) => r.id === row.id));
  });

  test('record(): B’s project cannot be named from A', async () => {
    await refuses(
      A.scoped.usage.record({ ...entry(`tenancy.proj.${A.org.id}`), projectId: bProject.id }),
      'PROJECT_NOT_IN_ORG',
    );
  });

  test('record(): B’s idempotency key is a clash for A, and says nothing about B’s row', async () => {
    const key = `tenancy.clash.${B.org.id}`;
    await B.scoped.usage.record(entry(key));
    await assert.rejects(A.scoped.usage.record(entry(key)), (e) => {
      assert.ok(e instanceof DomainError && e.code === 'KEY_IN_USE');
      assert.ok(!JSON.stringify([e.message, e.code]).includes(String(B.org.id)));
      return true;
    });
  });

  test('recent(): only A’s rows', async () => {
    const rows = await A.scoped.usage.recent({ limit: 500 });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.org_id === A.org.id));
  });

  test('spentSinceMicros(): B’s spending never counts towards A', async () => {
    await B.scoped.usage.record(entry(`tenancy.big.${B.org.id}`, '500'));
    const a = await A.scoped.usage.spentSinceMicros(since);
    assert.ok(a < 500_000_000, `A saw ${a} micro-dollars`);
    assert.ok((await B.scoped.usage.spentSinceMicros(since)) >= 500_000_000);
  });
});

describe('spend-cap state', () => {
  const until = new Date(Date.now() + 3_600_000);
  const pause = (org) =>
    org.scoped.spend.pause({ until, now: new Date(), spentUsd: '1', capUsd: '1' });

  test('state(): A sees A’s cap and plan, not B’s', async () => {
    await fx.setOrgSpend(B.org.id, { capUsd: '777.00', planCode: 'agency' });
    const a = await A.scoped.spend.state();
    assert.notEqual(a.orgCapUsd, '777');
    assert.notEqual(a.planCode, 'agency');
    assert.equal((await B.scoped.spend.state()).orgCapUsd, '777');
  });

  test('pause() / resume(): A’s calls never move B’s pause', async () => {
    assert.equal((await fx.organizationRow(B.org.id)).collection_paused_until, null);
    assert.equal(await pause(A), true);
    assert.equal((await fx.organizationRow(B.org.id)).collection_paused_until, null, 'B untouched');
    assert.ok((await fx.organizationRow(A.org.id)).collection_paused_until);

    await pause(B);
    assert.equal(await A.scoped.spend.resume({ reason: 'test' }), true);
    assert.ok((await fx.organizationRow(B.org.id)).collection_paused_until, 'B still paused');
    assert.equal(await A.scoped.spend.resume({ reason: 'test' }), false, 'nothing left for A');
    await B.scoped.spend.resume({ reason: 'test' });
  });

  test('pause() is claimed once: the other callers find it already paused', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => pause(A)));
    assert.equal(results.filter(Boolean).length, 1);
    await A.scoped.spend.resume({ reason: 'test' });
  });
});

describe('notifications', () => {
  const notice = (org, over = {}) => ({
    userId: org.owner.id,
    kind: 'test',
    dedupeKey: 'shared-key',
    ...over,
  });

  test('createOnce(): B’s user cannot be notified from A', async () => {
    await refuses(
      A.scoped.notifications.createOnce(notice(A, { userId: B.owner.id })),
      'NOT_MEMBER',
    );
    assert.equal((await B.scoped.notifications.forUser(B.owner.id)).length, 0);
  });

  test('createOnce(): the same key in two organizations is two notices; neither reveals the other', async () => {
    assert.equal((await A.scoped.notifications.createOnce(notice(A))).created, true);
    assert.equal(
      (await B.scoped.notifications.createOnce(notice(B))).created,
      true,
      'B’s key is not taken just because A used the same text',
    );
    assert.equal((await A.scoped.notifications.createOnce(notice(A))).created, false);
  });

  test('forUser(): B’s user has no notices as seen from A, though B has some', async () => {
    assert.ok((await B.scoped.notifications.forUser(B.owner.id)).length > 0);
    assert.deepEqual(await A.scoped.notifications.forUser(B.owner.id), []);
    const mine = await A.scoped.notifications.forUser(A.owner.id);
    assert.ok(mine.length > 0 && mine.every((n) => n.org_id === A.org.id));
  });
});

describe('site scans', () => {
  // A scan result as the crawler returns it, with every check "couldn't check" (that is enough to be stored).
  const report = runReadinessChecks(context());
  const resultFor = (domain) => ({
    status: 'partial',
    rubricVersion: report.rubricVersion,
    readinessScore: null,
    categoryScores: report.categories,
    coverage: 0,
    counts: report.counts,
    checks: report.checks,
    notes: ['test'],
    site: { platform: 'wordpress', origin: `https://${domain}` },
    robots: { key: null },
    sitemaps: { found: [] },
    pagesPlanned: 1,
    pagesFetched: 1,
    finishedAt: new Date().toISOString(),
    pages: [
      {
        url: `https://${domain}/`,
        finalUrl: `https://${domain}/`,
        pageType: 'home',
        isKey: true,
        sources: ['home'],
        status: 200,
        redirectCount: 0,
        contentType: 'text/html',
        headers: {},
        title: 'Home',
        jsonLdTypes: [],
        rawTextChars: 100,
        renderedTextChars: null,
        rawKey: 'test/crawl/x.html',
        renderedKey: null,
        fetchMs: 12,
        error: null,
      },
    ],
  });
  let aScan;
  let bScan;
  let aProject;

  before(async () => {
    aProject = await fx.project(A.org.id, 'Scanned A');
    aScan = await A.scoped.scans.create({ projectId: aProject.id, rubricVersion: 'v0.1' });
    bScan = await B.scoped.scans.create({ projectId: bProject.id, rubricVersion: 'v0.1' });
  });

  test('create(): B’s project cannot be scanned from A', async () => {
    await refuses(
      A.scoped.scans.create({ projectId: bProject.id, rubricVersion: 'v0.1' }),
      'PROJECT_NOT_IN_ORG',
    );
  });

  test('get(): A cannot read B’s scan, and B’s own is untouched', async () => {
    assert.equal(await A.scoped.scans.get(bScan.id), null);
    const own = await A.scoped.scans.get(aScan.id);
    assert.equal(own.domain, aProject.domain);
    assert.equal((await B.scoped.scans.get(bScan.id)).status, 'queued');
  });

  test('start(): A cannot start B’s scan', async () => {
    assert.equal(await A.scoped.scans.start(bScan.id), false);
    assert.equal((await B.scoped.scans.get(bScan.id)).status, 'queued');
    assert.equal(await B.scoped.scans.start(bScan.id), true);
  });

  test('fail(): A cannot fail B’s scan, and B can fail its own', async () => {
    const spare = await B.scoped.scans.create({ projectId: bProject.id, rubricVersion: 'v0.1' });
    assert.equal(await A.scoped.scans.fail(spare.id), false);
    assert.equal((await B.scoped.scans.get(spare.id)).status, 'queued');
    assert.equal(await B.scoped.scans.fail(spare.id), true);
    assert.equal((await B.scoped.scans.get(spare.id)).status, 'failed');
    assert.equal(
      await B.scoped.scans.fail(spare.id),
      false,
      'a scan that already ended is left alone',
    );
  });

  test('finish(): A cannot write results into B’s scan', async () => {
    await refuses(A.scoped.scans.finish(bScan.id, resultFor('a.example.test')), 'NOT_FOUND');
    assert.deepEqual(await B.scoped.scans.pages(bScan.id), []);
    assert.deepEqual(await B.scoped.scans.checks(bScan.id), []);
    assert.equal((await B.scoped.scans.get(bScan.id)).status, 'running');
  });

  test('finish(): saves the pages and checks, and doing it again replaces them instead of doubling them', async () => {
    const first = await B.scoped.scans.finish(bScan.id, resultFor('b.example.test'));
    assert.deepEqual([first.pages, first.checks], [1, 24]);
    await B.scoped.scans.finish(bScan.id, resultFor('b.example.test'));
    assert.equal((await B.scoped.scans.pages(bScan.id)).length, 1);
    assert.equal((await B.scoped.scans.checks(bScan.id)).length, 24);
    assert.equal(
      (await B.scoped.scans.knownPages(bProject.id)).length,
      1,
      'one known page, refreshed',
    );
    const row = await B.scoped.scans.get(bScan.id);
    assert.equal(row.status, 'partial');
    assert.equal(
      row.readiness_score,
      null,
      'a scan that could not be read has no score, not a score of 0',
    );
  });

  test('pages() / checks() / knownPages(): A sees nothing of B’s scan, though B has results', async () => {
    assert.deepEqual(await A.scoped.scans.pages(bScan.id), []);
    assert.deepEqual(await A.scoped.scans.checks(bScan.id), []);
    assert.deepEqual(await A.scoped.scans.knownPages(bProject.id), []);
    assert.ok((await B.scoped.scans.checks(bScan.id)).length > 0);
  });

  test('recent(): A listing B’s project gets nothing; its own project shows only its own scans', async () => {
    assert.deepEqual(await A.scoped.scans.recent({ projectId: bProject.id }), []);
    const mine = await A.scoped.scans.recent({ projectId: aProject.id });
    assert.deepEqual(ids(mine), [String(aScan.id)]);
    assert.ok(mine.every((r) => r.org_id === A.org.id));
  });

  test('the database itself refuses a scan row that names another organization’s project', async () => {
    await assert.rejects(fx.forceScan({ orgId: A.org.id, projectId: bProject.id }), (e) =>
      /foreign key|constraint/i.test(String(e.message)),
    );
  });
});

describe('answer snapshots', () => {
  // answer_snapshots has no foreign keys (a fact table), so the repository is the ONLY thing between one
  // organization and another's runs and prompts.
  let aProject;
  let aRun;
  let aPrompt;
  let bRun;
  let bPrompt;
  let bSnap;
  const plan = (runId, promptId, sampleIdx = 0) => ({
    runId,
    promptId,
    engineCode: 'perplexity',
    sampleIdx,
    providerCode: 'perplexity_api',
    method: 'api_grounded',
  });
  const answer = {
    status: 'ok',
    providerCode: 'perplexity_api',
    method: 'api_grounded',
    isFallback: false,
    providerTaskId: 'resp_1',
    modelVersion: 'perplexity/sonar',
    collectedAt: new Date(),
    rawUri: 'test/answers/x.json',
    rawSha256: 'a'.repeat(64),
    answerChars: 10,
    textExcerpt: 'Twin answer',
    costUsd: '0.004',
  };

  before(async () => {
    aProject = await fx.project(A.org.id, 'Snapshots A');
    aRun = await fx.run(aProject);
    aPrompt = await fx.prompt(aProject, { text: 'Same question' });
    bRun = await fx.run(bProject);
    bPrompt = await fx.prompt(bProject, { text: 'Same question' });
    bSnap = (await B.scoped.snapshots.create(plan(bRun.id, bPrompt.id))).snapshot;
  });

  test('create(): A cannot plan an answer on B’s run, with B’s prompt, or with a prompt from another project', async () => {
    await refuses(A.scoped.snapshots.create(plan(bRun.id, aPrompt.id)), 'RUN_NOT_IN_ORG');
    await refuses(A.scoped.snapshots.create(plan(aRun.id, bPrompt.id)), 'PROMPT_NOT_IN_RUN');
    const elsewhere = await fx.prompt(await fx.project(A.org.id, 'Other A project'));
    await refuses(A.scoped.snapshots.create(plan(aRun.id, elsewhere.id)), 'PROMPT_NOT_IN_RUN');
    assert.equal((await B.scoped.snapshots.forRun(bRun.id)).length, 1);

    const own = await A.scoped.snapshots.create(plan(aRun.id, aPrompt.id));
    assert.equal(own.created, true);
    assert.equal(own.snapshot.org_id, A.org.id);
    assert.equal(
      own.snapshot.project_id,
      aProject.id,
      'the project comes from the run, not the caller',
    );
    const again = await A.scoped.snapshots.create(plan(aRun.id, aPrompt.id));
    assert.deepEqual([again.created, again.snapshot.id], [false, own.snapshot.id]);
  });

  test('get() and forRun(): B’s snapshots and B’s question are invisible from A', async () => {
    assert.equal(await A.scoped.snapshots.get(bSnap.id), null);
    assert.deepEqual(await A.scoped.snapshots.forRun(bRun.id), []);
    const mine = await B.scoped.snapshots.get(bSnap.id);
    assert.equal(mine.prompt.text, 'Same question');
  });

  test('submitted(), complete() and fail(): A cannot move B’s snapshot', async () => {
    assert.equal(
      await A.scoped.snapshots.submitted(bSnap.id, {
        providerCode: 'dataforseo',
        method: 'ui_capture',
        isFallback: true,
        providerTaskId: 'stolen',
        costUsd: '9',
      }),
      false,
    );
    assert.equal(await A.scoped.snapshots.complete(bSnap.id, answer), false);
    assert.equal(await A.scoped.snapshots.fail(bSnap.id, 'from A'), false);
    const untouched = await B.scoped.snapshots.get(bSnap.id);
    assert.deepEqual(
      [
        untouched.status,
        untouched.provider_task_id,
        untouched.attempts,
        String(untouched.cost_usd),
      ],
      ['pending', null, 0, '0'],
    );

    // B itself can, once: a finished snapshot never moves again.
    assert.equal(await B.scoped.snapshots.complete(bSnap.id, answer), true);
    assert.equal(await B.scoped.snapshots.fail(bSnap.id, 'late'), false);
    assert.equal(await B.scoped.snapshots.complete(bSnap.id, answer), false);
    assert.equal((await B.scoped.snapshots.get(bSnap.id)).status, 'ok');
  });

  test('complete() refuses an answer whose raw payload was not stored first, or a failure in disguise', async () => {
    const { snapshot } = await A.scoped.snapshots.create(plan(aRun.id, aPrompt.id, 1));
    await refuses(
      A.scoped.snapshots.complete(snapshot.id, { ...answer, rawSha256: null }),
      'INVALID',
    );
    await refuses(
      A.scoped.snapshots.complete(snapshot.id, { ...answer, status: 'failed' }),
      'INVALID',
    );
  });
});

describe('answer extraction', () => {
  // mentions, citations and claims are fact tables with no foreign keys, so the repository is the only thing that
  // keeps one organization's readings, entities and batches away from another's.
  let aProject;
  let aRun;
  let aSnap;
  let aBrand;
  let bRun;
  let bSnap;
  let bBrand;
  const DOMAIN = 'tenancy-extract.test';
  const planFor = (entityId) => ({
    answerType: 'list',
    mentions: [
      {
        entityId,
        discoveredName: null,
        nameAsWritten: 'Twin',
        listRank: 1,
        mentionOrder: 1,
        prominence: 'primary',
        stance: 'recommended',
        sentiment: 1,
        excerpt: 'Twin is good.',
        detectedBy: 'both',
        claims: [{ attribute: 'pricing', value: 'cheap', polarity: 'positive' }],
      },
      {
        entityId: null,
        discoveredName: 'Shared Rival',
        nameAsWritten: 'Shared Rival',
        listRank: 2,
        mentionOrder: 2,
        prominence: 'primary',
        stance: 'neutral',
        sentiment: 0,
        excerpt: null,
        detectedBy: 'llm',
        claims: [],
      },
    ],
    citations: [
      {
        position: 1,
        url: `https://${DOMAIN}/a`,
        domain: DOMAIN,
        title: 'A',
        ownerEntityId: entityId,
        isOwn: true,
        supportsEntityIds: [entityId],
        supportsDiscovered: ['Shared Rival'],
      },
    ],
    disagreements: [],
  });
  const save = (scoped, snapshotId, entityId) =>
    scoped.extractions.save(snapshotId, {
      plan: planFor(entityId),
      prepass: { v: 'p1', found: [], citations: 1 },
      version: 'x1.opus55',
    });

  before(async () => {
    aProject = await fx.project(A.org.id, 'Extraction A');
    aBrand = await fx.entity(aProject, { kind: 'brand', name: 'Twin', domains: ['twin-a.test'] });
    bBrand = await fx.entity(bProject, {
      kind: 'brand',
      name: 'Twin',
      aliases: ['Twins'],
      domains: ['twin-b.test'],
      excludes: ['Twin Peaks'],
    });
    aRun = await fx.run(aProject);
    bRun = await fx.run(bProject);
    aSnap = await fx.collectedAnswer(aRun, await fx.prompt(aProject, { text: 'Which twin?' }));
    bSnap = await fx.collectedAnswer(bRun, await fx.prompt(bProject, { text: 'Which twin?' }));
  });

  after(() => fx.forgetDomains([DOMAIN]));

  test('entitiesFor(): A gets nothing for B’s project; B gets its own with aliases and exclusions', async () => {
    assert.deepEqual(await A.scoped.extractions.entitiesFor(bProject.id), []);
    const mine = await B.scoped.extractions.entitiesFor(bProject.id);
    assert.deepEqual(
      mine.map((e) => [e.name, e.aliases, e.domains, e.excludes]),
      [['Twin', ['Twins'], ['twin-b.test'], ['Twin Peaks']]],
    );
  });

  test('snapshot(), run() and pendingForRun(): B’s answers, runs and questions are invisible from A', async () => {
    assert.equal(await A.scoped.extractions.snapshot(bSnap.id), null);
    assert.equal(await A.scoped.extractions.run(bRun.id), null);
    assert.deepEqual(await A.scoped.extractions.pendingForRun(bRun.id), []);
    const pending = await B.scoped.extractions.pendingForRun(bRun.id);
    assert.deepEqual(ids(pending), [String(bSnap.id)]);
    assert.equal(pending[0].prompt.text, 'Which twin?');
  });

  test('addBatch(), batchesOf() and batchProcessed(): A can neither record nor see nor close B’s batches', async () => {
    const at = new Date();
    assert.equal(
      await A.scoped.extractions.addBatch(bRun.id, {
        batchId: 'msgbatch_a',
        model: 'opus55',
        count: 1,
        submittedAt: at,
      }),
      false,
    );
    assert.equal(
      await B.scoped.extractions.addBatch(bRun.id, {
        batchId: 'msgbatch_b',
        model: 'opus55',
        count: 1,
        submittedAt: at,
      }),
      true,
    );
    assert.deepEqual(await A.scoped.extractions.batchesOf(bRun.id), []);
    assert.equal(await A.scoped.extractions.batchProcessed(bRun.id, 'msgbatch_b', at), false);
    const [batch] = await B.scoped.extractions.batchesOf(bRun.id);
    assert.equal(batch.id, 'msgbatch_b');
    assert.equal(batch.processedAt, null, 'A did not close it');
  });

  test('save(): A cannot write into B’s snapshot, nor name B’s entity in its own', async () => {
    await refuses(save(A.scoped, bSnap.id, aBrand.id), 'NOT_FOUND');
    await refuses(save(A.scoped, aSnap.id, bBrand.id), 'ENTITY_NOT_IN_PROJECT');
    const forged = planFor(aBrand.id);
    forged.citations[0].supportsEntityIds = [bBrand.id];
    await refuses(
      A.scoped.extractions.save(aSnap.id, { plan: forged, prepass: null, version: 'x1.opus55' }),
      'ENTITY_NOT_IN_PROJECT',
    );
    assert.equal((await B.scoped.extractions.readingOf(bSnap.id)).mentions.length, 0);
  });

  test('save(): the same discovered brand in two organizations is two entities; readingOf() shows only one’s own', async () => {
    await save(A.scoped, aSnap.id, aBrand.id);
    await save(B.scoped, bSnap.id, bBrand.id);
    const a = await A.scoped.extractions.readingOf(aSnap.id);
    const b = await B.scoped.extractions.readingOf(bSnap.id);
    assert.equal(a.mentions.length, 2);
    assert.notEqual(String(a.mentions[1].entity_id), String(b.mentions[1].entity_id));
    assert.equal(await A.scoped.extractions.readingOf(bSnap.id), null);
    assert.deepEqual(a.citations[0].supports_entity_ids, [
      String(aBrand.id),
      String(a.mentions[1].entity_id),
    ]);
    assert.ok(
      a.mentions.every((m) => m.org_id === A.org.id) &&
        a.claims.every((c) => c.org_id === A.org.id),
    );
  });

  test('fail() and requeue(): A cannot move B’s snapshot', async () => {
    assert.equal(await B.scoped.extractions.requeue(bSnap.id), true);
    assert.equal(await A.scoped.extractions.fail(bSnap.id, 'from A'), false);
    assert.equal(await A.scoped.extractions.requeue(bSnap.id), false);
    const b = await B.scoped.extractions.readingOf(bSnap.id);
    assert.equal(b.snapshot.extraction_status, 'pending');
    assert.equal(
      b.mentions.length,
      2,
      'requeueing keeps the old reading until a new one replaces it',
    );
  });
});

describe('system lookups (the reviewed cross-organization set)', () => {
  test('dueProjects(): IDs only, active projects only, none of their content', async () => {
    const slotHour = 150;
    const active = await fx.project(A.org.id, 'Private name A', { status: 'active', slotHour });
    await fx.project(B.org.id, 'Private name B', { status: 'active', slotHour });
    await fx.project(A.org.id, 'Still onboarding', { status: 'onboarding', slotHour });
    await fx.project(A.org.id, 'Archived', { status: 'archived', slotHour });

    const due = await db.system.scheduling.dueProjects({ hour: slotHour });
    const mine = due.filter((d) => d.orgId === A.org.id || d.orgId === B.org.id);
    assert.equal(mine.length, 2, 'one active project per organization, and nothing else');
    assert.ok(mine.some((d) => d.projectId === active.id));
    for (const d of due) {
      assert.deepEqual(Object.keys(d).sort(), ['orgId', 'projectId', 'projectPublicId']);
    }
    const text = JSON.stringify(due, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    assert.ok(!text.includes('Private name'));
  });

  test('spentByOrgSince() and pausedOrgIds(): numbers and IDs, nothing else', async () => {
    const spent = await db.system.spendMonitor.spentByOrgSince(new Date(Date.now() - 3_600_000));
    assert.ok(spent.length > 0);
    for (const s of spent) assert.deepEqual(Object.keys(s).sort(), ['orgId', 'spentMicros']);
    const paused = await db.system.spendMonitor.pausedOrgIds();
    assert.ok(paused.every((id) => typeof id === 'bigint'));
  });
});

describe('coverage: no repository function without a leak test', () => {
  // Update this list in the same commit that adds a function to org-scoped.js or org-usage.js.
  const COVERED = {
    memberships: ['add', 'changeRole', 'get', 'getByUser', 'list', 'remove', 'setProjectAccess'],
    invitations: ['cancel', 'create', 'get', 'listPending', 'reissue'],
    activity: ['append', 'recent'],
    usage: ['recent', 'record', 'spentSinceMicros'],
    spend: ['pause', 'resume', 'state'],
    notifications: ['createOnce', 'forUser'],
    scans: ['checks', 'create', 'fail', 'finish', 'get', 'knownPages', 'pages', 'recent', 'start'],
    snapshots: ['complete', 'create', 'fail', 'forRun', 'get', 'submitted'],
    extractions: [
      'addBatch',
      'batchProcessed',
      'batchesOf',
      'entitiesFor',
      'fail',
      'pendingForRun',
      'readingOf',
      'requeue',
      'run',
      'save',
      'snapshot',
    ],
  };

  // The cross-organization lookups the worker makes (src/db/repos/system.js). Adding one is a reviewed decision:
  // list it here, and have its test above say what it returns.
  const SYSTEM = {
    scheduling: ['dueProjects'],
    spendMonitor: ['pausedOrgIds', 'spentByOrgSince'],
    providerHealth: ['knownProviders', 'recent', 'upsertBucket'],
  };

  test('every cross-organization system lookup is listed above', () => {
    assert.deepEqual(Object.keys(db.system).sort(), Object.keys(SYSTEM).sort());
    for (const [repo, functions] of Object.entries(SYSTEM)) {
      assert.deepEqual(
        Object.keys(db.system[repo]).sort(),
        functions,
        `${repo}: review, then list`,
      );
    }
  });

  test('every function exposed by forOrg() is listed above', () => {
    const scoped = db.forOrg(A.org.id);
    for (const [repo, functions] of Object.entries(COVERED)) {
      assert.deepEqual(
        Object.keys(scoped[repo]).sort(),
        functions,
        `${repo}: add a leak test, then list it`,
      );
    }
    assert.deepEqual(Object.keys(scoped).sort(), [
      'activity',
      'extractions',
      'invitations',
      'memberships',
      'notifications',
      'orgId',
      'scans',
      'snapshots',
      'spend',
      'usage',
    ]);
  });

  test('forOrg() is the only way into tenant data: no function takes an org ID as an argument', () => {
    // A function whose source mentions a caller-supplied orgId/org_id would be able to leave its tenant.
    const scoped = db.forOrg(A.org.id);
    for (const [repo, fns] of Object.entries(COVERED)) {
      for (const name of fns) {
        const source = scoped[repo][name].toString();
        assert.doesNotMatch(
          source,
          /\b(args?|options?|params?)\.(org_?id|orgId)\b/i,
          `${repo}.${name}`,
        );
      }
    }
  });
});
