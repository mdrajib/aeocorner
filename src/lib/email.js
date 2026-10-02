import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { emailTokens } from './email-tokens.js';

const EMAILS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'views', 'emails');

/**
 * Registry of transactional emails. Each entry names its templates (emails/<name>.html.ejs and
 * emails/<name>.text.ejs — the body only; the shared layout wraps it) and builds the subject and
 * preheader. Later phases add their emails here (audit report, invitation, weekly digest, …).
 */
const TEMPLATES = {
  'verification-code': {
    subject: (d) => `Your AEO Corner code: ${d.code}`,
    preheader: (d) =>
      `Enter ${d.code} to see your AEO report. It expires in ${d.expiresMinutes} minutes.`,
    footerReason:
      'You are receiving this because someone asked for an AEO Corner report with this email address.',
  },
};

const cache = new Map();
function compile(file) {
  if (!cache.has(file)) {
    cache.set(
      file,
      ejs.compile(readFileSync(join(EMAILS_DIR, file), 'utf8'), {
        filename: join(EMAILS_DIR, file),
      }),
    );
  }
  return cache.get(file);
}

export function emailNames() {
  return Object.keys(TEMPLATES);
}

/**
 * Render an email to { subject, html, text }. The same data renders both variants, so they can't
 * disagree. Throws if the template is unknown or needs data that wasn't supplied.
 *
 * @param {string} name   key of TEMPLATES
 * @param {object} data   template data
 * @param {{ baseUrl: string, unsubscribeUrl?: string }} context
 */
export function renderEmail(name, data, context) {
  const def = TEMPLATES[name];
  if (!def) throw new Error(`Unknown email template: ${name}`);
  const { baseUrl, unsubscribeUrl } = context;

  const shared = {
    ...data,
    baseUrl,
    unsubscribeUrl: unsubscribeUrl ?? null,
    footerReason: def.footerReason,
    preheader: def.preheader(data),
    t: emailTokens,
  };

  const bodyHtml = compile(`${name}.html.ejs`)(shared);
  const bodyText = compile(`${name}.text.ejs`)(shared);
  return {
    subject: def.subject(data),
    html: compile('layout.html.ejs')({ ...shared, bodyHtml }),
    text: compile('layout.text.ejs')({ ...shared, bodyText }),
  };
}
