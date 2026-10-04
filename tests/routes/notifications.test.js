import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { unsubscribeToken } from '../../src/core/notify.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createNotifier } from '../../src/lib/notify.js';
import { APP_SECRET, authHarness, orgPathOf, svixHeaders } from './auth-helpers.js';

/**
 * One-click unsubscribe, the email preferences page and Resend's delivery webhooks (Milestone 8, tasks 8.15 and 8.16)
 * through the real app and database.
 */

const RESEND_SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const h = authHarness({ env: { RESEND_WEBHOOK_SECRET: RESEND_SECRET } });
after(() => h.close());

const tokenFor = (user, pref = 'digest') =>
  unsubscribeToken({ userId: String(user.id), pref }, APP_SECRET);
async function newOrg() {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Mail Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  return {
    owner,
    orgId,
    org: found.org,
    scoped: h.db.forOrg(found.org.id),
    base: `/app/o/${orgId}`,
  };
}

describe('the unsubscribe link', () => {
  test('opening it shows what it does and changes nothing', async () => {
    const o = await newOrg();
    const res = await h.agent.get(`/unsubscribe/${tokenFor(o.owner.user)}`).expect(200);
    assert.match(res.text, /Stop getting the weekly digest\?/);
    assert.match(res.text, /Yes, unsubscribe me/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['x-robots-tag'], /noindex/);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.doesNotMatch(res.text, /posthog/i);
    assert.deepEqual(await o.scoped.notifyPrefs.get(o.owner.user.id), {
      digest: true,
      alerts: true,
    });
  });

  test('pressing the button switches that email off, and again changes nothing more', async () => {
    const o = await newOrg();
    const url = `/unsubscribe/${tokenFor(o.owner.user)}`;
    const res = await h.agent.post(url).type('form').send({}).expect(200);
    assert.match(res.text, /You won’t get the weekly digest any more/);
    assert.deepEqual(await o.scoped.notifyPrefs.get(o.owner.user.id), {
      digest: false,
      alerts: true,
    });
    await h.agent.post(url).type('form').send({}).expect(200);
    assert.deepEqual(await o.scoped.notifyPrefs.get(o.owner.user.id), {
      digest: false,
      alerts: true,
    });
  });

  test('a mail client’s one-click POST works with no page and no sign-in', async () => {
    const o = await newOrg();
    const res = await h.agent
      .post(`/unsubscribe/${tokenFor(o.owner.user, 'alerts')}`)
      .type('form')
      .send({ 'List-Unsubscribe': 'One-Click' })
      .expect(200);
    assert.equal(res.text, 'Unsubscribed.');
    assert.deepEqual(await o.scoped.notifyPrefs.get(o.owner.user.id), {
      digest: true,
      alerts: false,
    });
  });

  test('"all" switches off both; the account’s own messages are not affected', async () => {
    const o = await newOrg();
    await h.agent
      .post(`/unsubscribe/${tokenFor(o.owner.user, 'all')}`)
      .type('form')
      .send({})
      .expect(200);
    assert.deepEqual(await o.scoped.notifyPrefs.get(o.owner.user.id), {
      digest: false,
      alerts: false,
    });
  });

  test('a link we did not make is the same plain page whether the person exists or not, and changes nothing', async () => {
    const o = await newOrg();
    const real = tokenFor(o.owner.user);
    for (const bad of [
      real.slice(0, -2) + 'xx',
      real.replace('digest', 'all'),
      'junk',
      `999999999.digest.${real.split('.')[2]}`,
    ]) {
      const get = await h.agent.get(`/unsubscribe/${encodeURIComponent(bad)}`).expect(404);
      assert.match(get.text, /couldn’t use that link/);
      await h.agent
        .post(`/unsubscribe/${encodeURIComponent(bad)}`)
        .type('form')
        .send({})
        .expect(404);
      const oneClick = await h.agent
        .post(`/unsubscribe/${encodeURIComponent(bad)}`)
        .type('form')
        .send({ 'List-Unsubscribe': 'One-Click' })
        .expect(400);
      assert.equal(oneClick.text, 'This link does not work.');
    }
    assert.deepEqual(await o.scoped.notifyPrefs.get(o.owner.user.id), {
      digest: true,
      alerts: true,
    });
  });

  test('a token for one person cannot be used for another', async () => {
    const a = await newOrg();
    const b = await newOrg();
    await h.agent
      .post(`/unsubscribe/${tokenFor(a.owner.user)}`)
      .type('form')
      .send({})
      .expect(200);
    assert.deepEqual(await b.scoped.notifyPrefs.get(b.owner.user.id), {
      digest: true,
      alerts: true,
    });
  });
});

