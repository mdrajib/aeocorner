import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { signStripePayload } from '../../src/integrations/stripe.js';
import { authHarness, clerkKeys, svixHeaders } from './auth-helpers.js';

/**
 * The webhook audit (Milestone 10, task 10.03). Every endpoint that accepts a call from another company is attacked
 * the same way, so a new one can't be added with a weaker door: no signature, a wrong secret, a changed body, an old
 * timestamp, a garbled header, and no secret configured at all. A rejected call must not leave a `webhook_events`
 * row and must not reach a handler. The per-sender suites (webhooks, billing, notifications) test what the events DO.
 */

const STRIPE_SECRET = 'whsec_audit_stripe_secret';
const RESEND_SECRET = `whsec_${Buffer.from('resend-audit-secret-resend-audit').toString('base64')}`;
const h = authHarness({
  billing: { stripe: {} },
  env: {
    STRIPE_SECRET_KEY: 'sk_test_stub',
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    RESEND_WEBHOOK_SECRET: RESEND_SECRET,
  },
});
after(() => h.close());

const now = () => Math.floor(Date.now() / 1000);

/** One sender: how to sign a body for it, and what a good body looks like. */
const SENDERS = [
  {
    source: 'clerk',
    path: '/webhooks/clerk',
    secret: clerkKeys.CLERK_WEBHOOK_SECRET,
    body: (id) =>
      JSON.stringify({ type: 'user.updated', object: 'event', data: { id: 'user_x' }, id }),
    sign: ({ secret, id, body, timestamp }) => svixHeaders({ secret, id, body, timestamp }),
    unconfigured: { CLERK_WEBHOOK_SECRET: '' },
  },
  {
    source: 'stripe',
    path: '/webhooks/stripe',
    secret: STRIPE_SECRET,
    body: (id) => JSON.stringify({ id, object: 'event', type: 'ping.audit', data: { object: {} } }),
    sign: ({ secret, body, timestamp }) => ({
      'stripe-signature': signStripePayload(body, secret, timestamp),
      'content-type': 'application/json',
    }),
    unconfigured: { STRIPE_WEBHOOK_SECRET: '' },
  },
  {
    source: 'resend',
    path: '/webhooks/resend',
    secret: RESEND_SECRET,
    body: () => JSON.stringify({ type: 'email.delivered', data: { email_id: 'x' } }),
    sign: ({ secret, id, body, timestamp }) => svixHeaders({ secret, id, body, timestamp }),
    unconfigured: { RESEND_WEBHOOK_SECRET: '' },
  },
];

