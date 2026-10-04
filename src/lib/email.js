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
  'audit-report': {
    subject: (d) => `Your AEO report for ${d.domain} is ready`,
    preheader: (d) =>
      d.aeoScore === null
        ? `The full report for ${d.domain} is ready to open.`
        : `Your AEO Score is ${d.aeoScore} out of 100. Open the full report.`,
    footerReason:
      'You are receiving this because someone asked for an AEO Corner report with this email address.',
  },
  invitation: {
    subject: (d) => `${d.inviterName} invited you to ${d.orgName} on AEO Corner`,
    preheader: (d) => `Join as ${d.roleLabel}. The link works for ${d.expiresDays} days.`,
    footerReason:
      'You are receiving this because someone invited this email address to join an AEO Corner organization.',
  },
  'retention-warning': {
    subject: (d) => `Your AEO Corner data is deleted on ${d.closeDate}`,
    preheader: (d) => `${d.orgName} is read-only until ${d.closeDate}. Choose a plan to keep it.`,
    footerReason:
      'You are receiving this because you own an AEO Corner organization whose subscription was cancelled.',
  },
  digest: {
    subject: (d) => d.digest.subject,
    preheader: (d) => d.digest.preheader,
    footerReason:
      'You are receiving this because you are a member of this AEO Corner organization and the weekly digest is switched on for you.',
  },
  alert: {
    subject: (d) => d.subject,
    preheader: (d) => d.items[0].text.slice(0, 110),
    footerReason:
      'You are receiving this because alerts are switched on for you in this AEO Corner organization.',
  },
  'google-reconnect': {
    subject: (d) => `Reconnect Google for ${d.projectName}`,
    preheader: () =>
      'Google stopped sharing your analytics with AEO Corner. It takes a minute to reconnect.',
    footerReason:
      'You are receiving this because you manage the Google connection of an AEO Corner project.',
  },
  'trial-ending': {
    subject: (d) => `Your free trial ends on ${d.chargeDate}`,
    preheader: (d) =>
      `${d.priceText} is charged on ${d.chargeDate}. Cancel before then to pay nothing.`,
    footerReason: 'You are receiving this because you started a free trial of AEO Corner.',
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
