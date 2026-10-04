/**
 * What Resend tells us about an email we sent (Milestone 8, task 8.15): delivered, bounced, or the reader marked it as
 * spam. A bounce to an address that does not exist and a spam complaint put the address on the suppression list, so we
 * never email it again (protecting the sending reputation every customer's email depends on). A temporary bounce (a full
 * mailbox) only marks the message. Every branch is safe to run twice.
 *
 * Event names and fields were checked against Resend's webhook documentation on 2026-10-04: `email.delivered`,
 * `email.bounced` and `email.complained`, with `data.email_id`, `data.to` and, for a bounce, `data.bounce.type`.
 * Anything else, or an event with no address, is ignored.
 *
 * @returns {'processed'|'ignored'}
 */
export async function handleResendEvent({ db, event }) {
  const data = event?.data ?? {};
  const recipients = Array.isArray(data.to) ? data.to.filter((a) => typeof a === 'string') : [];
  switch (event?.type) {
    case 'email.delivered': {
      if (typeof data.email_id !== 'string') return 'ignored';
      await db.notifications.messages.setStatusByProviderId(data.email_id, 'delivered');
      return 'processed';
    }
    case 'email.bounced': {
      if (typeof data.email_id === 'string') {
        await db.notifications.messages.setStatusByProviderId(data.email_id, 'bounced');
      }
      const temporary = String(data.bounce?.type ?? '').toLowerCase() === 'transient';
      if (!temporary) {
        for (const email of recipients) {
          await db.notifications.suppressions.add({ email, reason: 'bounce' });
        }
      }
      return recipients.length || data.email_id ? 'processed' : 'ignored';
    }
    case 'email.complained': {
      if (typeof data.email_id === 'string') {
        await db.notifications.messages.setStatusByProviderId(data.email_id, 'complained');
      }
      for (const email of recipients) {
        await db.notifications.suppressions.add({ email, reason: 'complaint' });
      }
      return recipients.length || data.email_id ? 'processed' : 'ignored';
    }
    default:
      return 'ignored';
  }
}
