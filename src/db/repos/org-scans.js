import { DomainError } from '../errors.js';
import { transaction } from '../transaction.js';
import { clip, sha256, toDate, writeScanResult } from './scan-results.js';

/**
 * One organization's website scans (DATABASE_SCHEMA §8 "readiness scans"): a scan row per run, the pages it read
 * and the result of each readiness check. Merged into `forOrg(orgId)`; the organization is bound once and no
 * function takes an `org_id` from its arguments (see org-scoped.js).
 *
 * A scan's life: `create` (queued) -> `start` (running) -> `finish` (complete, partial or failed). `finish`
 * replaces any rows an earlier attempt of the same scan wrote, so a retried job leaves exactly one set of results.
 */

// A site_pages row records HOW we first met the page. A menu link outranks a sitemap entry, which outranks a link
// in the page body.
const sourceOf = (sources = []) =>
  sources.includes('nav') ? 'nav' : sources.includes('sitemap') ? 'sitemap' : 'crawl';

export function scanRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const found = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId },
      select: { id: true },
    });
    if (!found) throw new DomainError('PROJECT_NOT_IN_ORG');
  }

  const scans = {
    /** Queue a scan of one of this organization's projects. */
    async create({ projectId, trigger = 'manual', rubricVersion }) {
      await ownProject(projectId);
      return prisma.site_scans.create({
        data: {
          org_id: orgId,
          project_id: projectId,
          trigger_type: trigger,
          rubric_version: rubricVersion,
          status: 'queued',
        },
      });
    },

    /** A scan and the domain of the project it belongs to, or null if it is not this organization's. */
    async get(scanId) {
      const scan = await prisma.site_scans.findFirst({
        where: { id: scanId, org_id: orgId },
        include: { projects: { select: { domain: true } } },
      });
      if (!scan) return null;
      const { projects, ...rest } = scan;
      return { ...rest, domain: projects?.domain ?? null };
    },

    /** Mark a queued scan as running. A scan that already finished is left alone (a duplicate job). */
    async start(scanId) {
      const result = await prisma.site_scans.updateMany({
        where: { id: scanId, org_id: orgId, status: { in: ['queued', 'running'] } },
        data: { status: 'running', started_at: new Date() },
      });
      return result.count === 1;
    },

    /**
     * Save the outcome of a scan: the scan row, the pages it read and every check's result. All or nothing, and
     * safe to repeat: rows from an earlier attempt are replaced.
     * @param result  what `runSiteScan` returned
     */
    async finish(scanId, result) {
      const scan = await prisma.site_scans.findFirst({
        where: { id: scanId, org_id: orgId },
        select: { id: true, project_id: true },
      });
      if (!scan) throw new DomainError('NOT_FOUND');
      const finishedAt = toDate(result.finishedAt) ?? new Date();

      return transaction(prisma, async (tx) => {
        // The project's known pages: one row per address, refreshed by every scan.
        const pageRows = result.pages.filter((p) => p.url);
        for (const p of pageRows) {
          await tx.$executeRaw`
            INSERT INTO site_pages
              (org_id, project_id, url, url_hash, title, page_type, is_key_page, source,
               last_http_status, last_crawled_at, last_modified_at)
            VALUES
              (${orgId}, ${scan.project_id}, ${p.url}, ${sha256(p.url)}, ${clip(p.title, 512)},
               ${p.pageType}, ${p.isKey ? 1 : 0}, ${sourceOf(p.sources)},
               ${p.status}, ${p.status === null ? null : finishedAt}, ${toDate(p.headers?.['last-modified'])})
            ON DUPLICATE KEY UPDATE
              title = COALESCE(VALUES(title), title), page_type = VALUES(page_type),
              is_key_page = VALUES(is_key_page),
              last_http_status = COALESCE(VALUES(last_http_status), last_http_status),
              last_crawled_at = COALESCE(VALUES(last_crawled_at), last_crawled_at),
              last_modified_at = COALESCE(VALUES(last_modified_at), last_modified_at)`;
        }
        const known = await tx.site_pages.findMany({
          where: {
            project_id: scan.project_id,
            org_id: orgId,
            url_hash: { in: pageRows.map((p) => sha256(p.url)) },
          },
          select: { id: true, url_hash: true },
        });
        const pageIdByHash = new Map(known.map((k) => [k.url_hash.toString('hex'), k.id]));

        return writeScanResult(tx, { scan, orgId, result, finishedAt, pageIdByHash });
      });
    },

    /**
     * Give up on a scan: its job failed every attempt. Without this a scan would stay "running" forever. A scan that
     * already finished is left as it is.
     */
    async fail(scanId) {
      const result = await prisma.site_scans.updateMany({
        where: { id: scanId, org_id: orgId, status: { in: ['queued', 'running'] } },
        data: { status: 'failed', finished_at: new Date() },
      });
      return result.count === 1;
    },

    /** The most recent scans of a project, newest first. */
    async recent({ projectId, limit = 20 }) {
      return prisma.site_scans.findMany({
        where: { org_id: orgId, project_id: projectId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: Math.min(limit, 100),
      });
    },

    /** The result of every readiness check in a scan. */
    async checks(scanId) {
      return prisma.scan_checks.findMany({
        where: { scan_id: scanId, org_id: orgId },
        orderBy: { check_code: 'asc' },
      });
    },

    /** The pages a scan read. */
    async pages(scanId) {
      return prisma.scan_pages.findMany({
        where: { scan_id: scanId, org_id: orgId },
        orderBy: { id: 'asc' },
      });
    },

    /** The pages we know about for a project (the key pages, with what each is). */
    async knownPages(projectId) {
      return prisma.site_pages.findMany({
        where: { project_id: projectId, org_id: orgId },
        orderBy: { id: 'asc' },
      });
    },
  };

  return { scans };
}
