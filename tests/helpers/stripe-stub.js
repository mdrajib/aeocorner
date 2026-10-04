import { startServer } from './http-fixture.js';

/**
 * A Stripe stand-in for tests (Milestone 8): the REST calls billing makes, kept in memory, on a real socket. It is not
 * Stripe: the real checks are a test card in Stripe's test mode, which needs the founder's test keys (MILESTONES 8,
 * Definition of Done). What it does reproduce is the shape of the objects and the calls we depend on.
 *
 * Everything it receives is recorded in `calls`, so a test can say what was NOT sent (a card number, say).
 */

/** Decode Stripe's form encoding (`a[b][0][c]=1`) back into nested objects. */
export function parseForm(text) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const parts = rawKey.match(/[^[\]]+/g) ?? [];
    let node = out;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = value;
      else node = node[part] ??= /^\d+$/.test(parts[i + 1]) ? [] : {};
    });
  }
  return out;
}

export async function startStripeStub({ secretKey = 'sk_test_stub' } = {}) {
  const state = {
    products: [],
    prices: [],
    meters: [],
    meterEvents: [],
    customers: new Map(),
    subscriptions: new Map(),
    checkouts: [],
    portals: [],
    calls: [],
    failNext: null,
    seq: 0,
  };
  const next = (prefix) => `${prefix}_${(state.seq += 1).toString().padStart(4, '0')}`;
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res, status, message, code = null) =>
    json(res, status, { error: { message, code, type: 'invalid_request_error' } });

  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = parseForm(
      chunks.length ? Buffer.concat(chunks).toString('utf8') : url.search.slice(1),
    );
    state.calls.push({ method: req.method, path: url.pathname, form, headers: req.headers });

    if (req.headers.authorization !== `Bearer ${secretKey}`) {
      return error(res, 401, 'Invalid API Key provided.', 'api_key_invalid');
    }
    if (state.failNext) {
      const { status, message } = state.failNext;
      state.failNext = null;
      return error(res, status, message);
    }
    const route = `${req.method} ${url.pathname}`;

    const productGet = /^GET \/v1\/products\/([^/]+)$/.exec(route);
    if (productGet) {
      const product = state.products.find((p) => p.id === productGet[1]);
      return product
        ? json(res, 200, product)
        : error(res, 404, 'No such product.', 'resource_missing');
    }
    if (route === 'POST /v1/products') {
      const product = { id: next('prod'), object: 'product', active: true, ...form };
      state.products.push(product);
      return json(res, 200, product);
    }
    if (route === 'GET /v1/prices') {
      const keys = Object.values(form.lookup_keys ?? {});
      return json(res, 200, {
        object: 'list',
        data: state.prices.filter((p) => p.active && keys.includes(p.lookup_key)),
      });
    }
    if (route === 'POST /v1/prices') {
      const price = {
        id: next('price'),
        object: 'price',
        active: true,
        ...form,
        unit_amount: form.unit_amount === undefined ? null : Number(form.unit_amount),
      };
      state.prices.push(price);
      return json(res, 200, price);
    }
    if (route === 'GET /v1/billing/meters') {
      return json(res, 200, { object: 'list', data: state.meters });
    }
    if (route === 'POST /v1/billing/meters') {
      const meter = { id: next('mtr'), object: 'billing.meter', status: 'active', ...form };
      state.meters.push(meter);
      return json(res, 200, meter);
    }
    if (route === 'POST /v1/billing/meter_events') {
      if (state.meterEvents.some((e) => e.identifier === form.identifier)) {
        return error(res, 400, 'Duplicate identifier.', 'billing_meter_event_duplicate');
      }
      const event = { object: 'billing.meter_event', ...form };
      state.meterEvents.push(event);
      return json(res, 200, event);
    }
    if (route === 'POST /v1/customers') {
      const customer = { id: next('cus'), object: 'customer', ...form };
      state.customers.set(customer.id, customer);
      return json(res, 200, customer);
    }
    const customerGet = /^GET \/v1\/customers\/([^/]+)$/.exec(route);
    if (customerGet) {
      const customer = state.customers.get(customerGet[1]);
      return customer
        ? json(res, 200, customer)
        : error(res, 404, 'No such customer.', 'resource_missing');
    }
    if (route === 'POST /v1/checkout/sessions') {
      const session = {
        id: next('cs_test'),
        object: 'checkout.session',
        url: `https://checkout.stripe.test/c/pay/${state.seq}`,
        ...form,
      };
      state.checkouts.push(session);
      return json(res, 200, session);
    }
    if (route === 'POST /v1/billing_portal/sessions') {
      const session = {
        id: next('bps'),
        object: 'billing_portal.session',
        url: `https://billing.stripe.test/p/${state.seq}`,
        ...form,
      };
      state.portals.push(session);
      return json(res, 200, session);
    }
    const subGet = /^GET \/v1\/subscriptions\/([^/]+)$/.exec(route);
    if (subGet) {
      const sub = state.subscriptions.get(subGet[1]);
      return sub
        ? json(res, 200, sub)
        : error(res, 404, 'No such subscription.', 'resource_missing');
    }
    const subPost = /^POST \/v1\/subscriptions\/([^/]+)$/.exec(route);
    if (subPost) {
      const sub = state.subscriptions.get(subPost[1]);
      if (!sub) return error(res, 404, 'No such subscription.', 'resource_missing');
      if (form.cancel_at_period_end !== undefined)
        sub.cancel_at_period_end = form.cancel_at_period_end === 'true';
      const change = form.items?.[0];
      if (change) {
        const item = sub.items.data.find((i) => i.id === change.id);
        const price = state.prices.find((p) => p.id === change.price);
        if (!item || !price) return error(res, 400, 'No such item or price.');
        item.price = { id: price.id, object: 'price', lookup_key: price.lookup_key };
      }
      return json(res, 200, sub);
    }
    if (route === 'POST /v1/subscription_items') {
      const sub = state.subscriptions.get(form.subscription);
      const price = state.prices.find((p) => p.id === form.price);
      if (!sub || !price) return error(res, 400, 'No such subscription or price.');
      const item = {
        id: next('si'),
        object: 'subscription_item',
        quantity: Number(form.quantity ?? 1),
        price: { id: price.id, object: 'price', lookup_key: price.lookup_key },
      };
      sub.items.data.push(item);
      return json(res, 200, item);
    }
    const itemDelete = /^DELETE \/v1\/subscription_items\/([^/]+)$/.exec(route);
    if (itemDelete) {
      for (const sub of state.subscriptions.values()) {
        sub.items.data = sub.items.data.filter((i) => i.id !== itemDelete[1]);
      }
      return json(res, 200, { id: itemDelete[1], deleted: true });
    }
    if (route === 'GET /v1/subscriptions') {
      const data = [...state.subscriptions.values()].filter((s) => s.customer === form.customer);
      return json(res, 200, { object: 'list', data });
    }
    return error(res, 404, `Unrecognized request URL (${route}).`);
  });

  return {
    state,
    secretKey,
    url: `http://127.0.0.1:${server.port}`,
    calls: state.calls,
    close: server.close,

    /** Make the next API call fail with this status (for "Stripe is down" tests). */
    failNext(status = 500, message = 'Stripe had a problem.') {
      state.failNext = { status, message };
    },

    /** Put a subscription in Stripe's memory, in the shape Stripe returns it. */
    setSubscription(overrides = {}) {
      const nowSec = Math.floor(Date.now() / 1000);
      const sub = {
        id: next('sub'),
        object: 'subscription',
        customer: 'cus_unknown',
        status: 'trialing',
        trial_end: nowSec + 14 * 86400,
        cancel_at_period_end: false,
        canceled_at: null,
        metadata: {},
        items: { data: [] },
        ...overrides,
      };
      state.subscriptions.set(sub.id, sub);
      return sub;
    },

    /** A Stripe item for a plan or add-on price. */
    item({ priceId, lookupKey, quantity = 1, id = next('si'), period = {} }) {
      const nowSec = Math.floor(Date.now() / 1000);
      return {
        id,
        object: 'subscription_item',
        quantity,
        current_period_start: nowSec,
        current_period_end: nowSec + 30 * 86400,
        ...period,
        price: { id: priceId, object: 'price', lookup_key: lookupKey },
      };
    },
  };
}
