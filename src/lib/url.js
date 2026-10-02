/**
 * Turn what a visitor types into a website address we can hand to the audit.
 *
 * This is input hygiene for the form, NOT the SSRF defence — that lives in the crawler's safe fetcher
 * (MVP §11.2, Phase 4), which re-checks DNS and every redirect. Rejecting obvious nonsense here just
 * gives the visitor a clear message before any work is queued.
 *
 * @returns {{ ok: true, url: string, domain: string } | { ok: false, message: string }}
 */
export function normalizeWebsite(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, message: 'Enter your website address, like yourcompany.com.' };
  if (raw.length > 2048) return { ok: false, message: 'That address is too long.' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return invalid();
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return invalid();
  if (url.username || url.password) return invalid();
  if (url.port) {
    // URL drops default ports, so any port left over is non-standard (MVP §11.2: only 80/443).
    return { ok: false, message: 'Use the normal web address, without a port number.' };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  const validLabel = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
  // Real hostnames only: at least two labels, a letter-based top level domain, and no IP literals.
  const isHostname =
    labels.length >= 2 &&
    labels.every((l) => validLabel.test(l) || /^xn--[a-z0-9-]+$/i.test(l)) &&
    /^[a-z]{2,}$|^xn--[a-z0-9-]+$/i.test(labels.at(-1));
  if (!isHostname) return invalid();

  return {
    ok: true,
    url: `${url.protocol}//${host}${url.pathname === '/' ? '' : url.pathname}`,
    domain: host.replace(/^www\./, ''),
  };
}

function invalid() {
  return {
    ok: false,
    message: 'That doesn’t look like a website address. Try something like yourcompany.com.',
  };
}
