/**
 * How a brand's name is compared: the same function fills `tracked_entities.name_normalized` and
 * `entity_aliases.value_normalized`, and resolves the names Claude reads in an answer to tracked entities. Two
 * spellings that normalize the same are one brand ("Acme, Inc." and "acme"); anything else is a different one.
 */

const LEGAL_SUFFIX =
  /(?:,?\s+(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|plc)\.?)+$/;
const MARKS = /[™®©]/g; // ™ ® ©

/** "  Acme CRM, Inc.™ " -> "acme crm". Empty for anything with no letters or digits. */
export function normalizeName(value) {
  // Marks first: NFKC would turn ™ into the letters "TM".
  const text = String(value ?? '')
    .replace(MARKS, '')
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”«»]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEGAL_SUFFIX, '')
    .replace(/^[\s"'([{]+|[\s"'.,;:!?)\]}]+$/g, '');
  return /[\p{L}\p{N}]/u.test(text) ? text.slice(0, 255) : '';
}

/** "https://www.Acme.com/x" or "WWW.acme.com" -> "acme.com". Null when it isn't a host name. */
export function normalizeDomain(value) {
  let host = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!host) return null;
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  return /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** True when `host` is `domain` or one of its subdomains (blog.acme.com belongs to acme.com). */
export function hostBelongsTo(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}
