import express, { Router } from 'express';
import { normalizeWebsite } from '../../lib/url.js';
import { homeFaq } from '../content/faq.js';
import { publicPages } from '../pages.js';

const home = publicPages.find((p) => p.view === 'home');

// Form fields arrive as strings. A repeated field (a=1&a=2) or a nested one (a[]=1) arrives as an
// array/object: that is never one website address, so it is treated as invalid rather than ignored.
const isMalformed = (value) => value !== undefined && typeof value !== 'string';
const field = (value) => (typeof value === 'string' ? value.trim().slice(0, 2048) : '');

/**
 * Free-audit entry point — a STUB until Phase 7. It validates what was typed and tells the visitor
 * the audit isn't open yet. Nothing is stored, queued or fetched. Phase 7 replaces the success branch
 * with Turnstile verification, the email/OTP step and the audit job.
 */
export function auditRoutes() {
  const router = Router();

  router.get('/audit', (req, res) => res.redirect(302, '/#audit'));

  router.post('/audit', express.urlencoded({ extended: false, limit: '10kb' }), (req, res) => {
    const body = req.body ?? {};
    const values = { url: field(body.url), competitor_url: field(body.competitor_url) };
    const errors = {};

    const site = isMalformed(body.url) ? normalizeWebsite('') : normalizeWebsite(values.url);
    if (!site.ok) errors.url = site.message;

    if (isMalformed(body.competitor_url)) {
      errors.competitor_url = normalizeWebsite('not a website').message;
    } else if (values.competitor_url) {
      const competitor = normalizeWebsite(values.competitor_url);
      if (!competitor.ok) errors.competitor_url = competitor.message;
    }

    if (Object.keys(errors).length) {
      return res.page(
        'home',
        {
          faq: homeFaq,
          audit: { values, errors },
          meta: { title: home.title, description: home.description, path: '/', noindex: true },
        },
        { status: 422 },
      );
    }

    res.page('audit-soon', {
      domain: site.domain,
      meta: {
        title: 'The free audit opens soon | AEO Corner',
        description: 'The AEO Corner free audit is not open yet.',
        noindex: true,
        path: '/',
      },
    });
  });

  return router;
}
