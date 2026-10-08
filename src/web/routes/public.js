import { Router } from 'express';
import { MONEY_BACK_DAYS, TRIAL_DAYS } from '../../core/entitlements.js';
import { pricingFaq, pricingView } from '../../core/pricing.js';
import { homeFaq } from '../content/faq.js';
import { agency, stageBySlug, stages } from '../content/product.js';
import { SUBPROCESSORS } from '../../core/subprocessors.js';
import { publicPages } from '../pages.js';

const CONTEXT = 'https://schema.org';

const faqLd = (items) => ({
  '@context': CONTEXT,
  '@type': 'FAQPage',
  mainEntity: items.map((item) => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: { '@type': 'Answer', text: item.a },
  })),
});

const organizationRef = (config) => ({
  '@type': 'Organization',
  name: 'AEO Corner',
  url: config.baseUrl,
});

/** Home > this page, on every page but the home page. */
const breadcrumbLd = (page, config) => ({
  '@context': CONTEXT,
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${config.baseUrl}/` },
    { '@type': 'ListItem', position: 2, name: page.crumb, item: `${config.baseUrl}${page.path}` },
  ],
});

/** JSON-LD that is specific to a page (the Organization/WebSite blocks are added for every page). */
export function pageJsonLd(page, config, data = {}) {
  const blocks = specificJsonLd(page, config, data);
  return page.crumb ? [...blocks, breadcrumbLd(page, config)] : blocks;
}

function specificJsonLd(page, config, { pricing = null, faq = [] }) {
  switch (page.view) {
    case 'home':
      return [faqLd(homeFaq)];
    case 'methodology':
      return [
        {
          '@context': CONTEXT,
          '@type': 'Article',
          headline: page.title,
          description: page.description,
          dateModified: page.lastmod,
          author: organizationRef(config),
          publisher: organizationRef(config),
        },
      ];
    case 'product':
    case 'agencies':
      return [
        {
          '@context': CONTEXT,
          '@type': 'Service',
          name:
            page.view === 'agencies'
              ? 'AEO Corner for agencies'
              : `AEO Corner: ${stageBySlug[page.stage].name}`,
          description: page.description,
          url: `${config.baseUrl}${page.path}`,
          provider: organizationRef(config),
        },
        faqLd(faq),
      ];
    case 'pricing': {
      const out = [];
      // The offers are the plans table; without it (the database is down) there is no Product to describe.
      if (pricing?.plans.length) {
        out.push({
          '@context': CONTEXT,
          '@type': 'Product',
          name: 'AEO Corner',
          description:
            'Tracks how often AI answer engines mention, recommend and cite your brand, and helps you fix the gaps.',
          image: `${config.baseUrl}/img/og.png`,
          brand: { '@type': 'Brand', name: 'AEO Corner' },
          offers: pricing.plans
            .filter((p) => p.priced)
            .map((p) => ({
              '@type': 'Offer',
              name: p.name,
              price: p.amount,
              priceCurrency: pricing.currency,
              url: `${config.baseUrl}${page.path}`,
            })),
        });
      }
      out.push(faqLd(faq));
      return out;
    }
    case 'tool':
      return [
        {
          '@context': CONTEXT,
          '@type': 'WebApplication',
          name: page.crumb,
          description: page.description,
          url: `${config.baseUrl}${page.path}`,
          applicationCategory: 'BusinessApplication',
          operatingSystem: 'Any',
          browserRequirements: 'Requires a web browser',
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          provider: organizationRef(config),
        },
        ...(faq.length ? [faqLd(faq)] : []),
      ];
    default:
      return [];
  }
}

/** The page's own data: the FAQ it shows (also its FAQPage JSON-LD) and whatever the view needs. */
async function pageData(page, { db, logger, currency = 'usd' }) {
  switch (page.view) {
    case 'home':
      return { faq: homeFaq };
    case 'product':
      return { stage: stageBySlug[page.stage], stages, faq: stageBySlug[page.stage].faq };
    case 'agencies':
      return { page: agency, faq: agency.faq };
    case 'pricing': {
      let pricing = null;
      try {
        const rows = db ? await db.reference.plans.list() : [];
        pricing = rows.length ? pricingView(rows, { currency }) : null;
      } catch (err) {
        logger?.error({ err }, 'The pricing page could not read the plans table');
      }
      return {
        pricing,
        faq: pricingFaq(pricing ?? { trialDays: TRIAL_DAYS, moneyBackDays: MONEY_BACK_DAYS }),
      };
    }
    case 'privacy':
    case 'subprocessors':
    case 'dpa':
      return { faq: [], subprocessors: SUBPROCESSORS };
    default:
      return { faq: [] };
  }
}

// These pages have the audit form in their first screen, so the closing band would repeat it.
const HAS_OWN_AUDIT_FORM = new Set(['product', 'agencies']);

export function publicRoutes(config, { db = null, logger = null } = {}) {
  const router = Router();
  for (const page of publicPages) {
    if (page.own) continue; // served by its own router (the free tools: routes/tools.js)
    router.get(page.path, async (req, res, next) => {
      try {
        // With bKash configured the plans are shown in taka; without it, in dollars as before.
        const data = await pageData(page, {
          db,
          logger,
          currency: config.bkash ? 'bdt' : 'usd',
        });
        res.page(page.view, {
          analytics: true,
          ...data,
          ...(HAS_OWN_AUDIT_FORM.has(page.view) ? { showAuditBand: false } : {}),
          meta: {
            title: page.title,
            description: page.description,
            ogType: page.ogType,
            path: page.path,
            jsonLd: pageJsonLd(page, config, data),
          },
        });
      } catch (err) {
        next(err);
      }
    });
  }
  return router;
}

export function healthRoutes() {
  const router = Router();
  // Process liveness only (no database yet). Used by PM2/Nginx checks and the Playwright web server.
  router.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  return router;
}
