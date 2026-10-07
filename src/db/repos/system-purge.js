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
 *
 * Two things live outside the organization's rows and go first, through hooks the worker passes in (this layer
 * never touches Spaces or Clerk):
 *  - the raw files in Spaces that no row of any other organization or audit points at (the keys are content
 *    addressed, so two owners can share one file; a shared file stays), and
 *  - the Clerk accounts of people who belong to no other organization.
 * A hook that fails stops the purge before anything is deleted, so the next night starts again from the same
 * place. A file that is already gone is not an error.
 */

const BATCH = 5000;
const KEY_BATCH = 500;
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

  /** Every Spaces key the organization's own rows point at (its scans, audits' scans, answers, audits' answers, reports). */
  async function filesOf(orgId) {
    const rows = await prisma.$queryRaw`
      SELECT raw_uri AS k FROM answer_snapshots WHERE org_id = ${orgId} AND raw_uri IS NOT NULL
      UNION SELECT file_uri FROM reports WHERE org_id = ${orgId} AND file_uri IS NOT NULL
      UNION SELECT robots_txt_uri FROM site_scans
        WHERE (org_id = ${orgId} OR audit_id IN (SELECT id FROM audits WHERE org_id = ${orgId}))
          AND robots_txt_uri IS NOT NULL
      UNION SELECT p.raw_uri FROM scan_pages p JOIN site_scans s ON s.id = p.scan_id
        WHERE (s.org_id = ${orgId} OR s.audit_id IN (SELECT id FROM audits WHERE org_id = ${orgId}))
          AND p.raw_uri IS NOT NULL
      UNION SELECT p.rendered_uri FROM scan_pages p JOIN site_scans s ON s.id = p.scan_id
        WHERE (s.org_id = ${orgId} OR s.audit_id IN (SELECT id FROM audits WHERE org_id = ${orgId}))
          AND p.rendered_uri IS NOT NULL
      UNION SELECT a.raw_uri FROM audit_answers a JOIN audits u ON u.id = a.audit_id
        WHERE u.org_id = ${orgId} AND a.raw_uri IS NOT NULL`;
    return rows.map((r) => String(r.k));
  }

  /** Of `keys`, the ones some row that is NOT this organization's still points at. */
  async function filesHeldByOthers(orgId, keys) {
    const held = new Set();
    for (let i = 0; i < keys.length; i += KEY_BATCH) {
      const batch = keys.slice(i, i + KEY_BATCH);
      const marks = batch.map(() => '?').join(',');
      const owned =
        '(COALESCE(s.org_id, 0) = ? OR COALESCE(s.audit_id IN (SELECT id FROM audits WHERE org_id = ?), 0))';
      const sql = `
        SELECT raw_uri AS k FROM answer_snapshots WHERE org_id <> ? AND raw_uri IN (${marks})
        UNION SELECT file_uri FROM reports WHERE org_id <> ? AND file_uri IN (${marks})
        UNION SELECT export_uri FROM data_requests WHERE org_id <> ? AND export_uri IN (${marks})
        UNION SELECT s.robots_txt_uri FROM site_scans s WHERE NOT ${owned} AND s.robots_txt_uri IN (${marks})
        UNION SELECT p.raw_uri FROM scan_pages p JOIN site_scans s ON s.id = p.scan_id
          WHERE NOT ${owned} AND p.raw_uri IN (${marks})
        UNION SELECT p.rendered_uri FROM scan_pages p JOIN site_scans s ON s.id = p.scan_id
          WHERE NOT ${owned} AND p.rendered_uri IN (${marks})
        UNION SELECT a.raw_uri FROM audit_answers a JOIN audits u ON u.id = a.audit_id
          WHERE COALESCE(u.org_id, 0) <> ? AND a.raw_uri IN (${marks})`;
      const params = [
        orgId,
        ...batch,
        orgId,
        ...batch,
        orgId,
        ...batch,
        orgId,
        orgId,
        ...batch,
        orgId,
        orgId,
        ...batch,
        orgId,
        orgId,
        ...batch,
        orgId,
        ...batch,
      ];
      for (const r of await prisma.$queryRawUnsafe(sql, ...params)) held.add(String(r.k));
    }
    return held;
  }

  /** Files only this organization holds: what the purge may delete from Spaces. */
  async function filesToDelete(orgId) {
    const keys = [...new Set(await filesOf(orgId))];
    if (keys.length === 0) return [];
    const held = await filesHeldByOthers(orgId, keys);
    return keys.filter((k) => !held.has(k));
  }

  /** Members who belong to no other organization: their Clerk accounts have no reason to stay. */
  async function soleMembers(orgId) {
    const rows = await prisma.$queryRaw`
      SELECT u.id AS id, u.clerk_user_id AS clerkUserId
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${orgId} AND u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.user_id = u.id AND o.org_id <> ${orgId})`;
    return rows.map((r) => ({ id: r.id, clerkUserId: String(r.clerkUserId) }));
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
     *
     * `erase` (both optional): `files(keys)` deletes those files from Spaces, `users([{ id, clerkUserId }])` deletes
     * those people's Clerk accounts and anonymizes them here. They run before any row is deleted; if one throws,
     * so does the purge, and nothing has been removed from the database yet.
     */
    async purge(orgId, { now = new Date(), erase = {} } = {}) {
      if (!(await stillPurgeable(orgId, now))) return null;
      const removed = {};

      if (erase.files) {
        const keys = await filesToDelete(orgId);
        if (keys.length > 0) removed.spaces_files = (await erase.files(keys)) ?? keys.length;
      }
      if (erase.users) {
        const members = await soleMembers(orgId);
        if (members.length > 0)
          removed.clerk_accounts = (await erase.users(members)) ?? members.length;
      }

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

    /** What `purge` would delete from Spaces, for a test or a dry run. */
    filesToDelete,
  };
}
