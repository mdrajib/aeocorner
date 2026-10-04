import { statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanUtm } from '../../core/utm.js';
import { buildMeta } from '../meta.js';
import { createUi } from '../ui.js';

/**
 * Adds `res.page(view, locals, options)`, which renders views/pages/<view>.ejs inside a layout
 * (EJS has no layouts of its own), and the template locals every view can rely on:
 * `ui` (component helpers), `meta` (head tags), `site`, `asset()`, `currentPath`.
 */
export function pageRenderer({ config, viewsDir, publicDir }) {
  const ui = createUi({ viewsDir, cache: config.isProduction });
  const assetVersions = new Map();

  function asset(path) {
    let version = assetVersions.get(path);
    if (version === undefined || !config.isProduction) {
      try {
        version = Math.floor(statSync(join(publicDir, path)).mtimeMs).toString(36);
      } catch {
        version = '0';
      }
      assetVersions.set(path, version);
    }
    return `${path}?v=${version}`;
  }

  const site = {
    appEnv: config.appEnv,
    authEnabled: Boolean(config.auth),
    turnstileSiteKey: config.turnstileSiteKey,
    posthog: config.posthog,
  };

  return function pageRendererMiddleware(req, res, next) {
    res.locals.ui = ui;
    res.locals.asset = asset;
    res.locals.site = site;
    res.locals.currentPath = req.path;
    res.locals.utm = cleanUtm(req.query); // campaign tags, carried through the audit form (src/core/utm.js)
    res.locals.flash = [];

    /**
     * @param {string} view     file in views/pages, without extension
     * @param {object} locals   template data; `locals.meta` customises the <head>
     * @param {{ layout?: string, status?: number, onError?: (err: Error) => void }} options
     */
    res.page = (view, locals = {}, options = {}) => {
      const { layout = 'public', status, onError = next } = options;
      const showAuditBand = locals.showAuditBand ?? (layout === 'public' && view !== 'home');
      const data = {
        faq: [],
        audit: null,
        ...res.locals,
        ...locals,
        showAuditBand,
        // Opt-in, per page. Analytics is for the public marketing pages only: the signed-in area, invitation
        // links and the staff console have private data or secrets in their URLs, which must never reach PostHog.
        analytics: Boolean(config.posthog) && locals.analytics === true,
        // The page shows the Turnstile widget (the audit's email step), so it loads Cloudflare's script.
        hasAuditForm: layout === 'public' && locals.turnstile === true,
        meta: buildMeta({ config, path: req.path, meta: locals.meta }),
      };

      req.app.render(`pages/${view}`, data, (err, body) => {
        if (err) return onError(err);
        req.app.render(`layouts/${layout}`, { ...data, body }, (err2, html) => {
          if (err2) return onError(err2);
          if (status) res.status(status);
          res.type('html').send(html);
        });
      });
    };

    next();
  };
}
