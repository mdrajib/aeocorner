import { hashToken } from '../../lib/tokens.js';
import { DomainError, isUniqueViolation } from '../errors.js';

/**
 * Invitations seen from the invitee's side. This is the one place a tenant row is found without first
 * knowing the organization, and that is safe only because the emailed token is the key: 256 random
 * bits, stored as a SHA-256 hash, so a serial ID or a guess finds nothing (DATABASE_SCHEMA §2.4).
 * Everything after the lookup is bound to the invitation's own organization.
 */
export function invitationLinksRepo(prisma) {
  const OWNER_ROLES = ['owner', 'admin'];

  function usable(invitation) {
    if (!invitation) return 'not_found';
    if (invitation.status !== 'pending') return invitation.status; // accepted | rejected | canceled | expired
    return invitation.expires_at.getTime() <= Date.now() ? 'expired' : 'pending';
  }

  return {
    /** The invitation and its organization's name, plus a plain status for the page to show. */
    async find(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const invitation = await prisma.invitations.findUnique({
        where: { token_hash: hashToken(token) },
        include: { organizations: { select: { public_id: true, name: true, deleted_at: true } } },
      });
      if (!invitation || invitation.organizations.deleted_at) return null;
      const { organizations: org, ...rest } = invitation;
      return { invitation: rest, org, state: usable(invitation) };
    },

    /**
     * Accept an invitation. The caller proves identity by passing the Clerk user's VERIFIED email
     * addresses (fetched from Clerk just now); the invitation must have been sent to one of them.
     * Accepting twice is harmless: the second call returns the existing membership.
     * @returns {Promise<{ orgId: bigint, orgPublicId: string, membership: object, alreadyMember: boolean }>}
     */
    async accept({ token, user, verifiedEmails }) {
      const tokenHash = hashToken(token);
      const emails = new Set(verifiedEmails.map((e) => String(e).trim().toLowerCase()));

      return prisma.$transaction(async (tx) => {
        // Lock the invitation so two tabs accepting at once can't both create a membership.
        const rows = await tx.$queryRaw`
          SELECT id FROM invitations WHERE token_hash = ${tokenHash} FOR UPDATE`;
        if (rows.length === 0) throw new DomainError('INVITE_NOT_FOUND');

        const invitation = await tx.invitations.findUnique({
          where: { id: rows[0].id },
          include: { organizations: { select: { id: true, public_id: true, deleted_at: true } } },
        });
        if (invitation.organizations.deleted_at) throw new DomainError('INVITE_NOT_FOUND');
        if (!emails.has(invitation.email.toLowerCase())) throw new DomainError('EMAIL_MISMATCH');

        const orgId = invitation.org_id;
        const existing = await tx.memberships.findFirst({
          where: { org_id: orgId, user_id: user.id },
        });
        if (existing) {
          if (invitation.status === 'pending') {
            await tx.invitations.update({
              where: { id: invitation.id },
              data: { status: 'accepted', accepted_at: new Date() },
            });
          }
          return {
            orgId,
            orgPublicId: invitation.organizations.public_id,
            membership: existing,
            alreadyMember: true,
          };
        }

        if (invitation.status !== 'pending') throw new DomainError('INVITE_USED');
        if (invitation.expires_at.getTime() <= Date.now()) throw new DomainError('INVITE_EXPIRED');

        let membership;
        try {
          membership = await tx.memberships.create({
            data: { org_id: orgId, user_id: user.id, role: invitation.role, project_access: 'all' },
          });
        } catch (err) {
          if (isUniqueViolation(err, 'uq_memberships_org_user'))
            throw new DomainError('ALREADY_MEMBER');
          throw err;
        }

        if (invitation.project_access === 'selected' && !OWNER_ROLES.includes(invitation.role)) {
          const wanted = (invitation.project_ids ?? []).map((id) => BigInt(id));
          const stillThere = await tx.projects.findMany({
            where: { org_id: orgId, deleted_at: null, id: { in: wanted } },
            select: { id: true },
          });
          // A selected-projects seat with no projects left would silently see nothing; refuse instead.
          if (stillThere.length === 0) throw new DomainError('INVITE_PROJECTS_GONE');
          await tx.memberships.update({
            where: { id: membership.id },
            data: { project_access: 'selected' },
          });
          await tx.membership_projects.createMany({
            data: stillThere.map((p) => ({
              membership_id: membership.id,
              project_id: p.id,
              org_id: orgId,
            })),
          });
          membership = { ...membership, project_access: 'selected' };
        }

        await tx.invitations.update({
          where: { id: invitation.id },
          data: { status: 'accepted', accepted_at: new Date() },
        });
        await tx.users.update({ where: { id: user.id }, data: { last_org_id: orgId } });
        await tx.org_activity_log.create({
          data: {
            org_id: orgId,
            actor_type: 'user',
            actor_user_id: user.id,
            action: 'invitation.accepted',
            target_type: 'membership',
            target_id: membership.id,
            summary: `${user.name || 'A new member'} accepted an invitation as ${invitation.role}`,
            metadata: { role: invitation.role },
          },
        });
        return {
          orgId,
          orgPublicId: invitation.organizations.public_id,
          membership,
          alreadyMember: false,
        };
      });
    },
  };
}