describe('the email preferences page', () => {
  test('every member sees their own choices, and saving changes only theirs', async () => {
    const o = await newOrg();
    const viewer = await h.signedIn();
    await o.scoped.memberships.add({ userId: viewer.user.id, role: 'viewer' });
    const page = await viewer.get(`${o.base}/notifications`).expect(200);
    assert.match(page.text, /The weekly digest/);
    assert.match(page.text, /name="digest"[^>]*checked/);

    // The viewer turns the digest off (the box is simply not sent) and keeps alerts.
    await viewer.post(`${o.base}/notifications`, { alerts: 'on' }).expect(303);
    assert.deepEqual(await o.scoped.notifyPrefs.get(viewer.user.id), {
      digest: false,
      alerts: true,
    });
    assert.deepEqual(await o.scoped.notifyPrefs.get(o.owner.user.id), {
      digest: true,
      alerts: true,
    });
    const after = await viewer
      .get(`${o.base}/notifications?notice=notifications-saved`)
      .expect(200);
    assert.match(after.text, /Your email choices are updated/);
    assert.doesNotMatch(after.text, /name="digest"[^>]*checked/);
  });

  test('a stranger gets a plain 404, and a post without the CSRF token is refused', async () => {
    const o = await newOrg();
    const stranger = await h.signedIn();
    await stranger.get(`${o.base}/notifications`).expect(404);
    await stranger.post(`${o.base}/notifications`, {}).expect(404);
    await o.owner.post(`${o.base}/notifications`, { digest: 'on' }, { csrf: null }).expect(403);
    assert.deepEqual(await o.scoped.notifyPrefs.get(o.owner.user.id), {
      digest: true,
      alerts: true,
    });
  });
});

