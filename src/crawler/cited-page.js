import { citableSignals, readPageFormat } from '../core/citation-format.js';
import { decodeBody } from './decode.js';
import { extractPage } from './html.js';
import { createRobotsGate } from './robots-gate.js';
import { FetchError } from './safe-fetch.js';

/**
 * Read one page an AI engine cited (Milestone 13, task 13.03): what format is it, and what makes it easy to cite. It is "a
 * URL we did not choose", so it goes through the safe fetcher (ADR-0005) and robots.txt is obeyed as `AEOCornerBot`
 * (src/crawler/robots-gate.js).
 *
 * Nothing here throws for a page we could not read: that is `{ format: null, finding }`, and the caller keeps no format for
 * it. "Couldn't look" is never "other". The page is hostile input, read only by `extractPage` (linear, nesting capped).
 */

const PAGE_TYPES = [/^text\/html/i, /^application\/xhtml/i];
const PAGE_BYTES = 1.5 * 1024 * 1024;

const couldNot = (finding) => ({ format: null, finding, signals: null });

export function createCitedPageReader({ fetcher }) {
  const gate = createRobotsGate({ fetcher });

  /** @returns {Promise<{ format: string|null, finding: string|null, signals: object|null }>} */
  async function read(url) {
    try {
      const robots = await gate.allow(url);
      if (!robots.allowed) return couldNot(robots.finding);
      const res = await fetcher.fetch(url, {
        accept: ['text/html', 'application/xhtml+xml'],
        bodyTypes: PAGE_TYPES,
        maxBytes: PAGE_BYTES,
      });
      if (res.status === 429 || res.status >= 500) return couldNot('unavailable');
      if (res.status < 200 || res.status >= 300) return couldNot('not_found');
      const isPage =
        !res.bodySkipped && res.body && PAGE_TYPES.some((t) => t.test(res.contentType));
      if (!isPage) return couldNot('unreadable');
      const html = decodeBody(res.body, res.contentType).text;
      const facts = extractPage(html, res.url ?? url, { headers: res.headers });
      const verdict = readPageFormat(facts, res.url ?? url);
      if (!verdict.format) return couldNot(verdict.finding ?? 'unreadable');
      return {
        format: verdict.format,
        finding: null,
        signals: citableSignals(facts, res.url ?? url),
      };
    } catch (err) {
      if (err instanceof FetchError) return couldNot('fetch_failed');
      throw err;
    }
  }

  return { read };
}
