import { createHash } from 'node:crypto';
import { DomainError } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * One organization's website scans (DATABASE_SCHEMA §8 "readiness scans"): a scan row per run, the pages it read
 * and the result of each readiness check. Merged into `forOrg(orgId)`; the organization is bound once and no
 * function takes an `org_id` from its arguments (see org-scoped.js).
 *
 * A scan's life: `create` (queued) -> `start` (running) -> `finish` (complete, partial or failed). `finish`
 * replaces any rows an earlier attempt of the same scan wrote, so a retried job leaves exactly one set of results.
 */

const sha256 = (text) => createHash('sha256').update(text).digest();

// A site_pages row records HOW we first met the page. A menu link outranks a sitemap entry, which outranks a link
// in the page body.
const sourceOf = (sources = []) =>
  sources.includes('nav') ? 'nav' : sources.includes('sitemap') ? 'sitemap' : 'crawl';

const clip = (text, max) => (text == null ? null : String(text).slice(0, max));
const toDate = (text) => {
  const d = text ? new Date(text) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

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
        await tx.scan_checks.deleteMany({ where: { scan_id: scan.id, org_id: orgId } });
        await tx.scan_pages.deleteMany({ where: { scan_id: scan.id, org_id: orgId } });

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

        await tx.scan_pages.createMany({
          data: pageRows.map((p) => ({
            scan_id: scan.id,
            org_id: orgId,
            site_page_id: pageIdByHash.get(sha256(p.url).toString('hex')) ?? null,
            url: p.url,
            url_hash: sha256(p.url),
            is_key_page: Boolean(p.isKey),
            http_status: p.status,
            final_url: clip(p.finalUrl, 2048),
            redirect_count: Math.min(255, p.redirectCount ?? 0),
            content_type: clip(p.contentType, 128),
            raw_text_chars: p.rawTextChars,
            rendered_text_chars: p.renderedTextChars,
            raw_uri: clip(p.rawKey, 512),
            rendered_uri: clip(p.renderedKey, 512),
            jsonld_types: p.jsonLdTypes ?? [],
            fetch_ms: p.fetchMs === null || p.fetchMs === undefined ? null : Math.round(p.fetchMs),
            error: clip(p.error ?? p.renderError, 500),
            fetched_at: p.status === null ? null : finishedAt,
          })),
        });

        await tx.scan_checks.createMany({
          data: result.checks.map((c) => ({
            scan_id: scan.id,
            org_id: orgId,
            check_code: c.code,
            status: c.status,
            points_awarded: c.points,
            points_possible: c.possible,
            evidence: { summary: c.summary, ...c.evidence },
          })),
        });

        await tx.site_scans.update({
          where: { id: scan.id },
          data: {
            status: result.status,
            rubric_version: result.rubricVersion,
            readiness_score: result.readinessScore,
            category_scores: {
              categories: result.categoryScores,
              coverage: result.coverage,
              counts: result.counts,
              notes: result.notes,
              platform: result.site.platform,
              origin: result.site.origin,
            },
            robots_txt_uri: clip(result.robots.key, 512),
            sitemap_urls: result.sitemaps.found,
            pages_planned: result.pagesPlanned,
            pages_fetched: result.pagesFetched,
            finished_at: finishedAt,
          },
        });
        return { scanId: scan.id, pages: pageRows.length, checks: result.checks.length };
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
