import express, { Router } from 'express';
import { csrfProtection } from '../auth/csrf.js';
import { safeNext } from '../auth/return-to.js';

// Cookies Clerk's SDK reads on our domain. Clerk may add a per-instance suffix, so match by prefix.
const CLERK_COOKIE_PREFIXES = ['__session', '__client_uat', '__clerk_db_jwt', '__refresh'];

export function clearClerkCookies(req, res) {
  const names = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.split('=')[0].trim())
    .filter((name) => CLERK_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix)));
  for (const name of names) res.clearCookie(name, { path: '/' });
}

/**
 * Sign-in and sign-up are Clerk's hosted Account Portal pages (ADR-0004): we send the visitor there with
 * a `redirect_url` back into the app. Sign-out is ours, because it needs to revoke the session at Clerk and
 * clear Clerk's cookies on our domain.
 */
export function authRoutes({ config, provider, auth }) {
  const router = Router();

  function unavailable(res) {
    return res.page(
      'auth-unavailable',
      {
        showAuditBand: false,
        meta: {
          title: 'Sign-in is not set up | AEO Corner',
          description: 'Sign-in is not available on this server.',
          noindex: true,
          path: '/sign-in',
        },
      },
      { status: 503 },
    );
  }

  function toClerk(target) {
    return (req, res) => {
      if (!provider.configured) return unavailable(res);
      const url = new URL(target(provider));
      url.searchParams.set('redirect_url', `${config.baseUrl}${safeNext(req.query.next)}`);
      res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex');
      res.redirect(302, url.toString());
    };
  }

  router.get(
    '/sign-in',
    toClerk((p) => p.signInUrl),
  );
  router.get(
    '/sign-up',
    toClerk((p) => p.signUpUrl),
  );

  router.post(
    '/sign-out',
    auth.identify,
    express.urlencoded({ extended: false, limit: '2kb' }),
    csrfProtection({ secret: config.appSecret }),
    async (req, res, next) => {
      try {
        if (req.session) {
          // Revoke at Clerk so the token stops working within seconds; if Clerk is down we still sign
          // the visitor out of this browser rather than leave them stuck signed in.
          await provider.endSession(req.session.sessionId).catch((err) => {
            req.log?.warn({ err }, 'Could not revoke the Clerk session');
          });
        }
        clearClerkCookies(req, res);
        res.set('Cache-Control', 'no-store').redirect(303, '/');
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
