import { randomBytes } from 'node:crypto';

/**
 * Proving that a customer owns the website of a project (Milestone 3, task 3.04). The proof lets us ignore that site's
 * robots.txt when we scan it for them (docs/adr/0005-fetching-other-peoples-websites.md): without it anyone could point
 * a project at somebody else's site and have us read what the site owner asked crawlers to leave alone.
 *
 * Two ways, the customer picks whichever they can do:
 *   - DNS:  a TXT record on `_aeocorner.<domain>` whose value is `aeocorner-verification=<token>`;
 *   - file: `https://<domain>/.well-known/aeocorner-verification.txt` whose body is the token.
 *
 * Pure: the network checks live in src/crawler/verify-domain.js, so the rules here are testable without a network.
 */

export const TXT_PREFIX = 'aeocorner-verification=';
export const FILE_PATH = '/.well-known/aeocorner-verification.txt';
const TOKEN = /^[0-9a-f]{32}$/;

/** A fresh proof-of-ownership token: 128 bits, hex. */
export const newVerificationToken = () => randomBytes(16).toString('hex');
export const isVerificationToken = (value) => typeof value === 'string' && TOKEN.test(value);

/** Where the customer adds the TXT record, and what it must say. */
export const dnsRecord = (domain, token) => ({
  type: 'TXT',
  name: `_aeocorner.${domain}`,
  value: `${TXT_PREFIX}${token}`,
});

/** Where the customer puts the file, and what is in it. */
export const fileProof = (domain, token) => ({
  url: `https://${domain}${FILE_PATH}`,
  path: FILE_PATH,
  body: token,
});

/**
 * Does any TXT record carry the token? `records` is what `dns.resolveTxt` returns: a list of records, each a list of
 * string chunks (long records are split) that are joined.
 */
export function txtProves(records, token) {
  if (!isVerificationToken(token) || !Array.isArray(records)) return false;
  const wanted = `${TXT_PREFIX}${token}`;
  return records.some(
    (chunks) => Array.isArray(chunks) && chunks.join('').trim().toLowerCase() === wanted,
  );
}

/** Does the file's text carry the token (alone on its first non-blank line, so a page that merely quotes it fails)? */
export function fileProves(body, token) {
  if (!isVerificationToken(token) || typeof body !== 'string') return false;
  const unmarked = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body; // a byte-order mark
  const first = unmarked.split(/\r?\n/).find((line) => line.trim() !== '');
  return first !== undefined && first.trim().toLowerCase() === token;
}
