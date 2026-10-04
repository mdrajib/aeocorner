const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

/** The provider refused or failed to take an email. `retryable` is true for rate limits and server errors. */
export class MailError extends Error {
  constructor(message, { status, retryable }) {
    super(message);
    this.name = 'MailError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Sends already-rendered emails ({ subject, html, text } from renderEmail) through Resend's HTTP API
 * (checked against Resend's docs on 2026-10-02: POST /emails, Bearer key, optional Idempotency-Key).
 * `idempotencyKey` makes a retried send harmless for 24 hours.
 */
export function resendMailer({ apiKey, from, fetchImpl = globalThis.fetch, logger }) {
  return {
    kind: 'resend',
    async send({ to, email, idempotencyKey, headers }) {
      let response;
      try {
        response = await fetchImpl(RESEND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey && { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) }),
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject: email.subject,
            html: email.html,
            text: email.text,
            ...(headers && { headers }),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new MailError(`Email provider unreachable: ${err.message}`, { retryable: true });
      }

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new MailError(`Email provider answered ${response.status}`, {
          status: response.status,
          retryable,
        });
      }
      const body = await response.json().catch(() => ({}));
      logger?.info({ emailId: body.id, subject: email.subject }, 'Email sent');
      return { id: body.id ?? null };
    },
  };
}

/**
 * No provider configured (local development): write the email to the log instead of sending it, so a
 * developer can click the link in the console. Production refuses to start without a real mailer.
 */
export function logMailer({ logger }) {
  return {
    kind: 'log',
    async send({ to, email }) {
      logger.info(
        { to, subject: email.subject },
        `Email not sent (RESEND_API_KEY is not set). Text version:\n${email.text}`,
      );
      return { id: null };
    },
  };
}

/** Collects emails in memory, for tests. */
export function memoryMailer() {
  const sent = [];
  return {
    kind: 'memory',
    sent,
    async send(message) {
      sent.push(message);
      return { id: `memory-${sent.length}` };
    },
  };
}

export function createMailer({ config, logger, fetchImpl }) {
  const { resendApiKey, from } = config.email;
  return resendApiKey
    ? resendMailer({ apiKey: resendApiKey, from, fetchImpl, logger })
    : logMailer({ logger });
}
