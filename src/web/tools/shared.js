import { z } from 'zod';
import { normalizeWebsite } from '../../lib/url.js';

/**
 * Pieces every tool's input schema uses. Input is validated with zod at the boundary, and what a tool receives is
 * already clean: a typed value, never the raw form.
 */

/** A website address typed by the visitor: `{ url, origin, domain }`. The message is the one the audit form gives. */
export const siteInput = z
  .string({ error: normalizeWebsite('').message })
  .max(2048, { error: 'That address is too long.' })
  .transform((raw, ctx) => {
    const site = normalizeWebsite(raw);
    if (!site.ok) {
      ctx.addIssue({ code: 'custom', message: site.message });
      return z.NEVER;
    }
    return { url: site.url, origin: new URL(site.url).origin, domain: site.domain };
  });

/** A checkbox: present means on. */
export const checkbox = z
  .union([z.literal('1'), z.literal('on')])
  .optional()
  .transform((v) => v !== undefined);

/** The first message for each field a form got wrong: `{ field: message }`. */
export function fieldErrors(error) {
  const out = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? '_');
    out[field] ??= issue.message;
  }
  return out;
}
