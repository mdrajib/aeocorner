import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { csrfToken } from '../../src/web/auth/csrf.js';
import { closeQueues, createQueues } from '../../src/lib/queues.js';
import { connectTestRedis } from '../helpers/redis.js';
import { APP_SECRET, authHarness, fakeClerk } from './auth-helpers.js';

/**
 * What staff change from the console (Milestone 8, tasks 8.20–8.22): the extraction review queue and feature flags, and the
 * rule that every change is recorded first and refused if it cannot be.
 */

const TEAM = 'acme';
const AUD = 'aud-tag-1234567890';
const STAFF_HOST = 'admin.localhost:3000';
const staffFrontend = 'staff-app-34.clerk.accounts.dev';
const staffEnv = {
  CLERK_STAFF_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${staffFrontend}$`).toString('base64')}`,
  CLERK_STAFF_SECRET_KEY: 'sk_test_staff_not_real',
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: TEAM,
  CLOUDFLARE_ACCESS_AUD: AUD,
  STAFF_HOST,
};

let h;
let redis;
let queues;
let staffClerk;
let cf;

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  cf = await new SignJWT({ email: 'someone@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(`https://${TEAM}.cloudflareaccess.com`)
    .setAudience(AUD)
    .setSubject('cf-user')
    .setIssuedAt()
    .setExpirationTime('30m')
    .sign(privateKey);
  redis = connectTestRedis({ role: 'web' });
  queues = createQueues({ connection: redis.redis, prefix: redis.prefix });
  staffClerk = fakeClerk();
  h = authHarness({
    env: staffEnv,
    staffProvider: staffClerk,
    cloudflareKeys: createLocalJWKSet({ keys: [jwk] }),
    queues,
  });
});
after(async () => {
  await h.close();
  await closeQueues(queues);
  await redis.close();
});

async function staffer(roles) {
  const member = await h.fx.staff({ roles });
  const me = staffClerk.signIn(
    { id: `cu_${member.email}`, email: member.email, name: member.name },
    { claims: { fva: [1, 2] } },
  );
  const csrf = csrfToken(APP_SECRET, me.sessionId);
  const base = (method, path) =>
    h.agent[method](path)
      .set('Host', STAFF_HOST)
      .set('Cf-Access-Jwt-Assertion', cf)
      .set('X-Test-Session', me.session);
  return {
    member,
    get: (path) => base('get', path),
    post: (path, body = {}) =>
      base('post', path)
        .type('form')
        .send({ _csrf: csrf, ...body }),
  };
}
const actions = async (member) => (await h.fx.staffAuditRows(member.id)).map((r) => r.action);
const location = (res) => res.headers.location;

/** An organization with a brand, a rival, a question and one read answer that has a review item. */
async function reviewable({ source = 'disagreement', withEntity = true, collected = true } = {}) {
  const o = await h.fx.org({ name: 'Secretly Named Customer Ltd' });
  const project = await h.fx.project(o.org.id, 'Review Dental');
  await h.fx.engines(project, ['perplexity']);
  const brand = await h.fx.entity(project, { kind: 'brand', name: 'Acme Dental' });
  const rival = await h.fx.entity(project, { kind: 'competitor', name: 'Rival Dental' });
  const prompt = await h.fx.prompt(project, {
    text: `Best dentist in Austin ${randomBytes(3).toString('hex')}?`,
  });
  const run = await h.fx.run(project, { status: 'complete' });
  const snapshot = collected
    ? await h.fx.readAnswer(run, prompt, {
        excerpt: 'Acme is a name shared by several firms; the best dentist is Rival Dental.',
        mentions: [
          { entity: brand, listRank: 2, stance: 'neutral', excerpt: 'Acme is a name shared' },
        ],
      })
    : await o.scoped.snapshots
        .create({
          runId: run.id,
          promptId: prompt.id,
          engineCode: 'perplexity',
          sampleIdx: 0,
          providerCode: 'perplexity_api',
          method: 'api_grounded',
        })
        .then((r) => r.snapshot);
  const item = await h.fx.reviewItem(run, snapshot, {
    source,
    entity: withEntity ? brand : undefined,
    reportKind: source === 'customer_report' ? 'not_us' : null,
    comment: source === 'customer_report' ? 'That is a different Acme' : null,
    userId: source === 'customer_report' ? o.owner.id : null,
    details: source === 'disagreement' ? { prepass: ['Acme Dental'], llm: [] } : null,
  });
  return { o, project, brand, rival, prompt, run, snapshot, item };
}

