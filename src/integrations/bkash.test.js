import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STUB_CREDENTIALS, startBkashStub } from '../../tests/helpers/bkash-stub.js';
import { ALREADY_COMPLETED, BkashError, createBkash } from './bkash.js';

function client(stub, extra = {}) {
  return createBkash({
    ...STUB_CREDENTIALS,
    baseUrl: 'https://tokenized.sandbox.bka.sh/v1.2.0-beta',
    fetchImpl: stub.fetchImpl,
    ...extra,
  });
}

const request = {
  amountBdt: 2500,
  invoiceNumber: 'AEO-12345678-abc-def',
  payerReference: 'ORG1',
  callbackUrl: 'https://aeocorner.com/app/o/X/billing/bkash/return',
};

describe('bKash client', () => {
  test('creates a payment: amount with two decimals, taka, a sale, our invoice number; returns the page to send the customer to', async () => {
    const stub = startBkashStub();
    const { paymentId, url } = await client(stub).createPayment(request);
    const call = stub.calls.find((c) => c.path.endsWith('/create'));
    assert.equal(call.body.amount, '2500.00');
    assert.equal(call.body.currency, 'BDT');
    assert.equal(call.body.intent, 'sale');
    assert.equal(call.body.mode, '0011');
    assert.equal(call.body.merchantInvoiceNumber, request.invoiceNumber);
    assert.equal(call.body.callbackURL, request.callbackUrl);
    assert.match(paymentId, /^TR\d+$/);
    assert.ok(url.startsWith('https://'));
    // The token goes in Authorization, the app key in X-APP-Key.
    assert.match(call.headers.Authorization, /^id-token-/);
    assert.equal(call.headers['X-APP-Key'], STUB_CREDENTIALS.appKey);
  });

  test('one token serves many calls, and an expired one is refreshed, not granted again', async () => {
    const stub = startBkashStub();
    let now = 1_000_000;
    const bkash = client(stub, { nowMs: () => now });
    await bkash.createPayment(request);
    await bkash.createPayment(request);
    assert.equal(stub.grants(), 1);

    now += 2 * 3600 * 1000;
    await bkash.createPayment(request);
    assert.equal(stub.grants(), 1);
    assert.equal(stub.refreshes(), 1);
  });

  test('concurrent first calls share one token grant', async () => {
    const stub = startBkashStub();
    const bkash = client(stub);
    await Promise.all([
      bkash.createPayment(request),
      bkash.createPayment(request),
      bkash.createPayment(request),
    ]);
    assert.equal(stub.grants(), 1);
  });

  test('wrong credentials are a BkashError with bKash’s code, and the message holds no secret', async () => {
    const stub = startBkashStub();
    const bad = client(stub, { appSecret: 'wrong-secret-value', password: 'wrong-password' });
    await assert.rejects(bad.createPayment(request), (err) => {
      assert.ok(err instanceof BkashError);
      assert.equal(err.code, '2079');
      assert.doesNotMatch(err.message, /wrong-secret-value|wrong-password/);
      return true;
    });
  });

  test('execute completes an approved payment and reports the transaction, amount, currency and invoice', async () => {
    const stub = startBkashStub();
    const bkash = client(stub);
    const { paymentId } = await bkash.createPayment(request);
    stub.approve(paymentId);
    const result = await bkash.executePayment(paymentId);
    assert.equal(result.status, 'completed');
    assert.match(result.trxId, /^TRX/);
    assert.equal(result.amount, 2500);
    assert.equal(result.currency, 'BDT');
    assert.equal(result.invoiceNumber, request.invoiceNumber);
  });

  test('a payment the customer did not approve cannot be executed', async () => {
    const stub = startBkashStub();
    const bkash = client(stub);
    const { paymentId } = await bkash.createPayment(request);
    await assert.rejects(bkash.executePayment(paymentId), (err) => err.code === '2054');
  });

  test('executing twice says it is already completed, and a status query then reads the result', async () => {
    const stub = startBkashStub();
    const bkash = client(stub);
    const { paymentId } = await bkash.createPayment(request);
    stub.approve(paymentId);
    await bkash.executePayment(paymentId);
    await assert.rejects(bkash.executePayment(paymentId), (err) => err.code === ALREADY_COMPLETED);
    assert.equal((await bkash.queryPayment(paymentId)).status, 'completed');
  });

  test('a payment that has not been approved reads as initiated, never completed', async () => {
    const stub = startBkashStub();
    const bkash = client(stub);
    const { paymentId } = await bkash.createPayment(request);
    assert.equal((await bkash.queryPayment(paymentId)).status, 'initiated');
  });

  test('a status we do not know is "unknown", never completed', async () => {
    const stub = startBkashStub();
    const bkash = client(stub);
    const { paymentId } = await bkash.createPayment(request);
    stub.fail(paymentId);
    const result = await bkash.queryPayment(paymentId);
    assert.equal(result.status, 'unknown');
    assert.equal(result.rawStatus, 'Failed');
  });

  test('a network failure is retryable; a refusal is not', async () => {
    const stub = startBkashStub();
    const bkash = client(stub);
    stub.setDown(true);
    await assert.rejects(
      bkash.createPayment(request),
      (err) => err instanceof BkashError && err.retryable,
    );
    stub.setDown(false);
    await assert.rejects(
      bkash.queryPayment('NOPE'),
      (err) => err.code === '2056' && !err.retryable,
    );
  });

  test('an answer that is not what we expect is an error, not a payment page', async () => {
    const bkash = createBkash({
      ...STUB_CREDENTIALS,
      fetchImpl: async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes('grant')
              ? { statusCode: '0000', id_token: 't', expires_in: 3600 }
              : { statusCode: '0000', paymentID: 'P1', bkashURL: 'http://not-https.example/pay' },
          ),
        ),
    });
    await assert.rejects(bkash.createPayment(request), BkashError);
  });
});
