import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe, as much of it as billing needs (Milestone 8). Checked against Stripe's docs on 2026-10-04: the API takes
 * form-encoded bodies and answers JSON; a billing meter event is `POST /v1/billing/meter_events` with `event_name`,
 * `payload[stripe_customer_id]`, `payload[value]` and an `identifier` (unique for at least 24 hours, at most 100
 * characters; `timestamp` must be within 35 days back or 5 minutes ahead); a webhook is signed with HMAC-SHA256 over
 * `<t>.<raw body>`, header `Stripe-Signature: t=…,v1=…`, and a five-minute tolerance is the library default.
 *
 * No SDK: the calls are few, and a client we can hand a fake `fetch` is what lets every test run without Stripe.
 * Card details never come here: the customer types them on Stripe's own pages (Checkout and the Customer Portal).
 */

const API = 'https://api.stripe.com';
const TIMEOUT_MS = 20_000;
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeError extends Error {
  constructor(message, { status = null, code = null, type = null } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

/** Stripe's form encoding: nested keys as `a[b][0][c]`, arrays by index, `undefined` and `null` left out. */
export function formEncode(params) {
  const pairs = [];
  const walk = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}[${k}]` : k, v);
    } else {
      pairs.push([prefix, String(value)]);
    }
  };
  walk('', params);
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export function createStripe({
  secretKey,
  apiVersion = null,
  baseUrl = API,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  if (!secretKey) throw new TypeError('A Stripe secret key is required');

  async function call(method, path, params, { idempotencyKey = null } = {}) {
    const bodyless = method === 'GET';
    const body = !bodyless && params ? formEncode(params) : undefined;
    const query = bodyless && params ? `?${formEncode(params)}` : '';
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}${query}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(apiVersion ? { 'Stripe-Version': apiVersion } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new StripeError('Stripe could not be reached.', { code: 'unreachable' });
    }
    let json = null;
    try {
      json = await response.json();
    } catch {
      /* an unreadable answer is handled below */
    }
    if (!response.ok) {
      const e = json?.error ?? {};
      // Stripe's own message is safe to keep: it never contains our key or a card number.
      throw new StripeError(e.message ?? `Stripe answered ${response.status}.`, {
        status: response.status,
        code: e.code ?? null,
        type: e.type ?? null,
      });
    }
    if (json === null || typeof json !== 'object') {
      throw new StripeError('Stripe answered something unreadable.', { status: response.status });
    }
    return json;
  }

  return {
    products: {
      retrieve: (id) => call('GET', `/v1/products/${encodeURIComponent(id)}`),
      create: (params, opts) => call('POST', '/v1/products', params, opts),
    },
    prices: {
      /** Prices by lookup key (one call for all of them). */
      list: (lookupKeys) =>
        call('GET', '/v1/prices', { lookup_keys: lookupKeys, active: true, limit: 100 }),
      create: (params, opts) => call('POST', '/v1/prices', params, opts),
    },
    meters: {
      list: () => call('GET', '/v1/billing/meters', { limit: 100 }),
      create: (params, opts) => call('POST', '/v1/billing/meters', params, opts),
    },
    meterEvents: {
      create: ({ eventName, customerId, value, identifier, timestamp }) =>
        call('POST', '/v1/billing/meter_events', {
          event_name: eventName,
          payload: { stripe_customer_id: customerId, value },
          identifier,
          timestamp,
        }),
    },
    customers: {
      create: (params, opts) => call('POST', '/v1/customers', params, opts),
      retrieve: (id) => call('GET', `/v1/customers/${encodeURIComponent(id)}`),
    },
    checkout: {
      create: (params, opts) => call('POST', '/v1/checkout/sessions', params, opts),
    },
    portal: {
      create: (params) => call('POST', '/v1/billing_portal/sessions', params),
    },
    subscriptions: {
      retrieve: (id) =>
        call('GET', `/v1/subscriptions/${encodeURIComponent(id)}`, {
          expand: ['items.data.price'],
        }),
      list: ({ customer, status = 'all' }) =>
        call('GET', '/v1/subscriptions', {
          customer,
          status,
          limit: 20,
          expand: ['data.items.data.price'],
        }),
      /** Move the plan item to another price (prorated). `itemId` is the subscription item that holds the plan. */
      changePlan: (id, { itemId, priceId }) =>
        call('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, {
          items: [{ id: itemId, price: priceId }],
          proration_behavior: 'create_prorations',
        }),
      cancelAtPeriodEnd: (id, cancel = true) =>
        call('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, {
          cancel_at_period_end: cancel,
        }),
    },
    subscriptionItems: {
      create: ({ subscription, priceId, quantity }) =>
        call('POST', '/v1/subscription_items', {
          subscription,
          price: priceId,
          quantity,
          proration_behavior: 'create_prorations',
        }),
      remove: (id) =>
        call('DELETE', `/v1/subscription_items/${encodeURIComponent(id)}`, {
          proration_behavior: 'create_prorations',
        }),
    },
  };
}

/**
 * Verify a webhook against its raw body. Throws `StripeError` (code `bad_signature` or `stale`) unless a `v1`
 * signature matches the secret and the timestamp is within five minutes. Schemes other than `v1` are ignored (the
 * test-only `v0` must never count), and several `v1` values are accepted because Stripe sends one per active secret
 * while a secret is being rolled.
 *
 * @param {Buffer|string} rawBody   the body exactly as received
 * @param {string} header           the `Stripe-Signature` header
 * @param {string|string[]} secrets the endpoint's signing secret(s)
 */
export function verifyStripeSignature(rawBody, header, secrets, { now = Date.now() } = {}) {
  const fail = (code, message) => {
    throw new StripeError(message, { code });
  };
  if (typeof header !== 'string' || header.length === 0 || header.length > 2000) {
    fail('bad_signature', 'Missing signature.');
  }
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!/^\d{1,12}$/.test(timestamp ?? '') || signatures.length === 0) {
    fail('bad_signature', 'Malformed signature.');
  }
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]);
  const secretList = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  const matches = secretList.some((secret) => {
    const expected = createHmac('sha256', secret).update(payload).digest();
    return signatures.some((sig) => {
      if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
      return timingSafeEqual(expected, Buffer.from(sig, 'hex'));
    });
  });
  if (!matches) fail('bad_signature', 'The signature does not match.');
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    fail('stale', 'The signature is too old.');
  }
  return JSON.parse(Buffer.from(rawBody).toString('utf8'));
}

/** Sign a body the way Stripe does. For tests and the local replay script; production only ever verifies. */
export function signStripePayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]))
    .digest('hex');
  return `t=${timestamp},v1=${mac}`;
}
