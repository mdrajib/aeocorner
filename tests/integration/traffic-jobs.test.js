import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import pino from 'pino';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { GoogleError, createGoogle } from '../../src/integrations/google.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createNotifier } from '../../src/lib/notify.js';
import { createSecretBox } from '../../src/lib/secrets.js';
import { syncGoogle, syncGoogleSweep } from '../../src/worker/handlers/traffic.js';
import { startGoogleStub } from '../helpers/google-stub.js';

/**
 * Connecting Google and reading its data (Milestone 8, tasks 8.09–8.11) against the real database, a Google stand-in with
 * fixtures built from the API documentation, and a real secrets box: the token is only ever opened by the worker.
 */

const db = connectTestDb();
const fx = fixtures(db);
const stub = await startGoogleStub();
const google = createGoogle({
  clientId: stub.clientId,
  clientSecret: stub.clientSecret,
  urls: stub.urls,
});
const secrets = createSecretBox({ current: { version: 1, key: randomBytes(32) } });
const mailer = memoryMailer();
const NOW = new Date('2026-10-05T09:00:00Z');
let clock = NOW;
const jobs = {
  added: [],
  async add(name, data, opts) {
    this.added.push({ name, data, opts });
  },
};
const ctx = {
  db,
  jobs,
  google,
  content: { secrets },
  logger: pino({ level: 'silent' }),
  now: () => clock,
  mail: createNotifier({
    db,
    mailer,
    baseUrl: 'https://aeocorner.test',
    secret: 'test-secret-test-secret-test-secret-123',
    now: () => clock,
  }),
};
after(async () => {
  await fx.cleanup();
  await db.close();
  await stub.close();
});

/** An organization with a project, a brand, and a saved Google grant, as the sign-in callback would leave it. */
async function connected({
  choose = { ga4PropertyId: '123456789', gscSiteUrl: 'https://acme.example.test/' },
} = {}) {
  const o = await fx.org();
  const project = await fx.project(o.org.id, 'Acme Dental', { status: 'active' });
  await fx.entity(project, { kind: 'brand', name: 'Acme Dental', domains: ['acme.example.test'] });
  const { code, refreshToken } = stub.issueCode();
  const tokens = await google.exchangeCode({ code, redirectUri: 'x' });
  await o.scoped.google.saveGrant(project.id, {
    secret: secrets.encrypt(tokens.refreshToken, `google:${o.org.id}:${project.id}`),
    scopes: tokens.scopes,
    properties: await google.ga4Properties(tokens.accessToken),
    sites: await google.searchConsoleSites(tokens.accessToken),
    userId: o.owner.id,
  });
  if (choose) await o.scoped.google.choose(project.id, choose);
  return {
    ...o,
    project,
    refreshToken,
    data: { orgId: String(o.org.id), projectId: String(project.id) },
  };
}

