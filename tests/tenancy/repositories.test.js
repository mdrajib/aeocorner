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

describe('free-audit lookups (global by design: an audit belongs to a lead, not an organization)', () => {
  test('an audit’s scan is invisible to every organization, and an organization’s scan to the audit door', async () => {
    const audit = await fx.audit();
    const auditScan = await db.audits.scans.start({ auditId: audit.id, rubricVersion: 'r-test' });
    const project = await fx.project(A.org.id, 'Audit-door project');
    const orgScan = await db.forOrg(A.org.id).scans.create({
      projectId: project.id,
      rubricVersion: 'r-test',
    });

    assert.equal(await db.forOrg(A.org.id).scans.get(auditScan.id), null);
    assert.equal(await db.forOrg(B.org.id).scans.get(auditScan.id), null);
    assert.equal(
      await db
        .forOrg(A.org.id)
        .scans.get(orgScan.id)
        .then((s) => s?.id),
      orgScan.id,
    );
    assert.equal(
      await db.audits.scans.forAudit(audit.id).then((s) => s.id),
      auditScan.id,
      'the audit sees only its own scan',
    );
    assert.equal(await db.audits.scans.checks(orgScan.id).then((c) => c.length), 0);
  });

  test('an audit’s ledger rows are not an organization’s spend, and an organization’s are not the audits’', async () => {
    const audit = await fx.audit();
    const since = new Date(Date.now() - 3_600_000);
    const entry = (key, costUsd) => ({
      meter: 'answer_collect',
      providerCode: 'dataforseo',
      unit: 'request',
      costUsd,
      idempotencyKey: key,
    });
    const orgBefore = await db.forOrg(A.org.id).usage.spentSinceMicros(since);
    const auditsBefore = await db.audits.ledger.spentSinceMicros(since);

    await db.audits.ledger.record(audit.id, entry(`tenancy-audit-${audit.id}`, '0.004'));
    assert.equal(await db.forOrg(A.org.id).usage.spentSinceMicros(since), orgBefore);
    const rowsOf = (org) =>
      db
        .forOrg(org.id)
        .usage.recent({ limit: 500 })
        .then((rows) => rows.filter((r) => r.audit_id !== null));
    assert.deepEqual(await rowsOf(A.org), [], 'no organization sees an audit’s ledger row');
    assert.deepEqual(await rowsOf(B.org), []);

    await db.forOrg(A.org.id).usage.record(entry(`tenancy-org-${A.org.id}-${audit.id}`, '0.5'));
    assert.equal(
      await db.audits.ledger.spentSinceMicros(since),
      auditsBefore + 4_000,
      'only the audit’s own cost is in the audit budget',
    );
  });

  test('the audit repositories are a reviewed list; add a function, add its test, list it', () => {
    assert.deepEqual(Object.keys(db.audits).sort(), [
      'answers',
      'completeFromCache',
      'create',
      'fail',
      'findReusable',
      'finish',
      'get',
      'getByPublicId',
      'ledger',
      'markReportEmailed',
      'saveAnswer',
      'saveSetup',
      'scans',
      'start',
      'verify',
    ]);
    assert.deepEqual(Object.keys(db.audits.scans).sort(), [
      'checks',
      'finish',
      'forAudit',
      'start',
    ]);
    assert.deepEqual(Object.keys(db.audits.ledger).sort(), [
      'costMicros',
      'record',
      'spentSinceMicros',
    ]);
    assert.deepEqual(Object.keys(db.leads).sort(), ['capture', 'get', 'markVerified']);
    assert.deepEqual(Object.keys(db.abuse).sort(), ['active', 'block', 'unblock']);
  });
});

