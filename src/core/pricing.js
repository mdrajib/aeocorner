import { ADDONS } from './addons.js';
import { takaText } from './taka.js';
import { MONEY_BACK_DAYS, TRIAL_DAYS } from './entitlements.js';

/**
 * What the public pricing page says, worked out from the `plans` table (Milestone 9, task 9.04). Pure: the route reads
 * the rows, this turns them into sentences, so no price or limit is ever typed into a template.
 *
 * Rules:
 *   - A limit that is NULL on the plan row ("not enforced") is left out, never shown as "unlimited" or 0.
 *   - A feature is shown only when the product has it. `csv_export` is on the Growth and Agency rows but the export
 *     is not built yet, so it is held back here until it is (UNSHOWN_FEATURES); `white_label` and `daily_addon` are
 *     not offered in the MVP either.
 *   - Money comes from the DECIMAL column as text, never through floating point.
 */

/** Switches on the plan row that the marketing page must not promise yet. Remove one when its feature ships. */
export const UNSHOWN_FEATURES = Object.freeze(['csv_export', 'white_label', 'daily_addon']);

/** The features a plan can show, in the order of the comparison table. */
const FEATURE_ROWS = Object.freeze([
  { key: 'wordpress', label: 'Publish to WordPress from AEO Corner' },
  { key: 'ga4', label: 'AI-traffic reports (Google Analytics and Search Console)' },
  { key: 'alerts', label: 'Alerts on significant drops and negative mentions' },
  { key: 'autopilot', label: 'Autopilot: fixes and drafts prepared each week for you to approve' },
  { key: 'claude_engine', label: 'Claude tracked as a fifth AI engine, with web search' },
  { key: 'client_seats', label: 'Read-only client seats' },
]);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const trim = (value) => String(Number(value)); // 4.0 -> "4", 0.5 -> "0.5"

/** "79.00" -> "$79". Whole dollars show without cents; anything else keeps two places. */
export function priceText(value) {
  const [whole, cents = '00'] = String(value).split('.');
  return /^0*$/.test(cents)
    ? `$${Number(whole)}`
    : `$${Number(whole)}.${cents.padEnd(2, '0').slice(0, 2)}`;
}

/** The numbers a plan puts on its card. A limit that is not set is left out. */
export function planLimits(plan) {
  const out = [];
  if (plan.max_projects != null)
    out.push({ key: 'projects', label: plural(plan.max_projects, 'project') });
  if (plan.max_prompts != null)
    out.push({ key: 'prompts', label: `${plan.max_prompts} tracked buyer questions` });
  if (plan.max_seats != null)
    out.push({ key: 'seats', label: plural(plan.max_seats, 'team seat') });
  if (plan.drafts_per_month != null)
    out.push({ key: 'drafts', label: `${trim(plan.drafts_per_month)} content drafts a month` });
  if (plan.runs_now_per_month != null)
    out.push({
      key: 'runs_now',
      label: `${plural(plan.runs_now_per_month, 'on-demand check')} a month`,
    });
  return out;
}

/** The feature rows this plan has, for its card. */
export function planFeatures(plan) {
  const on = plan.features ?? {};
  return FEATURE_ROWS.filter((row) => on[row.key] === true).map((row) => row.label);
}

/**
 * @param {object[]} rows  public `plans` rows (snake_case, already in display order)
 * @returns {{
 *   plans: { code: string, name: string, price: string, perMonth: string, limits: object[], features: string[],
 *            samples: string, featured: boolean }[],
 *   comparison: { label: string, cells: { plan: string, value: string, included: boolean }[] }[],
 *   addons: { code: string, name: string, description: string, price: string }[],
 *   trialDays: number, moneyBackDays: number,
 * }}
 */
