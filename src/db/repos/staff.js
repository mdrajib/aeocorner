import { DomainError, isUniqueViolation } from '../errors.js';

/**
 * Internal staff accounts (DATABASE_SCHEMA §2.2). Sign-in and the second factor live in the separate
 * staff Clerk application; this table only says who is allowed in and with which roles.
 * Staff are invite-only: a super_admin creates the row, and the Clerk user ID is bound on first sign-in.
 */
export function staffRepo(prisma) {
  const withRoles = { staff_roles_staff_roles_staff_user_idTostaff_users: true };

  const shape = (row) => {
    if (!row) return null;
    const { staff_roles_staff_roles_staff_user_idTostaff_users: roles, ...staff } = row;
    return { ...staff, roles: roles.map((r) => r.role) };
  };

  return {
    async findByClerkId(clerkUserId) {
      return shape(
        await prisma.staff_users.findUnique({
          where: { clerk_user_id: String(clerkUserId) },
          include: withRoles,
        }),
      );
    },

    /**
     * Bind a Clerk user to the staff row invited under one of their VERIFIED emails. Only an unbound row can
     * be claimed, and only once: a second Clerk user with the same email gets nothing.
     * @returns the bound staff member, or null if no active, unbound invitation matches.
     */
    async bindByVerifiedEmail({ clerkUserId, verifiedEmails }) {
      const emails = verifiedEmails.map((e) => String(e).trim().toLowerCase());
      const candidate = await prisma.staff_users.findFirst({
        where: { email: { in: emails }, clerk_user_id: null, status: 'active' },
      });
      if (!candidate) return null;
      const claimed = await prisma.staff_users.updateMany({
        where: { id: candidate.id, clerk_user_id: null },
        data: { clerk_user_id: String(clerkUserId) },
      });
      if (claimed.count !== 1) return null;
      return shape(
        await prisma.staff_users.findUnique({ where: { id: candidate.id }, include: withRoles }),
      );
    },

    recordLogin: (staffId, ip) =>
      prisma.staff_users.update({
        where: { id: staffId },
        data: { last_login_at: new Date(), last_login_ip: ip ? String(ip).slice(0, 45) : null },
      }),

    /** Invite a staff member (what a super_admin does; also used to create the first one from a script). */
    async invite({ email, name, roles, createdByStaffId = null }) {
      if (!roles?.length) throw new DomainError('ROLE_REQUIRED');
      try {
        return await prisma.$transaction(async (tx) => {
          const staff = await tx.staff_users.create({
            data: {
              email: String(email).trim().toLowerCase(),
              name,
              created_by_staff_id: createdByStaffId,
            },
          });
          await tx.staff_roles.createMany({
            data: roles.map((role) => ({
              staff_user_id: staff.id,
              role,
              granted_by_staff_id: createdByStaffId,
            })),
          });
          return staff;
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_staff_users_email'))
          throw new DomainError('ALREADY_INVITED');
        throw err;
      }
    },
  };
}
