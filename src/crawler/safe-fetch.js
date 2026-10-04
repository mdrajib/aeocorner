import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { blockedHostname, classifyIp, isIpLiteral, unbracket } from './ip-guard.js';

/**
 * The only way the app fetches a URL that a person typed in (MVP §11.2, ADR-0005). The free audit fetches any
 * address a stranger gives it, so every request is checked BEFORE it is made, on the address we will really
 * connect to:
 *
 *   1. Only http and https, no `user:password@`, only ports 80 and 443.
 *   2. Resolve the name ONCE, refuse it if ANY answer is private, loopback, link-local, CGNAT or cloud metadata,
 *      then connect to that exact address (never to the name again), so a DNS answer that changes between the
 *      check and the connection can't send us somewhere else ("DNS rebinding").
 *   3. Follow redirects by hand, up to 5, and run all of the above again on every hop. A public page that
 *      redirects to http://169.254.169.254/ is stopped at the second step.
 *   4. Cap the time (15 s for the whole fetch), the size (5 MB AFTER decompression, so a zip bomb can't fill
 *      memory) and the number of redirects.
 *
 * The crawler never uses the environment's proxy settings and never sends cookies or credentials of its own. The one
 * exception is the WordPress connector, which passes an `authorization` or `x-aeo-*` header and (for writes) a body
 * to the customer's own site: a request that carries either is never redirected, so a credential can't follow a
 * redirect to another host, and writes go only to the address the customer gave (src/integrations/wordpress.js).
 */

export const CRAWLER_USER_AGENT = 'AEOCornerBot/1.0 (+https://aeocorner.com/bot)';

export const FETCH_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 5,
  /** If a name has several addresses and the first won't connect, try this many before giving up. */
  maxAddressesTried: 3,
});

const ALLOWED_PORTS = new Set([80, 443]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** `code` says what went wrong in a way code can branch on; `message` is for logs. */
export class FetchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    Object.assign(this, details);
  }
}

/** True for the failures that mean "the guard refused", as opposed to "the site didn't answer". */
export const isGuardError = (err) => err instanceof FetchError && err.code.startsWith('blocked_');

async function resolveWithSystemResolver(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map(({ address, family }) => ({ address, family }));
  } catch (err) {
    throw new FetchError(
      'dns_failed',
      `Could not resolve ${hostname} (${err.code ?? err.message})`,
    );
  }
}

const TLS_ERROR =
  /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|EPROTO|HOSTNAME_MISMATCH)/;
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EADDRNOTAVAIL',
  'ECONNABORTED',
]);

function describeNetworkError(err, signal) {
  if (err instanceof FetchError) return err;
  if (signal?.aborted) return new FetchError('timeout', 'The site took too long to answer');
  if (TLS_ERROR.test(err.code ?? '')) {
    return new FetchError('tls_failed', `The site's certificate was not accepted (${err.code})`);
  }
  if (CONNECT_ERRORS.has(err.code)) {
    return new FetchError('connect_failed', `Could not connect (${err.code})`);
  }
  return new FetchError('network_error', `The request failed (${err.code ?? err.message})`);
}

const DECODERS = {
  gzip: zlib.createGunzip,
  'x-gzip': zlib.createGunzip,
  deflate: zlib.createInflate,
  br: zlib.createBrotliDecompress,
};

/**
 * One request to one address, with TLS checked against the NAME (not the address). Resolves with the response
 * and its body, decompressed and capped. This is the only code that opens a socket.
 */
