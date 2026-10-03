import { randomInt } from 'node:crypto';
import { hmac, safeEqual } from './tokens.js';
import { redisKeys } from './redis.js';

/**
 * The six-digit code that proves a visitor owns the email address they gave for a free audit (MVP F1; the codes live
 * in Redis, DATABASE_SCHEMA §2.8, because they are short-lived and high-churn).
 *
 * What is stored is a keyed hash of the code, never the code, so a copy of Redis is not a pile of working codes.
 * One audit has one live code. The limits, each of which a bot would otherwise get around:
 *
 *   expires         after `ttlSeconds` (10 minutes)
 *   attempts        `maxAttempts` (5) wrong guesses kill the code; a million possible codes against five tries
 *   resend          one new code per `cooldownSeconds` (60 s) and `maxSends` (3) an hour per audit, so "ask again"
 *                   is not a way to get more guesses or to make us send mail to a stranger without end
 *   once            a right code is spent the moment it is used
 *
 * Counting a guess and reading the stored hash is one Lua script, so two requests racing cannot each get a "first"
 * attempt. The comparison is done here, in constant time.
 */

const ISSUE = `
if redis.call('EXISTS', KEYS[3]) == 1 then
  return { 'cooldown', redis.call('PTTL', KEYS[3]) }
end
local sends = tonumber(redis.call('GET', KEYS[2]) or '0')
if sends >= tonumber(ARGV[3]) then
  return { 'limit', redis.call('PTTL', KEYS[2]) }
end
if redis.call('INCR', KEYS[2]) == 1 then
  redis.call('PEXPIRE', KEYS[2], ARGV[5])
end
redis.call('HSET', KEYS[1], 'h', ARGV[1], 'a', 0)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[3], '1', 'PX', ARGV[4])
return { 'ok', 0 }
`;

const GUESS = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return { 'none', '', 0 }
end
local attempts = redis.call('HINCRBY', KEYS[1], 'a', 1)
if attempts > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return { 'locked', '', attempts }
end
return { 'check', redis.call('HGET', KEYS[1], 'h'), attempts }
`;

export function createOtpStore(
  redis,
  {
    prefix,
    secret,
    ttlSeconds = 600,
    maxAttempts = 5,
    maxSends = 3,
    sendsWindowSeconds = 3600,
    cooldownSeconds = 60,
    random = () => randomInt(0, 1_000_000),
  },
) {
  const keys = redisKeys(prefix);
  if (!redis.aeoOtpIssue) redis.defineCommand('aeoOtpIssue', { numberOfKeys: 3, lua: ISSUE });
  if (!redis.aeoOtpGuess) redis.defineCommand('aeoOtpGuess', { numberOfKeys: 1, lua: GUESS });

  const digest = (auditId, code) => hmac(secret, 'otp', auditId, code);

  return {
    /**
     * Make a new code for an audit, replacing any earlier one. Returns `{ ok: true, code }` to be emailed, or
     * `{ ok: false, reason: 'cooldown' | 'limit', retryAfterMs }` when asked too soon or too often.
     */
    async issue(auditId) {
      const code = String(random()).padStart(6, '0');
      const [verdict, wait] = await redis.aeoOtpIssue(
        keys.otp(auditId),
        keys.otpSends(auditId),
        keys.otpCooldown(auditId),
        digest(auditId, code),
        ttlSeconds * 1000,
        maxSends,
        cooldownSeconds * 1000,
        sendsWindowSeconds * 1000,
      );
      if (verdict === 'ok') return { ok: true, code };
      return { ok: false, reason: verdict, retryAfterMs: Math.max(0, Number(wait)) };
    },

    /**
     * Check what the visitor typed. `reason` is 'malformed' (not six digits: nothing is counted), 'expired' (no live
     * code: it timed out, was used or was never made), 'wrong' (with `attemptsLeft`) or 'locked' (too many wrong
     * guesses: the code is dead and a new one must be asked for).
     */
    async verify(auditId, typed) {
      // Only a string: a repeated form field arrives as an array, and String(['123456']) would pass for the code.
      const code = typeof typed === 'string' ? typed.replace(/\s+/g, '') : '';
      if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'malformed' };

      const [state, stored, attempts] = await redis.aeoOtpGuess(keys.otp(auditId), maxAttempts);
      if (state === 'none') return { ok: false, reason: 'expired' };
      if (state === 'locked') return { ok: false, reason: 'locked' };

      if (safeEqual(stored, digest(auditId, code))) {
        // DEL says how many keys it removed: only one of two simultaneous right answers gets to spend the code.
        return (await redis.del(keys.otp(auditId))) === 1
          ? { ok: true }
          : { ok: false, reason: 'expired' };
      }
      if (Number(attempts) >= maxAttempts) {
        await redis.del(keys.otp(auditId));
        return { ok: false, reason: 'locked' };
      }
      return { ok: false, reason: 'wrong', attemptsLeft: maxAttempts - Number(attempts) };
    },
  };
}
