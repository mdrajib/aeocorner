import { decodeBody } from './decode.js';
import { detectBotBlock } from './bot-block.js';
import { evaluateRobots, parseRobots, ROBOTS_MAX_BYTES } from './robots.js';
import { FetchError } from './safe-fetch.js';

/**
 * The robots.txt gate for pages that are not the customer's own (a profile they listed, a site an engine cited): obeyed
 * as `AEOCornerBot`, whoever is asking. A customer's verified domain is the only exception to robots.txt and it does not
 * carry over to another site. Anything that stops us from reading the rules is a "couldn't check", never a pass.
 */

export const AGENT = 'AEOCornerBot';

export function createRobotsGate({ fetcher }) {
  /** May we read this page? `{ allowed }`, or `{ allowed: false, finding }` when the answer is a "couldn't check". */
  async function allow(url) {
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

  return { allow };
}
