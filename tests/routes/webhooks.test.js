import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { authHarness, clerkKeys, svixHeaders } from './auth-helpers.js';

const h = authHarness();
after(() => h.close());

const secret = clerkKeys.CLERK_WEBHOOK_SECRET;
const nextId = () => h.fx.webhookId();

function userData(clerkUser, overrides = {}) {
  return {
    id: clerkUser.id,
    first_name: 'Maya',
    last_name: 'Chen',
    image_url: 'https://img.example.test/a.png',
    primary_email_address_id: 'idn_1',
    email_addresses: [
      { id: 'idn_1', email_address: clerkUser.email, verification: { status: 'verified' } },
    ],
    updated_at: Date.now(),
    ...overrides,
  };
}

/** POST a signed event; `sign` can be turned off or tampered with to test rejection. */
function deliver(type, data, { id = nextId(), tamper, timestamp, signSecret = secret } = {}) {
  const body = JSON.stringify({ type, object: 'event', data, timestamp: Date.now() });
  const headers = svixHeaders({ secret: signSecret, id, body, timestamp });
  const sent = tamper ? tamper(body) : body;
  return { id, req: h.agent.post('/webhooks/clerk').set(headers).send(sent) };
}

describe('signature check', () => {
  test('a correctly signed event is accepted and applied', async () => {
    const clerkUser = h.fx.clerkUser();
    const { id, req } = deliver('user.created', userData(clerkUser));
    const res = await req.expect(200);
    assert.equal(res.body.status, 'processed');

    const user = await h.db.users.findByClerkId(clerkUser.id);
    h.fx.trackUser(user.id);
    assert.equal(user.name, 'Maya Chen');
    assert.equal(user.email, clerkUser.email);

    const stored = await h.db.webhookEvents.find('clerk', id);
    assert.equal(stored.status, 'processed');
    assert.equal(stored.event_type, 'user.created');
  });

  test('a body changed after signing is rejected, and nothing is stored or created', async () => {
    const clerkUser = h.fx.clerkUser();
    const { id, req } = deliver('user.created', userData(clerkUser), {
      tamper: (body) => body.replace('Maya', 'Mallory'),
    });
    await req.expect(400);
    assert.equal(await h.db.webhookEvents.find('clerk', id), null);
    assert.equal(await h.db.users.findByClerkId(clerkUser.id), null);
  });

  test('a signature from the wrong secret is rejected', async () => {
    const clerkUser = h.fx.clerkUser();
    const wrong = `whsec_${Buffer.from('another-secret-entirely-1234').toString('base64')}`;
    const { req } = deliver('user.created', userData(clerkUser), { signSecret: wrong });
    await req.expect(400);
    assert.equal(await h.db.users.findByClerkId(clerkUser.id), null);
  });

  test('an old signature (replay of a captured request) is rejected', async () => {
    const clerkUser = h.fx.clerkUser();
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const { req } = deliver('user.created', userData(clerkUser), { timestamp: tenMinutesAgo });
    await req.expect(400);
  });

  test('a request with no signature headers is rejected', async () => {
    await h.agent
      .post('/webhooks/clerk')
      .set('content-type', 'application/json')
      .send('{"type":"user.created","data":{}}')
      .expect(400);
  });

  test('without a webhook secret configured the endpoint is off, not open', async () => {
    const off = authHarness({ env: { CLERK_WEBHOOK_SECRET: '' } });
    try {
      await off.agent
        .post('/webhooks/clerk')
        .set('content-type', 'application/json')
        .send('{}')
        .expect(503);
    } finally {
      await off.close();
    }
  });
});

