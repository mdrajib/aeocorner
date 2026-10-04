import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MONEY_BACK_DAYS, TRIAL_DAYS } from './entitlements.js';
import {
  planFeatures,
  planLimits,
  priceText,
  pricingFaq,
  pricingView,
  UNSHOWN_FEATURES,
} from './pricing.js';

// Rows as Prisma returns them: DECIMAL columns are objects whose text is "79" or "0.5", not numbers.
const decimal = (text) => ({ toString: () => text, valueOf: () => Number(text) });
const row = (over = {}) => ({
  code: 'starter',
  name: 'Starter',
  price_usd_month: decimal('79'),
  max_projects: 1,
  max_prompts: 50,
  max_seats: null,
  drafts_per_month: decimal('4'),
  runs_now_per_month: null,
  samples_per_engine: 3,
  features: { wordpress: true, ga4: true, alerts: false, csv_export: false, client_seats: false },
  ...over,
});

describe('priceText', () => {
  test('whole dollars have no cents; anything else keeps two places', () => {
    assert.equal(priceText(decimal('79')), '$79');
    assert.equal(priceText('79.00'), '$79');
    assert.equal(priceText('249.00'), '$249');
    assert.equal(priceText('12.5'), '$12.50');
    assert.equal(priceText('9.99'), '$9.99');
  });
});

describe('planLimits', () => {
  test('a limit the plan does not set (NULL) is left out, never "unlimited" or 0', () => {
    const labels = planLimits(row()).map((l) => l.label);
    assert.deepEqual(labels, [
      '1 project',
      '50 tracked buyer questions',
      '4 content drafts a month',
    ]);
    assert.ok(!labels.some((l) => /seat|unlimited|check/i.test(l)));
  });

  test('numbers come from the row: change a limit and the sentence changes', () => {
    const labels = planLimits(
      row({
        max_projects: 10,
        max_prompts: 500,
        max_seats: 3,
        drafts_per_month: decimal('0.5'),
        runs_now_per_month: 1,
      }),
    ).map((l) => l.label);
    assert.deepEqual(labels, [
      '10 projects',
      '500 tracked buyer questions',
      '3 team seats',
      '0.5 content drafts a month',
      '1 on-demand check a month',
    ]);
  });
});

describe('planFeatures', () => {
  test('shows only the features the plan has and the product offers', () => {
    assert.deepEqual(planFeatures(row()), [
      'Publish to WordPress from AEO Corner',
      'AI-traffic reports (Google Analytics and Search Console)',
    ]);
  });

  test('a switch for something not built yet is never promised', () => {
    const everything = Object.fromEntries(UNSHOWN_FEATURES.map((k) => [k, true]));
    assert.deepEqual(planFeatures(row({ features: everything })), []);
    assert.deepEqual(planFeatures(row({ features: null })), []);
  });
});

describe('pricingView', () => {
  const rows = [
    row(),
    row({
      code: 'growth',
      name: 'Growth',
      price_usd_month: decimal('249'),
      max_projects: 3,
      features: { wordpress: true, ga4: true, alerts: true },
    }),
    row({
      code: 'agency',
      name: 'Agency',
      price_usd_month: decimal('599'),
      max_projects: 10,
      features: { alerts: true, client_seats: true },
    }),
  ];

  test('one card per plan, in the order given, with the middle of three featured', () => {
    const view = pricingView(rows);
    assert.deepEqual(
      view.plans.map((p) => [p.name, p.price, p.featured]),
      [
        ['Starter', '$79', false],
        ['Growth', '$249', true],
        ['Agency', '$599', false],
      ],
    );
  });

  test('the comparison table has a row only where some plan sets or has the thing', () => {
    const view = pricingView(rows);
    const labels = view.comparison.map((r) => r.label);
    assert.ok(labels.includes('Projects'));
    assert.ok(!labels.includes('Team seats'), 'no plan sets seats');
    assert.ok(!labels.includes('On-demand checks a month'));
    const alerts = view.comparison.find((r) => /Alerts/.test(r.label));
    assert.deepEqual(
      alerts.cells.map((c) => c.value),
      ['Not included', 'Included', 'Included'],
    );
    assert.ok(!view.comparison.some((r) => /CSV/i.test(r.label)));
  });

  test('a single plan features nothing; no plans is an empty view, not an error', () => {
    assert.equal(pricingView([row()]).plans[0].featured, false);
    assert.deepEqual(pricingView([]).plans, []);
  });

  test('trial and refund terms are the billing constants', () => {
    const view = pricingView(rows);
    assert.equal(view.trialDays, TRIAL_DAYS);
    assert.equal(view.moneyBackDays, MONEY_BACK_DAYS);
    const text = pricingFaq(view)
      .map((f) => `${f.q} ${f.a}`)
      .join(' ');
    assert.match(text, new RegExp(`${TRIAL_DAYS}-day`));
    assert.match(text, new RegExp(`within ${MONEY_BACK_DAYS} days`));
  });

  test('add-ons come from the add-on catalog, with their real prices', () => {
    const { addons } = pricingView(rows);
    assert.deepEqual(
      addons.map((a) => [a.code, a.price]),
      [
        ['prompt_pack', '$19 a month'],
        ['extra_draft', '$5 per draft'],
      ],
    );
  });
});
