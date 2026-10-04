/**
 * "Is the published page really there?" (MVP F7: a published page is verified by fetching it, the same way as a
 * readiness fix is re-scanned). Pure: the worker fetches the page with the safe fetcher and reads it with the crawler's
 * `extractPage`; this decides what that says.
 *
 * Like `judgeCheck` (src/worker/handlers/actions.js) it never turns "we could not look" into "your fix failed": a
 * network error, a busy or blocking site (429, 401, 403, 5xx) is `couldntCheck`; a page that is not there (404, 410), is
 * marked noindex, lacks its headline or lacks the structured data we sent is a real failure.
 *
 * @param {object} input
 * @param {number|null} input.status   HTTP status of the final page, or null when the fetch failed
 * @param {object|null} input.facts    `extractPage(...)` of the page
 * @param {{ headline?: string, types?: string[] }} input.expect
 * @returns {{ status: 'passed'|'failed', couldntCheck: boolean, reasons: string[] }}
 */
export function judgeLivePage({ status, facts, expect = {} }) {
  const couldnt = (reason) => ({ status: 'failed', couldntCheck: true, reasons: [reason] });
  if (status == null) return couldnt('fetch_failed');
  if (status === 429 || status === 401 || status === 403 || status >= 500)
    return couldnt(`http_${status}`);
  if (status === 404 || status === 410)
    return { status: 'failed', couldntCheck: false, reasons: ['not_found'] };
  if (status < 200 || status >= 300)
    return { status: 'failed', couldntCheck: false, reasons: [`http_${status}`] };
  if (!facts || facts.skipped) return couldnt('unreadable');

  const reasons = [];
  if (facts.noindex) reasons.push('noindex');
  if (expect.headline) {
    const want = norm(expect.headline);
    const have = [facts.title, ...(facts.headings ?? []).map((h) => h.text)].map(norm);
    if (!have.some((h) => h.includes(want) || (h.length > 12 && want.includes(h))))
      reasons.push('headline_missing');
  }
  if (expect.types?.length) {
    const found = new Set(facts.jsonLd?.types ?? []);
    if (!expect.types.every((t) => found.has(t))) reasons.push('structured_data_missing');
  }
  return { status: reasons.length ? 'failed' : 'passed', couldntCheck: false, reasons };
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** What each reason means to the customer. */
export const LIVE_REASON_TEXT = Object.freeze({
  fetch_failed: 'We could not reach the page.',
  unreadable: 'We could not read the page.',
  not_found: 'The page is not there (the site says it was not found).',
  noindex: 'The page tells search and AI crawlers not to use it (noindex).',
  headline_missing: 'The page does not show the headline we published.',
  structured_data_missing: 'The structured data we sent is not in the page the crawlers see.',
});
