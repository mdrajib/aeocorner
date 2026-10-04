import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { GOOGLE_SCOPES, createGoogle } from '../../src/integrations/google.js';
import { createSecretBox } from '../../src/lib/secrets.js';
import { syncGoogle } from '../../src/worker/handlers/traffic.js';
import { signGoogleState } from '../../src/web/auth/google-state.js';
import { APP_SECRET, authHarness, orgPathOf } from './auth-helpers.js';
import { startGoogleStub } from '../helpers/google-stub.js';
import { csrfToken } from '../../src/web/auth/csrf.js';
import pino from 'pino';

/**
 * Connecting Google and the AI traffic screen (Milestone 8, tasks 8.09 and 8.12) through the real app, with a Google
 * stand-in: the sign-in's guards, the picker, the screen in each of its states, and who may do what.
 */

const stub = await startGoogleStub();
const google = createGoogle({
  clientId: stub.clientId,
  clientSecret: stub.clientSecret,
  urls: stub.urls,
});
const secrets = createSecretBox({ current: { version: 1, key: randomBytes(32) } });
const jobs = {
  added: [],
  async add(name, data, opts) {
    this.added.push({ name, data, opts });
  },
};
const h = authHarness({
  jobs,
  google,
  content: { secrets },
  env: { GOOGLE_OAUTH_CLIENT_ID: stub.clientId, GOOGLE_OAUTH_CLIENT_SECRET: stub.clientSecret },
});
after(async () => {
  await h.close();
  await stub.close();
});

let n = 0;
async function newProject() {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Traffic Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const scoped = h.db.forOrg(found.org.id);
  const editor = await h.signedIn();
  await scoped.memberships.add({ userId: editor.user.id, role: 'editor' });
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: `traffic-${Date.now().toString(36)}-${n++}.example.test`,
      name: 'Acme Dental',
      country: 'US',
      language: 'en',
    })
    .expect(303);
  const pid = created.headers.location.match(/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  return {
    owner,
    editor,
    org: found.org,
    orgId,
    scoped,
    project,
    pid,
    base: `/app/o/${orgId}/projects/${pid}`,
  };
}

/** Do what Google's redirect does after the person agreed: take the state from our "connect" redirect and call back. */
async function connect(t, { grant = {}, who = t.owner, state } = {}) {
  const res = await who.post(`${t.base}/integrations/google/connect`).expect(303);
  const url = new URL(res.headers.location);
  const issued = stub.issueCode(grant);
  const sent = state ?? url.searchParams.get('state');
  const callback = await who.get(
    `/app/google/callback?code=${issued.code}&state=${encodeURIComponent(sent)}`,
  );
  return { url, issued, callback };
}

