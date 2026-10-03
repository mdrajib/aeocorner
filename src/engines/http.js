import { ProviderError } from './contract.js';

/**
 * The one HTTP call the adapters make: JSON in, JSON out, with a time limit.
 *
 * These are hosts WE chose (api.dataforseo.com, api.perplexity.ai, serpapi.com), named in code and reached over
 * HTTPS, so this is plain `fetch`, not the crawler's safe fetcher (that one is for URLs a stranger gave us,
 * ADR-0005). `fetchImpl` and the adapters' `baseUrl` are injectable so the contract tests can replay recorded
 * responses from a server on this machine.
 *
 * HTTP failures become `ProviderError`s:
 *   401, 403            our credentials are wrong: not retryable, and not the provider's fault
 *   402                 the account is out of money: not retryable until someone tops it up
 *   400, 404, 422       we sent something wrong: not retryable, not the provider's fault
 *   408, 429, 5xx       try again later
 * The response body is never put in an error message: some providers echo the request, credentials included.
 */
export async function requestJson(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 60_000, fetchImpl = globalThis.fetch, label },
) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const error = new ProviderError(
      `${label}: ${timedOut ? `no answer within ${timeoutMs} ms` : 'could not connect'}`,
      { status: timedOut ? 'timeout' : 'network' },
    );
    if (timedOut) error.name = 'TimeoutError';
    throw error;
  }

  if (!res.ok) {
    // Drain the body so the connection can be reused, without keeping it.
    await res.arrayBuffer().catch(() => {});
    throw httpError(label, res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError(`${label}: the response was not JSON`, { status: 'bad_response' });
  }
}

export function httpError(label, status) {
  if (status === 401 || status === 403) {
    return new ProviderError(`${label}: HTTP ${status}, the credentials were refused`, {
      status: 'auth',
      retryable: false,
      countsAgainstProvider: false,
    });
  }
  if (status === 402) {
    return new ProviderError(`${label}: HTTP 402, the account has no credit`, {
      status: 'no_credit',
      retryable: false,
      countsAgainstProvider: false,
    });
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new ProviderError(`${label}: HTTP ${status}`, {
      status: status === 429 ? 'rate_limited' : `http_${status}`,
    });
  }
  return new ProviderError(`${label}: HTTP ${status}, the request was refused`, {
    status: `http_${status}`,
    retryable: false,
    countsAgainstProvider: false,
  });
}

/** `https://www.example.com/a` -> `example.com`. Null for anything that isn't an http(s) URL. */
export function domainOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** Keep the first occurrence of each URL, number them 1..n in that order, clip long fields. */
export function dedupeSources(sources) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    const url = typeof s?.url === 'string' ? s.url.trim() : '';
    if (!url || url.length > 2048 || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      domain: s.domain
        ? String(s.domain)
            .toLowerCase()
            .replace(/^www\./, '')
            .slice(0, 255)
        : domainOf(url),
      title: clip(s.title, 1000),
      snippet: clip(s.snippet, 4000),
      position: out.length + 1,
    });
  }
  return out;
}

export const clip = (text, max) =>
  typeof text === 'string' && text.trim() ? text.trim().slice(0, max) : null;
