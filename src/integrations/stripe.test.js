import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { StripeError, formEncode, signStripePayload, verifyStripeSignature } from './stripe.js';

const SECRET = 'whsec_test_secret_value';
const body = JSON.stringify({
  id: 'evt_1',
  type: 'customer.subscription.updated',
  data: { object: {} },
});

describe('formEncode', () => {
  test('nested objects and arrays use Stripe’s bracket form; null and undefined are left out', () => {
    assert.equal(
      decodeURIComponent(
        formEncode({
          mode: 'subscription',
          line_items: [{ price: 'price_1', quantity: 1 }],
          subscription_data: { metadata: { org_id: 'O1' }, trial_period_days: 14 },
          skipped: undefined,
          alsoSkipped: null,
        }),
      ),
      'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&subscription_data[metadata][org_id]=O1&subscription_data[trial_period_days]=14',
    );
  });

  test('keys and values are percent-encoded', () => {
    assert.equal(formEncode({ 'a b': 'x&y=z' }), 'a%20b=x%26y%3Dz');
  });
});

describe('verifyStripeSignature', () => {
  const now = 1_700_000_000_000;
  const at = Math.floor(now / 1000);

  test('a correct signature returns the parsed event', () => {
    const event = verifyStripeSignature(body, signStripePayload(body, SECRET, at), SECRET, { now });
    assert.equal(event.id, 'evt_1');
  });

  test('a body changed after signing is refused', () => {
    const header = signStripePayload(body, SECRET, at);
    assert.throws(
      () => verifyStripeSignature(body.replace('updated', 'deleted'), header, SECRET, { now }),
      (e) => e instanceof StripeError && e.code === 'bad_signature',
    );
  });

  test('the wrong secret, a missing header and a malformed header are refused', () => {
    const header = signStripePayload(body, SECRET, at);
    for (const bad of [
      undefined,
      '',
      'garbage',
      't=abc,v1=zz',
      `t=${at}`,
      `v1=${'0'.repeat(64)}`,
    ]) {
      assert.throws(() => verifyStripeSignature(body, bad, SECRET, { now }), StripeError);
    }
    assert.throws(() => verifyStripeSignature(body, header, 'whsec_other', { now }), StripeError);
  });

  test('a signature older than five minutes is refused, even if it is genuine (replay)', () => {
    const old = signStripePayload(body, SECRET, at - 301);
    assert.throws(
      () => verifyStripeSignature(body, old, SECRET, { now }),
      (e) => e.code === 'stale',
    );
    assert.ok(
      verifyStripeSignature(body, signStripePayload(body, SECRET, at - 299), SECRET, { now }),
    );
    const future = signStripePayload(body, SECRET, at + 400);
    assert.throws(
      () => verifyStripeSignature(body, future, SECRET, { now }),
      (e) => e.code === 'stale',
    );
  });

  test('only v1 counts: a v0 signature (Stripe sends one on test events) is ignored', () => {
    const real = signStripePayload(body, SECRET, at);
    const v1 = real.split('v1=')[1];
    assert.throws(
      () => verifyStripeSignature(body, `t=${at},v0=${v1}`, SECRET, { now }),
      StripeError,
    );
    assert.ok(
      verifyStripeSignature(body, `t=${at},v0=${'0'.repeat(64)},v1=${v1}`, SECRET, { now }),
    );
  });

  test('while a secret is being rolled, a signature from either secret is accepted', () => {
    const header = signStripePayload(body, 'whsec_old', at);
    assert.ok(verifyStripeSignature(body, header, ['whsec_new', 'whsec_old'], { now }));
    const both = `${signStripePayload(body, 'whsec_new', at)},v1=${signStripePayload(body, 'whsec_old', at).split('v1=')[1]}`;
    assert.ok(verifyStripeSignature(body, both, 'whsec_old', { now }));
  });

  test('a body that is not JSON throws after the signature passes, never before', () => {
    const junk = 'not json';
    assert.throws(
      () => verifyStripeSignature(junk, signStripePayload(junk, SECRET, at), SECRET, { now }),
      SyntaxError,
    );
  });
});