describe('projects, engines, competitors and aliases (Milestone 3)', () => {
  let bBrandEntity;
  let bCompetitor;
  let bAlias;
  let bAudit;

  before(async () => {
    await A.scoped.projects.create({
      name: 'Twin Dental',
      domain: `twin-a-${Date.now().toString(36)}.example.test`,
      country: 'US',
      language: 'en',
    });
    bBrandEntity = (await B.scoped.entities.list(bProject.id))[0];
    bCompetitor = await fx.entity(bProject, { kind: 'competitor', name: 'Twin Rival' });
    bAlias = await B.scoped.entities.addAlias(bCompetitor.id, { kind: 'name', value: 'Twin R' });
    bAudit = await fx.audit();
    await fx.adoptAudit(bAudit.public_id);
    await fx.claimAudit(bAudit.id, B.org.id);
  });

  test('projects: A cannot read, list, edit or archive B’s project', async () => {
    assert.equal(await A.scoped.projects.get(bProject.id), null);
    assert.equal(await A.scoped.projects.getByPublicId(bProject.public_id), null);
    assert.ok(!ids(await A.scoped.projects.list()).includes(String(bProject.id)));
    assert.ok(!ids(await A.scoped.projects.list({ onlyIds: [bProject.id] })).length);
    await refuses(A.scoped.projects.update(bProject.id, { city: 'Leak' }), 'NOT_FOUND');
    await refuses(A.scoped.projects.archive(bProject.id), 'NOT_FOUND');
    assert.equal((await fx.projectRow(bProject.id)).deleted_at, null);
    assert.equal((await fx.projectRow(bProject.id)).city, '');
  });

  test('projects.create(): A cannot seed a project from an audit B already owns', async () => {
    await refuses(
      A.scoped.projects.create({
        name: 'Stolen',
        domain: `stolen-${Date.now().toString(36)}.example.test`,
        country: 'US',
        language: 'en',
        sourceAuditPublicId: bAudit.public_id,
      }),
      'NOT_FOUND',
    );
  });

  test('projectEngines: A cannot read or change the engines of B’s project', async () => {
    await refuses(A.scoped.projectEngines.list(bProject.id), 'NOT_FOUND');
    await refuses(A.scoped.projectEngines.setEnabled(bProject.id, ['chatgpt']), 'NOT_FOUND');
    assert.ok(Array.isArray(await B.scoped.projectEngines.list(bProject.id)));
  });

  test('entities: A cannot list, add to, change or alias B’s brand and competitors', async () => {
    await refuses(A.scoped.entities.list(bProject.id), 'NOT_FOUND');
    await refuses(
      A.scoped.entities.addCompetitor(bProject.id, { name: 'Planted Rival' }),
      'NOT_FOUND',
    );
    await refuses(A.scoped.entities.update(bCompetitor.id, { name: 'Hijacked' }), 'NOT_FOUND');
    await refuses(A.scoped.entities.update(bBrandEntity.id, { name: 'Hijacked' }), 'NOT_FOUND');
    await refuses(A.scoped.entities.setStatus(bCompetitor.id, 'ignored'), 'NOT_FOUND');
    await refuses(
      A.scoped.entities.addAlias(bCompetitor.id, { kind: 'exclude', value: 'Planted rule' }),
      'NOT_FOUND',
    );
    await refuses(A.scoped.entities.removeAlias(bAlias.id), 'NOT_FOUND');

    const mine = await B.scoped.entities.list(bProject.id);
    assert.ok(mine.some((e) => e.name === 'Twin Rival' && e.status === 'active'));
    assert.ok(mine.some((e) => e.id === bCompetitor.id && e.aliases.length === 1));
    assert.ok(!mine.some((e) => /Hijacked|Planted/.test(e.name)));
  });
  test('brandKits: A cannot read, list or write B’s Brand Kit, and B’s versions stay as they were', async () => {
    const kit = { identity: { brandName: 'Twin Dental', domains: [] } };
    await B.scoped.brandKits.save(bProject.id, { kit, source: 'extracted', expectedVersion: null });
    await refuses(A.scoped.brandKits.current(bProject.id), 'NOT_FOUND');
    await refuses(A.scoped.brandKits.get(bProject.id, 1), 'NOT_FOUND');
    await refuses(A.scoped.brandKits.history(bProject.id), 'NOT_FOUND');
    await refuses(
      A.scoped.brandKits.save(bProject.id, {
        kit: { identity: { brandName: 'Hijacked', domains: [] } },
        source: 'edited',
        expectedVersion: 1,
      }),
      'NOT_FOUND',
    );
    const mine = await B.scoped.brandKits.history(bProject.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].data.identity.brandName, 'Twin Dental');
    assert.equal((await fx.projectRow(bProject.id)).brand_profile_version, 1);
  });
  test('prompts: A cannot list, add to, change, switch or import into B’s questions', async () => {
    const { prompt: bPrompt } = await B.scoped.prompts.add(bProject.id, {
      text: 'Which twin dentist is the best one?',
      intent: 'discovery',
    });
    await refuses(A.scoped.prompts.list(bProject.id), 'NOT_FOUND');
    await refuses(A.scoped.prompts.clusters(bProject.id), 'NOT_FOUND');
    await refuses(
      A.scoped.prompts.add(bProject.id, {
        text: 'Planted question about twins',
        intent: 'discovery',
      }),
      'NOT_FOUND',
    );
    await refuses(
      A.scoped.prompts.edit(bPrompt.id, { text: 'Hijacked wording for the twin' }),
      'NOT_FOUND',
    );
    await refuses(A.scoped.prompts.edit(bPrompt.id, { priority: 3 }), 'NOT_FOUND');
    await refuses(A.scoped.prompts.setStatus(bPrompt.id, 'archived'), 'NOT_FOUND');
    await refuses(
      A.scoped.prompts.importMany(bProject.id, [
        { text: 'Planted import about twins', intent: 'discovery' },
      ]),
      'NOT_FOUND',
    );

    const mine = await B.scoped.prompts.list(bProject.id);
    const kept = mine.find((p) => p.id === bPrompt.id);
    assert.deepEqual(
      [kept.text, kept.status, kept.priority],
      ['Which twin dentist is the best one?', 'active', 2],
    );
    assert.ok(!mine.some((p) => /Planted|Hijacked/.test(p.text)));
  });
  test('verification: A cannot read B’s token or mark B’s site verified', async () => {
    await refuses(A.scoped.projects.verification(bProject.id), 'NOT_FOUND');
    await refuses(A.scoped.projects.markVerified(bProject.id, 'dns'), 'NOT_FOUND');
    const row = await fx.projectRow(bProject.id);
    assert.equal(row.domain_verified_at, null);
  });
});

