import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The `state` that travels to Google and back in the sign-in (OAuth's guard against someone else's sign-in being finished
 * in your browser). It says which organization and project the connection is for and who started it, and is signed with the
 * app secret together with a value tied to the signed-in session: a state made in one browser does not verify in another,
 * and it expires after ten minutes.
 */

const TTL_MS = 10 * 60_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const mac = (secret, text, binding) =>
  createHmac('sha256', secret).update(`google-state.${binding}.${text}`).digest('base64url');

export function signGoogleState(
  { orgPublicId, projectPublicId, userId },
  { secret, binding, now = Date.now() },
) {
  const text = `${orgPublicId}.${projectPublicId}.${userId}.${now + TTL_MS}`;
  return `${text}.${mac(secret, text, binding)}`;
}

/** @returns {{ orgPublicId, projectPublicId, userId }|null} null for anything not made here, for this session, in time */
export function readGoogleState(state, { secret, binding, now = Date.now() }) {
  if (typeof state !== 'string' || state.length > 300) return null;
  const parts = state.split('.');
  if (parts.length !== 5) return null;
  const [orgPublicId, projectPublicId, userId, expires, given] = parts;
  if (!ULID.test(orgPublicId) || !ULID.test(projectPublicId) || !/^[1-9]\d{0,19}$/.test(userId))
    return null;
  if (!/^\d{10,15}$/.test(expires) || Number(expires) < now) return null;
  const text = `${orgPublicId}.${projectPublicId}.${userId}.${expires}`;
  const expected = Buffer.from(mac(secret, text, binding));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { orgPublicId, projectPublicId, userId };
}
