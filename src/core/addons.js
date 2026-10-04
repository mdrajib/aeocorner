/**
 * The add-ons a customer can put on top of a plan (MVP §4: "extra prompt packs", usage meters for add-ons).
 * Pure data and rules: no database, no Stripe. The prices are a HYPOTHESIS, like the plan prices (MVP §12.3);
 * the founder confirms them with task 0.17 before the first live Stripe sync.
 *
 *   prompt_pack   licensed: a quantity on the subscription. Each unit adds 25 active questions.
 *   extra_draft   metered: nothing is charged until a customer has used up the plan's drafts. Each draft after that
 *                 is reported to a Stripe meter once and billed at the end of the period.
 *
 * Daily tracking is sold in the MVP spec too, but the scheduler is weekly only, so it is not offered here.
 */
export const ADDONS = Object.freeze({
  prompt_pack: {
    code: 'prompt_pack',
    name: 'Extra questions',
    description: '25 more tracked questions a month, added to any plan.',
    priceUsdMonth: 19,
    kind: 'licensed',
    grants: { meter: 'prompts', amountPerUnit: 25 },
  },
  extra_draft: {
    code: 'extra_draft',
    name: 'Extra drafts',
    description:
      'Keep writing after your plan’s drafts run out. Billed per draft, at the end of the month.',
    priceUsdPerUnit: 5,
    kind: 'metered',
    meter: { eventName: 'aeo_extra_draft', displayName: 'Extra drafts' },
    grants: { meter: 'drafts', amountPerUnit: 0 },
  },
});

export const ADDON_CODES = Object.freeze(Object.keys(ADDONS));

export const isAddon = (code) => Object.hasOwn(ADDONS, code);

/** The Stripe lookup key of an add-on's price. It carries the amount, so a changed price is a new Stripe price. */
export function addonLookupKey(code) {
  const addon = ADDONS[code];
  if (!addon) throw new TypeError(`Unknown add-on: ${code}`);
  const cents = Math.round((addon.priceUsdMonth ?? addon.priceUsdPerUnit) * 100);
  return `aeo-addon-${code}-${cents}`;
}

/** The Stripe lookup key of a plan's monthly price. */
export function planLookupKey(plan) {
  return `aeo-plan-${plan.code}-monthly-${Math.round(Number(plan.price_usd_month) * 100)}`;
}

/** Which add-on a Stripe price belongs to, from its lookup key (null for anything else). */
export function addonFromLookupKey(key) {
  if (typeof key !== 'string') return null;
  return ADDON_CODES.find((code) => key === addonLookupKey(code)) ?? null;
}
