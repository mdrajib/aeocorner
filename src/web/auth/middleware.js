import { can, roleLabel } from '../../core/permissions.js';
import { isUlid } from '../../lib/ulid.js';
import { notFound } from '../middleware/errors.js';
import { csrfToken } from './csrf.js';

/**
 * Per-request identity for the signed-in area. Three steps, each its own middleware:
 *   identify        who is this? (Clerk session -> our `users` row; created on first sight)
 *   requireUser     stop anonymous visitors (redirect a page, 401 anything else)
 *   loadOrg         which organization is this URL about, and is this user a member?
 * Public pages never run any of this: Clerk is only consulted under /app, /invite and /sign-out.
 */
export function createAuthMiddleware({ config, provider, db }) {
  const clerk = provider.configured ? provider.middleware() : null;

  async function attachUser(req, res, next) {
    try {
      const session = await provider.authenticate(req);
      if (!session) return next();

      // The row usually exists already (webhook or an earlier visit). Ask Clerk only when it doesn't.
      let user = await db.users.findByClerkId(session.clerkUserId);
      if (!user) {
        const clerkUser = await provider.fetchUser(session.clerkUserId);
        user = clerkUser ? await db.users.getOrCreateFromClerk(clerkUser) : null;
      }
      if (!user || user.deleted_at) return next();

      await db.users.touchLogin(user);
      req.session = session;
      req.user = user;
      res.locals.user = { name: user.name || user.email, email: user.email };
      res.locals.csrfToken = csrfToken(config.appSecret, session.sessionId);
      next();
    } catch (err) {
      next(err);
    }
  }

  const identify = clerk ? [clerk, attachUser] : [attachUser];

  function requireUser(req, res, next) {
    if (req.user) return next();
    res.set('Cache-Control', 'no-store');

    if (!provider.configured) {
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

    const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && req.accepts('html');
    if (wantsPage) {
      return res.redirect(302, `/sign-in?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (req.get('hx-request')) res.set('HX-Redirect', '/sign-in');
    res.status(401).type('text/plain').send('Sign in required.');
  }

  /** Resolve `:org` (a public ID) to an organization the signed-in user belongs to, or answer 404. */
  async function loadOrg(req, res, next) {
    try {
      const publicId = req.params.org;
      if (!isUlid(publicId)) return notFound(req, res);

      // A non-member and a non-existent ID look identical: both are a plain 404.
      const found = await db.organizations.findForUser({ publicId, userId: req.user.id });
      if (!found) return notFound(req, res);

      req.org = found.org;
      req.membership = found.membership;
      req.orgDb = db.forOrg(found.org.id);
      res.locals.org = { publicId: found.org.public_id, name: found.org.name };
      res.locals.role = found.membership.role;
      res.locals.roleLabel = roleLabel(found.membership.role);
      res.locals.can = (action) => can(found.membership.role, action);

      if (req.user.last_org_id !== found.org.id && req.method === 'GET') {
        await db.users.setLastOrg(req.user.id, found.org.id);
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  /** Answer 403 unless the member's role allows `action`. Use after loadOrg. */
  const requirePermission = (action) => (req, res, next) => {
    if (can(req.membership.role, action)) return next();
    res.page(
      'forbidden',
      {
        showAuditBand: false,
        meta: {
          title: 'No access | AEO Corner',
          description: 'You do not have access to this page.',
          noindex: true,
          path: req.path,
        },
      },
      { layout: 'app', status: 403 },
    );
  };

  return { identify, requireUser, loadOrg, requirePermission };
}
