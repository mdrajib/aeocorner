import { judgeProfile } from '../core/entity-checks.js';
import { decodeBody } from './decode.js';
import { detectBotBlock } from './bot-block.js';
import { extractPage } from './html.js';
import { evaluateRobots, parseRobots, ROBOTS_MAX_BYTES } from './robots.js';
import { FetchError } from './safe-fetch.js';

/**
 * Look at one profile page a customer listed (Milestone 12, task 12.02): a LinkedIn page, a directory listing, any
 * address that is not their own site. It is "a URL we did not choose", so it goes through the safe fetcher (ADR-0005)
 * like every other fetch, and **robots.txt is obeyed as `AEOCornerBot`**: a profile is somebody else's website, so the
 * customer's own permission to read their site (domain verification) does not carry over to it.
 *
 * Nothing here throws for a page we could not read: that is the answer "couldn't check" (`status: 'error'`), with the
 * reason as `finding` (src/core/entity-checks.js). The judging is pure code over what was fetched; the page is hostile
 * input and is read only by `extractPage`, which is linear and caps nesting.
 */

const AGENT = 'AEOCornerBot';
const PAGE_TYPES = [/^text\/html/i, /^application\/xhtml/i];
const PAGE_BYTES = 1.5 * 1024 * 1024;

const couldNot = (finding, extra = {}) => ({
  status: 'error',
  finding,
  httpStatus: null,
  reachable: null,
  namesBrand: null,
  linksBack: null,
  ...extra,
});

export function createProfileChecker({ fetcher }) {
  /** May we read this page? `{ allowed }`, or `{ allowed: false, finding }` when the answer is a "couldn't check". */
  async function robotsAllow(url) {
    const u = new URL(url);
    let res;
    try {
      res = await fetcher.fetch(`${u.origin}/robots.txt`, {
        maxBytes: ROBOTS_MAX_BYTES,
        bodyTypes: [/^text\//i, /^$/, /octet-stream/i],
        timeoutMs: 10_000,
      });
    } catch (err) {
      if (!(err instanceof FetchError)) throw err;
      return { allowed: false, finding: 'fetch_failed' };
    }
    if (detectBotBlock(res).blocked) return { allowed: false, finding: 'blocked' };
    if (res.status === 429 || res.status >= 500) return { allowed: false, finding: 'unavailable' };
    if (res.status < 200 || res.status >= 300) return { allowed: true }; // 404 and the like: no rules
    const text = decodeBody(res.body ?? Buffer.alloc(0), res.contentType).text;
    if (/html/i.test(res.contentType) || /^\s*</.test(text)) return { allowed: true };
    const verdict = evaluateRobots(parseRobots(text), AGENT, `${u.pathname}${u.search}`);
    return verdict.allowed ? { allowed: true } : { allowed: false, finding: 'robots' };
  }

  /**
   * @param {object} p
   * @param {string} p.url         the profile's address (a plain https:// one)
   * @param {string[]} p.brandNames
   * @param {string} p.domain      the project's own domain
   * @returns {Promise<{ status, finding, httpStatus, reachable, namesBrand, linksBack }>}
   */
  async function check({ url, brandNames, domain }) {
    try {
      const robots = await robotsAllow(url);
      if (!robots.allowed) return couldNot(robots.finding);

      const res = await fetcher.fetch(url, {
        accept: ['text/html', 'application/xhtml+xml'],
        bodyTypes: PAGE_TYPES,
        maxBytes: PAGE_BYTES,
      });
      const isPage =
        !res.bodySkipped && res.body && PAGE_TYPES.some((t) => t.test(res.contentType));
      // A non-page answer (an image, a download) with a good status is not something we can read.
      if (res.status >= 200 && res.status < 300 && !isPage) {
        return couldNot('unreadable', { httpStatus: res.status });
      }
      const html = isPage ? decodeBody(res.body, res.contentType).text : '';
      const facts = isPage ? extractPage(html, res.url, { headers: res.headers }) : null;
      return judgeProfile({
        status: res.status,
        headers: res.headers,
        body: html,
        facts,
        brandNames,
        domain,
      });
    } catch (err) {
      if (err instanceof FetchError) return couldNot('fetch_failed');
      throw err;
    }
  }

  return { check };
}
