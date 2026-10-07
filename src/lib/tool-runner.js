import { createGet } from '../crawler/gather.js';
import { createRobotsGate } from '../crawler/robots-gate.js';
import { FetchError } from '../crawler/safe-fetch.js';

/**
 * Runs one free tool inside a web request (ADR-0017). A run has:
 *  - a total deadline: no request starts after it, no request may outlast it, and a tool that is still going when it
 *    passes is given up on (the visitor gets "couldn't check", the process is not held);
 *  - a cap on fetches, and on the connections they make (a redirect is a connection too);
 *  - a cap on runs in flight in this process: the next visitor is told "busy" at once, never queued.
 *
 * A tool is `async (ctx, input) => result` and returns plain findings. Anything it throws becomes a "couldn't check"
 * with a reason in plain words: an error's text is never shown (it can name a host, an address or a path), and a
 * fetch refused by the guard is told apart from a site that did not answer only by its words, never by its detail.
 *
 * `ctx`: `get(url, options)` (a fetch that reports failure as data, like the scan's), `robots` (the gate for pages
 * that are not robots.txt, sitemaps or llms.txt: `await ctx.robots.allow(url)`), `deadlineAt`, `requests()` and
 * `fetchesLeft()`.
 */

export const TOOL_RUN_LIMITS = Object.freeze({
  deadlineMs: 10_000,
  maxFetches: 5,
  /** Every connection counts, so a redirect chain cannot make five fetches into thirty. */
  maxConnections: 15,
  inFlight: 4,
});

/** What a tool throws when it knows why it could not look. `reason` is shown to the visitor, so it is plain words. */
export class CouldntCheck extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CouldntCheck';
    this.reason = reason;
  }
}

const REASONS = {
  timeout: 'The site took too long to answer.',
  dns_failed: 'We could not find that address.',
  connect_failed: 'We could not connect to that site.',
  tls_failed: 'We could not make a secure connection to that site.',
  network_error: 'We could not reach that site.',
  too_large: 'The file was larger than we read.',
  too_many_redirects: 'The address sent us round in circles.',
  unsupported_encoding: 'We could not read the way that file was packed.',
  bad_url: 'That does not look like a web address.',
  tool_deadline: 'The check took too long, so we stopped it.',
  tool_fetch_cap: 'The check needed more requests than we allow.',
};
const GUARD = 'We only check public websites. That address is not one we will open.';
const OTHER = 'Something went wrong on our side. Try again in a minute.';

/** Words for a visitor, from anything a tool threw. */
export function plainReason(err) {
  if (err instanceof CouldntCheck) return err.reason;
  if (err instanceof FetchError) {
    if (err.code.startsWith('blocked_')) return GUARD;
    return REASONS[err.code] ?? 'We could not read the site.';
  }
  return OTHER;
}

export function createToolRunner({
  fetcher,
  limits = {},
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const policy = { ...TOOL_RUN_LIMITS, ...limits };
  let running = 0;

  /**
   * @returns {Promise<{ status: 'ok', result: any, fetches: number }
   *   | { status: 'couldnt_check', reason: string, fetches: number }
   *   | { status: 'busy' }>}
   */
  async function run(tool, input) {
    if (running >= policy.inFlight) return { status: 'busy' };
    running += 1;
    const deadlineAt = now() + policy.deadlineMs;
    let fetches = 0;
    let connections = 0;

    // The only fetcher a tool can reach: counted, clamped to the time left, and shut after the deadline.
    const counted = {
      async fetch(url, options = {}) {
        const left = deadlineAt - now();
        if (left <= 0) throw new FetchError('tool_deadline', 'The run is out of time');
        if (fetches >= policy.maxFetches || connections >= policy.maxConnections)
          throw new FetchError('tool_fetch_cap', 'The run used its fetches');
        fetches += 1;
        const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? left, left));
        try {
          const res = await fetcher.fetch(url, { ...options, timeoutMs });
          connections += res.connections?.length ?? 1;
          return res;
        } catch (err) {
          connections += err?.redirects?.length ? err.redirects.length + 1 : 1;
          throw err;
        }
      },
    };
    const ctx = {
      get: createGet({ fetcher: counted, log }),
      robots: createRobotsGate({ fetcher: counted }),
      deadlineAt,
      requests: () => fetches,
      /** How many more fetches this run may make: a tool with several to do plans with it. */
      fetchesLeft: () => Math.max(0, policy.maxFetches - fetches),
    };

    let timer;
    const outOfTime = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new FetchError('tool_deadline', 'The run is out of time')),
        policy.deadlineMs,
      );
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => tool(ctx, input)),
        outOfTime,
      ]);
      return { status: 'ok', result, fetches };
    } catch (err) {
      // The error's own text can name a host or a path, so it goes to the log and nowhere else.
      if (!(err instanceof CouldntCheck))
        log('tool_failed', { code: err?.code, message: err?.message });
      return { status: 'couldnt_check', reason: plainReason(err), fetches };
    } finally {
      clearTimeout(timer);
      running -= 1;
    }
  }

  return { run, inFlight: () => running, limits: policy };
}
