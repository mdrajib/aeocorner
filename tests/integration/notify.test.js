import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { MailError, memoryMailer } from '../../src/lib/mailer.js';
import { createNotifier } from '../../src/lib/notify.js';

/** The notifier (Milestone 8, tasks 8.15 and 8.16): dedupe, suppressions, the one-a-day cap and one-click unsubscribe. */

const db = connectTestDb();
const fx = fixtures(db);
const SECRET = 'test-secret-test-secret-test-secret-123';
let clock = new Date('2026-10-05T08:00:00Z');
const mailer = memoryMailer();
const notifier = createNotifier({
  db,
  mailer,
  baseUrl: 'https://aeocorner.test',
  secret: SECRET,
  now: () => clock,
});
after(async () => {
  await fx.cleanup();
  await db.close();
});

describe('the notifier’s rules', () => {
  test('an unknown kind is an error, not a silent skip', async () => {
    const user = await fx.user();
    await assert.rejects(
      notifier.send({
        to: user.email,
        userId: user.id,
        kind: 'nonsense',
        dedupeKey: 'k',
        data: {},
      }),
      TypeError,
    );
  });
});

describe('account messages (a trial ending)', () => {
  const send = (user, org, over = {}) =>
    notifier.sendTrialEnding({
      to: user.email,
      userId: user.id,
      orgId: org.id,
      orgName: 'Acme',
      orgPublicId: org.public_id,
      subscriptionId: 77,
      planName: 'Starter',
      priceText: '$79',
      chargeDate: new Date('2026-10-18T00:00:00Z'),
      ...over,
    });

  test('is sent once however often it is asked for, with no unsubscribe', async () => {
    const { org, owner } = await fx.org();
    mailer.sent.length = 0;
    assert.equal(await send(owner, org), true);
    assert.equal(await send(owner, org), false);
    assert.equal(await send(owner, org), false);
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].headers, undefined);
    assert.doesNotMatch(mailer.sent[0].email.html, /Unsubscribe/);
    const [row] = await db.notifications.messages.recentForUser(owner.id);
    assert.equal(row.status, 'sent');
    assert.equal(row.category, 'transactional');
    assert.equal(row.provider_message_id, 'memory-' + mailer.sent.length);
  });

  test('never goes to an address on the suppression list, and the refusal is recorded', async () => {
    const { org, owner } = await fx.org();
    mailer.sent.length = 0;
    await db.notifications.suppressions.add({ email: owner.email, reason: 'bounce' });
    assert.equal(await send(owner, org, { subscriptionId: 78 }), false);
    assert.equal(mailer.sent.length, 0);
    const [row] = await db.notifications.messages.recentForUser(owner.id);
    assert.equal(row.status, 'suppressed');
    assert.equal(row.error, 'address_suppressed');
  });

  test('suppression ignores case and spaces, and adding twice is harmless', async () => {
    const email = `Mixed.Case.${Date.now()}@Example.test`;
    assert.equal(await db.notifications.suppressions.add({ email, reason: 'complaint' }), true);
    assert.equal(
      await db.notifications.suppressions.add({ email: email.toUpperCase(), reason: 'bounce' }),
      false,
    );
    assert.equal(
      await db.notifications.suppressions.isSuppressed(`  ${email.toLowerCase()} `),
      true,
    );
  });

  test('a send the provider asks us to retry stays queued and throws; the retry sends it exactly once', async () => {
    const { org, owner } = await fx.org();
    const flaky = {
      sent: [],
      failures: 1,
      async send(message) {
        if (this.failures-- > 0)
          throw new MailError('rate limited', { status: 429, retryable: true });
        this.sent.push(message);
        return { id: 'msg_1' };
      },
    };
    const n = createNotifier({
      db,
      mailer: flaky,
      baseUrl: 'https://aeocorner.test',
      secret: SECRET,
      now: () => clock,
    });
    const ask = () =>
      n.sendTrialEnding({
        to: owner.email,
        userId: owner.id,
        orgId: org.id,
        orgName: 'Acme',
        orgPublicId: org.public_id,
        subscriptionId: 79,
        planName: 'Starter',
        priceText: '$79',
        chargeDate: clock,
      });
    await assert.rejects(ask(), MailError);
    let [row] = await db.notifications.messages.recentForUser(owner.id);
    assert.equal(row.status, 'queued');
    assert.match(row.error, /rate limited/);
    assert.equal(await ask(), true);
    assert.equal(await ask(), false);
    [row] = await db.notifications.messages.recentForUser(owner.id);
    assert.equal(row.status, 'sent');
    assert.equal(flaky.sent.length, 1);
  });

  test('a send the provider refuses for good is marked failed and not retried', async () => {
    const { org, owner } = await fx.org();
    const refusing = {
      async send() {
        throw new MailError('invalid address', { status: 422, retryable: false });
      },
    };
    const n = createNotifier({
      db,
      mailer: refusing,
      baseUrl: 'https://aeocorner.test',
      secret: SECRET,
      now: () => clock,
    });
    const sent = await n.sendTrialEnding({
      to: owner.email,
      userId: owner.id,
      orgId: org.id,
      orgName: 'Acme',
      orgPublicId: org.public_id,
      subscriptionId: 80,
      planName: 'Starter',
      priceText: '$79',
      chargeDate: clock,
    });
    assert.equal(sent, false);
    const [row] = await db.notifications.messages.recentForUser(owner.id);
    assert.equal(row.status, 'failed');
  });
});

describe('unsubscribing', () => {
  test('switches the digest off in every organization the person belongs to, and nothing else', async () => {
    const a = await fx.org();
    const b = await fx.org({ owner: a.owner });
    const stay = await fx.org();
    const prefs = async (o) => o.scoped.notifyPrefs.get(o.owner.id);
    const off = { digest: false, alerts: true };
    const on = { digest: true, alerts: true };
    assert.equal(
      await db.notifications.preferences.unsubscribe({ userId: a.owner.id, pref: 'digest' }),
      2,
    );
    assert.deepEqual(await prefs(a), off);
    assert.deepEqual(await prefs(b), off);
    assert.deepEqual(await prefs(stay), on);
    // Again: nothing changes.
    await db.notifications.preferences.unsubscribe({ userId: a.owner.id, pref: 'digest' });
    assert.deepEqual(await prefs(a), off);
    assert.ok(b);
  });

  test('an unknown person is a quiet no-op', async () => {
    assert.equal(
      await db.notifications.preferences.unsubscribe({ userId: 999_999_999n, pref: 'all' }),
      0,
    );
  });
});
