import 'dotenv/config';
import { createDb } from '../src/db/index.js';
import { createStripe } from '../src/integrations/stripe.js';
import { syncCatalog } from '../src/integrations/stripe-catalog.js';
import { loadConfig } from '../src/lib/config.js';

/**
 * Make Stripe's products and prices match the `plans` table (task 8.01), then store each plan's Stripe price ID.
 * Safe to run again. Prints what it created. Uses whatever Stripe account STRIPE_SECRET_KEY points at: use a test key
 * first.
 *
 *   npm run stripe:sync
 */
const config = loadConfig();
if (!config.stripe) {
  console.error('Set STRIPE_SECRET_KEY first (a test key, sk_test_…).');
  process.exit(1);
}
if (!config.databaseUrl) {
  console.error('Set DATABASE_URL first.');
  process.exit(1);
}
const db = createDb({ databaseUrl: config.databaseUrl, caCertPath: process.env.DATABASE_CA_CERT });
try {
  const stripe = createStripe({
    secretKey: config.stripe.secretKey,
    apiVersion: config.stripe.apiVersion,
  });
  const plans = await db.system.billing.plans.list();
  const unset = plans.filter((p) => p.max_projects === null || p.max_prompts === null);
  if (unset.length) {
    console.warn(
      `Warning: ${unset.map((p) => p.code).join(', ')} still have NULL limits (docs/MILESTONES.md task 0.17). They sync, but the limits are not enforced yet.`,
    );
  }
  const report = await syncCatalog({ stripe, plans });
  for (const p of report.plans) {
    await db.system.billing.plans.setStripePrice(p.code, p.priceId);
    console.log(`${p.created ? 'created' : 'found  '}  plan   ${p.code.padEnd(14)} ${p.priceId}`);
  }
  for (const a of report.addons)
    console.log(`${a.created ? 'created' : 'found  '}  addon  ${a.code.padEnd(14)} ${a.priceId}`);
  for (const m of report.meters)
    console.log(
      `${m.created ? 'created' : 'found  '}  meter  ${m.eventName.padEnd(14)} ${m.meterId}`,
    );
} finally {
  await db.close();
}