describe('connecting Google', () => {
  test('the owner is sent to Google with the read-only scopes and a signed state; nothing is saved yet', async () => {
    const t = await newProject();
    const res = await t.owner.post(`${t.base}/integrations/google/connect`).expect(303);
    const url = new URL(res.headers.location);
    assert.equal(url.origin + url.pathname, stub.urls.auth);
    assert.deepEqual(url.searchParams.get('scope').split(' '), GOOGLE_SCOPES);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/app/google/callback');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.match(url.searchParams.get('state'), /^[0-9A-Z]{26}\.[0-9A-Z]{26}\.\d+\.\d+\.[\w-]+$/);
    assert.equal(await t.scoped.google.status(t.project.id), null);
  });

  test('coming back with a code saves the encrypted token and the choices, and shows the picker', async () => {
    const t = await newProject();
    const { issued, callback } = await connect(t);
    assert.equal(callback.status, 303);
    assert.match(callback.headers.location, /\/traffic\?notice=google-connected$/);

    const status = await t.scoped.google.status(t.project.id);
    assert.equal(status.status, 'pending');
    assert.deepEqual(
      status.config.ga4_candidates.map((p) => p.id),
      ['123456789', '987654321'],
    );
    const stored = await t.scoped.google.secret(t.project.id);
    assert.equal(
      secrets.decryptText(stored.secret, `google:${t.org.id}:${t.project.id}`),
      issued.refreshToken,
    );

    const page = await t.owner.get(`${t.base}/traffic`).expect(200);
    assert.match(page.text, /Choose what to read/);
    assert.match(page.text, /Acme Dental - GA4/);
    assert.match(page.text, /https:\/\/acme\.example\.test\//);
    assert.doesNotMatch(page.text, new RegExp(issued.refreshToken));
  });

  test('a state from another browser session, another person, a forged one or an expired one is a plain 404 and saves nothing', async () => {
    const t = await newProject();
    const other = await h.signedIn();
    const res = await t.owner.post(`${t.base}/integrations/google/connect`).expect(303);
    const state = new URL(res.headers.location).searchParams.get('state');
    const issued = () => stub.issueCode().code;

    // The same state in someone else's session.
    await other
      .get(`/app/google/callback?code=${issued()}&state=${encodeURIComponent(state)}`)
      .expect(404);
    // A forged tail, junk, and nothing at all.
    await t.owner
      .get(
        `/app/google/callback?code=${issued()}&state=${encodeURIComponent(state.slice(0, -2))}xx`,
      )
      .expect(404);
    await t.owner.get(`/app/google/callback?code=${issued()}&state=junk`).expect(404);
    await t.owner.get(`/app/google/callback?code=${issued()}`).expect(404);
    // An expired state, correctly signed for this session.
    const binding = csrfToken(APP_SECRET, t.owner.sessionId);
    const old = signGoogleState(
      { orgPublicId: t.org.public_id, projectPublicId: t.pid, userId: t.owner.user.id },
      { secret: APP_SECRET, binding, now: Date.now() - 11 * 60_000 },
    );
    await t.owner
      .get(`/app/google/callback?code=${issued()}&state=${encodeURIComponent(old)}`)
      .expect(404);
    assert.equal(await t.scoped.google.status(t.project.id), null);
  });

  test('a person who may no longer manage integrations cannot finish it, and an editor cannot start it', async () => {
    const t = await newProject();
    await t.editor.post(`${t.base}/integrations/google/connect`).expect(403);
    // The state was made for an owner; the person is now only an editor of the organization.
    const res = await t.owner.post(`${t.base}/integrations/google/connect`).expect(303);
    const state = new URL(res.headers.location).searchParams.get('state');
    const second = await h.signedIn();
    await t.scoped.memberships.add({ userId: second.user.id, role: 'owner' });
    await t.scoped.memberships.changeRole({
      membershipId: (await t.scoped.memberships.getByUser(t.owner.user.id)).id,
      role: 'editor',
      actorUserId: second.user.id,
    });
    const back = await t.owner.get(
      `/app/google/callback?code=${stub.issueCode().code}&state=${encodeURIComponent(state)}`,
    );
    assert.equal(back.status, 303);
    assert.match(back.headers.location, /notice=not-allowed/);
    assert.equal(await t.scoped.google.status(t.project.id), null);
  });

  test('saying no at Google, or a code Google refuses, is a plain notice and saves nothing', async () => {
    const t = await newProject();
    const res = await t.owner.post(`${t.base}/integrations/google/connect`).expect(303);
    const state = encodeURIComponent(new URL(res.headers.location).searchParams.get('state'));
    const denied = await t.owner
      .get(`/app/google/callback?error=access_denied&state=${state}`)
      .expect(303);
    assert.match(denied.headers.location, /google-denied/);
    const bad = await t.owner
      .get(`/app/google/callback?code=not-a-real-code&state=${state}`)
      .expect(303);
    assert.match(bad.headers.location, /google-failed/);
    assert.equal(await t.scoped.google.status(t.project.id), null);
  });

  test('allowing only one of the two scopes still connects, and says what is missing; allowing neither does not', async () => {
    const t = await newProject();
    const partial = await connect(t, { grant: { scopes: [GOOGLE_SCOPES[1]] } });
    assert.match(partial.callback.headers.location, /google-partial/);
    assert.deepEqual((await t.scoped.google.status(t.project.id)).config.ga4_candidates, []);
    const none = await newProject();
    const res = await connect(none, { grant: { scopes: [] } });
    assert.match(res.callback.headers.location, /google-denied/);
    assert.equal(await none.scoped.google.status(none.project.id), null);
  });

  test('without Google switched on the screen says so and the button does nothing', async () => {
    const off = authHarness({ content: { secrets } });
    try {
      const owner = await off.signedIn();
      const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'No Google' }).expect(303));
      const created = await owner
        .post(`/app/o/${orgId}/projects`, {
          website: `nogoogle-${Date.now().toString(36)}.example.test`,
          name: 'Quiet Dental',
          country: 'US',
          language: 'en',
        })
        .expect(303);
      const base = `/app/o/${orgId}/projects/${created.headers.location.match(/projects\/([0-9A-Z]{26})/)[1]}`;
      const page = await owner.get(`${base}/traffic`).expect(200);
      assert.match(page.text, /Connecting Google is not switched on yet/);
      const res = await owner.post(`${base}/integrations/google/connect`).expect(303);
      assert.match(res.headers.location, /google-not-configured/);
    } finally {
      await off.close();
    }
  });
});