describe('tracking runs, rollups, changes and quota', () => {
  // cell_results, cell_entity_results and metric_daily are fact tables with no foreign keys, so these functions are
  // the only thing between one organization and another's runs.
  let aProject;
  let bRun;

  before(async () => {
    aProject = await fx.project(A.org.id, 'Tracked A');
    ({ run: bRun } = await B.scoped.runs.start({
      projectId: bProject.id,
      slotKey: '2026-W40',
      trigger: 'manual',
    }));
  });

  test('start(): A cannot make a run on B’s project, and the slot is per project', async () => {
    const bRunsBefore = (await B.scoped.runs.recent(bProject.id)).length;
    await refuses(
      A.scoped.runs.start({ projectId: bProject.id, slotKey: '2026-W41', trigger: 'manual' }),
      'PROJECT_NOT_IN_ORG',
    );
    assert.equal((await B.scoped.runs.recent(bProject.id)).length, bRunsBefore);
    const own = await A.scoped.runs.start({
      projectId: aProject.id,
      slotKey: '2026-W40',
      trigger: 'manual',
    });
    assert.equal(own.created, true, 'the same slot on another project is its own run');
    assert.equal(own.run.org_id, A.org.id);
  });

  test('get(), recent(), plan(), progress() and cells(): B’s run is invisible from A', async () => {
    assert.equal(await A.scoped.runs.get(bRun.id), null);
    assert.deepEqual(await A.scoped.runs.recent(bProject.id), []);
    const plan = await A.scoped.runs.plan(bRun.id);
    assert.deepEqual([plan.run, plan.prompts, plan.engines], [null, [], []]);
    assert.equal(await A.scoped.runs.progress(bRun.id), null);
    assert.deepEqual(await A.scoped.runs.cells(bRun.id), []);
  });

  test('begin(), advance(), finish(), settle(), expirePending() and expireUnread(): A cannot move B’s run', async () => {
    assert.equal(await A.scoped.runs.begin(bRun.id, { promptsCount: 1, tasksPlanned: 1 }), false);
    assert.equal(await A.scoped.runs.advance(bRun.id, 'extracting'), false);
    await refuses(A.scoped.runs.finish(bRun.id, 'failed'), 'RUN_NOT_IN_ORG');
    await refuses(A.scoped.runs.settle(bRun.id), 'RUN_NOT_IN_ORG');
    await refuses(A.scoped.runs.expirePending(bRun.id), 'RUN_NOT_IN_ORG');
    await refuses(A.scoped.runs.expireUnread(bRun.id), 'RUN_NOT_IN_ORG');
    const row = await B.scoped.runs.get(bRun.id);
    assert.deepEqual(
      [row.status, row.started_at, row.finished_at, row.tasks_planned],
      ['queued', null, null, 0],
    );
  });

  test('noteFirstRun(): A cannot stamp B’s project', async () => {
    assert.equal(await A.scoped.runs.noteFirstRun(bProject.id), false);
    assert.equal((await fx.projectRow(bProject.id)).first_run_at, null);
  });

  test('rollupDay() and range(): A cannot roll up or read B’s metrics', async () => {
    await fx.seedMetrics(bProject, [
      {
        date: '2026-10-01',
        engine: 'perplexity',
        entityKind: 'brand',
        nAnswers: 30,
        kMentioned: 9,
      },
    ]);
    await refuses(
      A.scoped.metrics.rollupDay(bProject.id, new Date('2026-10-01')),
      'PROJECT_NOT_IN_ORG',
    );
    assert.deepEqual(
      await A.scoped.metrics.range(bProject.id, { from: '2026-09-01', to: '2026-10-31' }),
      [],
    );
    const mine = await B.scoped.metrics.range(bProject.id, {
      from: '2026-09-01',
      to: '2026-10-31',
    });
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kMentioned, 9, 'B’s row is as it was');
  });

  test('detect() and forProject(): A cannot read B’s history or write events on it', async () => {
    await refuses(
      A.scoped.changes.detect(bProject.id, { asOf: '2026-10-26' }),
      'PROJECT_NOT_IN_ORG',
    );
    assert.deepEqual(await A.scoped.changes.forProject(bProject.id), []);
  });

  test('startTracking(): A cannot switch B’s project on', async () => {
    await refuses(A.scoped.projects.startTracking(bProject.id), 'NOT_FOUND', 'PROJECT_NOT_IN_ORG');
    assert.equal((await fx.projectRow(bProject.id)).status, 'onboarding');
  });

  test('takeRunNow(), returnRunNow() and runNowUsage(): each organization has its own allowance', async () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const before = await B.scoped.quota.runNowUsage({ now });
    const taken = await A.scoped.quota.takeRunNow({ now });
    assert.equal(taken.allowed, true);
    assert.deepEqual(await B.scoped.quota.runNowUsage({ now }), before);
    await A.scoped.quota.returnRunNow({ now });
    assert.equal((await A.scoped.quota.runNowUsage({ now })).used, 0);
    assert.deepEqual(await B.scoped.quota.runNowUsage({ now }), before);
  });
});

describe('dashboard reads and customer feedback', () => {
  // The fact tables under these reads have no foreign keys, so the functions are the only boundary.
  let bBrand;
  let bPrompt;
  let bSnapshot;
  let aProject;
  let bDash;

  before(async () => {
    aProject = await fx.project(A.org.id, 'Dashboard A');
    bDash = await fx.project(B.org.id, 'Dashboard B');
    bBrand = await fx.entity(bDash, { kind: 'brand', name: 'Dashboard B Brand' });
    bPrompt = await fx.prompt(bDash, { text: 'Dashboard question of B?' });
    const run = await fx.run(bDash, { status: 'rolling_up', trigger: 'schedule' });
    bSnapshot = await fx.readAnswer(run, bPrompt, {
      excerpt: 'B’s answer text',
      mentions: [{ entity: bBrand, listRank: 1 }],
      citations: [{ url: 'https://dash-leak.example.test/page' }],
    });
    await B.scoped.runs.settle(run.id);
  });

  after(async () => {
    await fx.forgetDomains(['dash-leak.example.test']);
  });

  const range = { from: '2020-01-01', to: '2099-12-31' };

  test('matrix(), question(), answers(), competitorCells() and citations(): B’s project is not found from A', async () => {
    await refuses(A.scoped.dashboard.matrix(bDash.id, range), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.dashboard.question(bDash.id, bPrompt.id, range), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.dashboard.answers(bDash.id, bPrompt.id), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.dashboard.competitorCells(bDash.id, range), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.dashboard.citations(bDash.id, range), 'PROJECT_NOT_IN_ORG');
    // …and B's own view of the same data is intact.
    assert.equal((await B.scoped.dashboard.matrix(bDash.id, range)).cells.length, 1);
    assert.equal((await B.scoped.dashboard.citations(bDash.id, range)).total, 1);
  });

  test('question() and answers(): B’s question asked through A’s own project finds nothing', async () => {
    assert.equal(await A.scoped.dashboard.question(aProject.id, bPrompt.id, range), null);
    assert.equal(await A.scoped.dashboard.answers(aProject.id, bPrompt.id), null);
    assert.deepEqual((await A.scoped.dashboard.matrix(aProject.id, range)).cells, []);
    assert.equal((await A.scoped.dashboard.citations(aProject.id, range)).total, 0);
  });

  test('reportAnswer() and reportsFor(): A cannot report B’s answers, or through B’s project', async () => {
    const before = (await B.scoped.dashboard.reportsFor(bDash.id, [bSnapshot.id])).length;
    await refuses(
      A.scoped.dashboard.reportAnswer(bDash.id, {
        snapshotId: bSnapshot.id,
        kind: 'misread',
        userId: A.owner.id,
      }),
      'PROJECT_NOT_IN_ORG',
    );
    await refuses(
      A.scoped.dashboard.reportAnswer(aProject.id, {
        snapshotId: bSnapshot.id,
        kind: 'misread',
        userId: A.owner.id,
      }),
      'SNAPSHOT_NOT_IN_PROJECT',
    );
    await refuses(A.scoped.dashboard.reportsFor(bDash.id, [bSnapshot.id]), 'PROJECT_NOT_IN_ORG');
    assert.deepEqual(await A.scoped.dashboard.reportsFor(aProject.id, [bSnapshot.id]), []);
    assert.equal((await B.scoped.dashboard.reportsFor(bDash.id, [bSnapshot.id])).length, before);
  });
});

