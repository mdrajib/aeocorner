import { createHash } from 'node:crypto';

/**
 * Writing one scan's outcome: its pages, its checks and the scan row itself. Shared by the two owners a scan can
 * have (DATABASE_SCHEMA §2.8): an organization's project (org-scans.js) and a free audit (audits.js), so there is
 * one readiness engine and one way its results are stored. Runs inside the caller's transaction.
 *
 * Rows from an earlier attempt of the same scan are removed first, so a retried job leaves exactly one set.
 * `orgId` is the organization for a project scan and null for an audit's.
 */

export const sha256 = (text) => createHash('sha256').update(text).digest();

export const clip = (text, max) => (text == null ? null : String(text).slice(0, max));

export const toDate = (text) => {
  const d = text ? new Date(text) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * @param tx       the transaction client
 * @param scan     { id } of the site_scans row, already checked to belong to the caller
 * @param orgId    BigInt, or null for an audit's scan
 * @param result   what `runSiteScan` returned
 * @param pageIdByHash  Map of url hash (hex) -> site_pages.id, for a project's scan; empty for an audit's
 */
export async function writeScanResult(
  tx,
  { scan, orgId, result, finishedAt, pageIdByHash = new Map() },
) {
  await tx.scan_checks.deleteMany({ where: { scan_id: scan.id, org_id: orgId } });
  await tx.scan_pages.deleteMany({ where: { scan_id: scan.id, org_id: orgId } });

  const pageRows = result.pages.filter((p) => p.url);
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
}
