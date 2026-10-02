import express, { Router } from 'express';
import { roleDescription, roleLabel } from '../../core/permissions.js';
import { DomainError } from '../../db/index.js';
import { maskEmail } from '../../lib/mask.js';
import { verifiedAddresses } from '../auth/clerk-user.js';
import { csrfProtection } from '../auth/csrf.js';

const META = {
  title: 'Your invitation | AEO Corner',
  description: 'Join an organization on AEO Corner.',
  noindex: true,
};

/**
 * The page behind the emailed link. It works signed out (to explain what the invitation is and where to
 * sign in) and signed in (to accept). Accepting needs BOTH the link's secret token AND a Clerk-verified email
 * address matching the one the invitation was sent to: forwarding the link to someone else doesn't hand them
 * the seat (DATABASE_SCHEMA §10.1).
 */
export function inviteRoutes({ config, db, auth, provider }) {
  const router = Router();

  router.use(auth.identify, (req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  /** The user's verified addresses, asked of Clerk right now rather than trusted from our copy. */
  async function verifiedEmailsOf(user) {
    const clerkUser = await provider.fetchUser(user.clerk_user_id);
    return clerkUser ? verifiedAddresses(clerkUser) : [];
  }

  function show(res, locals, status = 200) {
    res.page('invite', { showAuditBand: false, meta: META, ...locals }, { status });
  }

  router.get('/:token', async (req, res, next) => {
    try {
      const found = await db.invitationLinks.find(req.params.token);
      if (!found) return show(res, { state: 'invalid' }, 404);

      const { invitation, org, state } = found;
      const base = {
        state,
        orgName: org.name,
        roleLabel: roleLabel(invitation.role),
        roleDescription: roleDescription(invitation.role),
        maskedEmail: maskEmail(invitation.email),
        next: `/invite/${req.params.token}`,
        signedInAs: null,
      };
      if (state !== 'pending') return show(res, base);

      if (!req.user) return show(res, { ...base, state: 'sign-in' });

      const emails = await verifiedEmailsOf(req.user);
      const matches = emails.includes(invitation.email.toLowerCase());
      return show(res, {
        ...base,
        state: matches ? 'accept' : 'wrong-account',
        signedInAs: req.user.email,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/:token/accept',
    auth.requireUser,
    express.urlencoded({ extended: false, limit: '2kb' }),
    csrfProtection({ secret: config.appSecret }),
    async (req, res, next) => {
      try {
        const token = req.params.token;
        try {
          const result = await db.invitationLinks.accept({
            token,
            user: req.user,
            verifiedEmails: await verifiedEmailsOf(req.user),
          });
          return res.redirect(303, `/app/o/${result.orgPublicId}?notice=joined`);
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          // Every refusal is explained by the same page the link opens, so there is one place to read.
          const known = [
            'INVITE_NOT_FOUND',
            'INVITE_EXPIRED',
            'INVITE_USED',
            'EMAIL_MISMATCH',
            'INVITE_PROJECTS_GONE',
          ];
          if (!known.includes(err.code)) throw err;
          return res.redirect(303, `/invite/${encodeURIComponent(token)}`);
        }
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