describe('action center: recommendations, re-checks and outcomes', () => {
  // A recommendation raised for B's project. Everything below calls the Action Center as A.
  let aProject;
  let bAction;
  let bRec;
  let bPrompt;

  const item = (prompt) => ({
    ruleCode: 'readiness.A1',
    ruleVersion: 1,
    subject: 'A1',
    stableKey: 'readiness.A1:a1',
    category: 'crawler_access',
    fixPath: 'auto_fix',
    effort: 1,
    title: 'Let AI search crawlers read your site',
    why: 'Because of the scan.',
    steps: '1. Allow the crawlers.',
    narrativeVersion: 't1',
    evidence: { type: 'readiness', check: { code: 'A1', status: 'fail', points: 0, possible: 8 } },
    affectedUrls: [],
    impact: 100,
    confidence: 0.7,
    ice: 70,
    promptIds: [String(prompt.id)],
  });
  const reconcile = (scoped, project, prompt) =>
    scoped.recommendations.reconcile(project.id, {
      items: [item(prompt)],
      detectedKeys: ['readiness.A1:a1'],
      evaluated: { readiness: true, visibility: false },
      now: new Date(),
    });
  const window = { from: new Date('2020-01-01'), to: new Date('2099-12-31') };

  before(async () => {
    aProject = await fx.project(A.org.id, 'Actions A');
    bAction = await fx.project(B.org.id, 'Actions B');
    await fx.engines(bAction, ['perplexity']);
    await fx.entity(bAction, { kind: 'brand', name: 'Actions B Brand' });
    bPrompt = await fx.prompt(bAction, { text: 'Action question of B?' });
    await fx.scan(bAction, { checks: [{ code: 'A1', status: 'fail', points: 0, possible: 8 }] });
    await reconcile(B.scoped, bAction, bPrompt);
    [bRec] = await B.scoped.recommendations.list(bAction.id, { view: 'todo' });
  });

  test('every project-level read and write: B’s project is not found from A', async () => {
    const r = A.scoped.recommendations;
    const asA = [
      () => r.signals(bAction.id, window),
      () => r.reconcile(bAction.id, { items: [item(bPrompt)], evaluated: {}, now: new Date() }),
      () => r.list(bAction.id, { view: 'todo' }),
      () => r.counts(bAction.id),
      () => r.get(bAction.id, bRec.id),
      () => r.top(bAction.id),
      () => r.provenWins(bAction.id),
      () => r.verificationsOf(bAction.id, bRec.id),
      () =>
        r.saveNarrative(bAction.id, bRec.id, { why: 'x'.repeat(50), steps: '1. y', version: 'n1' }),
      () => r.transition(bAction.id, bRec.id, 'in_progress', { userId: A.owner.id }),
      () => r.markDone(bAction.id, bRec.id, { userId: A.owner.id }),
      () => r.attachScan(bAction.id, bRec.id, { attempt: 1, scanId: 1n }),
      () => r.recordVerification(bAction.id, bRec.id, { attempt: 1, status: 'passed' }),
      () => r.settleVerification(bAction.id, bRec.id, { verdict: 'verified', reason: 'passed' }),
      () => A.scoped.outcomes.measure(bAction.id, bRec.id, {}),
      () => A.scoped.outcomes.recent(bAction.id),
    ];
    for (const attempt of asA) await refuses(attempt(), 'PROJECT_NOT_IN_ORG');
  });

  test('B’s recommendation ID, asked for through A’s own project, finds nothing and changes nothing', async () => {
    const r = A.scoped.recommendations;
    assert.equal(await r.get(aProject.id, bRec.id), null);
    assert.equal(await r.load(bRec.id), null);
    assert.deepEqual(await r.verificationsOf(aProject.id, bRec.id), []);
    assert.equal(
      await r.saveNarrative(aProject.id, bRec.id, {
        why: 'x'.repeat(50),
        steps: '1. y',
        version: 'n1',
      }),
      false,
    );
    assert.equal(await r.attachScan(aProject.id, bRec.id, { attempt: 1, scanId: 1n }), false);
    assert.equal(
      await r.recordVerification(aProject.id, bRec.id, { attempt: 1, status: 'passed' }),
      false,
    );
    assert.deepEqual(
      await r.settleVerification(aProject.id, bRec.id, { verdict: 'verified', reason: 'passed' }),
      { changed: false, status: null },
    );
    assert.deepEqual(await A.scoped.outcomes.measure(aProject.id, bRec.id, {}), {
      skipped: 'not_measuring',
    });
    await refuses(
      r.transition(aProject.id, bRec.id, 'in_progress', { userId: A.owner.id }),
      'RECOMMENDATION_NOT_FOUND',
    );
    await refuses(
      r.markDone(aProject.id, bRec.id, { userId: A.owner.id }),
      'RECOMMENDATION_NOT_FOUND',
    );
  });

  test('the same issue raised in two organizations is two rows, each seen only by its own', async () => {
    const aPrompt = await fx.prompt(aProject, { text: 'Action question of A?' });
    const raised = await reconcile(A.scoped, aProject, aPrompt);
    assert.equal(raised.created.length, 1);
    const aList = await A.scoped.recommendations.list(aProject.id, { view: 'todo' });
    assert.equal(aList.length, 1);
    assert.notEqual(aList[0].id, bRec.id);
    assert.equal((await B.scoped.recommendations.list(bAction.id, { view: 'todo' })).length, 1);
    assert.deepEqual(await A.scoped.recommendations.counts(aProject.id), {
      todo: 1,
      progress: 0,
      results: 0,
      dismissed: 0,
    });
  });

  test('B’s recommendation is exactly as it was', async () => {
    const detail = await B.scoped.recommendations.get(bAction.id, bRec.id);
    assert.equal(detail.recommendation.status, 'open');
    assert.equal(detail.recommendation.whyMd, 'Because of the scan.');
    assert.equal(detail.events.length, 1);
    assert.deepEqual(detail.verifications, []);
  });
});

