import { Router } from 'express';
import { AI_CRAWLERS } from '../../core/ai-crawlers.js';
import { publicPages } from '../pages.js';

// Paths no crawler should index. The styleguide only exists outside production; /audit is a form endpoint;
// the rest is the signed-in area and the sign-in and invitation flows.
const DISALLOWED = [
  '/_styleguide',
  '/audit',
  '/app',
  '/invite',
  '/sign-in',
  '/sign-up',
  '/sign-out',
  '/webhooks',
];

export function robotsTxt(config) {
  if (!config.indexable) {
    // Staging and development: keep everything out of search and AI indexes.
    return 'User-agent: *\nDisallow: /\n';
  }

  const rules = DISALLOWED.map((p) => `Disallow: ${p}`).join('\n');
  // We want to be quoted by AI engines, so every known AI crawler is allowed by name. A group with its
  // own name replaces the `*` group for that bot, so the Disallow lines are repeated in it.
  const aiAgents = AI_CRAWLERS.map((c) => `User-agent: ${c.agent}`).join('\n');
  return [
    '# AEO Corner — we want AI answer engines to read this site.',
    'User-agent: *',
    'Allow: /',
    rules,
    '',
    aiAgents,
    'Allow: /',
    rules,
    '',
    `Sitemap: ${config.baseUrl}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(config) {
  const urls = publicPages
    .map(
      (p) =>
        `  <url>\n    <loc>${config.baseUrl}${p.path === '/' ? '/' : p.path}</loc>\n    <lastmod>${p.lastmod}</lastmod>\n    <priority>${p.priority.toFixed(1)}</priority>\n  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function seoRoutes(config) {
  const router = Router();
  router.get('/robots.txt', (req, res) => res.type('text/plain').send(robotsTxt(config)));
  router.get('/sitemap.xml', (req, res) => {
    if (!config.indexable) return res.status(404).type('text/plain').send('Not found');
    res.type('application/xml').send(sitemapXml(config));
  });
  return router;
}