describe('the review queue', () => {
  test('lists items with the question and the start of the answer, and never the customer', async () => {
    const t = await reviewable({ source: 'customer_report' });
    const rev = await staffer(['reviewer']);
    const list = await rev.get('/review');
    assert.equal(list.status, 200);
    assert.match(list.text, /Reported by a customer/);
    assert.match(list.text, /Best dentist in Austin/);
    assert.doesNotMatch(list.text, /Secretly Named Customer/);
    assert.doesNotMatch(list.text, new RegExp(t.o.owner.email));

    const page = await rev.get(`/review/${t.item.id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /That is a different Acme/);
    assert.match(page.text, /Acme is a name shared by several firms/);
    assert.match(page.text, /Rival Dental/);
    assert.match(page.text, /Names being tracked/);
    assert.doesNotMatch(page.text, /Secretly Named Customer/);
    assert.doesNotMatch(page.text, new RegExp(t.o.owner.email));
  });

  test('the list can be narrowed to one kind', async () => {
    await reviewable({ source: 'low_confidence' });
    const rev = await staffer(['reviewer']);
    const only = await rev.get('/review?source=low_confidence');
    assert.match(only.text, /Low confidence \(\d+\)/);
    assert.doesNotMatch(only.text, /Reported by a customer<\/td>/);
    assert.equal(
      (await rev.get('/review?source=junk')).status,
      200,
      'an unknown kind is read as "all"',
    );
  });

  test('an item that does not exist, or is not a number, is a plain 404', async () => {
    const rev = await staffer(['reviewer']);
    for (const path of ['/review/999999999', '/review/abc', '/review/0'])
      assert.equal((await rev.get(path)).status, 404, path);
    assert.equal((await rev.post('/review/999999999/take')).status, 404);
  });

  test('taking an item is recorded, and a second person cannot take it', async () => {
    const t = await reviewable();
    const a = await staffer(['reviewer']);
    const b = await staffer(['reviewer']);
    assert.match(location(await a.post(`/review/${t.item.id}/take`)), /review-taken/);
    assert.match(location(await b.post(`/review/${t.item.id}/take`)), /review-late/);
    const row = await h.fx.reviewRow(t.item.id);
    assert.equal(row.status, 'in_review');
    assert.equal(row.assigned_staff_id, a.member.id);
    assert.deepEqual(await actions(a.member), ['review.take']);
    assert.deepEqual(
      await actions(b.member),
      ['review.take'],
      'even the attempt that changed nothing is recorded',
    );
  });

  test('a verdict is saved once, with its note and who made it; a second verdict changes nothing', async () => {
    const t = await reviewable();
    const rev = await staffer(['reviewer']);
    assert.match(
      location(await rev.post(`/review/${t.item.id}/resolve`, { resolution: 'junk' })),
      /review-invalid/,
    );
    assert.equal((await h.fx.reviewRow(t.item.id)).status, 'open');
    assert.match(
      location(
        await rev.post(`/review/${t.item.id}/resolve`, {
          resolution: 'extraction_wrong',
          note: 'Two firms called Acme',
        }),
      ),
      /review-resolved/,
    );
    const row = await h.fx.reviewRow(t.item.id);
    assert.deepEqual(
      [row.status, row.resolution, row.resolution_note, row.resolved_by_staff_id],
      ['resolved', 'extraction_wrong', 'Two firms called Acme', rev.member.id],
    );
    assert.match(
      location(await rev.post(`/review/${t.item.id}/resolve`, { resolution: 'no_action' })),
      /review-late/,
    );
    assert.equal((await h.fx.reviewRow(t.item.id)).resolution, 'extraction_wrong');
    const page = await rev.get(`/review/${t.item.id}`);
    assert.match(page.text, /Decided: The reading is wrong/);
    assert.doesNotMatch(page.text, /Save the verdict/);
  });

  test('a report can be turned down, but only with a reason', async () => {
    const t = await reviewable({ source: 'customer_report' });
    const rev = await staffer(['reviewer']);
    assert.match(
      location(await rev.post(`/review/${t.item.id}/reject`, { note: 'no' })),
      /review-invalid/,
    );
    assert.equal((await h.fx.reviewRow(t.item.id)).status, 'open');
    assert.match(
      location(
        await rev.post(`/review/${t.item.id}/reject`, { note: 'It was them: the domain matches' }),
      ),
      /review-rejected/,
    );
    const row = await h.fx.reviewRow(t.item.id);
    assert.deepEqual(
      [row.status, row.resolution_note],
      ['rejected', 'It was them: the domain matches'],
    );
  });

  test('adding an alias writes it for the brand, from the review, and decides the item', async () => {
    const t = await reviewable();
    const rev = await staffer(['reviewer']);
    const res = await rev.post(`/review/${t.item.id}/alias`, {
      kind: 'name',
      value: 'Acme Family Dentistry',
    });
    assert.match(location(res), /review-alias$/);
    const [alias] = (await h.fx.aliasRows(t.brand)).filter(
      (a) => a.value === 'Acme Family Dentistry',
    );
    assert.deepEqual(
      [alias.kind, alias.source, alias.created_by_staff_id, alias.org_id],
      ['name', 'review', rev.member.id, t.o.org.id],
    );
    assert.equal((await h.fx.reviewRow(t.item.id)).resolution, 'alias_added');
  });

  test('an exclusion ("that is a different business") is an exclusion; the same alias twice is harmless', async () => {
    const one = await reviewable();
    const two = await reviewable();
    const rev = await staffer(['reviewer']);
    assert.match(
      location(
        await rev.post(`/review/${one.item.id}/alias`, { kind: 'exclude', value: 'Acme Plumbing' }),
      ),
      /review-alias$/,
    );
    assert.equal(
      (await h.fx.aliasRows(one.brand)).find((a) => a.value === 'Acme Plumbing').kind,
      'exclude',
    );
    assert.equal((await h.fx.reviewRow(one.item.id)).resolution, 'exclusion_added');

    // The same value again on a fresh item for the same brand: already there.
    const again = await h.fx.reviewItem(one.run, one.snapshot, { entity: one.brand });
    assert.match(
      location(
        await rev.post(`/review/${again.id}/alias`, { kind: 'exclude', value: 'Acme Plumbing' }),
      ),
      /review-alias-exists/,
    );
    assert.equal(
      (await h.fx.reviewRow(again.id)).status,
      'open',
      'nothing was decided when nothing was added',
    );
    assert.ok(two);
  });

  test('an alias needs a kind, a real value and an item that names a brand', async () => {
    const t = await reviewable();
    const noEntity = await reviewable({ withEntity: false });
    const rev = await staffer(['reviewer']);
    for (const body of [
      { kind: 'weird', value: 'Acme Co' },
      { kind: 'name', value: '' },
      { kind: 'name', value: 'A' },
    ]) {
      assert.match(location(await rev.post(`/review/${t.item.id}/alias`, body)), /review-invalid/);
    }
    assert.match(
      location(
        await rev.post(`/review/${noEntity.item.id}/alias`, { kind: 'name', value: 'Acme Co' }),
      ),
      /review-invalid/,
    );
    assert.equal((await h.fx.aliasRows(t.brand)).length, 0);
  });

  test('asking for the answer to be read again marks it pending and queues the job once', async () => {
    const t = await reviewable();
    const rev = await staffer(['reviewer']);
    assert.equal((await h.fx.snapshotRow(t.snapshot)).extraction_status, 'done');
    assert.match(location(await rev.post(`/review/${t.item.id}/reextract`)), /review-reextract$/);
    assert.equal((await h.fx.snapshotRow(t.snapshot)).extraction_status, 'pending');
    assert.ok((await h.fx.reviewRow(t.item.id)).reextract_requested_at);
    const queued = await queues.extract.getJob(
      `extract-answer-${t.snapshot.id}-review-${t.item.id}`,
    );
    assert.equal(queued.name, 'extract.answer');
    assert.deepEqual(queued.data, { orgId: String(t.o.org.id), snapshotId: String(t.snapshot.id) });
    await rev.post(`/review/${t.item.id}/reextract`);
    assert.equal(
      (await queues.extract.getJobs(['waiting', 'delayed', 'prioritized'])).filter(
        (j) => j.id === queued.id,
      ).length,
      1,
      'one job, however often it is asked',
    );
  });

  test('an answer that was never collected cannot be read again', async () => {
    const t = await reviewable({ collected: false });
    const rev = await staffer(['reviewer']);
    assert.match(location(await rev.post(`/review/${t.item.id}/reextract`)), /review-reextract-no/);
    assert.equal(
      await queues.extract.getJob(`extract-answer-${t.snapshot.id}-review-${t.item.id}`),
      undefined,
    );
  });

  test('adding to the golden set is marked once', async () => {
    const t = await reviewable();
    const rev = await staffer(['reviewer']);
    assert.match(location(await rev.post(`/review/${t.item.id}/golden`)), /review-golden/);
    const marked = (await h.fx.reviewRow(t.item.id)).golden_set_exported_at;
    assert.ok(marked);
    assert.match(location(await rev.post(`/review/${t.item.id}/golden`)), /review-late/);
    assert.equal(
      (await h.fx.reviewRow(t.item.id)).golden_set_exported_at.getTime(),
      marked.getTime(),
    );
  });
});

describe('feature flags', () => {
  test('a new flag is created with a reason, shown, and read as its default', async () => {
    const boss = await staffer(['super_admin']);
    const key = h.fx.flagKey();
    assert.equal(await h.db.system.flags.isEnabled(key), false, 'a flag nobody made is off');
    const res = await boss.post('/flags/default', {
      key,
      reason: 'trying it out',
      enabled: 'on',
      description: 'A test flag',
    });
    assert.match(location(res), /flag-saved/);
    assert.equal(await h.db.system.flags.isEnabled(key), true);
    const page = await boss.get('/flags');
    assert.match(page.text, new RegExp(key.replace('.', '\\.')));
    assert.match(page.text, /Not read by the application/);
    assert.deepEqual(await actions(boss.member), ['flag.default']);
    const [row] = await h.fx.staffAuditRows(boss.member.id);
    assert.equal(row.reason, 'trying it out');
    assert.deepEqual(row.after_state, { enabledDefault: true });
  });

  test('a customer can be given a flag, or have it taken away, and removing the override returns to the default', async () => {
    const boss = await staffer(['super_admin']);
    const key = h.fx.flagKey();
    await boss.post('/flags/default', { key, reason: 'new flag', description: 'x' });
    const o = await h.fx.org();
    const other = await h.fx.org();
    assert.equal(await h.db.system.flags.isEnabled(key, o.org.id), false);

    assert.match(
      location(
        await boss.post('/flags/override', {
          key,
          org: o.org.public_id,
          enabled: 'on',
          reason: 'beta for a design partner',
        }),
      ),
      /flag-saved/,
    );
    assert.equal(await h.db.system.flags.isEnabled(key, o.org.id), true);
    assert.equal(await h.db.system.flags.isEnabled(key, other.org.id), false, 'only that customer');
    assert.equal(await h.db.system.flags.isEnabled(key), false, 'and not everyone');

    assert.match(
      location(await boss.post('/flags/clear', { key, org: o.org.public_id, reason: 'beta over' })),
      /flag-saved/,
    );
    assert.equal(await h.db.system.flags.isEnabled(key, o.org.id), false);
    assert.deepEqual(await actions(boss.member), ['flag.default', 'flag.override', 'flag.clear']);
  });

  test('a flag that is on can be switched off for one customer, the other way round', async () => {
    const boss = await staffer(['super_admin']);
    const key = h.fx.flagKey();
    await boss.post('/flags/default', {
      key,
      enabled: 'on',
      reason: 'on for all',
      description: 'x',
    });
    const o = await h.fx.org();
    await boss.post('/flags/override', { key, org: o.org.public_id, reason: 'misusing it' });
    assert.equal(await h.db.system.flags.isEnabled(key, o.org.id), false);
    assert.equal(await h.db.system.flags.isEnabled(key, (await h.fx.org()).org.id), true);
  });

  test('a bad key, a missing reason, an unknown flag or customer change nothing', async () => {
    const boss = await staffer(['super_admin']);
    const key = h.fx.flagKey();
    await boss.post('/flags/default', { key, reason: 'make it', description: 'x', enabled: 'on' });
    const o = await h.fx.org();
    for (const body of [
      { key: 'Not Valid!', reason: 'long enough' },
      { key, reason: 'no' },
      { key, reason: '' },
    ]) {
      assert.match(location(await boss.post('/flags/default', body)), /flag-invalid/);
    }
    assert.match(
      location(
        await boss.post('/flags/override', {
          key: 'test.never_made',
          org: o.org.public_id,
          reason: 'long enough',
        }),
      ),
      /flag-missing/,
    );
    assert.match(
      location(
        await boss.post('/flags/override', {
          key,
          org: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
          reason: 'long enough',
        }),
      ),
      /flag-missing/,
    );
    assert.equal(await h.db.system.flags.isEnabled(key), true, 'the default was not touched');
  });

  test('the flags the application reads are on until someone switches them off, and the console shows them as read', async () => {
    const boss = await staffer(['super_admin']);
    for (const key of ['digest.weekly', 'alerts.emails', 'google.sync'])
      assert.equal(await h.db.system.flags.isEnabled(key), true);
    const page = await boss.get('/flags');
    assert.match(page.text, /digest\.weekly/);
    assert.match(page.text, /Send the weekly digest email/);
    const o = await h.fx.org();
    await boss.post('/flags/override', {
      key: 'digest.weekly',
      org: o.org.public_id,
      reason: 'they asked us to stop',
    });
    assert.equal(await h.db.system.flags.isEnabled('digest.weekly', o.org.id), false);
    assert.equal(await h.db.system.flags.isEnabled('digest.weekly'), true);
  });
});

describe('every change is recorded first, or refused', () => {
  test('when the audit log cannot be written the action is refused and nothing changes', async () => {
    const boss = await staffer(['super_admin']);
    const key = h.fx.flagKey();
    const real = h.db.staff.audit;
    h.db.staff.audit = async () => {
      throw new Error('audit log is down');
    };
    try {
      const res = await boss.post('/flags/default', {
        key,
        reason: 'should not happen',
        enabled: 'on',
        description: 'x',
      });
      assert.equal(res.status, 500);
    } finally {
      h.db.staff.audit = real;
    }
    assert.equal(await h.db.system.flags.isEnabled(key), false, 'the flag was not created');
    const t = await reviewable();
    h.db.staff.audit = async () => {
      throw new Error('audit log is down');
    };
    try {
      const rev = await staffer(['reviewer']);
      assert.equal(
        (await rev.post(`/review/${t.item.id}/resolve`, { resolution: 'no_action' })).status,
        500,
      );
    } finally {
      h.db.staff.audit = real;
    }
    assert.equal((await h.fx.reviewRow(t.item.id)).status, 'open');
  });

  test('the audit page lists what was done, who did it and why, newest first, and is for super admins only', async () => {
    const boss = await staffer(['super_admin']);
    const key = h.fx.flagKey();
    await boss.post('/flags/default', { key, reason: 'visible in the log', description: 'x' });
    const page = await boss.get('/audit');
    assert.equal(page.status, 200);
    assert.match(page.text, /flag\.default/);
    assert.match(page.text, /visible in the log/);
    assert.match(page.text, new RegExp(boss.member.name));
    const ops = await staffer(['ops']);
    assert.equal((await ops.get('/audit')).status, 403);
  });
});