describe('content studio and integrations', () => {
  // An item at every step in B's project, and a WordPress connection. Everything below is called as A.
  let aProject;
  let bProject;
  let bItem;
  let bReady;
  const HTML = '<h2>How much?</h2><p>Between $900 and $1,500.</p>';
  const secret = {
    ciphertext: Buffer.alloc(40, 1),
    wrappedDek: Buffer.alloc(60, 2),
    keyVersion: 1,
  };
  const qc = { version: 1, score: 90, ready: true, blocking: [], checks: [], words: 400 };

  before(async () => {
    aProject = await fx.project(A.org.id, 'Content A');
    bProject = await fx.project(B.org.id, 'Content B');
    bItem = await B.scoped.content.create(bProject.id, { title: 'B item' });
    bReady = await B.scoped.content.create(bProject.id, { title: 'B ready' });
    const c = B.scoped.content;
    await c.saveResearch(bProject.id, bReady.id, { research: { facts: [] } });
    await c.saveBrief(bProject.id, bReady.id, {
      brief: {
        format: 'faq',
        title: 'B ready page title',
        metaDescription: 'x'.repeat(30),
        audience: 'a',
        outline: [],
        entities: [],
        internalLinks: [],
        schemaType: 'Article',
      },
    });
    const draft = await c.saveDraft(bProject.id, bReady.id, { html: HTML });
    await c.saveQc(bProject.id, bReady.id, {
      revisionId: draft.revisionId,
      qc,
      jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: 'x' },
    });
    await B.scoped.integrations.saveWordpress(bProject.id, {
      config: { siteUrl: 'https://b.example.test', username: 'b' },
      secret,
    });
  });

  test('every project-level call: B’s project is not found from A', async () => {
    const c = A.scoped.content;
    const i = A.scoped.integrations;
    const asA = [
      () => c.create(bProject.id, { title: 'x' }),
      () => c.list(bProject.id),
      () => c.get(bProject.id, bItem.publicId),
      () => c.revision(bProject.id, bItem.id, 1),
      () => c.forRecommendations(bProject.id, [1]),
      () => c.counts(bProject.id),
      () => c.saveResearch(bProject.id, bItem.id, { research: {} }),
      () => c.saveBrief(bProject.id, bItem.id, { brief: {} }),
      () => c.saveDraft(bProject.id, bItem.id, { html: HTML }),
      () => c.saveQc(bProject.id, bItem.id, { revisionId: 1n, qc, jsonld: null }),
      () => c.fail(bProject.id, bItem.id, { stage: 'drafting', reason: 'x' }),
      () => c.editBrief(bProject.id, bReady.id, { brief: { title: 'x', format: 'faq' } }),
      () => c.saveEdit(bProject.id, bReady.id, { html: '<p>x</p>' }),
      () => c.approve(bProject.id, bReady.id, { userId: A.owner.id, revisionId: 1n }),
      () => c.unapprove(bProject.id, bReady.id),
      () => c.redraft(bProject.id, bReady.id),
      () => c.retry(bProject.id, bItem.id),
      () => c.archive(bProject.id, bItem.id),
      () => c.beginPublish(bProject.id, bReady.id, { userId: A.owner.id, mode: 'publish' }),
      () => c.forPublish(bProject.id, bReady.id),
      () => c.markApplying(bProject.id, 1n),
      () => c.rememberPost(bProject.id, bReady.id, { cmsRef: '1' }),
      () =>
        c.finishPublish(bProject.id, bReady.id, {
          siteChangeId: 1n,
          outcome: 'published',
          cmsRef: '1',
          url: 'x',
        }),
      () => c.siteChanges(bProject.id, bReady.id),
      () => c.forPipeline(bProject.id, bItem.id),
      () => i.wordpress(bProject.id),
      () => i.saveWordpress(bProject.id, { config: {}, secret }),
      () => i.wordpressSecret(bProject.id),
      () => i.wordpressResult(bProject.id, { ok: false, error: 'x' }),
      () => i.disconnectWordpress(bProject.id),
    ];
    for (const call of asA) await refuses(call(), 'PROJECT_NOT_IN_ORG');
  });

  test('B’s item addressed through A’s own project is simply not there', async () => {
    const c = A.scoped.content;
    assert.equal(await c.get(aProject.id, bItem.publicId), null);
    assert.equal(await c.get(aProject.id, String(bItem.id)), null);
    assert.equal(await c.revision(aProject.id, bReady.id, 1), null);
    assert.equal(await c.forPipeline(aProject.id, bItem.id), null);
    assert.equal(await c.forPublish(aProject.id, bReady.id), null);
    assert.deepEqual(await c.siteChanges(aProject.id, bReady.id), []);
    for (const call of [
      () => c.saveResearch(aProject.id, bItem.id, { research: {} }),
      () => c.fail(aProject.id, bItem.id, { stage: 'drafting', reason: 'x' }),
      () => c.saveEdit(aProject.id, bReady.id, { html: '<p>x</p>' }),
      () => c.approve(aProject.id, bReady.id, { userId: A.owner.id, revisionId: 1n }),
      () => c.unapprove(aProject.id, bReady.id),
      () => c.redraft(aProject.id, bReady.id),
      () => c.archive(aProject.id, bItem.id),
      () => c.beginPublish(aProject.id, bReady.id, { userId: A.owner.id, mode: 'publish' }),
      () =>
        c.finishPublish(aProject.id, bReady.id, {
          siteChangeId: 1n,
          outcome: 'published',
          cmsRef: '1',
          url: 'x',
        }),
    ]) {
      await refuses(call(), 'CONTENT_NOT_FOUND');
    }
    assert.deepEqual(await c.forRecommendations(aProject.id, []), new Map());
    assert.deepEqual(await c.counts(aProject.id), {});
    assert.deepEqual(await c.list(aProject.id), []);
  });

  test('A cannot attach B’s recommendation or B’s question to its own item', async () => {
    const prompt = await fx.prompt(bProject, { text: 'B question for content?' });
    await refuses(
      A.scoped.content.create(aProject.id, { title: 'x', promptIds: [prompt.id] }),
      'PROMPT_NOT_IN_PROJECT',
    );
    await refuses(
      A.scoped.content.create(aProject.id, { title: 'x', recommendationId: 1 }),
      'RECOMMENDATION_NOT_FOUND',
    );
  });

  test('A’s connection to its own project does not touch B’s, and the secret never appears in a read', async () => {
    assert.equal(await A.scoped.integrations.wordpress(aProject.id), null);
    assert.equal(await A.scoped.integrations.wordpressSecret(aProject.id), null);
    const seen = await B.scoped.integrations.wordpress(bProject.id);
    assert.equal(seen.status, 'connected');
    assert.deepEqual(Object.keys(seen).sort(), [
      'config',
      'connectedAt',
      'disconnectedAt',
      'hasSecret',
      'id',
      'lastError',
      'lastErrorAt',
      'lastSuccessAt',
      'status',
      'type',
    ]);
  });

  test('after all of that B’s data is what it was', async () => {
    const got = await B.scoped.content.get(bProject.id, bReady.publicId);
    assert.equal(got.status, 'ready');
    assert.equal(got.revisions.length, 1);
    assert.equal((await B.scoped.content.get(bProject.id, bItem.publicId)).status, 'researching');
    assert.equal((await B.scoped.integrations.wordpress(bProject.id)).status, 'connected');
  });
});

