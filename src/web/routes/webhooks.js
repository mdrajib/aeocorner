import express, { Router } from 'express';
import { verifyWebhook } from '@clerk/express/webhooks';
import { fromWebhookData } from '../auth/clerk-user.js';

/**
 * Apply one verified Clerk event. Returns 'processed' or 'ignored'.
 * Every branch is safe to run twice and in any order: see users.applyClerkUpdate / markDeleted.
 */
export async function handleClerkEvent(db, event, logger) {
  switch (event.type) {
    case 'user.created':
    case 'user.updated':
      await db.users.applyClerkUpdate(fromWebhookData(event.data));
      return 'processed';
    case 'user.deleted': {
      const { orphanedOrgIds } = await db.users.markDeleted(event.data.id);
      // Someone owned an organization alone and deleted their account: staff need to know.
      if (orphanedOrgIds.length) {
        logger.warn(
          { orphanedOrgIds: orphanedOrgIds.map(String) },
          'Organization left without an owner',
        );
      }
      return 'processed';
    }
    default:
      return 'ignored';
  }
}

/**
 * POST /webhooks/clerk — Clerk (via Svix) tells us a user changed. Order of work:
 *   1. verify the signature on the raw body (an unsigned request never reaches the database)
 *   2. record the delivery by its svix-id, so a repeat is recognised
 *   3. apply it, then mark it processed — or failed, and answer 500 so Clerk retries
 */
export function webhookRoutes({ config, db, logger, verify = verifyWebhook }) {
  const router = Router();

  router.post(
    '/webhooks/clerk',
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const secret = config.auth?.webhookSecret;
      if (!secret) return res.status(503).json({ error: 'Webhooks are not configured.' });

      let event;
      try {
        event = await verify(req, { signingSecret: secret });
      } catch {
        return res.status(400).json({ error: 'Invalid signature.' });
      }

      const externalId = req.get('svix-id');
      if (!externalId) return res.status(400).json({ error: 'Missing svix-id.' });

      try {
        const { event: stored, duplicate } = await db.webhookEvents.receive({
          source: 'clerk',
          externalId,
          eventType: event.type,
          payload: event,
        });

        if (duplicate && ['processed', 'ignored'].includes(stored.status)) {
          return res.json({ status: 'duplicate' });
        }
        if (!(await db.webhookEvents.begin(stored.id))) return res.json({ status: 'duplicate' });

        try {
          const outcome = await handleClerkEvent(db, event, logger);
          await db.webhookEvents.finish(stored.id, outcome);
          return res.json({ status: outcome });
        } catch (err) {
          logger.error({ err, eventType: event.type, svixId: externalId }, 'Clerk webhook failed');
          await db.webhookEvents.fail(stored.id, err.message);
          return res.status(500).json({ error: 'Processing failed; please retry.' });
        }
      } catch (err) {
        logger.error({ err }, 'Clerk webhook could not be recorded');
        return res.status(500).json({ error: 'Could not record the event; please retry.' });
      }
    },
  );

  return router;
}
