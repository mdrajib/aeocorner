import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random secret for an emailed link: 256 bits, URL-safe. Only its hash is stored. */
export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of a token, as the 32 bytes a `BINARY(32)` column holds. */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest();
}

/** Compare two strings without leaking, through timing, where they first differ. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Keyed hash (HMAC-SHA256), base64url. Used for CSRF tokens bound to a session. */
export function hmac(secret, ...parts) {
  return createHmac('sha256', secret).update(parts.join('\n')).digest('base64url');
}
