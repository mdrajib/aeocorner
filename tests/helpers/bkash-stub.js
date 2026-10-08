/**
 * A stand-in for bKash's tokenized checkout API, as a `fetch` (no socket needed): token grant and refresh, create, execute
 * and payment status, with the same shapes and the same refusals the client has to handle. A payment becomes executable
 * only after `approve(paymentId)`, as it does when the customer approves on bKash's page.
 *
 * The real sandbox has NOT been used yet (it needs the founder's merchant credentials), so this is built from bKash's
 * documentation and says what we believe the API does, not what it was seen to do.
 */

export const STUB_CREDENTIALS = Object.freeze({
  appKey: 'stub-app-key',
  appSecret: 'stub-app-secret',
  username: 'stub-user',
  password: 'stub-pass',
});

const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const refused = (statusCode, statusMessage) => json({ statusCode, statusMessage });

export function startBkashStub({ expiresIn = 3600 } = {}) {
  const payments = new Map();
  const calls = [];
  const tokens = new Set();
  const refreshTokens = new Set();
  let n = 0;
  let down = false;

  const stub = {
    payments,
    calls,
    grants: () => calls.filter((c) => c.path.endsWith('/token/grant')).length,
    refreshes: () => calls.filter((c) => c.path.endsWith('/token/refresh')).length,
    /** The customer approves the payment on bKash's page. */
    approve(paymentId) {
      payments.get(paymentId).approved = true;
    },
    /** bKash decides the payment failed (declined, insufficient balance…). */
    fail(paymentId) {
      payments.get(paymentId).status = 'Failed';
    },
    /** Every call from now on is a network failure. */
    setDown(value) {
      down = value;
    },
    /** Forget every token, as if they had expired on bKash's side. */
    expireTokens() {
      tokens.clear();
    },
    async fetch(url, init) {
      if (down) throw new TypeError('fetch failed');
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      const headers = init.headers;
      calls.push({ path, body, headers });

      if (path.endsWith('/token/grant') || path.endsWith('/token/refresh')) {
        const ok =
          headers.username === STUB_CREDENTIALS.username &&
          headers.password === STUB_CREDENTIALS.password &&
          body.app_key === STUB_CREDENTIALS.appKey &&
          body.app_secret === STUB_CREDENTIALS.appSecret;
        if (!ok) return refused('2079', 'Invalid credentials');
        if (path.endsWith('/token/refresh') && !refreshTokens.has(body.refresh_token)) {
          return refused('2079', 'Invalid refresh token');
        }
        n += 1;
        const id = `id-token-${n}`;
        const refresh = `refresh-token-${n}`;
        tokens.add(id);
        refreshTokens.add(refresh);
        return json({
          statusCode: '0000',
          statusMessage: 'Successful',
          id_token: id,
          token_type: 'Bearer',
          expires_in: expiresIn,
          refresh_token: refresh,
        });
      }

      if (!tokens.has(headers.Authorization) || headers['X-APP-Key'] !== STUB_CREDENTIALS.appKey) {
        return refused('2001', 'Invalid token');
      }

      if (path.endsWith('/tokenized/checkout/create')) {
        if (
          body.currency !== 'BDT' ||
          body.intent !== 'sale' ||
          !/^\d+\.\d{2}$/.test(body.amount)
        ) {
          return refused('2065', 'Invalid payment request');
        }
        n += 1;
        const paymentID = `TR${String(n).padStart(6, '0')}`;
        payments.set(paymentID, {
          amount: body.amount,
          invoice: body.merchantInvoiceNumber,
          callbackURL: body.callbackURL,
          payerReference: body.payerReference,
          status: 'Initiated',
          approved: false,
          trxID: null,
        });
        return json({
          statusCode: '0000',
          statusMessage: 'Successful',
          paymentID,
          bkashURL: `https://sandbox.payment.bkash.com/?paymentId=${paymentID}`,
          callbackURL: body.callbackURL,
          transactionStatus: 'Initiated',
          amount: body.amount,
          currency: 'BDT',
          merchantInvoiceNumber: body.merchantInvoiceNumber,
        });
      }

      const payment = payments.get(body.paymentID);
      if (!payment) return refused('2056', 'Invalid payment ID');
      const answer = () => ({
        statusCode: '0000',
        statusMessage: 'Successful',
        paymentID: body.paymentID,
        trxID: payment.trxID ?? undefined,
        transactionStatus: payment.status,
        amount: payment.amount,
        currency: 'BDT',
        merchantInvoiceNumber: payment.invoice,
      });

      if (path.endsWith('/tokenized/checkout/execute')) {
        if (payment.status === 'Completed')
          return refused('2062', 'The payment has already been completed');
        if (payment.status === 'Failed') return refused('2023', 'Insufficient balance');
        if (!payment.approved) return refused('2054', 'The payment was not approved');
        n += 1;
        payment.status = 'Completed';
        payment.trxID = `TRX${String(n).padStart(8, '0')}`;
        return json(answer());
      }
      if (path.endsWith('/tokenized/checkout/payment/status')) return json(answer());
      return new Response('not found', { status: 404 });
    },
  };
  stub.fetchImpl = stub.fetch.bind(stub);
  return stub;
}
