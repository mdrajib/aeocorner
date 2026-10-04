import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Who gets which email, when (Milestone 8, tasks 8.15 and 8.16). Pure: no database, no mailer.
 *
 * Three kinds of message, from the `notifications.category` column:
 *   transactional  the customer's own action or account (a trial ending, a retention notice): never capped, no unsubscribe
 *   proactive      what we noticed (the weekly digest, an alert): at most ONE a day per person, and the person can switch it off
 *   marketing      not used yet
 */

export const KINDS = Object.freeze({
  digest: { category: 'proactive', pref: 'digest' },
  alert: { category: 'proactive', pref: 'alerts' },
  'trial-ending': { category: 'transactional', pref: null },
  'retention-warning': { category: 'transactional', pref: null },
  'google-reconnect': { category: 'transactional', pref: null },
});

/** The preferences a member has until they choose otherwise. */
export const DEFAULT_PREFS = Object.freeze({ digest: true, alerts: true });

/** `notify_prefs` is JSON written by us, but treat anything unexpected as "defaults". */
export function readPrefs(raw) {
  const prefs = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    digest: typeof prefs.digest === 'boolean' ? prefs.digest : DEFAULT_PREFS.digest,
    alerts: typeof prefs.alerts === 'boolean' ? prefs.alerts : DEFAULT_PREFS.alerts,
  };
}

/** May this member be sent this kind of message? Transactional messages ignore preferences. */
export function prefAllows(rawPrefs, kind) {
  const def = KINDS[kind];
  if (!def) return false;
  if (def.pref === null) return true;
  return readPrefs(rawPrefs)[def.pref];
}

// --- When the digest is sent -------------------------------------------------------------------------------------

/** Monday 08:00 in the person's own timezone (UTC when theirs is unknown or invalid). */
export const DIGEST_WEEKDAY = 'Mon';
export const DIGEST_HOUR = 8;

/** The local weekday, hour and calendar date of `date` in `timezone`. An unknown timezone is read as UTC. */
export function localParts(date, timezone = 'UTC') {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return localParts(date, 'UTC');
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Is it Monday morning (the digest hour) where this person is? */
export function isDigestHour(date, timezone) {
  const p = localParts(date, timezone);
  return p.weekday === DIGEST_WEEKDAY && p.hour === DIGEST_HOUR;
}

/**
 * The ISO week a digest belongs to, from the person's local calendar date: `2026-W41`. The same week in the same
 * timezone is the same digest, so a tick that fires twice sends once (it is part of the notification's dedupe key).
 */
export function digestWeekKey(date, timezone) {
  const [y, m, d] = localParts(date, timezone).date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// --- One-click unsubscribe ---------------------------------------------------------------------------------------

/**
 * A link that switches one kind of email off for one person, with nothing to sign in to. The token says who and what, and
 * a keyed hash of both proves we made it (RFC 8058 one-click needs a link that works without a session). It carries no
 * expiry: an unsubscribe link in an old email must keep working.
 */
export function unsubscribeToken({ userId, pref }, secret) {
  if (!['digest', 'alerts', 'all'].includes(pref)) throw new TypeError('Unknown preference');
  const body = `${userId}.${pref}`;
  const mac = createHmac('sha256', secret).update(`unsub.${body}`).digest('base64url');
  return `${body}.${mac}`;
}

/** @returns {{ userId: string, pref: string }|null} null for anything we did not make */
export function readUnsubscribeToken(token, secret) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, pref, mac] = parts;
  if (!/^[1-9]\d{0,19}$/.test(userId) || !['digest', 'alerts', 'all'].includes(pref)) return null;
  const expected = createHmac('sha256', secret).update(`unsub.${userId}.${pref}`).digest();
  let given;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { userId, pref };
}

/** The new `notify_prefs` after unsubscribing from `pref` ("all" switches off both). */
export function applyUnsubscribe(rawPrefs, pref) {
  const next = { ...readPrefs(rawPrefs) };
  if (pref === 'all' || pref === 'digest') next.digest = false;
  if (pref === 'all' || pref === 'alerts') next.alerts = false;
  return next;
}

export const PREF_LABELS = Object.freeze({
  digest: 'the weekly digest',
  alerts: 'alert emails',
  all: 'all email from AEO Corner except messages about your account',
});