describe('choosing, syncing and disconnecting', () => {
  test('choosing saves the property and site, queues the first read, and refuses what was not offered', async () => {
    const t = await newProject();
    await connect(t);
    jobs.added.length = 0;
    const bad = await t.owner
      .post(`${t.base}/integrations/google/choose`, { ga4: '555', gsc: '' })
      .expect(303);
    assert.match(bad.headers.location, /google-bad-choice/);
    assert.equal(jobs.added.length, 0);
    const none = await t.owner
      .post(`${t.base}/integrations/google/choose`, { ga4: '', gsc: '' })
      .expect(303);
    assert.match(none.headers.location, /google-bad-choice/);

    const ok = await t.owner
      .post(`${t.base}/integrations/google/choose`, {
        ga4: '123456789',
        gsc: 'https://acme.example.test/',
      })
      .expect(303);
    assert.match(ok.headers.location, /google-chosen/);
    assert.equal(jobs.added[0].name, 'sync.google');
    assert.deepEqual(jobs.added[0].data, {
      orgId: String(t.org.id),
      projectId: String(t.project.id),
    });
    assert.equal((await t.scoped.google.status(t.project.id)).status, 'connected');
    // While the first read is waiting the page says so, rather than drawing empty charts.
    const page = await t.owner.get(`${t.base}/traffic`).expect(200);
    assert.match(page.text, /Reading your first weeks from Google/);
  });

  test('an editor can read the screen but not connect, choose, read again or disconnect', async () => {
    const t = await newProject();
    await connect(t);
    await t.scoped.google.choose(t.project.id, { ga4PropertyId: '123456789' });
    const page = await t.editor.get(`${t.base}/traffic`).expect(200);
    assert.doesNotMatch(page.text, /Disconnect/);
    for (const path of ['connect', 'choose', 'sync', 'disconnect']) {
      await t.editor.post(`${t.base}/integrations/google/${path}`, {}).expect(403);
    }
  });

  test('disconnecting erases the token, and a post without the CSRF token is refused', async () => {
    const t = await newProject();
    await connect(t);
    await t.owner.post(`${t.base}/integrations/google/disconnect`, {}, { csrf: null }).expect(403);
    assert.equal((await t.scoped.google.status(t.project.id)).hasSecret, true);
    const res = await t.owner.post(`${t.base}/integrations/google/disconnect`).expect(303);
    assert.match(res.headers.location, /google-disconnected/);
    assert.equal(await t.scoped.google.secret(t.project.id), null);
    const page = await t.owner.get(`${t.base}/traffic`).expect(200);
    assert.match(page.text, /Connect Google/);
  });

  test('another organization’s project and a malformed address are a plain 404', async () => {
    const mine = await newProject();
    const theirs = await newProject();
    await mine.owner.get(`${theirs.base}/traffic`).expect(404);
    await mine.owner.post(`${theirs.base}/integrations/google/connect`).expect(404);
    await mine.owner.get(`${mine.base.replace(mine.pid, 'not-a-ulid')}/traffic`).expect(404);
  });
});

describe('the screen with data', () => {
  test('after a sync it shows the figures, the weekly chart with its table, the pages and branded search', async () => {
    const t = await newProject();
    await connect(t);
    await t.scoped.google.choose(t.project.id, {
      ga4PropertyId: '123456789',
      gscSiteUrl: 'https://acme.example.test/',
    });
    const ctx = {
      db: h.db,
      google,
      content: { secrets },
      logger: pino({ level: 'silent' }),
      now: () => new Date('2026-10-05T09:00:00Z'),
      jobs,
    };
    await syncGoogle(ctx, { orgId: String(t.org.id), projectId: String(t.project.id) });
    // The screen reads "today" from the clock; the fixture's weeks end on 2026-09-28, so look at it from just after.
    const realNow = Date.now;
    Date.now = () => new Date('2026-10-05T10:00:00Z').getTime();
    let page;
    try {
      page = await t.owner.get(`${t.base}/traffic`).expect(200);
    } finally {
      Date.now = realNow;
    }
    assert.match(page.text, /Visits from AI answers, by week/);
    assert.match(page.text, /data-chart=/);
    assert.match(page.text, /ChatGPT/);
    assert.match(page.text, /Perplexity/);
    assert.match(page.text, /Pages AI sends people to/);
    assert.match(page.text, />\/pricing</);
    assert.match(page.text, /not tested/);
    assert.match(page.text, /Searches for your brand by name/);
    assert.doesNotMatch(page.text, /\/ignored/);
    assert.match(page.text, /Values as a table/);
  });
});
