import { isUniqueViolation } from '../errors.js';

const MAX_ERROR_LENGTH = 1000;

/**
 * The inbound webhook inbox. (source, external_id) is unique, so a delivery the provider repeats is
 * recognised by its ID (for Clerk, the `svix-id` header) and handled once. Only verified deliveries are stored.
 */
export function webhookEventsRepo(prisma) {
  return {
    /**
     * Record a delivery. If we have seen this ID before, return the stored row with `duplicate: true`;
     * the caller decides whether it needs processing again (it does, if the earlier attempt failed).
     */
    async receive({ source, externalId, eventType, payload }) {
      try {
        const event = await prisma.webhook_events.create({
          data: { source, external_id: externalId, event_type: eventType, payload },
        });
        return { event, duplicate: false };
      } catch (err) {
        if (!isUniqueViolation(err, 'uq_webhook_events_external')) throw err;
        const event = await prisma.webhook_events.findFirst({
          where: { source, external_id: externalId },
        });
        return { event, duplicate: true };
      }
    },

    /** Mark an attempt as started. Returns false when it was already handled, so the caller skips it. */
    async begin(id) {
      const claimed = await prisma.webhook_events.updateMany({
        where: { id, status: { in: ['received', 'failed'] } },
        data: { attempts: { increment: 1 } },
      });
      return claimed.count === 1;
    },

    finish: (id, status = 'processed') =>
      prisma.webhook_events.update({
        where: { id },
        data: { status, error: null, processed_at: new Date() },
      }),

    fail: (id, error) =>
      prisma.webhook_events.update({
        where: { id },
        data: { status: 'failed', error: String(error).slice(0, MAX_ERROR_LENGTH) },
      }),

    find: (source, externalId) =>
      prisma.webhook_events.findFirst({ where: { source, external_id: externalId } }),
  };
}
