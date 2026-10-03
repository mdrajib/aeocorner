/**
 * Blocks on the free audit (DATABASE_SCHEMA §2.8, `abuse_blocks`): an IP or network, an email address or a whole
 * email domain, or a target domain that may not be audited. Global by nature: the visitor has no organization.
 *
 * Made by staff (no expiry unless they set one) or automatically by the audit limiter (a day). Velocity counters are
 * not here: they live in Redis (src/lib/audit-limits.js).
 */

const KINDS = ['ip', 'ip_prefix', 'email', 'email_domain', 'target_domain'];

const clean = (kind, value) => {
  if (!KINDS.includes(kind)) throw new RangeError(`Unknown block kind: ${kind}`);
  return String(value).trim().toLowerCase().slice(0, 253);
};

export function abuseRepo(prisma) {
  return {
    /**
     * The block that applies to this visitor right now, or null. Expired blocks do not count (they are removed by
     * the retention job, not by this lookup). Pass whichever of the five the caller knows.
     */
    async active({ ip, ipPrefix, email, emailDomain, targetDomain, now = new Date() }) {
      const pairs = [
        ['ip', ip],
        ['ip_prefix', ipPrefix],
        ['email', email],
        ['email_domain', emailDomain],
        ['target_domain', targetDomain],
      ]
        .filter(([, value]) => value)
        .map(([kind, value]) => ({ kind, value: clean(kind, value) }));
      if (pairs.length === 0) return null;
      return prisma.abuse_blocks.findFirst({
        where: {
          OR: pairs,
          AND: [{ OR: [{ expires_at: null }, { expires_at: { gt: now } }] }],
        },
        orderBy: { id: 'asc' },
      });
    },

    /**
     * Block something. One row per (kind, value): blocking it again refreshes an automatic block, and never
     * shortens or replaces one a staff member made.
     */
    async block({ kind, value, reason, expiresAt = null, staffId = null }) {
      const v = clean(kind, value);
      await prisma.$executeRaw`
        INSERT INTO abuse_blocks (kind, value, reason, created_by_staff_id, expires_at)
        VALUES (${kind}, ${v}, ${String(reason).slice(0, 255)}, ${staffId}, ${expiresAt})
        ON DUPLICATE KEY UPDATE
          reason = IF(created_by_staff_id IS NOT NULL, reason, VALUES(reason)),
          expires_at = IF(created_by_staff_id IS NOT NULL, expires_at, VALUES(expires_at))`;
      return prisma.abuse_blocks.findFirst({ where: { kind, value: v } });
    },

    async unblock({ kind, value }) {
      const result = await prisma.abuse_blocks.deleteMany({
        where: { kind, value: clean(kind, value) },
      });
      return result.count === 1;
    },
  };
}
