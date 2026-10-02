const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery guard for the public, cookie-less forms (the audit form).
 * Browsers always tell us where a state-changing request came from, so we refuse any that came from
 * another site: `Sec-Fetch-Site` where the browser sends it, else the `Origin` host.
 * Requests with neither header are not browsers and can't be forged from a victim's browser.
 *
 * Phase 2 adds session-based forms; those get synchroniser tokens on top of this (MVP §11.1).
 */
export function sameOriginOnly() {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const site = req.get('sec-fetch-site');
    if (site) {
      if (site === 'same-origin' || site === 'none') return next();
      return forbid(res);
    }

    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host === req.host) return next();
      } catch {
        // fall through to forbid
      }
      return forbid(res);
    }

    next();
  };
}

function forbid(res) {
  res.status(403).type('text/plain').send('Cross-site requests are not allowed.');
}
