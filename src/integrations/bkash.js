import { BKASH_CURRENCY } from '../core/bkash-billing.js';
import { amountString } from '../core/taka.js';

/**
 * bKash tokenized checkout, the part we use: take a token, create a payment, send the customer to bKash to approve it,
 * then execute it and read the result (ADR-0018). Plain `fetch`, no SDK, injected so a test can use a stand-in on a
 * real socket. The endpoints follow bKash's tokenized checkout API (v1.2.0-beta); they have NOT yet been run against
 * bKash's sandbox (that needs the founder's merchant credentials), so the first sandbox payment is the real check.
 *
 * Errors never carry the app secret, the password or a token: `BkashError` holds bKash's own status code and message.
 */

export const BKASH_SANDBOX_URL = 'https://tokenized.sandbox.bka.sh/v1.2.0-beta';
export const BKASH_LIVE_URL = 'https://tokenized.pay.bka.sh/v1.2.0-beta';

const TIMEOUT_MS = 20_000;
/** bKash's code for "this payment was already executed", which means a second execute is a read, not a failure. */
export const ALREADY_COMPLETED = '2062';

export class BkashError extends Error {
  constructor(message, { code = null, status = null, retryable = false } = {}) {
    super(message);
    this.name = 'BkashError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * @param {object} o
 * @param {string} o.appKey
 * @param {string} o.appSecret
 * @param {string} o.username
 * @param {string} o.password
 * @param {string} [o.baseUrl]
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => number} [o.nowMs]
 */
export function createBkash({
  appKey,
  appSecret,
  username,
  password,
  baseUrl = BKASH_SANDBOX_URL,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now,
}) {
  const root = baseUrl.replace(/\/+$/, '');
  let token = null; // { id, refresh, expiresAt }
  let pending = null;

  async function call(path, body, headers) {
    let res;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new BkashError('bKash could not be reached.', { retryable: true });
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON: handled below */
    }
    if (!res.ok || !json || typeof json !== 'object') {
      throw new BkashError('bKash gave an answer we could not read.', {
        status: res.status,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    // bKash answers 200 with a statusCode of its own; '0000' is success. Payment calls carry no statusCode on success.
    const code = json.statusCode ?? json.errorCode ?? null;
    if (code && code !== '0000') {
      throw new BkashError(String(json.statusMessage ?? json.errorMessage ?? 'bKash refused.'), {
        code: String(code),
        status: res.status,
      });
    }
    return json;
  }

  async function fetchToken() {
    const grant = { username, password };
    const now = nowMs();
    // Try to refresh an expired token first; a refused refresh falls back to a new grant.
    if (token?.refresh) {
      try {
        const r = await call(
          '/tokenized/checkout/token/refresh',
          { app_key: appKey, app_secret: appSecret, refresh_token: token.refresh },
          grant,
        );
        return store(r, now);
      } catch {
        /* fall through to a new grant */
      }
    }
    const r = await call(
      '/tokenized/checkout/token/grant',
      { app_key: appKey, app_secret: appSecret },
      grant,
    );
    return store(r, now);
  }

  function store(r, now) {
    if (typeof r.id_token !== 'string') throw new BkashError('bKash gave no access token.');
    token = {
      id: r.id_token,
      refresh: typeof r.refresh_token === 'string' ? r.refresh_token : null,
      // Renew a minute early.
      expiresAt: now + Math.max(60, Number(r.expires_in) || 3600) * 1000 - 60_000,
    };
    return token;
  }

  /** One token at a time: concurrent calls wait for the same grant. */
  async function authHeaders() {
    if (!token || token.expiresAt <= nowMs()) {
      pending ??= fetchToken().finally(() => {
        pending = null;
      });
      await pending;
    }
    return { Authorization: token.id, 'X-APP-Key': appKey };
  }

  async function authed(path, body) {
    return call(path, body, await authHeaders());
  }

  return {
    /**
     * Ask bKash for a payment. The customer is then sent to `bkashURL`; bKash sends them back to `callbackUrl` with
     * `paymentID` and `status` in the query. Mode 0011 is a plain payment: no saved agreement.
     */
    async createPayment({ amountBdt, invoiceNumber, payerReference, callbackUrl }) {
      const r = await authed('/tokenized/checkout/create', {
        mode: '0011',
        payerReference,
        callbackURL: callbackUrl,
        amount: amountString(amountBdt),
        currency: BKASH_CURRENCY,
        intent: 'sale',
        merchantInvoiceNumber: invoiceNumber,
      });
      if (typeof r.paymentID !== 'string' || !/^https:\/\//.test(r.bkashURL ?? '')) {
        throw new BkashError('bKash gave no payment page.');
      }
      return { paymentId: r.paymentID, url: r.bkashURL };
    },

    /** Take the money, after the customer approved. The answer is the only proof a payment happened. */
    async executePayment(paymentId) {
      const r = await authed('/tokenized/checkout/execute', { paymentID: paymentId });
      return readPayment(r);
    },

    /** Ask what became of a payment (also how a double execute and a lost callback are settled). */
    async queryPayment(paymentId) {
      const r = await authed('/tokenized/checkout/payment/status', { paymentID: paymentId });
      return readPayment(r);
    },
  };
}

/** The few fields we keep from a payment answer. A status we do not know is `unknown`, never completed. */
function readPayment(r) {
  const status = String(r.transactionStatus ?? '');
  return {
    paymentId: typeof r.paymentID === 'string' ? r.paymentID : null,
    trxId: typeof r.trxID === 'string' && r.trxID ? r.trxID : null,
    status: status === 'Completed' ? 'completed' : status === 'Initiated' ? 'initiated' : 'unknown',
    rawStatus: status,
    amount: r.amount == null ? null : Number(r.amount),
    currency: typeof r.currency === 'string' ? r.currency : null,
    invoiceNumber: typeof r.merchantInvoiceNumber === 'string' ? r.merchantInvoiceNumber : null,
  };
}
