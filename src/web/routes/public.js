import { Router } from 'express';
import { homeFaq } from '../content/faq.js';
import { publicPages } from '../pages.js';

/** JSON-LD that is specific to a page (the Organization/WebSite blocks are added for every page). */
function pageJsonLd(page, config) {
  if (page.view === 'home') {
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: homeFaq.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ];
  }
  if (page.view === 'methodology') {
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: page.title,
        description: page.description,
        dateModified: page.lastmod,
        author: { '@type': 'Organization', name: 'AEO Corner', url: config.baseUrl },
        publisher: { '@type': 'Organization', name: 'AEO Corner', url: config.baseUrl },
      },
    ];
  }
  return [];
}

export function publicRoutes(config) {
  const router = Router();
  for (const page of publicPages) {
    router.get(page.path, (req, res) => {
      res.page(page.view, {
        analytics: true,
        faq: page.view === 'home' ? homeFaq : [],
        meta: {
          title: page.title,
          description: page.description,
          ogType: page.ogType,
          path: page.path,
          jsonLd: pageJsonLd(page, config),
        },
      });
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
