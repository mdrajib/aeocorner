import { ulid } from '../../lib/ulid.js';
import { DomainError } from '../errors.js';

/**
 * One organization's bKash payments (ADR-0018). Merged into `forOrg(orgId)` as `bkash`; the organization is bound once and
 * no function takes an `org_id`. Settling a payment (which updates the subscription) is a cross-organization write the
 * worker also makes, so it lives in `system-billing.js`; this file starts, marks and lists this organization's own.
 *
 * Every write names the status it expects, so a double click, a retry and a late callback change a row at most once.
 */

const view = (r) => ({
  id: r.id,
  publicId: r.public_id,
  planCode: r.plan_code,
  purpose: r.purpose,
  amountBdt: Number(r.amount_bdt),
  invoiceNumber: r.invoice_number,
  bkashPaymentId: r.bkash_payment_id,
  trxId: r.trx_id,
  status: r.status,
  failureReason: r.failure_reason,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  completedAt: r.completed_at,
  createdAt: r.created_at,
});

export function bkashRepos(prisma, orgId) {
  const bkash = {
    /** Record that a payment is about to be asked of bKash. Nothing has been charged yet. */
    async begin({ planCode, purpose, amountBdt, invoiceNumber, now = new Date() }) {
      const row = await prisma.bkash_payments.create({
        data: {
          public_id: ulid(now.getTime()),
          org_id: orgId,
          plan_code: planCode,
          purpose,
          amount_bdt: amountBdt,
          invoice_number: invoiceNumber,
        },
      });
      return view(row);
    },

    /** bKash gave the payment an ID: remember it (only once). */
    async attach(publicId, bkashPaymentId) {
      const done = await prisma.bkash_payments.updateMany({
        where: { org_id: orgId, public_id: publicId, status: 'created', bkash_payment_id: null },
        data: { bkash_payment_id: bkashPaymentId },
      });
      return done.count === 1;
    },

    /** The payment bKash named in the callback, if it is this organization's. */
    async byBkashId(bkashPaymentId) {
      if (typeof bkashPaymentId !== 'string' || !bkashPaymentId) return null;
      const row = await prisma.bkash_payments.findFirst({
        where: { org_id: orgId, bkash_payment_id: bkashPaymentId },
      });
      return row && view(row);
    },

    /** A payment that did not go through (declined, cancelled on bKash's page, or never created). */
    async close(publicId, { status, reason = null }) {
      if (!['failed', 'cancelled'].includes(status)) throw new DomainError('BAD_STATUS');
      const done = await prisma.bkash_payments.updateMany({
        where: { org_id: orgId, public_id: publicId, status: 'created' },
        data: { status, failure_reason: reason },
      });
      return done.count === 1;
    },

    /** The latest payments, newest first, for the billing screen. */
    async recent({ limit = 12 } = {}) {
      const rows = await prisma.bkash_payments.findMany({
        where: { org_id: orgId },
        orderBy: { id: 'desc' },
        take: limit,
      });
      return rows.map(view);
    },

    /** Stop the plan renewing at the end of the paid period (or start again). A reminder is not sent once stopped. */
    async setCancelAtPeriodEnd(cancel) {
      const done = await prisma.subscriptions.updateMany({
        where: { org_id: orgId, provider: 'bkash', status: { in: ['trialing', 'active'] } },
        data: { cancel_at_period_end: Boolean(cancel) },
      });
      return done.count > 0;
    },
  };

  return { bkash };
}
