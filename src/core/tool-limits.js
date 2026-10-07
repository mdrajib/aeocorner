/**
 * Who may run a free tool, and how often (ADR-0017, Milestone 17). Pure: the numbers, the windows a request is counted
 * in, and a small in-memory model of the rule. The model is the reference that `src/lib/tool-limits.js` (the same rule
 * as one atomic Lua script in Redis) is replayed against; change them together.
 *
 * Two kinds of tool:
 *  - `fetch`    asks another site for a file. Counted per IP a minute, per IP a day and per target domain an hour.
 *               A refused request is a "strike" against the IP; enough strikes in a day block the IP for a day.
 *  - `generate` only runs our own code on what the visitor typed. Counted per IP a minute, nothing more.
 *
 * Counting is fixed windows (the UTC minute, hour and day), so a counter's name says when it ends. A refusal never
 * spends another allowance: all the counters go up together, or none does.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const TOOL_LIMITS = Object.freeze({
  fetch: Object.freeze({ perIpPerMinute: 6, perIpPerDay: 40, perDomainPerHour: 20 }),
  generate: Object.freeze({ perIpPerMinute: 20 }),
  /** Refused fetch requests from one IP in a day before it is blocked for `autoBlockHours`. */
  strikesToBlock: 5,
  autoBlockHours: 24,
});

export const TOOL_KINDS = Object.freeze(['fetch', 'generate']);

const WINDOW_MS = { minute: MINUTE_MS, hour: HOUR_MS, day: DAY_MS };

/** The start of the window `nowMs` falls in, as a number (UTC windows start at multiples of their length). */
export const windowSlot = (window, nowMs) => Math.floor(nowMs / WINDOW_MS[window]);

/** Milliseconds until the window `nowMs` falls in ends. */
export const untilWindowEnds = (window, nowMs) =>
  (windowSlot(window, nowMs) + 1) * WINDOW_MS[window] - nowMs;

/**
 * The counters one request goes through, in the order they are checked. `ip` and `domain` are already hashed (or
 * plain, in the model); a counter that does not apply is not listed. `ttlMs` outlives the window a little so a clock
 * that is slightly off never leaves a counter that expires early.
 */
export function counterSpecs(kind, { ip, domain }, nowMs, limits = TOOL_LIMITS) {
  if (!TOOL_KINDS.includes(kind)) throw new Error(`Unknown tool kind "${kind}"`);
  const spec = (name, id, window, limit) => ({
    name,
    id,
    window,
    slot: windowSlot(window, nowMs),
    limit,
    ttlMs: WINDOW_MS[window] + MINUTE_MS,
  });
  if (kind === 'generate') return [spec('ip_minute', ip, 'minute', limits.generate.perIpPerMinute)];
  return [
    spec('ip_minute', ip, 'minute', limits.fetch.perIpPerMinute),
    spec('ip_day', ip, 'day', limits.fetch.perIpPerDay),
    spec('domain_hour', domain, 'hour', limits.fetch.perDomainPerHour),
  ];
}

/** The window a refusal by this counter clears at, for "try again in ...". */
export const counterWindow = (name) =>
  ({ ip_minute: 'minute', ip_day: 'day', domain_hour: 'hour' })[name];

/**
 * The in-memory rule. `admit` returns `{ allowed: true }` or `{ allowed: false, reason, retryAfterMs? }` where
 * `reason` is `blocked`, `ip_minute`, `ip_day` or `domain_hour`.
 */
export function createToolLimiterModel({ limits = TOOL_LIMITS } = {}) {
  const counts = new Map();
  const strikes = new Map();
  const blocked = new Set();
  const key = (s) => `${s.name}:${s.id}:${s.slot}`;

  return {
    blocked,
    admit({ kind, ip, domain, nowMs }) {
      if (blocked.has(ip)) return { allowed: false, reason: 'blocked' };
      const specs = counterSpecs(kind, { ip, domain }, nowMs, limits);
      const full = specs.find((s) => (counts.get(key(s)) ?? 0) >= s.limit);
      if (full) {
        if (kind === 'fetch') {
          const strikeKey = `${ip}:${windowSlot('day', nowMs)}`;
          const n = (strikes.get(strikeKey) ?? 0) + 1;
          strikes.set(strikeKey, n);
          if (n >= limits.strikesToBlock) blocked.add(ip);
        }
        return {
          allowed: false,
          reason: full.name,
          retryAfterMs: untilWindowEnds(full.window, nowMs),
        };
      }
      for (const s of specs) counts.set(key(s), (counts.get(key(s)) ?? 0) + 1);
      return { allowed: true };
    },
  };
}