export function nodeTransport({
  url,
  address,
  family,
  method,
  headers,
  body = null,
  signal,
  maxBytes,
  bodyTypes,
  tls = {},
}) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const request = (secure ? https : http).request(
      {
        host: address,
        family,
        port: Number(url.port) || (secure ? 443 : 80),
        method,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...headers,
          host: url.host,
          ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
        agent: false,
        signal,
        ...(secure
          ? {
              // The certificate must be valid for the NAME in the URL even though we connect to an address.
              servername: isIpLiteral(url.hostname) ? undefined : url.hostname,
              ...tls,
            }
          : {}),
      },
      (res) => {
        const status = res.statusCode;
        const responseHeaders = Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]),
        );
        const done = (body, extra = {}) =>
          settle(resolve, { status, headers: responseHeaders, body, ...extra });
        const fail = (err) => {
          res.destroy();
          settle(reject, err);
        };

        // A redirect, an empty answer or a HEAD has nothing we want to read.
        if (
          method === 'HEAD' ||
          status === 204 ||
          status === 205 ||
          (status >= 300 && status < 400)
        ) {
          res.destroy();
          return done(Buffer.alloc(0));
        }

        const contentType = String(responseHeaders['content-type'] ?? '');
        if (bodyTypes && !bodyTypes.some((t) => t.test(contentType))) {
          res.destroy();
          return done(Buffer.alloc(0), { bodySkipped: true });
        }

        const encoding = String(responseHeaders['content-encoding'] ?? 'identity')
          .toLowerCase()
          .trim();
        const makeDecoder = DECODERS[encoding];
        if (encoding !== 'identity' && !makeDecoder) {
          return fail(
            new FetchError('unsupported_encoding', `Unsupported content-encoding: ${encoding}`),
          );
        }
        const declared = Number(responseHeaders['content-length']);
        if (encoding === 'identity' && declared > maxBytes) {
          return fail(new FetchError('too_large', `The page is larger than ${maxBytes} bytes`));
        }

        let source = res;
        if (makeDecoder) {
          source = makeDecoder();
          source.on('error', () =>
            fail(new FetchError('network_error', 'The response could not be decompressed')),
          );
          res.pipe(source);
        }

        const chunks = [];
        let size = 0;
        source.on('data', (chunk) => {
          size += chunk.length;
          // Counted after decompression: a few kilobytes of gzip can expand to gigabytes.
          if (size > maxBytes) {
            source.destroy();
            return fail(new FetchError('too_large', `The page is larger than ${maxBytes} bytes`));
          }
          chunks.push(chunk);
        });
        source.on('end', () => done(Buffer.concat(chunks)));
        res.on('error', (err) => fail(describeNetworkError(err, signal)));
        res.on('close', () => {
          if (!res.complete) fail(new FetchError('network_error', 'The connection closed early'));
        });
      },
    );
    request.on('error', (err) => settle(reject, describeNetworkError(err, signal)));
    request.end(body ?? undefined);
  });
}

/**
 * @param {object} [options]
 * @param {(hostname: string) => Promise<{address: string, family: 4|6}[]>} [options.resolve]   DNS (tests replace it)
 * @param {Function} [options.transport]   opens the connection (tests replace it)
 * @param {object} [options.pacer]         createHostPacer(): per-host politeness
 * @param {{address: string, ports: number[]}[]} [options.exceptions]
 *        Addresses the guard lets through ON THE NAMED PORTS ONLY. For tests that need a fixture server on this
 *        machine. Never set from configuration; production code constructs the fetcher without it.
 * @param {object} [options.tls]           extra TLS options (a test certificate authority)
 */
