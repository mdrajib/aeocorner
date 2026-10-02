import { setTimeout as sleepFor } from 'node:timers/promises';

/**
 * Politeness toward the sites we crawl (MVP §11.2): at most `maxConcurrent` requests in flight to one host, and
 * each request starts at least `minGapMs` after the previous one. We are guests on someone else's server.
 *
 * It lives inside one process. Two workers crawling the same host at the same moment could together exceed the
 * limit; in practice the same domain is served from cache for 24 hours, so that overlap is rare and mild.
 * Requests for one host start in the order they asked.
 */
/**
 * Pacing for the requests ONE page makes while it renders (its scripts and data calls). A visitor's browser sends
 * these in parallel, so holding them to the crawl's one-every-half-second would make a render crawl for a minute.
 * Crawling the site's many pages still uses the stricter default.
 */
export const RENDER_PACING = Object.freeze({ maxConcurrent: 6, minGapMs: 40 });

export function createHostPacer({
  maxConcurrent = 2,
  minGapMs = 500,
  now = () => Date.now(),
  sleep = (ms) => sleepFor(ms),
} = {}) {
  const hosts = new Map();

  function stateFor(host) {
    let state = hosts.get(host);
    if (!state) {
      state = {
        active: 0,
        lastStart: Number.NEGATIVE_INFINITY,
        chain: Promise.resolve(),
        freed: [],
      };
      hosts.set(host, state);
      if (hosts.size > 500) forgetIdleHosts();
    }
    return state;
  }

  /** A long-running worker meets many hosts; drop the ones that have been quiet for a minute. */
  function forgetIdleHosts() {
    for (const [host, s] of hosts) {
      if (s.active === 0 && s.freed.length === 0 && now() - s.lastStart > 60_000)
        hosts.delete(host);
    }
  }

  function admit(state) {
    const turn = state.chain.then(async () => {
      while (state.active >= maxConcurrent)
        await new Promise((resolve) => state.freed.push(resolve));
      const wait = state.lastStart + minGapMs - now();
      if (wait > 0) await sleep(wait);
      state.lastStart = now();
      state.active += 1;
    });
    state.chain = turn.catch(() => {});
    return turn;
  }

  return {
    /** Run `fn` once this host has a free slot and the gap since its last request has passed. */
    async run(host, fn) {
      const state = stateFor(String(host).toLowerCase());
      await admit(state);
      try {
        return await fn();
      } finally {
        state.active -= 1;
        state.freed.shift()?.();
      }
    },
    /** For tests: how many hosts are being tracked. */
    size: () => hosts.size,
  };
}