describe('saving a grant and choosing what to read', () => {
  test('the token is stored encrypted, the choices are plain, and the connection waits for a choice', async () => {
    const t = await connected({ choose: null });
    const status = await t.scoped.google.status(t.project.id);
    assert.equal(status.status, 'pending');
    assert.equal(status.hasSecret, true);
    assert.deepEqual(
      status.config.ga4_candidates.map((p) => p.id),
      ['123456789', '987654321'],
    );
    assert.ok(
      !JSON.stringify(status, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(
        t.refreshToken,
      ),
      'the refresh token is nowhere in what the screen reads',
    );
    const stored = await t.scoped.google.secret(t.project.id);
    assert.ok(!stored.secret.ciphertext.toString('utf8').includes(t.refreshToken));
    assert.equal(
      secrets.decryptText(stored.secret, `google:${t.org.id}:${t.project.id}`),
      t.refreshToken,
    );
    assert.throws(
      () => secrets.decryptText(stored.secret, `google:${t.org.id}:999`),
      /could not be opened/,
      'bound to its own project',
    );
  });

  test('only what was on offer can be chosen, and something must be', async () => {
    const t = await connected({ choose: null });
    await assert.rejects(
      t.scoped.google.choose(t.project.id, { ga4PropertyId: '555' }),
      (e) => e instanceof DomainError && e.code === 'NOT_OFFERED',
    );
    await assert.rejects(
      t.scoped.google.choose(t.project.id, { gscSiteUrl: 'https://evil.test/' }),
      (e) => e.code === 'NOT_OFFERED',
    );
    await assert.rejects(
      t.scoped.google.choose(t.project.id, {}),
      (e) => e.code === 'NOTHING_CHOSEN',
    );
    const ok = await t.scoped.google.choose(t.project.id, {
      gscSiteUrl: 'https://acme.example.test/',
    });
    assert.equal(ok.status, 'connected');
  });

  test('connecting again keeps a choice that is still offered and drops one that is not', async () => {
    const t = await connected();
    const grant = (properties) =>
      t.scoped.google.saveGrant(t.project.id, {
        secret: secrets.encrypt('rt-new', `google:${t.org.id}:${t.project.id}`),
        scopes: [],
        properties,
        sites: [],
        userId: t.owner.id,
      });
    let status = await grant([{ id: '123456789', name: 'Kept', account: '' }]);
    assert.equal(status.config.ga4_property_id, '123456789');
    assert.equal(status.config.gsc_site_url, null, 'the site is no longer on offer');
    status = await grant([{ id: '42', name: 'Other', account: '' }]);
    assert.equal(status.config.ga4_property_id, null);
    assert.equal(status.status, 'pending');
  });

  test('disconnecting erases the token and keeps the traffic already read', async () => {
    const t = await connected();
    await syncGoogle(ctx, t.data);
    assert.equal(await t.scoped.google.disconnect(t.project.id), true);
    assert.equal(await t.scoped.google.secret(t.project.id), null);
    assert.equal((await t.scoped.google.status(t.project.id)).hasSecret, false);
    assert.ok(
      (await t.scoped.traffic.range(t.project.id, { from: '2026-08-01', to: '2026-10-01' }))
        .length > 0,
    );
  });
});

describe('sync.google', () => {
  test('reads GA4 and Search Console, stores the days, and records how far it has read', async () => {
    const t = await connected();
    const result = await syncGoogle(ctx, t.data);
    assert.ok(result.ga4Rows > 0 && result.gscRows > 0);
    assert.equal(result.from, '2026-07-07');
    assert.equal(result.to, '2026-10-04');

    const rows = await t.scoped.traffic.range(t.project.id, {
      from: '2026-08-01',
      to: '2026-10-01',
    });
    const chat = rows.find((r) => r.metricDate === '2026-08-10' && r.channel === 'chatgpt');
    assert.deepEqual(
      [chat.landingPage, chat.sessions, chat.engagedSessions, chat.keyEvents],
      ['/pricing', 12, 7, 1],
    );
    assert.equal(rows.filter((r) => r.channel === 'all').length, 8);
    assert.ok(!rows.some((r) => r.landingPage === '/ignored'));

    const search = await t.scoped.traffic.searchRange(t.project.id, {
      from: '2026-08-01',
      to: '2026-10-01',
    });
    assert.equal(
      search.filter((r) => r.dimension === 'query').length,
      16,
      'only branded queries are kept',
    );
    assert.ok(search.filter((r) => r.dimension === 'query').every((r) => r.isBranded));

    const status = await t.scoped.google.status(t.project.id);
    assert.deepEqual(
      [status.config.synced_from, status.config.synced_to],
      ['2026-07-07', '2026-10-04'],
    );
    assert.ok(status.lastSuccessAt);
  });

  test('reading again changes nothing: the same rows, no duplicates', async () => {
    const t = await connected();
    await syncGoogle(ctx, t.data);
    const first = await t.scoped.traffic.range(t.project.id, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    clock = new Date('2026-10-06T09:00:00Z');
    await syncGoogle(ctx, t.data);
    const second = await t.scoped.traffic.range(t.project.id, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    assert.deepEqual(second, first);
    const status = await t.scoped.google.status(t.project.id);
    assert.equal(status.config.synced_to, '2026-10-05', 'the range moves forward a day');
    assert.equal(status.config.synced_from, '2026-07-07', 'and never shrinks');
    clock = NOW;
  });

  test('a changed figure from Google replaces the old one (late data settles)', async () => {
    const t = await connected();
    await syncGoogle(ctx, t.data);
    const edited = structuredClone(stub.state.reports.all);
    edited.rows[0].metricValues[0].value = '999';
    const original = stub.state.reports.all;
    stub.state.reports.all = edited;
    await syncGoogle(ctx, t.data);
    stub.state.reports.all = original;
    const day = (
      await t.scoped.traffic.range(t.project.id, { from: '2026-08-10', to: '2026-08-10' })
    ).find((r) => r.channel === 'all');
    assert.equal(day.sessions, 999);
  });

  test('only the connection with a Google property reads Analytics; one with just a site reads only Search Console', async () => {
    const t = await connected({ choose: { gscSiteUrl: 'https://acme.example.test/' } });
    const before = stub.calls.filter((c) => c.path.endsWith(':runReport')).length;
    const result = await syncGoogle(ctx, t.data);
    assert.equal(result.ga4Rows, 0);
    assert.ok(result.gscRows > 0);
    assert.equal(stub.calls.filter((c) => c.path.endsWith(':runReport')).length, before);
  });

  test('access withdrawn in Google marks the connection broken, says so in plain words, and emails the owner once a month', async () => {
    const t = await connected();
    mailer.sent.length = 0;
    stub.revokeGrant(t.refreshToken);
    const result = await syncGoogle(ctx, t.data);
    assert.equal(result.broken, 'revoked');
    const status = await t.scoped.google.status(t.project.id);
    assert.equal(status.status, 'broken');
    assert.match(status.lastError, /withdrawn or has expired/);
    assert.doesNotMatch(status.lastError, new RegExp(t.refreshToken));

    const mine = mailer.sent.filter((m) => m.to === t.owner.email);
    assert.equal(mine.length, 1);
    assert.match(mine[0].email.subject, /Reconnect Google for Acme Dental/);
    assert.equal(mine[0].headers, undefined, 'a notice about the account has no unsubscribe');
    // Every day it stays broken: still one email this month.
    await syncGoogle(ctx, t.data);
    assert.equal(mailer.sent.filter((m) => m.to === t.owner.email).length, 1);
    // A new month: one more.
    clock = new Date('2026-11-05T09:00:00Z');
    await syncGoogle(ctx, t.data);
    assert.equal(mailer.sent.filter((m) => m.to === t.owner.email).length, 2);
    clock = NOW;
  });

  test('a viewer is never emailed to reconnect; only owners and admins', async () => {
    const t = await connected();
    const viewer = await fx.member(t.org, 'viewer');
    mailer.sent.length = 0;
    stub.revokeGrant(t.refreshToken);
    await syncGoogle(ctx, t.data);
    assert.equal(mailer.sent.filter((m) => m.to === viewer.user.email).length, 0);
  });

  test('a property the login can no longer read is "forbidden": broken with a plain reason, not a failed job', async () => {
    const t = await connected();
    stub.state.allowedProperties = ['987654321'];
    const result = await syncGoogle(ctx, t.data);
    stub.state.allowedProperties = null;
    assert.equal(result.broken, 'forbidden');
    assert.match(
      (await t.scoped.google.status(t.project.id)).lastError,
      /can no longer read the property or site/,
    );
  });

  test('Google being busy fails the job so it retries, and does not mark the connection broken', async () => {
    const t = await connected();
    await syncGoogle(ctx, t.data);
    const busy = {
      ...google,
      runReport: async () => {
        throw new GoogleError('Google is limiting requests for now.', { code: 'quota' });
      },
    };
    await assert.rejects(syncGoogle({ ...ctx, google: busy }, t.data), (e) => e.code === 'quota');
    const status = await t.scoped.google.status(t.project.id);
    assert.equal(status.status, 'connected');
    assert.equal(status.lastError, null);
  });

  test('a response that changed shape is said so on the connection and fails the job loudly, never stored as zero', async () => {
    const t = await connected({ choose: { ga4PropertyId: '123456789' } });
    const before = await t.scoped.traffic.range(t.project.id, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const broken = { ...google, runReport: async () => ({ rows: 'surprise' }) };
    await assert.rejects(syncGoogle({ ...ctx, google: broken }, t.data), /shape/);
    assert.deepEqual(
      await t.scoped.traffic.range(t.project.id, { from: '2026-01-01', to: '2026-12-31' }),
      before,
    );
    const status = await t.scoped.google.status(t.project.id);
    assert.equal(status.status, 'broken');
    assert.match(status.lastError, /could not read/);
  });

  test('without the secrets key, a connection with nothing chosen, or no connection, nothing happens', async () => {
    const t = await connected({ choose: null });
    assert.match((await syncGoogle(ctx, t.data)).skipped, /nothing chosen/);
    assert.match((await syncGoogle({ ...ctx, content: {} }, t.data)).skipped, /not configured/);
    const none = await fx.org();
    const p = await fx.project(none.org.id);
    assert.match(
      (await syncGoogle(ctx, { orgId: String(none.org.id), projectId: String(p.id) })).skipped,
      /not connected/,
    );
  });
});

describe('sync.google.sweep', () => {
  test('queues one sync per connected project, once a day, and skips disconnected ones', async () => {
    const live = await connected();
    const gone = await connected();
    await gone.scoped.google.disconnect(gone.project.id);
    jobs.added.length = 0;
    await syncGoogleSweep(ctx);
    const mine = jobs.added.filter((j) => j.data.projectId === live.data.projectId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, 'sync.google');
    assert.ok(!jobs.added.some((j) => j.data.projectId === gone.data.projectId));
    await syncGoogleSweep(ctx);
    const ids = new Set(
      jobs.added.filter((j) => j.data.projectId === live.data.projectId).map((j) => j.opts.jobId),
    );
    assert.equal(ids.size, 1, 'the same day is the same job');
  });
});

describe('feature flags', () => {
  test('reading Google, for one customer, can be switched off without a deploy', async () => {
    const t = await connected();
    const boss = await fx.staff({ roles: ['super_admin'] });
    await db.system.flags.ensureKnown();
    await db.system.flags.setOverride({
      key: 'google.sync',
      orgPublicId: t.org.public_id,
      enabled: false,
      staffId: boss.id,
    });
    assert.deepEqual(await syncGoogle(ctx, t.data), { skipped: 'switched off' });
    assert.deepEqual(
      await t.scoped.traffic.range(t.project.id, { from: '2026-01-01', to: '2026-12-31' }),
      [],
    );
  });
});
