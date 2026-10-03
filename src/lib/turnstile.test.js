import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTurnstile } from './turnstile.js';

/** A fake `fetch` that records what it was sent and answers with `reply`. */
const fake = (reply) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(init.body) });
    if (reply instanceof Error) throw reply;
    return { ok: reply.ok ?? true, status: reply.status ?? 200, json: async () => reply.json };
  };
  return { calls, fetchImpl };
};

const turnstile = (reply, extra = {}) => {
  const f = fake(reply);
  return {
    calls: f.calls,
    t: createTurnstile({ secretKey: 's3cret', fetchImpl: f.fetchImpl, ...extra }),
  };
};

describe('Turnstile verification', () => {
  test('a good token passes, and Cloudflare is sent the secret, the token and the visitor’s IP', async () => {
    const { t, calls } = turnstile({ json: { success: true, hostname: 'aeocorner.com' } });
    assert.deepEqual(await t.verify({ token: 'tok', remoteIp: '203.0.113.9' }), { ok: true });
    assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.deepEqual(calls[0].body, {
      secret: 's3cret',
      response: 'tok',
      remoteip: '203.0.113.9',
    });
  });

  test('a token Cloudflare refuses (bad, reused or expired) is rejected', async () => {
    const { t } = turnstile({ json: { success: false, 'error-codes': ['timeout-or-duplicate'] } });
    assert.deepEqual(await t.verify({ token: 'tok' }), { ok: false, reason: 'rejected' });
  });

  test('a missing, empty, non-string or oversized token is rejected without asking Cloudflare', async () => {
    const { t, calls } = turnstile({ json: { success: true } });
    for (const token of [undefined, null, '', 42, ['a'], 'x'.repeat(2049)]) {
      assert.deepEqual(await t.verify({ token }), { ok: false, reason: 'rejected' });
    }
    assert.equal(calls.length, 0);
  });

  test('a real token solved on another site is refused when we expect our own hostname', async () => {
    const reply = { json: { success: true, hostname: 'bots-r-us.example' } };
    const { t } = turnstile(reply, { expectedHostname: 'aeocorner.com' });
    assert.deepEqual(await t.verify({ token: 'tok' }), { ok: false, reason: 'wrong_site' });
    const ours = turnstile(
      { json: { success: true, hostname: 'aeocorner.com' } },
      { expectedHostname: 'aeocorner.com' },
    );
    assert.deepEqual(await ours.t.verify({ token: 'tok' }), { ok: true });
  });

  test('it fails closed: no secret, an unreachable Cloudflare, an error status and nonsense never pass', async () => {
    const none = createTurnstile({ secretKey: null });
    assert.deepEqual(await none.verify({ token: 'tok' }), { ok: false, reason: 'not_configured' });

    for (const reply of [
      new Error('network down'),
      { ok: false, status: 503, json: {} },
      { json: null },
      { json: 'yes' },
      { json: { success: 'true' } },
      { json: {} },
    ]) {
      const { t } = turnstile(reply);
      assert.deepEqual(await t.verify({ token: 'tok' }), { ok: false, reason: 'unavailable' });
    }
  });

  test('Cloudflare’s own internal error is "unavailable", not the visitor’s fault', async () => {
    const { t } = turnstile({ json: { success: false, 'error-codes': ['internal-error'] } });
    assert.deepEqual(await t.verify({ token: 'tok' }), { ok: false, reason: 'unavailable' });
  });
});
