/**
 * Pure rules for stopping abuse of the free audit (MVP §11.2: Turnstile, OTP, rate limits, disposable-email
 * blocking). The counters are in Redis (src/lib/audit-limits.js); what counts as "the same" email, IP or domain is
 * decided here, so it can be unit-tested.
 */

/**
 * The audit's limits. MVP F1 sets three per email and ten per IP a day; the domain limit stops one site being
 * hammered through many emails (an identical audit inside 24 hours is served from the earlier one, task 1.12).
 */
export const AUDIT_LIMITS = Object.freeze({
  perEmailPerDay: 3,
  perIpPerDay: 10,
  perDomainPerDay: 5,
  /** Refused attempts from one IP in a day before it is blocked for `autoBlockHours`. */
  strikesToBlock: 5,
  autoBlockHours: 24,
});

/**
 * What an email address counts as, for limits only (the address we write to stays as typed). Lowercase, without a
 * "+tag" and, for Gmail, without dots: `Jo.Smith+audit2@gmail.com` and `josmith@googlemail.com` are one mailbox, and
 * three audits per email would otherwise be unlimited.
 */
export function mailboxKey(email) {
  const text = String(email).trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at < 1) return text;
  let local = text.slice(0, at);
  let domain = text.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  return `${local}@${domain}`;
}

export const emailDomain = (email) => String(email).trim().toLowerCase().split('@').pop();

/**
 * The network an address belongs to: the /24 of an IPv4 address and the /64 of an IPv6 one, which is what a single
 * customer connection is given. Used to match staff-made blocks on a whole range. Null if it isn't an IP.
 */
export function ipPrefix(ip) {
  const text = String(ip ?? '').trim();
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(text);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (text.includes(':') && /^[0-9a-f:]+$/i.test(text)) {
    const groups = expandV6(text);
    return groups ? `${groups.slice(0, 4).join(':')}::/64` : null;
  }
  return null;
}

function expandV6(text) {
  const halves = text.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
}

/**
 * Throwaway-mailbox providers. A visitor who gives one hasn't given us a lead, only a free audit and a cost. The
 * list is short on purpose: it catches the well-known ones, and `abuse_blocks` (kind `email_domain`) takes the rest
 * as they turn up without a deploy.
 */
export const DISPOSABLE_EMAIL_DOMAINS = Object.freeze(
  new Set([
    '10minutemail.com',
    '10minutemail.net',
    '20minutemail.com',
    'anonbox.net',
    'burnermail.io',
    'discard.email',
    'dispostable.com',
    'emailondeck.com',
    'fakeinbox.com',
    'getairmail.com',
    'getnada.com',
    'guerrillamail.biz',
    'guerrillamail.com',
    'guerrillamail.de',
    'guerrillamail.net',
    'guerrillamail.org',
    'guerrillamailblock.com',
    'harakirimail.com',
    'inboxbear.com',
    'maildrop.cc',
    'mailinator.com',
    'mailnesia.com',
    'mailsac.com',
    'mintemail.com',
    'moakt.com',
    'mohmal.com',
    'mytemp.email',
    'sharklasers.com',
    'spam4.me',
    'spamgourmet.com',
    'temp-mail.io',
    'temp-mail.org',
    'tempail.com',
    'tempinbox.com',
    'tempmail.com',
    'tempmail.net',
    'tempmailo.com',
    'throwawaymail.com',
    'trashmail.com',
    'trashmail.net',
    'yopmail.com',
    'yopmail.fr',
    'yopmail.net',
  ]),
);

/** True for a throwaway-mailbox address, including a subdomain of one (`x.mailinator.com`). */
export function isDisposableEmail(email) {
  const parts = emailDomain(email).split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}
