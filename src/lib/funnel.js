import { randomUUID } from 'node:crypto';
import { UTM_KEYS, utmLabel } from '../core/utm.js';

/**
 * The free-audit funnel's PostHog events (docs/UI_DESIGN.md §9), sent from the server so that the page the visitor
 * is on never needs PostHog: an audit's report address is a private link (the address is the only secret), and
 * PostHog records page addresses.
 *
 * Anonymous by construction: every event gets a new random id, `$process_person_profile` is false, and a caller
 * passes only the few plain properties below. No email, domain, IP or audit id can be sent, because properties are
 * checked against an allow-list. A send never blocks or breaks the request: it is cut off after a short time and
 * any failure is dropped.
 */

export const FUNNEL_EVENTS = Object.freeze([
  'audit_form_submitted', // a valid website address reached the email step
  'audit_email_submitted', // an email was accepted and a code was sent
  'audit_code_verified', // the right code: the audit is queued
  'audit_report_viewed', // a finished report was opened
  'audit_track_clicked', // "track this weekly" was clicked on a report
  'signup_completed', // a new account made its first organization
]);

/** The only properties an event may carry, and the kind of value each may hold. */
const PROPERTIES = Object.freeze({
  has_competitor: 'boolean',
  from_audit: 'boolean', // the sign-up came from a report's "track this weekly"
  consent: 'boolean',
  cached: 'boolean',
  status: ['complete', 'partial', 'failed'],
  score_band: ['none', 'low', 'mid', 'high'],
});

const TIMEOUT_MS = 2_000;

export const scoreBand = (score) =>
  !Number.isFinite(score) ? 'none' : score < 34 ? 'low' : score < 67 ? 'mid' : 'high';

function clean(properties = {}) {
  const out = {};
  for (const [key, value] of Object.entries(properties)) {
    const rule = PROPERTIES[key];
    if (UTM_KEYS.includes(key)) {
      // Campaign tags: a short plain label or nothing (src/core/utm.js).
      const label = utmLabel(value);
      if (label) out[key] = label;
      continue;
    }
    if (!rule) throw new Error(`Funnel property "${key}" is not allowed`);
    if (rule === 'boolean' ? typeof value === 'boolean' : rule.includes(value)) out[key] = value;
  }
  return out;
}

export function createFunnel({ posthog, logger, fetchImpl = globalThis.fetch }) {
  return {
    /** Fire and forget: resolves when the attempt is over, and never rejects. */
    async capture(event, properties) {
      if (!FUNNEL_EVENTS.includes(event)) throw new Error(`Unknown funnel event "${event}"`);
      const props = clean(properties);
      if (!posthog) return false;
      try {
        const response = await fetchImpl(`${posthog.host}/capture/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_key: posthog.apiKey,
            event,
            distinct_id: randomUUID(),
            properties: { ...props, $process_person_profile: false, $lib: 'aeo-corner-server' },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        return response.ok;
      } catch (err) {
        logger?.warn({ event, err: err.message }, 'Funnel event not sent');
        return false;
      }
    },
  };
}
