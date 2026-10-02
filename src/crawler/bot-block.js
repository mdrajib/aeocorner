/**
 * Did a site's firewall turn this request away? (readiness check A3, MVP §6.6)
 *
 * A block rarely says "blocked". It is a 403 or a 429, or a 200 whose page is a "Just a moment..." challenge or
 * an "Access denied, reference #18.abc" notice. This reads the status, the headers and the start of the body
 * for the tell-tale signs of the common firewalls and CDNs.
 *
 * It is deliberately specific. A normal page that mentions "captcha" in a contact form or "Cloudflare" in a
 * blog post must not be taken for a block, so each marker is something only a challenge page says.
 */

// [vendor, a phrase that only that vendor's block or challenge page contains]. Matched against the lower-cased
// start of the body.
const BODY_MARKERS = [
  ['Cloudflare', 'just a moment...'],
  ['Cloudflare', 'cf-chl-'],
  ['Cloudflare', '/cdn-cgi/challenge-platform'],
  ['Cloudflare', 'attention required! | cloudflare'],
  ['Cloudflare', 'checking your browser before accessing'],
  ['Cloudflare', 'sorry, you have been blocked'],
  ['Imperva', 'pardon our interruption'],
  ['Imperva', 'request unsuccessful. incapsula incident id'],
  ['HUMAN', 'px-captcha'],
  ['HUMAN', 'press & hold to confirm you are a human'],
  ['DataDome', 'captcha-delivery.com'],
  ['DataDome', 'geo.captcha-delivery.com'],
  ['Akamai', 'you don’t have permission to access'],
  ['Akamai', "you don't have permission to access"],
  ['Sucuri', 'sucuri website firewall'],
  ['Wordfence', 'your access to this site has been limited'],
  ['AWS WAF', 'aws-waf-token'],
  ['Unknown', 'verify you are human'],
  ['Unknown', 'unusual traffic from your computer network'],
  ['Unknown', 'enable javascript and cookies to continue'],
];

const BLOCKING_STATUSES = new Set([401, 403, 406, 429, 451, 999]);

function vendorFromHeaders(headers) {
  const server = String(headers.server ?? '').toLowerCase();
  if (headers['cf-mitigated'] || (server === 'cloudflare' && headers['cf-ray']))
    return 'Cloudflare';
  if (headers['x-datadome'] || headers['x-dd-b'] || server === 'datadome') return 'DataDome';
  if (headers['x-sucuri-id'] || headers['x-sucuri-block']) return 'Sucuri';
  if (headers['x-iinfo'] || /incap_ses|visid_incap/i.test(String(headers['set-cookie'] ?? '')))
    return 'Imperva';
  if (headers['x-amzn-waf-action']) return 'AWS WAF';
  if (server.includes('akamai')) return 'Akamai';
  return null;
}

/**
 * @param {{ status: number, headers?: object, body?: Buffer | string }} response
 * @returns {{ blocked: boolean, vendor: string | null, reason: string }}
 */
export function detectBotBlock({ status, headers = {}, body = '' }) {
  const head = (typeof body === 'string' ? body : body.subarray(0, 20_000).toString('utf8'))
    .slice(0, 20_000)
    .toLowerCase();
  const fromHeaders = vendorFromHeaders(headers);

  const marker = BODY_MARKERS.find(([, phrase]) => head.includes(phrase));
  const challengeHeader = ['challenge', 'captcha', 'block'].includes(
    String(headers['cf-mitigated'] ?? headers['x-amzn-waf-action'] ?? '').toLowerCase(),
  );

  // A challenge page is a block even when it is served with a 200.
  if (challengeHeader || marker) {
    const vendor =
      marker && marker[0] !== 'Unknown' ? marker[0] : (fromHeaders ?? marker?.[0] ?? null);
    return {
      blocked: true,
      vendor: vendor === 'Unknown' ? null : vendor,
      reason: `a challenge or block page${vendor && vendor !== 'Unknown' ? ` (${vendor})` : ''}, status ${status}`,
    };
  }

  if (BLOCKING_STATUSES.has(status)) {
    return {
      blocked: true,
      vendor: fromHeaders,
      reason: `HTTP ${status}${fromHeaders ? ` from ${fromHeaders}` : ''}`,
    };
  }

  // 503 is only a block when it is the firewall saying so; on its own it is a server having a bad day.
  if (status === 503 && fromHeaders && /\bchallenge|captcha\b/.test(head)) {
    return { blocked: true, vendor: fromHeaders, reason: `HTTP 503 challenge from ${fromHeaders}` };
  }
  return { blocked: false, vendor: null, reason: `HTTP ${status}` };
}