describe('billing, alerts, notification choices and Google traffic (Milestone 8)', () => {
  let aProject;
  let bProject;
  const secret = {
    ciphertext: Buffer.alloc(40, 1),
    wrappedDek: Buffer.alloc(60, 2),
    keyVersion: 1,
  };
  const grant = (project, owner) => ({
    secret,
    scopes: [],
    properties: [{ id: '111', name: 'B property', account: 'B' }],
    sites: [],
    userId: owner.id,
    projectId: project.id,
  });

  before(async () => {
    aProject = await fx.project(A.org.id, 'Billing A');
    bProject = await fx.project(B.org.id, 'Billing B');
    await fx.setOrg(B.org.id, {
      plan_code: 'agency',
      billing_status: 'active',
      stripe_customer_id: `cus_b_${Date.now()}`,
    });
    await fx.grant(B.org.id, { meter: 'prompts', amount: 77, source: 'staff_grant' });
    await B.scoped.google.saveGrant(bProject.id, grant(bProject, B.owner));
    await B.scoped.google.choose(bProject.id, { ga4PropertyId: '111' });
    await B.scoped.traffic.saveGa4(bProject.id, [
      {
        metricDate: '2026-09-01',
        channel: 'chatgpt',
        landingPage: '/b',
        sessions: 5,
        engagedSessions: 3,
        keyEvents: 1,
        revenue: 0,
        currency: 'USD',
      },
    ]);
  });

  test('billing.summary / limitFor / usage / addons: A sees only A’s plan, grants and counts, never B’s', async () => {
    const a = await A.scoped.billing.summary();
    assert.equal(a.planCode, null);
    assert.equal(a.stripeCustomerId, null);
    assert.deepEqual(a.grants, []);
    assert.equal(a.limits.prompts, null);
    assert.equal(await A.scoped.billing.limitFor('prompts'), null);
    const b = await B.scoped.billing.summary();
    assert.equal(b.planCode, 'agency');
    assert.equal(b.limits.prompts, 500 + 77);
    assert.equal(
      (await A.scoped.billing.usage()).projects,
      (await A.scoped.projects.list()).filter((p) => p.status !== 'archived').length,
      'A’s own projects only, not B’s',
    );
    assert.deepEqual(await A.scoped.billing.addons(), []);
    assert.equal(await A.scoped.billing.hasMeteredDrafts(), false);
    assert.equal(
      (await A.scoped.billing.access()).level,
      'setup',
      'A has no plan; B being active does not help it',
    );
    assert.equal((await B.scoped.billing.access()).level, 'full');
  });

  test('billing.canAdd / promptRoom / feature / featureAllowed: decided from A’s own data, whichever project ID is named', async () => {
    assert.equal((await A.scoped.billing.canAdd('projects')).limit, null);
    assert.equal(
      await A.scoped.billing.promptRoom(bProject.id),
      null,
      'A has no plan, so no limit: nothing of B’s is read',
    );
    assert.equal(await A.scoped.billing.feature('client_seats'), false);
    assert.equal(
      await A.scoped.billing.featureAllowed('client_seats'),
      true,
      'no plan yet is not held back',
    );
    assert.equal(await B.scoped.billing.featureAllowed('client_seats'), true);
  });

  test('billing.attachCustomer: sets only A’s customer, and B’s is untouched', async () => {
    const before = (await B.scoped.billing.summary()).stripeCustomerId;
    await A.scoped.billing.attachCustomer(`cus_a_${Date.now()}`);
    assert.equal((await B.scoped.billing.summary()).stripeCustomerId, before);
    assert.match((await A.scoped.billing.summary()).stripeCustomerId, /^cus_a_/);
  });

  test('billing.note: writes into A’s own activity log only', async () => {
    const before = (await B.scoped.activity.recent()).length;
    await A.scoped.billing.note({ action: 'billing.test', summary: 'a note' });
    assert.equal((await B.scoped.activity.recent()).length, before);
    assert.ok((await A.scoped.activity.recent()).some((e) => e.action === 'billing.test'));
  });

  test('alerts.pending / markAlerted / recipients / digestFacts: B’s project is refused', async () => {
    await refuses(A.scoped.alerts.pending(bProject.id), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.alerts.markAlerted(bProject.id, [1n]), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.alerts.recipients(bProject.id, 'digest'), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.alerts.digestFacts(bProject.id), 'PROJECT_NOT_IN_ORG');
  });

  test('alerts.markAlerted: cannot mark B’s change event told, even through A’s own project', async () => {
    const event = await fx.changeEvent(bProject, { key: 'tenancy-b' });
    assert.equal(await A.scoped.alerts.markAlerted(aProject.id, [event.id]), 0);
    assert.equal((await B.scoped.alerts.pending(bProject.id)).events.length, 1);
    assert.equal(await B.scoped.alerts.markAlerted(bProject.id, [event.id]), 1);
  });

  test('alerts.recipients: A’s list never includes B’s members', async () => {
    const mine = await A.scoped.alerts.recipients(aProject.id, 'digest');
    assert.ok(!mine.some((r) => r.userId === B.owner.id));
    assert.ok(mine.some((r) => r.userId === A.owner.id));
  });

  test('notifyPrefs.get / set: B’s member has no settings in A, and A cannot change B’s', async () => {
    assert.equal(await A.scoped.notifyPrefs.get(B.owner.id), null);
    await refuses(
      A.scoped.notifyPrefs.set(B.owner.id, { digest: false, alerts: false }),
      'NOT_FOUND',
    );
    assert.deepEqual(await B.scoped.notifyPrefs.get(B.owner.id), { digest: true, alerts: true });
    assert.deepEqual(await A.scoped.notifyPrefs.set(A.owner.id, { digest: false, alerts: true }), {
      digest: false,
      alerts: true,
    });
  });

  test('google.status / saveGrant / choose / secret / syncResult / disconnect: B’s project is refused, and B’s connection is unchanged', async () => {
    await refuses(A.scoped.google.status(bProject.id), 'PROJECT_NOT_IN_ORG');
    await refuses(
      A.scoped.google.saveGrant(bProject.id, grant(bProject, A.owner)),
      'PROJECT_NOT_IN_ORG',
    );
    await refuses(
      A.scoped.google.choose(bProject.id, { ga4PropertyId: '111' }),
      'PROJECT_NOT_IN_ORG',
    );
    await refuses(A.scoped.google.secret(bProject.id), 'PROJECT_NOT_IN_ORG');
    await refuses(
      A.scoped.google.syncResult(bProject.id, { ok: false, error: 'x' }),
      'PROJECT_NOT_IN_ORG',
    );
    await refuses(A.scoped.google.disconnect(bProject.id), 'PROJECT_NOT_IN_ORG');
    const b = await B.scoped.google.status(bProject.id);
    assert.equal(b.status, 'connected');
    assert.equal(b.hasSecret, true);
    assert.equal(await A.scoped.google.status(aProject.id), null);
  });

  test('traffic.range / searchRange / saveGa4 / saveSearch: B’s project is refused, and B’s numbers are not readable from A', async () => {
    const wide = { from: '2020-01-01', to: '2030-01-01' };
    await refuses(A.scoped.traffic.range(bProject.id, wide), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.traffic.searchRange(bProject.id, wide), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.traffic.saveGa4(bProject.id, []), 'PROJECT_NOT_IN_ORG');
    await refuses(A.scoped.traffic.saveSearch(bProject.id, []), 'PROJECT_NOT_IN_ORG');
    assert.deepEqual(await A.scoped.traffic.range(aProject.id, wide), []);
    assert.equal((await B.scoped.traffic.range(bProject.id, wide)).length, 1);
  });
});