export function createSafeFetcher({
  resolve = resolveWithSystemResolver,
  transport = nodeTransport,
  pacer = null,
  userAgent = CRAWLER_USER_AGENT,
  limits = {},
  exceptions = [],
  tls = {},
  now = () => Date.now(),
} = {}) {
  const policy = { ...FETCH_LIMITS, ...limits };

  const excepted = (address, port) =>
    exceptions.some((e) => e.address === address && e.ports.includes(port));

  /** Parse and judge a URL on its own (scheme, credentials, name), before any network traffic. */
  function vet(input, base) {
    if (String(input).length > 2048) throw new FetchError('bad_url', 'The address is too long');
    let url;
    try {
      url = new URL(input, base);
    } catch {
      throw new FetchError('bad_url', 'Not a valid address');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new FetchError(
        'blocked_scheme',
        `Only http and https are fetched, not ${url.protocol}`,
      );
    }
    if (url.username || url.password) {
      throw new FetchError(
        'blocked_credentials',
        'Addresses with a user name or password are refused',
      );
    }
    if (!url.hostname) throw new FetchError('bad_url', 'The address has no host');
    const reason = !isIpLiteral(url.hostname) && blockedHostname(url.hostname);
    if (reason)
      throw new FetchError('blocked_host', `${url.hostname} is an internal name`, { reason });
    return url;
  }

  /** Resolve (once) and refuse anything that isn't a public address. Returns the addresses to connect to. */
  async function resolveAndJudge(url, port, signal) {
    const host = unbracket(url.hostname);
    let records;
    if (isIpLiteral(url.hostname)) {
      records = [{ address: host, family: host.includes(':') ? 6 : 4 }];
    } else {
      records = await raceAbort(resolve(host), signal);
    }
    if (!records.length) throw new FetchError('dns_failed', `${host} has no addresses`);

    for (const { address } of records) {
      const verdict = classifyIp(address);
      if (!verdict.allowed && !excepted(address, port)) {
        throw new FetchError(
          'blocked_address',
          `${host} points at a non-public address (${verdict.reason})`,
          {
            reason: verdict.reason,
            address,
          },
        );
      }
    }
    // Port 80/443 only, except where a test has allowed one fixture port on one address.
    const portOk = ALLOWED_PORTS.has(port) || records.every((r) => excepted(r.address, port));
    if (!portOk)
      throw new FetchError('blocked_port', `Port ${port} is not fetched (only 80 and 443)`);
    return records;
  }

  /**
   * Fetch a URL. Resolves with the final response, whatever its status; rejects with a FetchError when the
   * guard refuses or the site can't be reached.
   * @param {string} input
   * @param {object} [opts]
   * @param {string[]} [opts.accept]      media types in the Accept header (default: pages and XML)
   * @param {RegExp[]} [opts.bodyTypes]   read the body only when the content type matches one of these
   * @param {boolean} [opts.followRedirects]  default true; false returns the 3xx itself (the renderer does this)
   * @param {object} [opts.headers]       extra request headers (never `host`)
   */
  async function fetchUrl(input, opts = {}) {
    const maxBytes = opts.maxBytes ?? policy.maxBytes;
    const timeoutMs = opts.timeoutMs ?? policy.timeoutMs;
    const method = WRITE_METHODS.has(opts.method)
      ? opts.method
      : opts.method === 'HEAD'
        ? 'HEAD'
        : 'GET';
    const body = WRITE_METHODS.has(method) && opts.body != null ? opts.body : null;
    // A request that carries a credential, or changes something on the site, is never sent on to another address.
    const sensitive =
      WRITE_METHODS.has(method) ||
      Object.keys(opts.headers ?? {}).some((h) => /^(authorization|cookie|x-aeo-)/i.test(h));
    const followRedirects = sensitive ? false : (opts.followRedirects ?? true);
    const started = now();
    const redirects = [];
    const connections = [];
    let deadline = null;

    let url = vet(input);
    for (let hop = 0; ; hop += 1) {
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
      const host = url.hostname;
      const step = async () => {
        // The clock starts when the host's turn comes, not while we queue behind politeness delays.
        deadline ??= now() + timeoutMs;
        const signal = AbortSignal.timeout(Math.max(1, deadline - now()));
        const records = await resolveAndJudge(url, port, signal);
        let lastError;
        for (const { address, family } of records.slice(0, policy.maxAddressesTried)) {
          try {
            connections.push({ host, address, port });
            const response = await transport({
              url,
              address,
              family,
              method,
              headers: requestHeaders(userAgent, opts),
              body,
              signal,
              maxBytes,
              bodyTypes: opts.bodyTypes,
              tls,
            });
            return { response, address };
          } catch (err) {
            lastError = describeNetworkError(err, signal);
            if (lastError.code !== 'connect_failed') throw lastError;
          }
        }
        throw lastError;
      };
      let outcome;
      try {
        outcome = await (pacer ? pacer.run(host, step) : step());
      } catch (err) {
        // Say how far a redirect chain got before it was stopped.
        if (err instanceof FetchError) err.redirects ??= redirects;
        throw err;
      }
      const { response, address } = outcome;

      const location = response.headers.location;
      if (followRedirects && REDIRECT_STATUSES.has(response.status) && location) {
        if (hop >= policy.maxRedirects) {
          throw new FetchError('too_many_redirects', `More than ${policy.maxRedirects} redirects`, {
            redirects,
          });
        }
        let next;
        try {
          next = vet(String(location), url);
        } catch (err) {
          if (err instanceof FetchError) {
            err.message = `Redirected somewhere refused: ${err.message}`;
            err.redirects = redirects;
          }
          throw err;
        }
        redirects.push({ from: url.href, to: next.href, status: response.status });
        url = next;
        continue;
      }

      return {
        url: url.href,
        status: response.status,
        headers: response.headers,
        body: response.body,
        bodySkipped: response.bodySkipped === true,
        contentType: String(response.headers['content-type'] ?? ''),
        redirects,
        address,
        connections,
        ms: now() - started,
      };
    }
  }

  return { fetch: fetchUrl, vet, limits: policy, userAgent };
}

function requestHeaders(userAgent, opts) {
  // The Host header is always the URL's own host; a caller can't point the request at a different virtual host.
  const extra = Object.fromEntries(
    Object.entries(opts.headers ?? {})
      .map(([name, value]) => [name.toLowerCase(), value])
      .filter(([name]) => name !== 'host'),
  );
  return {
    'user-agent': opts.userAgent ?? userAgent,
    accept:
      opts.accept?.join(', ') ??
      'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en',
    connection: 'close',
    ...extra,
  };
}

/** Stop waiting for `promise` when the signal fires (DNS lookups can't be cancelled, but we can stop waiting). */
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new FetchError('timeout', 'The name lookup took too long'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
