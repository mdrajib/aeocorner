import { UnrecoverableError } from 'bullmq';
import { runSiteScan } from '../../crawler/scan.js';
import { ledgerKey } from '../provider-call.js';
import { queueRefresh } from '../refresh-queue.js';

/**
 * Handlers for the `crawl` queue: reading a customer's website.
 *
 * A scan is NOT routed through `callProvider`. That path is for paid providers: it rate-limits and circuit-breaks
 * by provider, and a breaker keyed on "the crawler" would stop every customer's scan because one customer's site
 * was down. Instead the crawler protects the sites it visits itself (robots.txt, pacing, size and time caps), and
 * the scan writes one ledger row of its own: the number of requests it made, at no cost, so volume is on the record.
 */

/**
 * Run one scan that already has its row. Exported because the same-day re-check of a fix (`fix.verify`) scans the site
 * the same way, as its own scan row with the trigger "verification".
 */
export async function executeScan(ctx, data, job) {
  const crawler = ctx.crawler;
  if (!crawler?.fetcher || !crawler?.store) {
    throw new UnrecoverableError('The crawler is not configured on this worker');
  }
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scanId = BigInt(data.scanId);
  const scoped = ctx.db.forOrg(orgId);

  // The organization comes from the payload, but everything is read through it: a scan that is not this
  // organization's, or whose project is not the one named, is simply not found.
  const scan = await scoped.scans.get(scanId);
  if (!scan || scan.project_id !== projectId || !scan.domain) {
    throw new UnrecoverableError(`Scan ${data.scanId} was not found`);
  }
  // A duplicate job, or a retry after the results were saved but before the job was acknowledged.
  if (['complete', 'partial', 'failed'].includes(scan.status)) {
    return { scanId: data.scanId, status: scan.status, repeated: true };
  }

  // robots.txt is ignored only for a site its owner has proven is theirs (a DNS record or a file, ADR-0005). Until then
  // a project is scanned like any other site: politely, and not at all where robots.txt says so.
  const project = await scoped.projects.get(projectId);
  const ownerVerified = Boolean(project?.domain_verified_at);

  await scoped.scans.start(scanId);
  try {
    const target = crawler.targetFor ? crawler.targetFor(scan.domain) : scan.domain;
    const result = await runSiteScan(target, {
      fetcher: crawler.fetcher,
      renderer: crawler.renderer ?? null,
      store: crawler.store,
      now: ctx.now,
      // The owner's request counts only once ownership is verified; the free audit never has an owner, so it obeys.
      respectRobots: !ownerVerified,
      log: (event, details) => ctx.logger.debug({ scan: data.scanId, event, ...details }, 'crawl'),
    });
    await scoped.scans.finish(scanId, result);
    await scoped.usage.record({
      projectId,
      meter: 'crawl',
      providerCode: 'crawler',
      unit: 'request',
      quantity: result.connections.length,
      costUsd: '0',
      refType: 'scan',
      refId: scanId,
      idempotencyKey: ledgerKey('crawl', job),
    });
    // What the scan found may open, change or clear recommendations.
    if (result.status !== 'failed') {
      await queueRefresh(ctx, { orgId, projectId, cause: `scan${data.scanId}` });
    }
    return {
      scanId: data.scanId,
      status: result.status,
      readinessScore: result.readinessScore,
      pagesFetched: result.pagesFetched,
    };
  } catch (err) {
    // The job will be retried; on the last attempt the scan must not be left looking busy.
    const lastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
    if (lastAttempt) await scoped.scans.fail(scanId).catch(() => {});
    throw err;
  }
}

export const crawlHandlers = {
  'crawl.readiness': executeScan,
};