describe('what the worker and the staff console may look up across organizations (Milestone 8)', () => {
  test('billing: the organization a Stripe subscription belongs to is found by its customer or its own ID, nothing else', async () => {
    const bCustomer = (await B.scoped.billing.summary()).stripeCustomerId;
    const sub = {
      stripeSubscriptionId: `sub_x_${Date.now()}`,
      stripeCustomerId: bCustomer,
      orgPublicId: A.org.public_id, // claims A but names B's customer: the customer wins, and a mismatch is refused
      planCode: 'starter',
      status: 'active',
      orgStatus: 'active',
      trialEndsAt: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      addons: [],
    };
    const result = await db.system.billing.subscriptions.apply({ parsed: sub });
    assert.equal(result.orgId, B.org.id, 'it landed on the customer’s organization');
    assert.equal((await A.scoped.billing.summary()).planCode, null, 'and A was not touched');
    assert.deepEqual(
      await db.system.billing.subscriptions.apply({
        parsed: { ...sub, stripeCustomerId: 'cus_nobody', orgPublicId: 'x' },
      }),
      { applied: false, reason: 'unknown_organization' },
    );
  });

  test('billing.retention / trials / meters: return only IDs, names for the email, and counts', async () => {
    const found = await db.system.billing.retention.warnable({ now: new Date(), days: 36500 });
    for (const w of found)
      assert.deepEqual(Object.keys(w).sort(), ['orgId', 'orgName', 'owners', 'retainUntil']);
    const trials = await db.system.billing.trials.ending({ now: new Date(), days: 36500 });
    for (const t of trials) assert.ok(!('payload' in t));
  });

  test('costs, providers, review and flags: aggregates and items by ID, never a customer’s name in the review queue', async () => {
    const since = new Date(Date.now() - 86_400_000);
    for (const r of await db.system.costs.byMeter({ since })) assert.ok(!('orgId' in r));
    for (const r of await db.system.costs.daily({ since }))
      assert.deepEqual(Object.keys(r).sort(), ['costMicros', 'day']);
    const unit = await db.system.costs.unitCosts({ from: since, to: new Date() });
    assert.deepEqual(Object.keys(unit).sort(), ['audits', 'meters', 'promptRuns']);
    assert.deepEqual(Object.keys(unit.audits).sort(), ['costMicros', 'count', 'worstMicros']);
    for (const r of unit.meters) assert.deepEqual(Object.keys(r).sort(), ['costMicros', 'meter']);
    for (const r of await db.system.review.list({}))
      assert.ok(!('orgId' in r) && !('orgName' in r), 'the list names no customer');
    const counts = await db.system.review.counts();
    for (const n of Object.values(counts)) assert.equal(typeof n, 'number');
    assert.equal(await db.system.flags.isEnabled('test.never_created', A.org.id), false);
  });
});