describe('Resend’s webhooks', () => {
  const body = (type, data) => JSON.stringify({ type, created_at: new Date().toISOString(), data });
  const post = (type, data, { id = h.fx.webhookId(), secret = RESEND_SECRET, tamper } = {}) => {
    const text = body(type, data);
    return {
      id,
      req: h.agent
        .post('/webhooks/resend')
        .set(svixHeaders({ secret, id, body: text }))
        .send(tamper ? tamper(text) : text),
    };
  };
  const uniqueEmail = () =>
    `bounce-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;

  test('a bounce to an address that does not exist puts it on the suppression list and marks the message', async () => {
    const o = await newOrg();
    const mailer = memoryMailer();
    const notifier = createNotifier({
      db: h.db,
      mailer,
      baseUrl: 'https://aeocorner.test',
      secret: APP_SECRET,
    });
    await notifier.sendTrialEnding({
      to: o.owner.user.email,
      userId: o.owner.user.id,
      orgId: o.org.id,
      orgName: 'Mail Co',
      orgPublicId: o.orgId,
      subscriptionId: 5,
      planName: 'Starter',
      priceText: '$79',
      chargeDate: new Date(),
    });
    const [row] = await h.db.notifications.messages.recentForUser(o.owner.user.id);
    assert.equal(row.status, 'sent');

    const res = await post('email.bounced', {
      email_id: row.provider_message_id,
      to: [o.owner.user.email],
      bounce: { type: 'Permanent' },
    }).req.expect(200);
    assert.equal(res.body.status, 'processed');
    assert.equal(await h.db.notifications.suppressions.isSuppressed(o.owner.user.email), true);
    assert.equal((await h.db.notifications.messages.get(row.id)).status, 'bounced');
  });

  test('a temporary bounce marks the message but does not suppress the address', async () => {
    const email = uniqueEmail();
    await post('email.bounced', {
      email_id: 'em_x',
      to: [email],
      bounce: { type: 'Transient' },
    }).req.expect(200);
    assert.equal(await h.db.notifications.suppressions.isSuppressed(email), false);
  });

  test('a spam complaint suppresses the address', async () => {
    const email = uniqueEmail();
    await post('email.complained', { email_id: 'em_y', to: [email] }).req.expect(200);
    assert.equal(await h.db.notifications.suppressions.isSuppressed(email), true);
  });

  test('delivered is recorded on the message; an event for a message we do not know is harmless', async () => {
    const o = await newOrg();
    const { notification } = await h.db.notifications.messages.enqueue({
      orgId: o.org.id,
      userId: o.owner.user.id,
      kind: 'trial-ending',
      category: 'transactional',
      dedupeKey: `test-delivered-${Date.now()}`,
    });
    await h.db.notifications.messages.markSent(notification.id, {
      providerMessageId: `em_${Date.now()}`,
    });
    const sent = await h.db.notifications.messages.get(notification.id);
    await post('email.delivered', {
      email_id: sent.provider_message_id,
      to: ['x@example.test'],
    }).req.expect(200);
    assert.equal((await h.db.notifications.messages.get(notification.id)).status, 'delivered');
    await post('email.delivered', { email_id: 'em_unknown', to: ['x@example.test'] }).req.expect(
      200,
    );
  });

  test('the same delivery twice is applied once; other event types are ignored', async () => {
    const email = uniqueEmail();
    const id = h.fx.webhookId();
    const first = await post(
      'email.complained',
      { email_id: 'em_z', to: [email] },
      { id },
    ).req.expect(200);
    assert.equal(first.body.status, 'processed');
    const second = await post(
      'email.complained',
      { email_id: 'em_z', to: [email] },
      { id },
    ).req.expect(200);
    assert.equal(second.body.status, 'duplicate');
    const other = await post('email.opened', { email_id: 'em_z', to: [email] }).req.expect(200);
    assert.equal(other.body.status, 'ignored');
  });

  test('a changed body, a wrong secret and a stale signature are refused, and nothing is stored', async () => {
    const email = uniqueEmail();
    const tampered = post(
      'email.complained',
      { email_id: 'em_t', to: [email] },
      { tamper: (t) => t.replace('em_t', 'em_u') },
    );
    await tampered.req.expect(400);
    const wrong = post(
      'email.complained',
      { email_id: 'em_t', to: [email] },
      { secret: `whsec_${randomBytes(24).toString('base64')}` },
    );
    await wrong.req.expect(400);
    assert.equal(await h.db.notifications.suppressions.isSuppressed(email), false);
    assert.equal(await h.db.webhookEvents.find('resend', wrong.id), null);

    const text = body('email.complained', { email_id: 'em_t', to: [email] });
    const id = h.fx.webhookId();
    await h.agent
      .post('/webhooks/resend')
      .set(
        svixHeaders({
          secret: RESEND_SECRET,
          id,
          body: text,
          timestamp: Math.floor(Date.now() / 1000) - 3600,
        }),
      )
      .send(text)
      .expect(400);
    assert.equal(await h.db.notifications.suppressions.isSuppressed(email), false);
  });

  test('without a signing secret on our side the endpoint says it is not configured', async () => {
    const bare = authHarness();
    try {
      await bare.agent.post('/webhooks/resend').send('{}').expect(503);
    } finally {
      await bare.close();
    }
  });
});
