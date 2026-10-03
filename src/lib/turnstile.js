const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;
// Cloudflare's documented limit for a token is 2048 characters; anything longer is not one of theirs.
const MAX_TOKEN_LENGTH = 2048;

/**
 * Checks a Cloudflare Turnstile token on the server (checked against Cloudflare's docs on 2026-10-03: POST
 * `siteverify` with `secret`, `response` and optionally `remoteip`; the answer is `{ success, hostname, action,
 * 'error-codes' }`; a token works once and expires after 300 seconds). The widget on the page proves nothing by
 * itself: a bot can post the form without ever loading it. Only this call does.
 *
 * It fails closed. A token we cannot verify is never let through: `reason` says why, so the route can tell a bot
 * (`rejected`) from our own trouble (`unavailable`, `not_configured`) and show the visitor the right message.
 *
 *   rejected        Cloudflare said no (a bad, reused or expired token), or the token is missing or malformed
 *   wrong_site      a real token, but for another site, so a bot farm solved it elsewhere and replayed it here
 *   unavailable     Cloudflare could not be reached or answered something unreadable
 *   not_configured  no secret key is set (a deploy mistake, never a pass)
 *
 * `expectedHostname` (when set) must match the hostname Cloudflare says the challenge ran on.
 */
export function createTurnstile({
  secretKey,
  expectedHostname = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  return {
    async verify({ token, remoteIp = null }) {
      if (!secretKey) return { ok: false, reason: 'not_configured' };
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, reason: 'rejected' };
      }

      const body = new URLSearchParams({ secret: secretKey, response: token });
      if (remoteIp) body.set('remoteip', remoteIp);

      let result;
      try {
        const response = await fetchImpl(SITEVERIFY_URL, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return { ok: false, reason: 'unavailable' };
        result = await response.json();
      } catch {
        return { ok: false, reason: 'unavailable' };
      }

      if (result === null || typeof result !== 'object' || typeof result.success !== 'boolean') {
        return { ok: false, reason: 'unavailable' };
      }
      if (result.success !== true) {
        // `internal-error` is Cloudflare's own trouble, not the visitor's token.
        const codes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
        return { ok: false, reason: codes.includes('internal-error') ? 'unavailable' : 'rejected' };
      }
      if (expectedHostname && result.hostname !== expectedHostname) {
        return { ok: false, reason: 'wrong_site' };
      }
      return { ok: true };
    },
  };
}
