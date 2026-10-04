/**
 * Campaign tags on the public site (Milestone 9, task 9.09). A visitor who arrives from `?utm_source=newsletter` has the
 * tag carried through the free-audit form to the first server-side funnel event, so "where did this audit come from"
 * can be answered without a cookie or an identifier.
 *
 * Only three tags are kept (source, medium, campaign), and a value is kept only if it is a short plain label. Anything
 * else is dropped, not trimmed: a tag like `utm_content=jane@example.com` must never reach an analytics event, and a
 * value that is not a label is more likely to be somebody's text than a campaign name.
 */

export const UTM_KEYS = Object.freeze(['utm_source', 'utm_medium', 'utm_campaign']);

const LABEL = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** One tag value -> a lower-case label, or null. */
export function utmLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim().toLowerCase();
  return LABEL.test(label) ? label : null;
}

/** The tags in a query string or a posted form (an object), as `{ utm_source?, utm_medium?, utm_campaign? }`. */
export function cleanUtm(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of UTM_KEYS) {
    const label = utmLabel(source[key]);
    if (label) out[key] = label;
  }
  return out;
}
