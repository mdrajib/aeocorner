import { Router } from 'express';
import { emailNames, renderEmail } from '../../lib/email.js';

const SAMPLE_EMAIL_DATA = {
  'verification-code': { code: '482915', expiresMinutes: 10 },
};

const SAMPLE_NAV = [
  { href: '/_styleguide/app-shell', label: 'Dashboard', icon: 'chart', current: true },
  { href: '#', label: 'Buyer questions', icon: 'list' },
  { href: '#', label: 'Citations', icon: 'globe' },
  { href: '#', label: 'Action Center', icon: 'bolt' },
  { href: '#', label: 'Content', icon: 'document' },
  { href: '#', label: 'Settings', icon: 'shield' },
];

/**
 * Dev-only component catalogue. Mounted only when NODE_ENV !== 'production' (see app.js), so in
 * production these URLs fall through to the normal 404 page.
 */
export function styleguideRoutes(config) {
  const router = Router();
  const meta = (title) => ({
    title: `${title} | AEO Corner styleguide`,
    description: 'Internal component catalogue.',
    noindex: true,
  });

  router.get('/', (req, res) => {
    res.page('styleguide', {
      showAuditBand: false,
      meta: { ...meta('Styleguide'), path: '/_styleguide' },
    });
  });

  router.get('/app-shell', (req, res) => {
    res.page(
      'app-shell-sample',
      {
        nav: SAMPLE_NAV,
        user: { name: 'Maya Example' },
        project: { name: 'maya-dental.com' },
        meta: { ...meta('App shell'), path: '/_styleguide/app-shell' },
      },
      { layout: 'app' },
    );
  });

  router.get('/error', (req, res, next) =>
    next(new Error('Styleguide: deliberate error to preview the 500 page')),
  );

  router.get('/email/:name', (req, res) => {
    const isText = req.params.name.endsWith('.txt');
    const name = isText ? req.params.name.slice(0, -4) : req.params.name;
    if (!emailNames().includes(name))
      return res.status(404).type('text/plain').send('Unknown email template');
    const email = renderEmail(name, SAMPLE_EMAIL_DATA[name], { baseUrl: config.baseUrl });
    // Previews are dev-only, so the email's own inline styles run under a CSP that allows them.
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.type(isText ? 'text/plain' : 'html').send(isText ? email.text : email.html);
  });

  return router;
}
