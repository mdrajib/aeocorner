import { UnrecoverableError } from 'bullmq';
import { createCitedPageReader } from '../../crawler/cited-page.js';
import { queueRefresh } from '../refresh-queue.js';

/**
 * Reading the pages engines cite (Milestone 13, task 13.03):
 *
 *   citations.formats   for one project, read the format of its most cited pages that nobody has read yet (or not for 30
 *                       days), and keep it in the global URL dictionary. Up to `BATCH` pages a run, most cited first, so a
 *                       project with hundreds of sources catches up over a few days instead of crawling them all at once.
 *                       A page that cannot be read keeps no format and is tried again after a day. When it learned
 *                       anything, the project's recommendations are refreshed, because a competitor's page in a format we
 *                       write is a different kind of fix from a review site.
 *
 * Nothing here costs money, so it does not go through `callProvider`; the safe fetcher, robots.txt as `AEOCornerBot` and the
 * linear page parser are the guard rails (ADR-0005).
 */

export const BATCH = 10;
const WINDOW_DAYS = 28;
const DAY_MS = 86_400_000;

async function citationFormats(ctx, data) {
  const crawler = ctx.crawler;
  if (!crawler?.fetcher) {
    throw new UnrecoverableError('The crawler is not configured on this worker');
  }
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scoped = ctx.db.forOrg(orgId);
  const project = await scoped.projects.get(projectId);
  if (!project || project.status === 'archived') return { skipped: 'project_gone' };

  const now = ctx.now();
  const from = new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS);
  const urls = await scoped.dashboard.unreadCitedUrls(projectId, {
    from,
    to: now,
    limit: BATCH,
    now,
  });
  const reader = ctx.citations?.reader ?? createCitedPageReader({ fetcher: crawler.fetcher });
  const counts = { read: 0, couldNotLook: 0 };

  for (const url of urls) {
    const result = await reader.read(url.url);
    await scoped.dashboard.saveUrlFormat(projectId, url.id, { ...result, now });
    if (result.format) counts.read += 1;
    else counts.couldNotLook += 1;
  }
  if (counts.read > 0) {
    await queueRefresh(ctx, {
      orgId,
      projectId,
      cause: `fmt${now.toISOString().slice(0, 10)}`,
    });
  }
  return counts;
}

export const citationHandlers = {
  'citations.formats': citationFormats,
};
