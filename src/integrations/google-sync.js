import {
  GA4_PAGE_SIZE,
  GSC_MAX_PAGES,
  GSC_ROW_LIMIT,
  ga4Reports,
  gscRequests,
  parseGa4Response,
  parseGscResponse,
} from '../core/traffic.js';

/**
 * Read a day range from GA4 and Search Console, all pages of every report (Milestone 8, tasks 8.10 and 8.11). Pure
 * orchestration over the Google client: the client is handed in, so a test hands it a stand-in.
 */

const MAX_GA4_PAGES = 50;

/** Every row of the three GA4 reports over `[startDate, endDate]`, parsed. Throws on an unreadable answer. */
export async function fetchGa4({ google, accessToken, propertyId, startDate, endDate }) {
  const reports = ga4Reports({ startDate, endDate });
  const out = [];
  for (const kind of ['ai', 'all', 'organic']) {
    let offset = 0;
    for (let page = 0; page < MAX_GA4_PAGES; page += 1) {
      const response = await google.runReport(accessToken, propertyId, {
        ...reports[kind],
        offset,
      });
      out.push(...parseGa4Response(response, kind));
      const total = Number(response.rowCount ?? 0);
      offset += GA4_PAGE_SIZE;
      if (offset >= total) break;
    }
  }
  return out;
}

/** Every branded query and every page row of Search Console over `[startDate, endDate]`, parsed. */
export async function fetchSearchConsole({
  google,
  accessToken,
  siteUrl,
  startDate,
  endDate,
  terms,
}) {
  const requests = gscRequests({ startDate, endDate });
  const out = [];
  for (const dimension of ['query', 'page']) {
    for (let page = 0; page < GSC_MAX_PAGES; page += 1) {
      const response = await google.queryResults(accessToken, siteUrl, {
        ...requests[dimension],
        startRow: page * GSC_ROW_LIMIT,
      });
      out.push(...parseGscResponse(response, dimension, terms));
      if ((response.rows?.length ?? 0) < GSC_ROW_LIMIT) break;
    }
  }
  return out;
}

const DAY_MS = 86_400_000;
export const dayString = (d) => d.toISOString().slice(0, 10);
export const addDaysText = (text, n) =>
  dayString(new Date(new Date(`${text}T00:00:00Z`).getTime() + n * DAY_MS));

/** How far back the first sync goes, and how many recent days every sync reads again (late data settles). */
export const BACKFILL_DAYS = 90;
export const OVERLAP_DAYS = 3;
/** Search Console's newest finished day is about two days behind. */
export const GSC_LAG_DAYS = 2;

/**
 * The day range one sync should read: from the first day not yet read (less the overlap), or the backfill on the first
 * sync, up to yesterday. GA4 is read through yesterday (a day in progress is not a day); Search Console through its lag.
 * @param {{synced_from?: string|null, synced_to?: string|null}} config
 */
export function syncRange(config, now = new Date()) {
  const today = dayString(now);
  const endGa4 = addDaysText(today, -1);
  const endGsc = addDaysText(today, -GSC_LAG_DAYS);
  const startFirst = addDaysText(today, -BACKFILL_DAYS);
  const start = config?.synced_to ? addDaysText(config.synced_to, -OVERLAP_DAYS) : startFirst;
  return {
    ga4: { startDate: start < startFirst ? startFirst : start, endDate: endGa4 },
    gsc: { startDate: start < startFirst ? startFirst : start, endDate: endGsc },
  };
}
