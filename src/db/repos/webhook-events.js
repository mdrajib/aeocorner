import { isUniqueViolation } from '../errors.js';

const MAX_ERROR_LENGTH = 1000;

/**
 * The inbound webhook inbox. (source, external_id) is unique, so a delivery the provider repeats is
 * recognised by its ID (for Clerk, the `svix-id` header) and handled once. Only verified deliveries are stored.
 */
export function webhookEventsRepo(prisma) {
  return {
    /**
     * Retention (docs/DATABASE_SCHEMA.md §8): empty the payload of every delivery received before `payloadsBefore`, and
     * delete the row of every one received before `rowsBefore`. The row outlives the payload because its
     * (source, external_id) is what recognises a delivery the provider sends again. Returns both counts.
     */
    async prune({ payloadsBefore, rowsBefore }) {
      const loop = async (run) => {
        let total = 0;
        for (;;) {
          const n = Number(await run());
          total += n;
          if (n < 5000) return total;
        }
      };
      const payloads = await loop(
        () => prisma.$executeRaw`
          UPDATE webhook_events SET payload = NULL
          WHERE received_at < ${payloadsBefore} AND payload IS NOT NULL LIMIT 5000`,
      );
      const rows = await loop(
        () =>
          prisma.$executeRaw`DELETE FROM webhook_events WHERE received_at < ${rowsBefore} LIMIT 5000`,
      );
      return { payloads, rows };
    },

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
