/**
 * Leads: the email addresses of people who asked for a free audit (DATABASE_SCHEMA §2.8). Global, not tenant data:
 * a lead has no organization until they sign up. They are kept 12 months after their last audit unless they convert
 * (`delete_after`).
 */

const RETENTION_MONTHS = 12;

const retentionEnd = (from) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + RETENTION_MONTHS);
  return d;
};

export function leadsRepo(prisma) {
  return {
    /**
     * Record that `email` asked for an audit. One row per address. The consent box is stored exactly as ticked: an
     * unticked box is "no consent", and a later unticked audit never withdraws a consent given earlier (leaving the
     * list is an unsubscribe, which is its own action). The 12-month clock restarts with each audit.
     */
    async capture({
      email,
      consent = false,
      consentVersion = null,
      utm = null,
      ipHash = null,
      now = new Date(),
    }) {
      const address = String(email).trim().toLowerCase();
      const ticked = consent === true;
      await prisma.$executeRaw`
        INSERT INTO leads
          (email, email_domain, consent_marketing, consent_version, consent_at, utm, first_ip_hash, delete_after)
        VALUES
          (${address}, ${address.split('@').pop()}, ${ticked ? 1 : 0}, ${ticked ? consentVersion : null},
           ${ticked ? now : null}, ${utm === null ? null : JSON.stringify(utm)}, ${ipHash}, ${retentionEnd(now)})
        ON DUPLICATE KEY UPDATE
          consent_version = IF(${ticked ? 1 : 0} = 1, VALUES(consent_version), consent_version),
          consent_at = IF(${ticked ? 1 : 0} = 1 AND consent_marketing = 0, VALUES(consent_at), consent_at),
          consent_marketing = IF(${ticked ? 1 : 0} = 1, 1, consent_marketing),
          delete_after = IF(converted_org_id IS NULL, VALUES(delete_after), delete_after)`;
      return prisma.leads.findUnique({ where: { email: address } });
    },

    async get(leadId) {
      return prisma.leads.findUnique({ where: { id: leadId } });
    },

    /** The visitor proved they own the address. The first time stays; returns the lead as it now is. */
    async markVerified(leadId, at = new Date()) {
      await prisma.leads.updateMany({
        where: { id: leadId, verified_at: null },
        data: { verified_at: at },
      });
      return prisma.leads.findUnique({ where: { id: leadId } });
    },
  };
}
