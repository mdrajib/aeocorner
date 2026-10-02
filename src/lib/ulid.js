import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so IDs survive being read aloud or retyped.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A ULID: 10 characters of millisecond time (so IDs sort by creation) + 16 of randomness.
 * Used for `public_id CHAR(26)` columns, the only IDs that appear in URLs (DATABASE_SCHEMA §1).
 */
export function ulid(now = Date.now()) {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }

  let bits = 0n;
  for (const byte of randomBytes(10)) bits = (bits << 8n) | BigInt(byte);
  let random = '';
  for (let i = 0; i < 16; i++) {
    random = ALPHABET[Number(bits & 31n)] + random;
    bits >>= 5n;
  }
  return time + random;
}

export const isUlid = (value) => typeof value === 'string' && ULID_PATTERN.test(value);
