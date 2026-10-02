import { hmac, safeEqual } from '../../lib/tokens.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF token for a signed-in session: an HMAC of the Clerk session ID under the app secret. Stateless (no
 * server-side session store), different for every sign-in, and useless to a site that can't read our pages.
 * This sits on top of the Sec-Fetch-Site / Origin check in same-origin.js (MVP §11.1).
 */
export function csrfToken(secret, sessionId) {
  return hmac(secret, 'csrf-v1', sessionId);
}

/** Refuse any state-changing request without the right token (form field `_csrf` or header `X-CSRF-Token`). */
export function csrfProtection({ secret }) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const supplied = req.body?._csrf ?? req.get('x-csrf-token');
    if (
      req.session &&
      typeof supplied === 'string' &&
      safeEqual(supplied, csrfToken(secret, req.session.sessionId))
    ) {
      return next();
    }
    const err = new Error('Missing or invalid CSRF token');
    err.status = 403;
    next(err);
  };
}
