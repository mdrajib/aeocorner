// Registry of public, indexable pages. Single source for the routes, the sitemap and the
// accessibility/responsive sweeps (tests/e2e/pages.js). A new public page = one entry here.
//
// Titles must be unique and descriptions distinct (a route test enforces it). `name` (default: the view) names the
// page in the browser sweeps, so two pages that share a view need one each. `crumb` is the page's name in its
// BreadcrumbList (every page but the home page has one).
import { agency, stages } from './content/product.js';

export const publicPages = [
  {
    path: '/',
    view: 'home',
    title: 'AEO Corner — See what AI says about your brand',
    description:
      'Run a free AEO audit: see how ChatGPT, Perplexity, Gemini and Google AI Overviews talk about your brand, with your score, real answers and top 5 fixes.',
    lastmod: '2026-10-02',
    priority: 1.0,
  },
  ...stages.map((s) => ({
    path: `/product/${s.slug}`,
    view: 'product',
    name: `product-${s.slug}`,
    crumb: s.name,
    stage: s.slug,
    title: s.title,
    description: s.description,
    lastmod: '2026-10-04',
    priority: 0.8,
  })),
  {
    path: '/agencies',
    crumb: 'Agencies',
    view: 'agencies',
    title: agency.title,
    description: agency.description,
    lastmod: '2026-10-04',
    priority: 0.7,
  },
  {
    path: '/pricing',
    crumb: 'Pricing',
    view: 'pricing',
    title: 'Pricing: AEO Corner plans and free trial',
    description:
      'AEO Corner plans, limits and add-ons, with a free trial and a money-back guarantee. Start with the free AEO audit; no account or card needed.',
    // The page is built from the `plans` table, so its date is the day the page changed, not the day a price did.
    lastmod: '2026-10-04',
    priority: 0.9,
  },
  {
    path: '/methodology',
    crumb: 'Methodology',
    view: 'methodology',
    title: 'Methodology: how AEO Corner measures AI visibility',
    description:
      'How AEO Corner collects AI answers, reads them and calculates your AEO Score: engines, sampling, statistics, metric definitions and the readiness checklist.',
    lastmod: '2026-10-04',
    priority: 0.8,
    ogType: 'article',
  },
  {
    path: '/terms',
    crumb: 'Terms of Service',
    view: 'terms',
    title: 'Terms of Service | AEO Corner',
    description: 'The terms that apply when you use AEO Corner, including the free AEO audit.',
    lastmod: '2026-10-02',
    priority: 0.3,
  },
  {
    path: '/bot',
    crumb: 'AEOCornerBot',
    view: 'bot',
    title: 'AEOCornerBot: our crawler | AEO Corner',
    description:
      'What AEOCornerBot is, how to recognise it, how politely it crawls, and how to block it with robots.txt.',
    lastmod: '2026-10-03',
    priority: 0.3,
  },
  {
    path: '/privacy',
    crumb: 'Privacy Policy',
    view: 'privacy',
    title: 'Privacy Policy | AEO Corner',
    description:
      'What personal data AEO Corner collects, why, how long we keep it, and who we share it with.',
    lastmod: '2026-10-02',
    priority: 0.3,
  },
  {
    path: '/subprocessors',
    crumb: 'Subprocessors',
    view: 'subprocessors',
    title: 'Subprocessors | AEO Corner',
    description:
      'The companies that handle customer and visitor data for AEO Corner, what they do, and where.',
    lastmod: '2026-10-04',
    priority: 0.3,
  },
  {
    path: '/dpa',
    crumb: 'Data Processing Agreement',
    view: 'dpa',
    title: 'Data Processing Agreement | AEO Corner',
    description:
      'How AEO Corner handles personal data on behalf of customers: roles, security measures, subprocessors and deletion.',
    lastmod: '2026-10-04',
    priority: 0.3,
  },
];
