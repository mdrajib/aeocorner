import express, { Router } from 'express';
import { verifyWebhook } from '@clerk/express/webhooks';
import { handleStripeEvent } from '../../integrations/stripe-sync.js';
import { StripeError, verifyStripeSignature } from '../../integrations/stripe.js';
import { handleResendEvent } from '../../integrations/resend-events.js';
import { verifySvix } from '../../lib/svix.js';
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
export function webhookRoutes({ config, db, logger, verify = verifyWebhook, billing = null }) {
  const router = Router();

  /**
   * POST /webhooks/stripe: the same order of work as Clerk's. The signature is checked on the raw body first (a bad one
   * never reaches the database), the delivery is recorded by its event ID so a repeat is recognised, then it is applied
   * and marked processed, or failed with a 500 so Stripe sends it again. A replayed event writes the same rows.
   */
  router.post(
    '/webhooks/stripe',
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const secret = config.stripe?.webhookSecret;
      if (!secret || !billing?.stripe) {
        return res.status(503).json({ error: 'Webhooks are not configured.' });
      }
      let event;
      try {
        event = verifyStripeSignature(req.body, req.get('stripe-signature'), secret);
      } catch (err) {
        if (!(err instanceof StripeError))
          return res.status(400).json({ error: 'Invalid payload.' });
        return res.status(400).json({ error: 'Invalid signature.' });
      }
      if (typeof event?.id !== 'string' || typeof event?.type !== 'string') {
        return res.status(400).json({ error: 'Invalid payload.' });
      }

      try {
        const { event: stored, duplicate } = await db.webhookEvents.receive({
          source: 'stripe',
          externalId: event.id,
          eventType: event.type,
          payload: event,
        });
        if (duplicate && ['processed', 'ignored'].includes(stored.status)) {
          return res.json({ status: 'duplicate' });
        }
        if (!(await db.webhookEvents.begin(stored.id))) return res.json({ status: 'duplicate' });

        try {
          const outcome = await handleStripeEvent({
            db,
            stripe: billing.stripe,
            event,
            now: billing.now?.() ?? new Date(),
          });
          await db.webhookEvents.finish(stored.id, outcome);
          return res.json({ status: outcome });
        } catch (err) {
          logger.error(
            { err: err.message, eventType: event.type, eventId: event.id },
            'Stripe webhook failed',
          );
          await db.webhookEvents.fail(stored.id, err.message);
          return res.status(500).json({ error: 'Processing failed; please retry.' });
        }
      } catch (err) {
        logger.error({ err }, 'Stripe webhook could not be recorded');
        return res.status(500).json({ error: 'Could not record the event; please retry.' });
      }
    },
  );

  /**
   * POST /webhooks/resend: Resend tells us an email was delivered, bounced or marked as spam. Signed the Svix way; recorded by
   * its `svix-id` so a repeat is recognised; a bounce or complaint puts the address on the suppression list.
   */
  router.post(
    '/webhooks/resend',
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const secret = config.email?.webhookSecret;
      if (!secret) return res.status(503).json({ error: 'Webhooks are not configured.' });
      let event;
      try {
        event = verifySvix(req.body, req.headers, secret);
      } catch {
        return res.status(400).json({ error: 'Invalid signature.' });
      }
      const externalId = req.get('svix-id');
      if (typeof event?.type !== 'string')
        return res.status(400).json({ error: 'Invalid payload.' });
      try {
        const { event: stored, duplicate } = await db.webhookEvents.receive({
          source: 'resend',
          externalId,
          eventType: event.type,
          payload: event,
        });
        if (duplicate && ['processed', 'ignored'].includes(stored.status)) {
          return res.json({ status: 'duplicate' });
        }
        if (!(await db.webhookEvents.begin(stored.id))) return res.json({ status: 'duplicate' });
        try {
          const outcome = await handleResendEvent({ db, event });
          await db.webhookEvents.finish(stored.id, outcome);
          return res.json({ status: outcome });
        } catch (err) {
          logger.error({ err: err.message, eventType: event.type }, 'Resend webhook failed');
          await db.webhookEvents.fail(stored.id, err.message);
          return res.status(500).json({ error: 'Processing failed; please retry.' });
        }
      } catch (err) {
        logger.error({ err }, 'Resend webhook could not be recorded');
        return res.status(500).json({ error: 'Could not record the event; please retry.' });
      }
    },
  );

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
