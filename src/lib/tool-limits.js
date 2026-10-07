import { createHash } from 'node:crypto';
import {
  counterSpecs,
  counterWindow,
  TOOL_LIMITS,
  untilWindowEnds,
  windowSlot,
} from '../core/tool-limits.js';
import { ipPrefix } from '../core/audit-abuse.js';
import { redisKeys } from './redis.js';

/**
 * Who may run a free tool (ADR-0017). The rule is `src/core/tool-limits.js` (counters, windows, strikes); this is the
 * same rule as one atomic Lua script, so two requests at the same moment cannot both take the last place.
 *
 * Order, cheapest first, and a refusal never spends another allowance:
 *   1. a block in `abuse_blocks` for the IP or its network   -> refused, nothing counted
 *   2. the counters for the tool's kind, checked together    -> all go up, or none does
 *
 * Counters are Redis keys per fixed window, named by a hash of the value so no address or domain sits in Redis in the
 * clear. A refused `fetch` request is a strike against the IP; enough strikes in a day block it for a day
 * (`abuse_blocks`, no staff member on the row). Redis being down is the caller's error to handle: the tool is closed,
 * it never opens up.
 *
 * KEYS = the counters, then the strike key. ARGV = the number of counters, each counter's limit, each counter's TTL (ms)
 * and, when the kind has strikes, the strike key's TTL (the caller compares the strike count with its limit). Returns { index of the full counter (0 = none), strikes }.
 */
const ATTEMPT = `
local n = tonumber(ARGV[1])
local full = 0
for i = 1, n do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  if used >= tonumber(ARGV[1 + i]) then full = i break end
end
if full > 0 then
  local strikes = 0
  if KEYS[n + 1] then
    strikes = redis.call('INCR', KEYS[n + 1])
    if strikes == 1 then redis.call('PEXPIRE', KEYS[n + 1], ARGV[2 + 2 * n]) end
  end
  return { full, strikes }
end
for i = 1, n do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('PEXPIRE', KEYS[i], ARGV[1 + n + i]) end
end
return { 0, 0 }
`;

const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);

export function createToolLimiter({
  redis,
  prefix,
  db,
  limits = TOOL_LIMITS,
  now = () => new Date(),
}) {
  const keys = redisKeys(prefix);
  if (!redis.aeoToolAttempt) redis.defineCommand('aeoToolAttempt', { lua: ATTEMPT });

  return {
    /**
     * May this visitor run a tool of this `kind` (`fetch` or `generate`)? `ip` is the connection's address (after
     * Express's trust-proxy handling) and `domain` the site a `fetch` tool will ask. Returns `{ allowed: true }` or
     * `{ allowed: false, reason, retryAfterMs? }` where `reason` is `blocked`, `ip_minute`, `ip_day` or
     * `domain_hour`. Counting the attempt is part of asking.
     */
    async admit({ kind, ip, domain }) {
      const at = now();
      const nowMs = at.getTime();
      const who = ip ?? 'unknown';

      if (ip) {
        const block = await db.abuse.active({
          ip,
          ipPrefix: ipPrefix(ip),
          email: null,
          emailDomain: null,
          targetDomain: kind === 'fetch' && domain ? String(domain).toLowerCase() : null,
          now: at,
        });
        if (block) return { allowed: false, reason: 'blocked' };
      }

      const specs = counterSpecs(
        kind,
        { ip: digest(who), domain: digest(String(domain ?? '').toLowerCase()) },
        nowMs,
        limits,
      );
      const withStrikes = kind === 'fetch';
      const strikeKey = keys.toolLimit('strikes', digest(who), windowSlot('day', nowMs));
      const [index, strikes] = await redis.aeoToolAttempt(
        specs.length + (withStrikes ? 1 : 0),
        ...specs.map((s) => keys.toolLimit(s.name, s.id, s.slot)),
        ...(withStrikes ? [strikeKey] : []),
        specs.length,
        ...specs.map((s) => s.limit),
        ...specs.map((s) => s.ttlMs),
        ...(withStrikes ? [25 * 3_600_000] : []),
      );
      if (Number(index) === 0) return { allowed: true };

      const refused = specs[Number(index) - 1];
      if (withStrikes && ip && Number(strikes) >= limits.strikesToBlock) {
        await db.abuse.block({
          kind: 'ip',
          value: ip,
          reason: `Automatic: ${strikes} refused tool requests in a day`,
          expiresAt: new Date(nowMs + limits.autoBlockHours * 3_600_000),
        });
      }
      return {
        allowed: false,
        reason: refused.name,
        retryAfterMs: untilWindowEnds(counterWindow(refused.name), nowMs),
      };
    },
  };
}
