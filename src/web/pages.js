// Registry of public, indexable pages. Single source for the routes, the sitemap and the
// accessibility/responsive sweeps (tests/e2e/pages.js). A new public page = one entry here.
//
// Titles must be unique and descriptions distinct (a route test enforces it).
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
  {
    path: '/methodology',
    view: 'methodology',
    title: 'Methodology: how AEO Corner measures AI visibility',
    description:
      'How AEO Corner collects AI answers, reads them and calculates your AEO Score: engines, sampling, statistics, metric definitions and the readiness checklist.',
    lastmod: '2026-10-02',
    priority: 0.8,
    ogType: 'article',
  },
  {
    path: '/terms',
    view: 'terms',
    title: 'Terms of Service | AEO Corner',
    description: 'The terms that apply when you use AEO Corner, including the free AEO audit.',
    lastmod: '2026-10-02',
    priority: 0.3,
  },
  {
    path: '/privacy',
    view: 'privacy',
    title: 'Privacy Policy | AEO Corner',
    description:
      'What personal data AEO Corner collects, why, how long we keep it, and who we share it with.',
    lastmod: '2026-10-02',
    priority: 0.3,
  },
];