for (const s of SENDERS) {
  describe(`${s.source}: ${s.path}`, () => {
    const attempt = async ({
      id = h.fx.webhookId(),
      headers,
      body,
      secret = s.secret,
      timestamp,
    }) => {
      const text = body ?? s.body(id);
      const signed = headers ?? s.sign({ secret, id, body: text, timestamp });
      const res = await h.agent.post(s.path).set(signed).send(text);
      return { id, res };
    };
    const recorded = (id) => h.db.webhookEvents.find(s.source, id);

    test('a correctly signed call gets past the door (it is recorded)', async () => {
      const { id, res } = await attempt({});
      assert.ok([200, 500].includes(res.status), `signed call answered ${res.status}`);
      assert.ok(await recorded(id), 'a verified delivery is recorded');
    });

    test('no signature headers: 400, nothing recorded', async () => {
      const id = h.fx.webhookId();
      const res = await h.agent
        .post(s.path)
        .set('content-type', 'application/json')
        .send(s.body(id));
      assert.equal(res.status, 400);
      assert.equal(await recorded(id), null);
    });

    test('signed with the wrong secret: 400, nothing recorded', async () => {
      const wrong =
        s.secret.startsWith('whsec_') && s.source !== 'stripe'
          ? `whsec_${Buffer.from('some-other-secret-entirely-xx').toString('base64')}`
          : 'whsec_some_other_secret';
      const { id, res } = await attempt({ secret: wrong });
      assert.equal(res.status, 400);
      assert.equal(await recorded(id), null);
    });

    test('a body changed after signing: 400, nothing recorded', async () => {
      const id = h.fx.webhookId();
      const original = s.body(id);
      const headers = s.sign({ secret: s.secret, id, body: original });
      const tampered = original.replace(/"type":"([^"]+)"/, '"type":"user.deleted"');
      assert.notEqual(tampered, original);
      const res = await h.agent.post(s.path).set(headers).send(tampered);
      assert.equal(res.status, 400);
      assert.equal(await recorded(id), null);
    });

    test('a correctly signed but old call (10 minutes) is refused: no replaying a captured request', async () => {
      const { id, res } = await attempt({ timestamp: now() - 600 });
      assert.equal(res.status, 400);
      assert.equal(await recorded(id), null);
    });

    test('a signature from the far future is refused too', async () => {
      const { id, res } = await attempt({ timestamp: now() + 3600 });
      assert.equal(res.status, 400);
      assert.equal(await recorded(id), null);
    });

    test('a garbled or empty signature header is refused without a crash', async () => {
      for (const garbage of ['', 'v1,', 'v1,!!!', 't=,v1=', 't=abc,v1=zz', 'x'.repeat(5000)]) {
        const id = h.fx.webhookId();
        const headers = {
          'content-type': 'application/json',
          'svix-id': id,
          'svix-timestamp': String(now()),
          'svix-signature': garbage,
          'stripe-signature': garbage,
        };
        const res = await h.agent.post(s.path).set(headers).send(s.body(id));
        assert.equal(
          res.status,
          400,
          `signature ${JSON.stringify(garbage).slice(0, 20)} answered ${res.status}`,
        );
        assert.equal(await recorded(id), null);
      }
    });

    test('a body that is not JSON is refused even if the signature is right', async () => {
      const id = h.fx.webhookId();
      const body = 'this is not json';
      const res = await h.agent
        .post(s.path)
        .set(s.sign({ secret: s.secret, id, body }))
        .send(body);
      assert.equal(res.status, 400);
      assert.equal(await recorded(id), null);
    });

    test('it is a POST door only: GET answers 404 and says nothing', async () => {
      const res = await h.agent.get(s.path);
      assert.equal(res.status, 404);
    });

    test('with no secret configured the door is shut (503), not open', async () => {
      const off = authHarness({
        billing: { stripe: {} },
        env: {
          STRIPE_SECRET_KEY: 'sk_test_stub',
          STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
          RESEND_WEBHOOK_SECRET: RESEND_SECRET,
          ...s.unconfigured,
        },
      });
      try {
        const id = off.fx.webhookId();
        const body = s.body(id);
        const res = await off.agent
          .post(s.path)
          .set(s.sign({ secret: s.secret, id, body }))
          .send(body);
        assert.equal(res.status, 503);
        assert.equal(await off.db.webhookEvents.find(s.source, id), null);
      } finally {
        await off.close();
      }
    });
  });
}

describe('inventory: every door for another company is one of the audited ones', () => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory()
        ? walk(p)
        : p.endsWith('.js') && !p.endsWith('.test.js')
          ? [p]
          : [];
    });

  test('only /webhooks/clerk, /stripe and /resend are registered under /webhooks', () => {
    const found = new Set();
    for (const file of walk(
      new URL('../../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    )) {
      for (const m of readFileSync(file, 'utf8').matchAll(/['"`](\/webhooks\/[a-z0-9_-]+)/gi))
        found.add(m[1]);
    }
    assert.deepEqual([...found].sort(), SENDERS.map((s) => s.path).sort());
  });

  test('the senders the staff audit names are all covered here', () => {
    assert.deepEqual(SENDERS.map((s) => s.source).sort(), ['clerk', 'resend', 'stripe']);
  });
});
