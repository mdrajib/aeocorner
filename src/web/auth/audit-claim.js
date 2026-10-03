import { isUlid } from '../../lib/ulid.js';

/**
 * The thread that carries a visitor from "Track this every week" on their report to a project made from that audit.
 *
 * The report's address is a secret, so it is not put in a URL that goes through sign-up and sign-in (an address
 * is copied, logged and sent in Referer headers). Pressing the button sets this cookie instead: HttpOnly, scoped to
 * `/app`, gone after two hours, and holding only the audit's public ID. Making a project reads it, and the project
 * is prefilled only if the audit is the visitor's to claim (see `projects.create`).
 */

export const AUDIT_CLAIM_COOKIE = 'aeo_audit';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const OPTIONS = { httpOnly: true, sameSite: 'lax', path: '/app' };

export function setAuditClaim(req, res, publicId) {
  res.cookie(AUDIT_CLAIM_COOKIE, publicId, { ...OPTIONS, secure: req.secure, maxAge: MAX_AGE_MS });
}

export function clearAuditClaim(res) {
  res.clearCookie(AUDIT_CLAIM_COOKIE, OPTIONS);
}

/** The audit ID a visitor is claiming, or null. Anything that is not a well-formed ID is ignored. */
export function readAuditClaim(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at === -1 || part.slice(0, at).trim() !== AUDIT_CLAIM_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return isUlid(value) ? value : null;
  }
  return null;
}
