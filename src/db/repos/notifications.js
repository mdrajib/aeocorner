import { applyUnsubscribe } from '../../core/notify.js';
import { isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

const MAX_ERROR = 500;

/**
 * Email we send and the rules around it (Milestone 8, task 8.15). One row per message, with a dedupe key that names
 * what the message is ("the digest for this person, this project, this week"), so a job that runs twice sends once. The
 * suppression list (bounces, complaints, "unsubscribe all") is checked before every send.
 *
 * Global rather than per organization: a message can be about an organization or, for a lead, none; the person it is
 * for is what matters. The notifier (src/lib/notify.js) is the only caller.
 */
export function notificationsRepo(prisma) {
  const messages = {
    /**
     * Record that a message should go out. Returns the existing row with `created: false` when this dedupe key is already
     * known; the caller sends only when its status is still `queued`.
     */
    async enqueue({
      orgId = null,
      userId = null,
      projectId = null,
      kind,
      category,
      dedupeKey,
      subject,
      payload,
    }) {
      const key = String(dedupeKey).slice(0, 191);
      try {
        const notification = await prisma.notifications.create({
          data: {
            org_id: orgId,
            user_id: userId,
            project_id: projectId,
            channel: 'email',
            category,
            kind,
            dedupe_key: key,
            subject: subject ? String(subject).slice(0, 255) : null,
            payload: payload ?? undefined,
          },
        });
        return { notification, created: true };
      } catch (err) {
        if (!isUniqueViolation(err, 'uq_notifications_dedupe')) throw err;
        const notification = await prisma.notifications.findFirst({ where: { dedupe_key: key } });
        return { notification, created: false };
      }
    },

    /** Only a queued message can be marked sent, so a second worker finishing the same job changes nothing. */
    async markSent(id, { providerMessageId = null, now = new Date() } = {}) {
      const done = await prisma.notifications.updateMany({
        where: { id, status: 'queued' },
        data: { status: 'sent', provider_message_id: providerMessageId, sent_at: now, error: null },
      });
      return done.count === 1;
    },

    /** The send failed for good (a rejected address). A retryable failure leaves the message queued with a note. */
    markFailed: (id, error, { final = true } = {}) =>
      prisma.notifications.updateMany({
        where: { id, status: 'queued' },
        data: { ...(final ? { status: 'failed' } : {}), error: String(error).slice(0, MAX_ERROR) },
      }),

    markSuppressed: (id, reason) =>
      prisma.notifications.updateMany({
        where: { id, status: 'queued' },
        data: { status: 'suppressed', error: String(reason).slice(0, MAX_ERROR) },
      }),

    /** Proactive emails this person was sent since `since` (the one-a-day cap counts these). */
    sentProactiveSince: (userId, since) =>
      prisma.notifications.count({
        where: {
          user_id: userId,
          channel: 'email',
          category: 'proactive',
          status: { in: ['sent', 'delivered'] },
          sent_at: { gte: since },
        },
      }),

    /** The email provider told us what became of a message (delivered, bounced, complained). */
    async setStatusByProviderId(providerMessageId, status) {
      const done = await prisma.notifications.updateMany({
        where: { provider_message_id: providerMessageId, status: { in: ['sent', 'delivered'] } },
        data: { status },
      });
      return done.count;
    },

    get: (id) => prisma.notifications.findUnique({ where: { id } }),
    recentForUser: (userId, { limit = 50 } = {}) =>
      prisma.notifications.findMany({
        where: { user_id: userId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: Math.min(limit, 200),
      }),
  };

  const suppressions = {
    async isSuppressed(email) {
      const row = await prisma.email_suppressions.findFirst({
        where: { email: String(email).trim().toLowerCase() },
        select: { id: true },
      });
      return Boolean(row);
    },

    /** Never email this address again. Idempotent: the first reason stays. */
    async add({ email, reason, source = 'resend' }) {
      try {
        await prisma.email_suppressions.create({
          data: { email: String(email).trim().toLowerCase().slice(0, 320), reason, source },
        });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },
  };

  const preferences = {
    /**
     * Switch a kind of email off for one person, in every organization they belong to. Idempotent. Returns how many
     * memberships were looked at (0 when the person is unknown, which the page treats the same as success).
     */
    async unsubscribe({ userId, pref }) {
      return transaction(prisma, async (tx) => {
        const rows = await tx.memberships.findMany({
          where: { user_id: userId },
          select: { id: true, notify_prefs: true },
        });
        for (const row of rows) {
          await tx.memberships.update({
            where: { id: row.id },
            data: { notify_prefs: applyUnsubscribe(row.notify_prefs, pref) },
          });
        }
        return rows.length;
      });
    },
  };

  return { messages, suppressions, preferences };
}
