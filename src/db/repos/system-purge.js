import { KEPT_AFTER_PURGE, purgeOrder } from '../../core/org-purge.js';

/**
 * The purge of closed organizations (docs/DATABASE_SCHEMA.md §8). An organization is purgeable once it is closed
 * (`deleted_at`, by the retention sweep or a deletion request) and its `purge_after` has passed. Reviewed and
 * listed in tests/tenancy like the rest of `system`.
 *
 * Which tables to empty and in what order come from the database itself (every table with an `org_id`, ordered by
 * its foreign keys), so a table added later is purged without a list to forget. Rows go in batches of BATCH so a
 * large organization never holds a long lock, and the purge is not one transaction: it can stop at any point and
 * run again, because the organization stays purgeable until its own row is the last thing deleted.
 */

const BATCH = 5000;
const SAFE_NAME = /^[a-z0-9_]+$/;

export function systemPurge(prisma) {
  /** The tables to empty for one organization, children first. Names come from the schema, never from a caller. */
  async function tableOrder() {
    const cols = await prisma.$queryRaw`
      SELECT DISTINCT table_name AS name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND column_name = 'org_id'`;
    const tables = cols
      .map((r) => String(r.name))
      .filter((t) => t !== 'organizations' && !(t in KEPT_AFTER_PURGE));
    for (const t of tables) if (!SAFE_NAME.test(t)) throw new Error(`Unexpected table name: ${t}`);

    const fks = await prisma.$queryRaw`
      SELECT DISTINCT table_name AS child, referenced_table_name AS parent
      FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`;
    return purgeOrder(
      tables,
      fks.map((r) => ({ child: String(r.child), parent: String(r.parent) })),
    );
  }

  /** The organization is still closed and past its purge date (checked again before every table). */
  async function stillPurgeable(orgId, now) {
    const n = await prisma.organizations.count({
      where: { id: orgId, deleted_at: { not: null }, purge_after: { lte: now } },
    });
    return n === 1;
  }

  return {
    /** Closed organizations whose purge date has passed, oldest first. */
    async purgeDue({ now = new Date(), limit = 20 } = {}) {
      const rows = await prisma.organizations.findMany({
        where: { deleted_at: { not: null }, purge_after: { lte: now } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: limit,
      });
      return rows.map((r) => r.id);
    },

    /**
     * Delete everything one closed organization owns, then the organization. Returns `null` when it is not (or no
     * longer) purgeable, otherwise the number of rows removed per table. Safe to run again after a crash.
     */
    async purge(orgId, { now = new Date() } = {}) {
      if (!(await stillPurgeable(orgId, now))) return null;
      const removed = {};

      // A scan of an audit the organization claimed may carry no org_id of its own, but it blocks deleting the audit.
      removed.site_scans_of_audits = Number(
        await prisma.$executeRaw`
          DELETE FROM site_scans WHERE org_id IS NULL
            AND audit_id IN (SELECT id FROM audits WHERE org_id = ${orgId})`,
      );

      for (const table of await tableOrder()) {
        if (!(await stillPurgeable(orgId, now))) return null;
        let total = 0;
        for (;;) {
          const n = Number(
            await prisma.$executeRawUnsafe(
              `DELETE FROM \`${table}\` WHERE org_id = ? LIMIT ${BATCH}`,
              orgId,
            ),
          );
          total += n;
          if (n < BATCH) break;
        }
        if (total > 0) removed[table] = total;
      }

      if (!(await stillPurgeable(orgId, now))) return null;
      // The proof line is written first: it survives (the log is append-only and has no foreign key to the organization).
      await prisma.org_activity_log.create({
        data: {
          org_id: orgId,
          actor_type: 'system',
          action: 'org.purged',
          summary: 'All of the organization’s data was deleted at the end of its retention period',
        },
      });
      const gone = await prisma.organizations.deleteMany({
        where: { id: orgId, deleted_at: { not: null }, purge_after: { lte: now } },
      });
      if (gone.count !== 1) return null;
      removed.organizations = 1;
      return removed;
    },
  };
}
