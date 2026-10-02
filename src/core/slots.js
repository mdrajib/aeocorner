/**
 * Weekly tracking slots (MVP §7.8).
 *
 * Every project is tracked once a week at a fixed hour, `hash(public_id) mod 168`, so a thousand projects
 * spread over the 168 hours of the week instead of all hitting the providers on Monday morning.
 * Hour 0 is Monday 00:00 UTC. The week is the ISO week, so `2026-W40` is the same week for everyone, and
 * "project + week" names a run slot exactly once, which is what makes a double-fired scheduler harmless.
 *
 * Everything is UTC. A customer's time zone only affects when emails arrive, never when data is collected.
 */

export const HOURS_PER_WEEK = 168;
const HOUR_MS = 60 * 60 * 1000;

/** FNV-1a, 32 bit. Stable across Node versions and processes, which `Math.random` and Map order are not. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The project's weekly slot, 0-167. Stored in `projects.weekly_slot_hour` when the project is created. */
export function slotHourOf(projectPublicId) {
  return fnv1a(String(projectPublicId)) % HOURS_PER_WEEK;
}

/** Hours since Monday 00:00 UTC, 0-167. */
export function hourOfWeek(date) {
  const day = (date.getUTCDay() + 6) % 7; // Monday = 0
  return day * 24 + date.getUTCHours();
}

/** The ISO week as `2026-W40`. The week belongs to the year that contains its Thursday. */
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayOfWeek + 3); // the Thursday of this week
  const year = d.getUTCFullYear();
  // Week 1 is the week containing 4 January; find its Thursday and count weeks from there.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Thursday = jan4.getTime() + (3 - ((jan4.getUTCDay() + 6) % 7)) * 86400000;
  const week = 1 + Math.round((d.getTime() - week1Thursday) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The start of the hour containing `date`. */
export function startOfHour(date) {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * The slots the scheduler should look at on a tick at `now`: the current hour, plus `lookbackHours` earlier
 * ones, so a tick that was missed (worker down, deploy) is caught up by the next one. Each entry names the
 * hour of the week and the ISO week it belongs to. Oldest first.
 */
export function slotsToCheck(now, lookbackHours = 3) {
  const current = startOfHour(now);
  const slots = [];
  for (let back = lookbackHours; back >= 0; back -= 1) {
    const at = new Date(current.getTime() - back * HOUR_MS);
    slots.push({ at, hour: hourOfWeek(at), weekKey: isoWeekKey(at) });
  }
  return slots;
}
