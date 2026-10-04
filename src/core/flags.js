/**
 * Feature flags (Milestone 8, task 8.21; ADMIN_OPERATIONS module 10). A flag has a default for everyone, and a staff member
 * can turn it on or off for one organization (a beta for a design partner, a feature switched off for one that misuses it).
 * Pure: the rule for which setting wins, and the flags the code itself reads.
 */

export const FLAG_KEY = /^[a-z][a-z0-9_.]{1,63}$/;

/**
 * The flags the application reads. Each is a switch someone may need to throw in a hurry without a deploy, so each is
 * ON unless a person turns it off. A flag the code does not read has no effect, which the console says plainly.
 */
export const KNOWN_FLAGS = Object.freeze({
  'digest.weekly': 'Send the weekly digest email.',
  'alerts.emails': 'Send alert emails (drops, rising competitors, negative claims).',
  'google.sync': 'Read Google Analytics and Search Console every day.',
});

/** Which setting wins: the organization's own override, else the flag's default. A flag that does not exist is off. */
export function resolveFlag({ exists = true, defaultEnabled, override = null }) {
  if (!exists) return false;
  return override === null || override === undefined ? Boolean(defaultEnabled) : Boolean(override);
}
