import { verifiedAddresses } from '../auth/clerk-user.js';

const LOGIN_TOUCH_MS = 10 * 60 * 1000;

/**
 * Clerk puts `fva` in the session token: [minutes since the first factor was verified, minutes since the
 * second factor was verified]. A second number of -1 means no second factor is registered or it was never
 * verified (Clerk docs, "Session tokens", read 2026-10-02). Staff must have one.
 */
export function hasSecondFactor(claims) {
  const fva = claims?.fva;
  return Array.isArray(fva) && Number.isFinite(fva[1]) && fva[1] >= 0;
}

/**
 * Staff authentication, in the order the checks are cheapest and most telling:
 *   1. a Clerk session from the STAFF Clerk app (customers can't have one: separate user pool)
 *   2. a verified second factor on that session
 *   3. an active staff_users row, bound to this Clerk user on first sign-in by verified email
 * Anything short of all three is refused with a page that says which step failed.
 */
export function createStaffAuth({ config, provider, db, logger }) {
  const staff = config.staff;
  const clerk = provider.middleware();

  const deny = (res, reason, status = 403) =>
    res.page(
      'staff-denied',
      {
        reason,
        showAuditBand: false,
        meta: { title: 'Staff access | AEO Corner', description: 'Staff access.', noindex: true },
      },
      { status },
    );

  async function identify(req, res, next) {
    try {
      const session = await provider.authenticate(req);
      if (!session) {
        if (req.method === 'GET' && req.accepts('html')) {
          const url = new URL(staff.signInUrl);
          url.searchParams.set('redirect_url', `${staff.baseUrl}/`);
          return res.redirect(302, url.toString());
        }
        return res.status(401).type('text/plain').send('Sign in required.');
      }

      if (!hasSecondFactor(session.claims)) return deny(res, 'mfa');

      let member = await db.staff.findByClerkId(session.clerkUserId);
      if (!member) {
        const clerkUser = await provider.fetchUser(session.clerkUserId);
        member = clerkUser
          ? await db.staff.bindByVerifiedEmail({
              clerkUserId: session.clerkUserId,
              verifiedEmails: verifiedAddresses(clerkUser),
            })
          : null;
        if (member)
          logger.info({ staffId: String(member.id) }, 'Staff account bound to Clerk user');
      }
      if (!member || member.status !== 'active') return deny(res, 'not-staff');

      if (Date.now() - (member.last_login_at?.getTime() ?? 0) > LOGIN_TOUCH_MS) {
        await db.staff.recordLogin(member.id, req.ip);
      }
      req.session = session;
      req.staff = { id: member.id, email: member.email, name: member.name, roles: member.roles };
      res.locals.user = { name: member.name, email: member.email };
      next();
    } catch (err) {
      next(err);
    }
  }

  /** Allow staff holding any of `roles`. super_admin can do everything (ADMIN_OPERATIONS §2). */
  const requireRole =
    (...roles) =>
    (req, res, next) => {
      const held = req.staff.roles;
      if (held.includes('super_admin') || roles.some((r) => held.includes(r))) return next();
      deny(res, 'role');
    };

  /**
   * For sign-out only: look at the Clerk session but never refuse because there is none. The session cookie lasts about a
   * minute, so a person who clicks "Sign out" after a pause has none left, and must still end up at the sign-in page,
   * not on a blank "Sign in required".
   */
  const optionalSession = [
    clerk,
    async (req, res, next) => {
      try {
        req.session = (await provider.authenticate(req)) ?? null;
        next();
      } catch (err) {
        next(err);
      }
    },
  ];

  return { identify: [clerk, identify], optionalSession, requireRole };
}
