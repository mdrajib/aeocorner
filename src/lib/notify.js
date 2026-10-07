import { KINDS, unsubscribeToken } from '../core/notify.js';
import { utcDayStart } from '../core/spend.js';
import { renderEmail } from './email.js';
import { MailError } from './mailer.js';

/**
 * Sends one email to one person, with the rules that keep a mailbox safe (Milestone 8, tasks 8.15 and 8.16):
 *
 *   1. record it under its dedupe key: the same message asked for twice is one message
 *   2. an address on the suppression list (a bounce, a complaint, "unsubscribe all") is never emailed
 *   3. a proactive message (digest, alert) is sent at most once a day per person
 *   4. a proactive message carries a one-click unsubscribe (the link and the RFC 8058 headers)
 *
 * It answers with what happened, so the caller can count it: `sent`, `duplicate`, `suppressed`, `capped`, `failed`.
 * A send that failed for a reason worth retrying throws the mailer's `MailError`, and the job retries: the message
 * stays queued, so the retry sends it.
 */
export function createNotifier({
  db,
  mailer,
  baseUrl,
  secret,
  logger = null,
  now = () => new Date(),
}) {
  const base = baseUrl.replace(/\/$/, '');
  const unsubscribeUrl = (userId, pref) =>
    `${base}/unsubscribe/${unsubscribeToken({ userId, pref }, secret)}`;

  /**
   * @param {object} m
   * @param {string} m.to          the address
   * @param {bigint} m.userId      the person (the daily cap and the unsubscribe are about them)
   * @param {string} m.kind        a key of KINDS in src/core/notify.js, and the email template's name
   * @param {string} m.dedupeKey   what makes this message this message
   * @param {object} m.data        the template's data
   * @param {bigint} [m.orgId]
   * @param {bigint} [m.projectId]
   */
  async function send({
    to,
    userId,
    kind,
    dedupeKey,
    data,
    orgId = null,
    projectId = null,
    about = {},
  }) {
    const def = KINDS[kind];
    if (!def) throw new TypeError(`Unknown notification kind: ${kind}`);
    const proactive = def.category === 'proactive';
    const at = now();

    const link = proactive ? unsubscribeUrl(userId, def.pref) : null;
    const email = renderEmail(kind, data, { baseUrl: base, unsubscribeUrl: link });

    const { notification, created } = await db.notifications.messages.enqueue({
      orgId,
      userId,
      projectId,
      kind,
      category: def.category,
      dedupeKey,
      subject: email.subject,
      // What was sent about, never the email's text or the address: the row is for support and audit.
      payload: { kind, projectId: projectId === null ? null : String(projectId), ...about },
    });
    if (!created && notification.status !== 'queued') {
      return {
        status:
          notification.status === 'sent' || notification.status === 'delivered'
            ? 'duplicate'
            : notification.status,
      };
    }

    if (await db.notifications.suppressions.isSuppressed(to)) {
      await db.notifications.messages.markSuppressed(notification.id, 'address_suppressed');
      return { status: 'suppressed', reason: 'address_suppressed' };
    }
    if (proactive) {
      const sentToday = await db.notifications.messages.sentProactiveSince(userId, utcDayStart(at));
      if (sentToday >= 1) {
        await db.notifications.messages.markSuppressed(notification.id, 'daily_cap');
        return { status: 'capped', reason: 'daily_cap' };
      }
    }

    try {
      const result = await mailer.send({
        to,
        email,
        idempotencyKey: `notification-${notification.id}`,
        ...(link
          ? {
              headers: {
                'List-Unsubscribe': `<${link}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              },
            }
          : {}),
      });
      await db.notifications.messages.markSent(notification.id, {
        providerMessageId: result?.id ?? null,
        now: at,
      });
      return { status: 'sent', id: notification.id };
    } catch (err) {
      if (err instanceof MailError && err.retryable) {
        await db.notifications.messages.markFailed(notification.id, err.message, { final: false });
        throw err;
      }
      logger?.error({ err: err.message, kind }, 'An email was refused and will not be retried');
      await db.notifications.messages.markFailed(notification.id, err.message);
      return { status: 'failed' };
    }
  }

  const longDate = (d) =>
    new Date(d).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });

  return {
    send,
    baseUrl: base,
    unsubscribeUrl,

    /** 14 days before a cancelled account is closed: what happens and how to keep it. One per organization and owner. */
    async sendRetentionWarning({ to, userId, orgId, orgName, retainUntil }) {
      const r = await send({
        to,
        userId,
        orgId,
        kind: 'retention-warning',
        dedupeKey: `retention-warning.${orgId}.${userId}`,
        data: { orgName, closeDate: longDate(retainUntil), billingUrl: `${base}/app` },
      });
      return r.status === 'sent';
    },

    /** The plan lost Claude: when tracking stops and how to keep it. One per owner and end date. */
    async sendClaudeEnding({ to, userId, orgId, orgPublicId, orgName, until, projectNames }) {
      const r = await send({
        to,
        userId,
        orgId,
        kind: 'claude-ending',
        dedupeKey: `claude-ending.${orgId}.${userId}.${new Date(until).toISOString().slice(0, 10)}`,
        data: {
          orgName,
          endDate: longDate(until),
          projectNames: projectNames.join(', '),
          billingUrl: `${base}/app/o/${orgPublicId}/billing`,
        },
      });
      return r.status === 'sent';
    },

    /** The Google login stopped working: reconnect. At most one a month per person and project. */
    async sendGoogleReconnect({ to, userId, orgId, projectId, projectName, month, trafficUrl }) {
      const r = await send({
        to,
        userId,
        orgId,
        projectId,
        kind: 'google-reconnect',
        dedupeKey: `google-reconnect.${projectId}.${userId}.${month}`,
        data: { projectName, trafficUrl },
      });
      return r.status === 'sent';
    },

    /** The trial ends soon: what was found, and what stops if they cancel (CUSTOMER_JOURNEY stage 9). */
    async sendTrialEnding({
      to,
      userId,
      orgId,
      orgName,
      subscriptionId,
      planName,
      priceText,
      chargeDate,
      orgPublicId,
    }) {
      const r = await send({
        to,
        userId,
        orgId,
        kind: 'trial-ending',
        dedupeKey: `trial-ending.${subscriptionId}.${userId}`,
        data: {
          orgName,
          planName,
          priceText,
          chargeDate: longDate(chargeDate),
          billingUrl: `${base}/app/o/${orgPublicId}/billing`,
        },
      });
      return r.status === 'sent';
    },
  };
}
