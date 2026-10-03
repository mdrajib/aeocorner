import { randomBytes } from 'node:crypto';
import { renderEmail } from './email.js';

/**
 * The two emails of the free audit (MVP F1): the six-digit code that proves the address is the visitor's, and the
 * "your report is ready" message. Both are transactional (the visitor asked for them), so neither carries an
 * unsubscribe link and neither depends on the marketing-consent box.
 *
 * The report is sent with an idempotency key naming the audit, so a retried job cannot email it twice. A code email
 * is a new message each time (the OTP store already limits how often one may be asked for). A failed send throws the mailer's `MailError`; the caller
 * decides whether to retry (the worker) or tell the visitor (the form).
 */

export const OTP_MINUTES = 10;

/** The address of an audit's report page (UI_DESIGN A9). */
export const reportUrl = (baseUrl, publicId) => `${baseUrl.replace(/\/$/, '')}/r/${publicId}`;

export function createAuditMail({ mailer, baseUrl, otpMinutes = OTP_MINUTES }) {
  const context = { baseUrl };
  return {
    async sendVerificationCode({ to, code, auditPublicId }) {
      const email = renderEmail('verification-code', { code, expiresMinutes: otpMinutes }, context);
      // A fresh nonce, not anything derived from the code: with a million possible codes a hash of one would be
      // reversible by whoever sees the key (the provider's dashboard, a log).
      const nonce = randomBytes(8).toString('hex');
      return mailer.send({ to, email, idempotencyKey: `audit-code.${auditPublicId}.${nonce}` });
    },

    /** `aeoScore` is null when it could not be worked out: the email says so rather than showing 0. */
    async sendReportReady({ to, domain, aeoScore = null, auditPublicId }) {
      const email = renderEmail(
        'audit-report',
        {
          domain,
          aeoScore: Number.isFinite(aeoScore) ? aeoScore : null,
          reportUrl: reportUrl(baseUrl, auditPublicId),
        },
        context,
      );
      return mailer.send({ to, email, idempotencyKey: `audit-report.${auditPublicId}` });
    },
  };
}
