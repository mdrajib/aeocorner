import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a webhook signed the Svix way, which is what Resend uses (checked against Svix's documentation on 2026-10-04:
 * headers `svix-id`, `svix-timestamp` and `svix-signature` (`v1,<base64>`, several separated by spaces while a secret is
 * rolled); the signed content is `<id>.<timestamp>.<raw body>`; HMAC-SHA256 with the secret's base64 part after `whsec_`;
 * a five-minute tolerance). Clerk's own webhooks go through Clerk's library instead; this is for the senders that have no
 * library of ours.
 *
 * @returns the parsed body
 * @throws Error('bad_signature' | 'stale')
 */
export function verifySvix(
  rawBody,
  headers,
  secret,
  { now = Date.now(), toleranceSeconds = 300 } = {},
) {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !/^\d{1,12}$/.test(String(timestamp)) || typeof signature !== 'string' || !secret) {
    throw new Error('bad_signature');
  }
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), Buffer.from(rawBody)]))
    .digest();
  const ok = signature.split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new Error('bad_signature');
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) throw new Error('stale');
  return JSON.parse(Buffer.from(rawBody).toString('utf8'));
}