export function pricingView(rows, { currency = 'usd' } = {}) {
  const taka = currency === 'bdt';
  const plans = rows.map((p) => ({
    code: p.code,
    name: p.name,
    // Paying with bKash is in taka only: a plan with no taka price is not open yet, and no dollar price stands in for it.
    priced: taka ? p.price_bdt_month != null : true,
    amount: taka
      ? p.price_bdt_month == null
        ? null
        : String(Number(p.price_bdt_month))
      : String(Number(p.price_usd_month)),
    price: taka
      ? p.price_bdt_month == null
        ? 'Not open yet'
        : takaText(p.price_bdt_month)
      : priceText(p.price_usd_month),
    perMonth: taka && p.price_bdt_month == null ? '' : 'a month',
    limits: planLimits(p),
    features: planFeatures(p),
    samples: `Every question asked ${p.samples_per_engine} times on each engine`,
    // The middle plan of three is the one most small teams pick; with any other count nothing is singled out.
    featured: rows.length === 3 && p === rows[1],
  }));

  // One row per limit that at least one plan sets, then one per feature that at least one plan has.
  const comparison = [];
  const limitKeys = ['projects', 'prompts', 'seats', 'drafts', 'runs_now'];
  const labels = {
    projects: 'Projects',
    prompts: 'Tracked buyer questions',
    seats: 'Team seats',
    drafts: 'Content drafts a month',
    runs_now: 'On-demand checks a month',
  };
  const columnOf = {
    projects: 'max_projects',
    prompts: 'max_prompts',
    seats: 'max_seats',
    drafts: 'drafts_per_month',
    runs_now: 'runs_now_per_month',
  };
  for (const key of limitKeys) {
    if (!rows.some((p) => p[columnOf[key]] != null)) continue;
    comparison.push({
      label: labels[key],
      cells: rows.map((p) => {
        const set = p[columnOf[key]] != null;
        return { plan: p.name, value: set ? trim(p[columnOf[key]]) : 'Not set', included: set };
      }),
    });
  }
  for (const row of FEATURE_ROWS) {
    if (!rows.some((p) => p.features?.[row.key] === true)) continue;
    comparison.push({
      label: row.label,
      cells: rows.map((p) => {
        const has = p.features?.[row.key] === true;
        return { plan: p.name, value: has ? 'Included' : 'Not included', included: has };
      }),
    });
  }

  // Add-ons are Stripe line items; with bKash none are offered, so none are listed.
  const addons = (taka ? [] : Object.values(ADDONS)).map((a) => ({
    code: a.code,
    name: a.name,
    description: a.description,
    price:
      a.kind === 'metered'
        ? `${priceText(a.priceUsdPerUnit)} per draft`
        : `${priceText(a.priceUsdMonth)} a month`,
  }));

  return {
    plans,
    comparison,
    addons,
    currency: taka ? 'BDT' : 'USD',
    trialDays: TRIAL_DAYS,
    moneyBackDays: MONEY_BACK_DAYS,
  };
}

/** The pricing page's questions, with the trial and money-back terms taken from the same constants billing uses. */
export function pricingFaq(view) {
  const bkash = view.currency === 'BDT';
  return [
    {
      q: `How does the ${view.trialDays}-day free trial work?`,
      a: bkash
        ? `Run the free audit, then start a trial from your report. You pay nothing and give us no payment details for the ${view.trialDays} days. When it ends, you pay for the first month with bKash to keep tracking. The trial is once per organization.`
        : `Run the free audit, then start a trial from your report. You enter a card on Stripe’s page; it is not charged during the ${view.trialDays} days, and you can cancel before then from the billing screen. The trial is once per organization.`,
    },
    ...(bkash
      ? [
          {
            q: 'How do I pay with bKash?',
            a: 'You pay one month at a time, on bKash’s own page, and approve it in the bKash app. We never see your bKash number or PIN. Nothing is charged automatically: we email you five days before your plan ends with a link to pay for the next month. If you don’t pay, tracking pauses after a week and your data is kept.',
          },
        ]
      : []),
    {
      q: 'Is there a money-back guarantee?',
      a: bkash
        ? `Yes. If AEO Corner is not useful to you, ask within ${view.moneyBackDays} days of your first payment and we refund that first month to your bKash account.`
        : `Yes. If AEO Corner is not useful to you, ask within ${view.moneyBackDays} days of your first payment and we refund that first month.`,
    },
    {
      q: 'Can I change plan or cancel?',
      a: bkash
        ? 'Yes, from the billing screen. A bigger plan starts at once and takes off the unused part of the month you paid for. A smaller plan can start in the last week of the month, and has to fit what you already have. To cancel, stop renewing; your plan runs to the end of the month you paid for. Nothing is deleted when you downgrade or cancel; your data is kept for 90 days after a cancellation so you can come back.'
        : 'Yes, any time, from the billing screen. A smaller plan has to fit what you already have: if you track more questions than it allows, we ask you to pause some first. Nothing is deleted when you downgrade or cancel; your data is kept for 90 days after a cancellation so you can come back.',
    },
    {
      q: 'What happens if I reach a limit?',
      a: bkash
        ? 'You see it where it happens (“50 of 50 buyer questions”) with the way to move to a bigger plan. Nothing is dropped without telling you.'
        : 'You see it where it happens (“50 of 50 buyer questions”) with the way to add more. Nothing is dropped without telling you. Extra questions can be added in packs, and drafts beyond your plan’s allowance are billed per draft at the end of the month.',
    },
    {
      q: 'Do you charge for failed answers?',
      a: 'No. The price is per plan, not per answer. When an engine can’t be checked we show “Couldn’t check” and never count it against your brand.',
    },
    {
      q: 'Which plan is right for an agency?',
      a: 'Agency is built for several clients: more projects, more questions, and read-only seats so a client can see their own results without seeing anyone else’s.',
    },
  ];
}