describe('what the worker may look up across organizations about the Action Center', () => {
  test('due(), overdue() and ruleStats() return IDs and counts, never tenant content', async () => {
    for (const row of await db.system.outcomes.due({ now: new Date('2099-01-01') })) {
      assert.deepEqual(Object.keys(row).sort(), ['orgId', 'projectId', 'recommendationId']);
    }
    for (const row of await db.system.verifications.overdue({ now: new Date('2099-01-01') })) {
      assert.deepEqual(Object.keys(row).sort(), ['attempt', 'orgId', 'recommendationId']);
    }
    for (const [rule, counts] of Object.entries(await db.system.outcomes.ruleStats())) {
      assert.match(rule, /^(readiness|visibility)\./);
      assert.deepEqual(Object.keys(counts).sort(), ['decided', 'wins']);
    }
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
    billing: [
      'access',
      'addons',
      'attachCustomer',
      'canAdd',
      'feature',
      'featureAllowed',
      'hasMeteredDrafts',
      'limitFor',
      'note',
      'promptRoom',
      'summary',
      'usage',
    ],
    alerts: ['digestFacts', 'markAlerted', 'pending', 'recipients'],
    notifyPrefs: ['get', 'set'],
    google: ['choose', 'disconnect', 'saveGrant', 'secret', 'status', 'syncResult'],
    traffic: ['range', 'saveGa4', 'saveSearch', 'searchRange'],
    projects: [
      'archive',
      'create',
      'get',
      'getByPublicId',
      'list',
      'markVerified',
      'startTracking',
      'update',
      'verification',
    ],
    runs: [
      'advance',
      'begin',
      'cells',
      'expirePending',
      'expireUnread',
      'finish',
      'get',
      'noteFirstRun',
      'plan',
      'progress',
      'recent',
      'settle',
      'start',
    ],
    metrics: ['range', 'rollupDay'],
    changes: ['detect', 'forProject'],
    dashboard: [
      'answers',
      'citations',
      'competitorCells',
      'matrix',
      'question',
      'reportAnswer',
      'reportsFor',
    ],
    quota: ['returnRunNow', 'runNowUsage', 'takeRunNow'],
    recommendations: [
      'attachScan',
      'counts',
      'get',
      'list',
      'load',
      'markDone',
      'provenWins',
      'reconcile',
      'recordVerification',
      'saveNarrative',
      'settleVerification',
      'signals',
      'top',
      'transition',
      'verificationsOf',
    ],
    outcomes: ['measure', 'recent'],
    content: [
      'approve',
      'archive',
      'beginPublish',
      'counts',
      'create',
      'editBrief',
      'fail',
      'finishPublish',
      'forPipeline',
      'forPublish',
      'forRecommendations',
      'get',
      'list',
      'markApplying',
      'redraft',
      'rememberPost',
      'retry',
      'revision',
      'saveBrief',
      'saveDraft',
      'saveEdit',
      'saveQc',
      'saveResearch',
      'siteChanges',
      'unapprove',
    ],
    draftQuota: ['draftsUsed'],
    integrations: [
      'disconnectWordpress',
      'saveWordpress',
      'wordpress',
      'wordpressResult',
      'wordpressSecret',
    ],
    brandKits: ['current', 'get', 'history', 'save'],
    projectEngines: ['list', 'setEnabled'],
    prompts: ['add', 'clusters', 'edit', 'importMany', 'list', 'setStatus'],
    entities: ['addAlias', 'addCompetitor', 'list', 'removeAlias', 'setStatus', 'update'],
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
    outcomes: ['due', 'ruleStats'],
    verifications: ['overdue'],
    traffic: ['connections'],
    digest: ['projectsInTimezones', 'timezones'],
    // Costs and health are aggregates; the review queue shows an item and the names being tracked, never the customer;
    // flags are staff's switches. Each is only reached from the console, behind its wall, and every write there is audited.
    costs: ['answers', 'auditsMicros', 'byMeter', 'byOrganization', 'daily', 'unitCosts'],
    providers: ['buckets'],
    review: [
      'addAlias',
      'assign',
      'counts',
      'get',
      'list',
      'markGolden',
      'reject',
      'requestReextract',
      'resolve',
    ],
    flags: ['clearOverride', 'ensureKnown', 'isEnabled', 'list', 'set', 'setOverride'],
    // Spend caps: names and money per customer, for staff only; the one write is audited by the route.
    spend: ['list', 'setCap'],
  };

  // Billing is a group of groups: what a Stripe webhook and the billing jobs need to find an organization by Stripe's IDs.
  const SYSTEM_BILLING = {
    plans: ['get', 'list', 'priceMap', 'setStripePrice'],
    subscriptions: ['apply', 'reconcilable'],
    retention: ['close', 'due', 'purge', 'purgeDue', 'warnable'],
    trials: ['ending'],
    meters: ['draftsToReport', 'markDraftsReported'],
  };

  test('every cross-organization system lookup is listed above', () => {
    assert.deepEqual(Object.keys(db.system).sort(), [...Object.keys(SYSTEM), 'billing'].sort());
    for (const [group, functions] of Object.entries(SYSTEM_BILLING)) {
      assert.deepEqual(
        Object.keys(db.system.billing[group]).sort(),
        functions,
        `billing.${group}: review, then list`,
      );
    }
    assert.deepEqual(Object.keys(db.system.billing).sort(), Object.keys(SYSTEM_BILLING).sort());
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
      'alerts',
      'billing',
      'brandKits',
      'changes',
      'content',
      'dashboard',
      'draftQuota',
      'entities',
      'extractions',
      'google',
      'integrations',
      'invitations',
      'memberships',
      'metrics',
      'notifications',
      'notifyPrefs',
      'orgId',
      'outcomes',
      'projectEngines',
      'projects',
      'prompts',
      'quota',
      'recommendations',
      'runs',
      'scans',
      'snapshots',
      'spend',
      'traffic',
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
