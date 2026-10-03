import { createHash } from 'node:crypto';
import {
  AUDIT_LIMITS,
  emailDomain,
  ipPrefix,
  isDisposableEmail,
  mailboxKey,
} from '../core/audit-abuse.js';
import { redisKeys } from './redis.js';

/**
 * Who may start a free audit, and how often (MVP F1: three per email and ten per IP per day, plus a limit per target
 * domain). The order is cheapest first and never spends a visitor's allowance on a refusal:
 *
 *   1. a throwaway email address                    -> refused, nothing counted
 *   2. a block in `abuse_blocks` (IP, network, email, email domain, target domain)  -> refused, nothing counted
 *   3. the three daily counters, checked together   -> all three go up, or none does
 *
 * The counters are Redis keys per UTC day, named by a hash of the value so no address or email sits in Redis in the
 * clear. A refusal is a "strike" against the IP; enough strikes in a day and the IP is blocked for a day
 * (`abuse_blocks`, no staff member on the row), which is how a bot that ignores the limits stops costing us even a
 * Turnstile check. Redis being down is the caller's error to handle (the audit form fails, it does not open up).
 */

const ATTEMPT = `
local keys = { KEYS[1], KEYS[2], KEYS[3] }
local limits = { tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]) }
local names = { 'email', 'ip', 'domain' }
for i = 1, 3 do
  local used = tonumber(redis.call('GET', keys[i]) or '0')
  if used >= limits[i] then
    local strikes = redis.call('INCR', KEYS[4])
    if strikes == 1 then redis.call('PEXPIRE', KEYS[4], ARGV[4]) end
    return { names[i], strikes }
  end
end
for i = 1, 3 do
  if redis.call('INCR', keys[i]) == 1 then redis.call('PEXPIRE', keys[i], ARGV[4]) end
end
return { 'ok', 0 }
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);

export function createAuditLimiter({
  redis,
  prefix,
  db,
  limits = AUDIT_LIMITS,
  now = () => new Date(),
}) {
  const keys = redisKeys(prefix);
  if (!redis.aeoAuditAttempt)
    redis.defineCommand('aeoAuditAttempt', { numberOfKeys: 4, lua: ATTEMPT });

  return {
    /**
     * May this visitor start an audit of `domain`? `ip` is the connection's address (after Express's trust-proxy
     * handling). Returns `{ allowed: true }` or `{ allowed: false, reason, retryAfterMs? }` where `reason` is
     * `disposable_email`, `blocked`, `email`, `ip` or `domain`. Counting the attempt is part of asking.
     */
    async admit({ ip, email, domain }) {
      const at = now();
      if (isDisposableEmail(email)) return { allowed: false, reason: 'disposable_email' };

      const block = await db.abuse.active({
        ip,
        ipPrefix: ipPrefix(ip),
        email: String(email).trim().toLowerCase(),
        emailDomain: emailDomain(email),
        targetDomain: domain,
        now: at,
      });
      if (block) return { allowed: false, reason: 'blocked' };

      const day = at.toISOString().slice(0, 10);
      const untilMidnight =
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1) - at.getTime();
      const [verdict, strikes] = await redis.aeoAuditAttempt(
        keys.auditLimit('email', digest(mailboxKey(email)), day),
        keys.auditLimit('ip', digest(ip ?? 'unknown'), day),
        keys.auditLimit('domain', digest(String(domain).toLowerCase()), day),
        keys.auditLimit('strikes', digest(ip ?? 'unknown'), day),
        limits.perEmailPerDay,
        limits.perIpPerDay,
        limits.perDomainPerDay,
        untilMidnight + 3_600_000,
      );
      if (verdict === 'ok') return { allowed: true };

      if (ip && Number(strikes) >= limits.strikesToBlock) {
        await db.abuse.block({
          kind: 'ip',
          value: ip,
          reason: `Automatic: ${strikes} refused audit requests in a day`,
          expiresAt: new Date(at.getTime() + limits.autoBlockHours * 3_600_000),
        });
      }
      return { allowed: false, reason: verdict, retryAfterMs: Math.min(untilMidnight, DAY_MS) };
    },
  };
}
