import dns from 'node:dns/promises';
import { dnsRecord, fileProof, fileProves, txtProves } from '../core/domain-verification.js';

/**
 * Look for a customer's proof that they own a site (src/core/domain-verification.js has the rules). The two checks:
 *
 *   - DNS: one TXT lookup of `_aeocorner.<domain>`. It never connects to the customer's server, so it can't be pointed
 *     at an internal address.
 *   - File: a fetch of the well-known file through the safe fetcher (the only way we fetch a URL we did not choose,
 *     ADR-0005), so redirects, private addresses and size are all policed there.
 *
 * Neither check throws: a lookup that fails is "not found yet" (the customer is usually still waiting for DNS to
 * spread), with a short reason for the screen.
 *
 * @param {object} deps
 * @param {{ fetch: Function }} deps.fetcher   createSafeFetcher()
 * @param {Function} [deps.resolveTxt]         defaults to dns.resolveTxt (tests replace it)
 */
export function createDomainVerifier({ fetcher, resolveTxt = dns.resolveTxt }) {
  async function checkDns(domain, token) {
    const record = dnsRecord(domain, token);
    try {
      const records = await resolveTxt(record.name);
      return txtProves(records, token)
        ? { found: true }
        : { found: false, reason: 'The TXT record is there, but its value isn’t ours.' };
    } catch (err) {
      const missing = err?.code === 'ENODATA' || err?.code === 'ENOTFOUND';
      return {
        found: false,
        reason: missing
          ? 'We couldn’t find the TXT record yet. DNS changes can take a few minutes to spread.'
          : 'We couldn’t look up the TXT record just now. Try again in a minute.',
      };
    }
  }

  async function checkFile(domain, token) {
    const proof = fileProof(domain, token);
    try {
      const res = await fetcher.fetch(proof.url, {
        accept: ['text/plain'],
        bodyTypes: [/^text\/plain/i],
        maxBytes: 4096,
        timeoutMs: 10_000,
      });
      if (res.status !== 200) {
        return { found: false, reason: `The file answered with status ${res.status}, not 200.` };
      }
      const text = res.body ? Buffer.from(res.body).toString('utf8') : '';
      return fileProves(text, token)
        ? { found: true }
        : { found: false, reason: 'The file is there, but it doesn’t contain our code.' };
    } catch {
      return { found: false, reason: 'We couldn’t open the file. Check that it is public.' };
    }
  }

  /**
   * Check one method, or both (`method: 'any'`, the default: DNS first). Resolves with
   * `{ verified, method, reasons: { dns?, file? } }`.
   */
  async function verify({ domain, token, method = 'any' }) {
    const reasons = {};
    if (method === 'dns' || method === 'any') {
      const r = await checkDns(domain, token);
      if (r.found) return { verified: true, method: 'dns', reasons };
      reasons.dns = r.reason;
    }
    if (method === 'file' || method === 'any') {
      const r = await checkFile(domain, token);
      if (r.found) return { verified: true, method: 'file', reasons };
      reasons.file = r.reason;
    }
    return { verified: false, method: null, reasons };
  }

  return { verify, checkDns, checkFile };
}
