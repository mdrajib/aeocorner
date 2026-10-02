import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createSafeFetcher } from '../../src/crawler/safe-fetch.js';

/**
 * A tiny web server on this machine for the crawler's tests: a real socket, a real HTTP exchange.
 *
 * `handler(req, res)` is plain Node. Every request is recorded in `requests`, so a test can assert what the
 * crawler sent, and, for the security tests, that something was NEVER requested.
 */
export async function startServer(handler, { secure = false } = {}) {
  const requests = [];
  const wrapped = (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  };
  const server = secure
    ? https.createServer(
        {
          cert: readFileSync(new URL('../fixtures/tls/test-only-cert.pem', import.meta.url)),
          key: readFileSync(new URL('../fixtures/tls/test-only-key.pem', import.meta.url)),
        },
        wrapped,
      )
    : http.createServer(wrapped);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    origin: (host = 'fixture.test') => `${secure ? 'https' : 'http'}://${host}:${port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A fetcher for tests: names ending in `.test` resolve to this machine, and ONLY the fixture ports are allowed
 * through the guard (on 127.0.0.1, nothing else). `dns` adds or overrides names, for example to make a name
 * resolve to a private address and prove the guard refuses it.
 */
export function testFetcher({ ports, dns = {}, ...options } = {}) {
  const lookups = [];
  const fetcher = createSafeFetcher({
    resolve: async (host) => {
      lookups.push(host);
      const addresses = dns[host] ?? (host.endsWith('.test') ? ['127.0.0.1'] : null);
      if (!addresses) throw new Error(`test DNS has no answer for ${host}`);
      return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    exceptions: ports?.length ? [{ address: '127.0.0.1', ports }] : [],
    tls: { ca: readFileSync(new URL('../fixtures/tls/test-only-cert.pem', import.meta.url)) },
    ...options,
  });
  return Object.assign(fetcher, { lookups });
}
