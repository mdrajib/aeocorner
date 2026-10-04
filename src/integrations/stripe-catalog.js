import { ADDONS, ADDON_CODES, addonLookupKey, planLookupKey } from '../core/addons.js';
import { StripeError } from './stripe.js';

/**
 * Make Stripe's products and prices match our `plans` table and the add-ons (Milestone 8, task 8.01). Safe to run again
 * and again: every object is found by a fixed ID or a lookup key before anything is made, and a price's lookup key
 * carries its amount (`aeo-plan-starter-monthly-7900`), so changing a price here creates a new Stripe price and leaves
 * the old one for the customers already on it.
 *
 * Refuses to run for a plan whose price is not a positive amount, and for plans that are not public.
 */

const cents = (usd) => Math.round(Number(usd) * 100);

async function ensureProduct(stripe, { id, name, description, metadata }) {
  try {
    return await stripe.products.retrieve(id);
  } catch (err) {
    if (!(err instanceof StripeError) || err.status !== 404) throw err;
  }
  return stripe.products.create(
    { id, name, description, metadata },
    { idempotencyKey: `aeo-product-${id}` },
  );
}

async function ensurePrice(stripe, { lookupKey, create }) {
  const found = await stripe.prices.list([lookupKey]);
  if (found.data?.length) return { price: found.data[0], created: false };
  const price = await stripe.prices.create(
    { ...create, lookup_key: lookupKey },
    { idempotencyKey: `aeo-price-${lookupKey}` },
  );
  return { price, created: true };
}

async function ensureMeter(stripe, { eventName, displayName }) {
  const meters = await stripe.meters.list();
  const found = meters.data?.find((m) => m.event_name === eventName && m.status !== 'inactive');
  if (found) return { meter: found, created: false };
  const meter = await stripe.meters.create(
    {
      display_name: displayName,
      event_name: eventName,
      default_aggregation: { formula: 'sum' },
      customer_mapping: { event_payload_key: 'stripe_customer_id', type: 'by_id' },
      value_settings: { event_payload_key: 'value' },
    },
    { idempotencyKey: `aeo-meter-${eventName}` },
  );
  return { meter, created: true };
}

/**
 * @param {object} deps
 * @param {object} deps.stripe   the client
 * @param {object[]} deps.plans  `plans` rows (snake_case)
 * @returns {{ plans: {code, priceId, created}[], addons: {code, priceId, created}[], meters: {eventName, meterId, created}[] }}
 */
export async function syncCatalog({ stripe, plans }) {
  const report = { plans: [], addons: [], meters: [] };

  for (const plan of plans) {
    if (!plan.is_public) continue;
    if (!(cents(plan.price_usd_month) > 0)) {
      throw new Error(
        `Plan ${plan.code} has no price: set price_usd_month before syncing to Stripe.`,
      );
    }
    await ensureProduct(stripe, {
      id: `aeo_plan_${plan.code}`,
      name: `AEO Corner ${plan.name}`,
      description: `The ${plan.name} plan`,
      metadata: { aeo_plan: plan.code },
    });
    const { price, created } = await ensurePrice(stripe, {
      lookupKey: planLookupKey(plan),
      create: {
        product: `aeo_plan_${plan.code}`,
        currency: 'usd',
        unit_amount: cents(plan.price_usd_month),
        recurring: { interval: 'month' },
        nickname: `${plan.name} monthly`,
        metadata: { aeo_plan: plan.code },
      },
    });
    report.plans.push({ code: plan.code, priceId: price.id, created });
  }

  for (const code of ADDON_CODES) {
    const addon = ADDONS[code];
    await ensureProduct(stripe, {
      id: `aeo_addon_${code}`,
      name: `AEO Corner: ${addon.name}`,
      description: addon.description,
      metadata: { aeo_addon: code },
    });
    let create;
    if (addon.kind === 'metered') {
      const { meter, created } = await ensureMeter(stripe, addon.meter);
      report.meters.push({ eventName: addon.meter.eventName, meterId: meter.id, created });
      create = {
        product: `aeo_addon_${code}`,
        currency: 'usd',
        unit_amount: cents(addon.priceUsdPerUnit),
        billing_scheme: 'per_unit',
        recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
        nickname: `${addon.name} (per draft)`,
        metadata: { aeo_addon: code },
      };
    } else {
      create = {
        product: `aeo_addon_${code}`,
        currency: 'usd',
        unit_amount: cents(addon.priceUsdMonth),
        recurring: { interval: 'month' },
        nickname: `${addon.name} monthly`,
        metadata: { aeo_addon: code },
      };
    }
    const { price, created } = await ensurePrice(stripe, {
      lookupKey: addonLookupKey(code),
      create,
    });
    report.addons.push({ code, priceId: price.id, created });
  }
  return report;
}

/** The Stripe price ID of an add-on, by its lookup key. Null if the catalog has not been synced. */
export async function addonPriceId(stripe, code) {
  const found = await stripe.prices.list([addonLookupKey(code)]);
  return found.data?.[0]?.id ?? null;
}