describe('replays and ordering', () => {
  test('the same svix-id twice is a no-op the second time', async () => {
    const clerkUser = h.fx.clerkUser();
    const id = nextId();
    const data = userData(clerkUser);

    assert.equal(
      (await deliver('user.created', data, { id }).req.expect(200)).body.status,
      'processed',
    );
    h.fx.trackUser((await h.db.users.findByClerkId(clerkUser.id)).id);

    // Change the stored user behind the event's back: a real replay must not overwrite it.
    await h.db.users.applyClerkUpdate({
      ...clerkUser,
      name: 'Changed Later',
      updatedAt: Date.now() + 10_000,
    });
    assert.equal(
      (await deliver('user.created', data, { id }).req.expect(200)).body.status,
      'duplicate',
    );
    assert.equal((await h.db.users.findByClerkId(clerkUser.id)).name, 'Changed Later');
    assert.equal((await h.db.webhookEvents.find('clerk', id)).attempts, 1);
  });

  test('an update older than what we already hold is dropped', async () => {
    const clerkUser = h.fx.clerkUser();
    const t = Date.now();
    await deliver(
      'user.created',
      userData(clerkUser, { first_name: 'New', updated_at: t }),
    ).req.expect(200);
    h.fx.trackUser((await h.db.users.findByClerkId(clerkUser.id)).id);

    await deliver(
      'user.updated',
      userData(clerkUser, { first_name: 'Older', updated_at: t - 60_000 }),
    ).req.expect(200);
    assert.equal((await h.db.users.findByClerkId(clerkUser.id)).name, 'New Chen');

    await deliver(
      'user.updated',
      userData(clerkUser, { first_name: 'Newest', updated_at: t + 60_000 }),
    ).req.expect(200);
    assert.equal((await h.db.users.findByClerkId(clerkUser.id)).name, 'Newest Chen');
  });

  test('"updated" arriving before "created" creates the user; the late "created" changes nothing', async () => {
    const clerkUser = h.fx.clerkUser();
    const t = Date.now();
    await deliver(
      'user.updated',
      userData(clerkUser, { first_name: 'Second', updated_at: t + 1000 }),
    ).req.expect(200);
    h.fx.trackUser((await h.db.users.findByClerkId(clerkUser.id)).id);
    await deliver(
      'user.created',
      userData(clerkUser, { first_name: 'First', updated_at: t }),
    ).req.expect(200);
    assert.equal((await h.db.users.findByClerkId(clerkUser.id)).name, 'Second Chen');
  });

  test('a deletion anonymizes the user, and a stale update afterwards cannot bring them back', async () => {
    const { org, owner } = await h.fx.org();
    const { user: member } = await h.fx.member(org, 'editor');
    const t = Date.now();

    await deliver('user.deleted', {
      id: member.clerk_user_id,
      object: 'user',
      deleted: true,
    }).req.expect(200);
    const row = await h.db.users.findById(member.id);
    assert.ok(row.deleted_at);
    assert.equal(row.name, '');
    assert.equal(await h.db.forOrg(org.id).memberships.getByUser(member.id), null);
    assert.ok(await h.db.forOrg(org.id).memberships.getByUser(owner.id));

    await deliver(
      'user.updated',
      userData(
        { id: member.clerk_user_id, email: 'back@example.test' },
        { updated_at: t + 99_999 },
      ),
    ).req.expect(200);
    assert.equal((await h.db.users.findById(member.id)).name, '');
  });

  test('event types we do not use are recorded and ignored', async () => {
    const { id, req } = deliver('session.created', { id: 'sess_1' });
    assert.equal((await req.expect(200)).body.status, 'ignored');
    assert.equal((await h.db.webhookEvents.find('clerk', id)).status, 'ignored');
  });
});

describe('when processing fails', () => {
  test('Clerk gets a 500 so it retries, the event is kept as failed, and the retry succeeds', async () => {
    const clerkUser = h.fx.clerkUser();
    const id = nextId();
    const original = h.db.users.applyClerkUpdate;
    h.db.users.applyClerkUpdate = async () => {
      throw new Error('database is on fire');
    };
    try {
      await deliver('user.created', userData(clerkUser), { id }).req.expect(500);
    } finally {
      h.db.users.applyClerkUpdate = original;
    }
    const failed = await h.db.webhookEvents.find('clerk', id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /database is on fire/);

    // Clerk's retry carries the same svix-id.
    const retry = await deliver('user.created', userData(clerkUser), { id }).req.expect(200);
    assert.equal(retry.body.status, 'processed');
    h.fx.trackUser((await h.db.users.findByClerkId(clerkUser.id)).id);
    const done = await h.db.webhookEvents.find('clerk', id);
    assert.deepEqual([done.status, done.attempts, done.error], ['processed', 2, null]);
  });
});
