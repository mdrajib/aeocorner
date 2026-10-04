import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import zlib from 'node:zlib';
import { createHostPacer } from '../../src/crawler/pacer.js';
import { CRAWLER_USER_AGENT } from '../../src/crawler/safe-fetch.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';

/**
 * The safe fetcher against real sockets (BUILD_PLAN Phase 4). The unit tests use a pretend network; these show
 * the same guard holding when bytes really move: compression, size and time limits, TLS, and a redirect chain
 * that ends somewhere it must not go.
 */

const servers = [];
const serve = async (handler, options) => {
  const server = await startServer(handler, options);
  servers.push(server);
  return server;
};
after(() => Promise.all(servers.map((s) => s.close())));

const html = (res, body, headers = {}) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
};

async function refused(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `${err.code}: ${err.message}`);
    return true;
  });
}

describe('a plain fetch', () => {
  test('returns the page, and sends who we are and nothing we should not', async () => {
    const site = await serve((req, res) => html(res, '<h1>Hello</h1>', { 'x-extra': '1' }));
    const fetcher = testFetcher({ ports: [site.port] });
    const res = await fetcher.fetch(`${site.origin()}/about?x=1`);

    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '<h1>Hello</h1>');
    assert.match(res.contentType, /text\/html/);
    assert.equal(res.headers['x-extra'], '1');
    assert.equal(res.address, '127.0.0.1');

    const seen = site.requests[0];
    assert.equal(seen.url, '/about?x=1');
    assert.equal(seen.headers['user-agent'], CRAWLER_USER_AGENT);
    assert.equal(
      seen.headers.host,
      `fixture.test:${site.port}`,
      'the Host header is the NAME, not the address',
    );
    assert.match(seen.headers['accept-encoding'], /gzip/);
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers.authorization, undefined);
  });

  test('4xx and 5xx answers are returned, not thrown', async () => {
    const site = await serve((req, res) => {
      res.writeHead(req.url === '/gone' ? 404 : 503, { 'content-type': 'text/plain' });
      res.end('nope');
    });
    const fetcher = testFetcher({ ports: [site.port] });
    assert.equal((await fetcher.fetch(`${site.origin()}/gone`)).status, 404);
    assert.equal((await fetcher.fetch(`${site.origin()}/busy`)).status, 503);
  });

  test('HEAD returns headers and no body', async () => {
    const site = await serve((req, res) => html(res, 'body'));
    const res = await testFetcher({ ports: [site.port] }).fetch(site.origin(), { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    assert.equal(site.requests[0].method, 'HEAD');
  });

  test('a connection that is refused is reported as such', async () => {
    const site = await serve((req, res) => res.end());
    const port = site.port;
    await site.close();
    await refused(
      testFetcher({ ports: [port] }).fetch(`http://fixture.test:${port}/`),
      'connect_failed',
    );
  });
});

describe('compression', () => {
  const body = '<p>' + 'compress me '.repeat(500) + '</p>';

  for (const [name, encode] of [
    ['gzip', zlib.gzipSync],
    ['deflate', zlib.deflateSync],
    ['br', zlib.brotliCompressSync],
  ]) {
    test(`${name} is decoded`, async () => {
      const site = await serve((req, res) =>
        html(res, encode(Buffer.from(body)), { 'content-encoding': name }),
      );
      const res = await testFetcher({ ports: [site.port] }).fetch(site.origin());
      assert.equal(res.body.toString(), body);
    });
  }

  test('an encoding we do not know is refused rather than mistaken for text', async () => {
    const site = await serve((req, res) => html(res, 'x', { 'content-encoding': 'compress' }));
    await refused(testFetcher({ ports: [site.port] }).fetch(site.origin()), 'unsupported_encoding');
  });

  test('a corrupt body is an error', async () => {
    const site = await serve((req, res) =>
      html(res, Buffer.from('this is not gzip'), { 'content-encoding': 'gzip' }),
    );
    await refused(testFetcher({ ports: [site.port] }).fetch(site.origin()), 'network_error');
  });
});

describe('size limits', () => {
  test('a page over the limit is refused, whether or not the server says how big it is', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 'a');
    const site = await serve((req, res) => {
      if (req.url === '/declared') return html(res, big); // sends Content-Length
      res.writeHead(200, { 'content-type': 'text/html' }); // chunked, no length
      res.write(big);
      res.end(big);
    });
    const fetcher = testFetcher({ ports: [site.port] });
    await refused(
      fetcher.fetch(`${site.origin()}/declared`, { maxBytes: 1024 * 1024 }),
      'too_large',
    );
    await refused(
      fetcher.fetch(`${site.origin()}/chunked`, { maxBytes: 3 * 1024 * 1024 }),
      'too_large',
    );
    assert.equal(
      (await fetcher.fetch(`${site.origin()}/declared`, { maxBytes: 3 * 1024 * 1024 })).status,
      200,
    );
  });

  test('a small download that expands to hundreds of megabytes is stopped at the limit (zip bomb)', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(300 * 1024 * 1024)); // 300 MB of zeros
    assert.ok(bomb.length < 1024 * 1024, `the bomb itself is only ${bomb.length} bytes`);
    const site = await serve((req, res) => html(res, bomb, { 'content-encoding': 'gzip' }));
    const before = process.memoryUsage().rss;
    await refused(testFetcher({ ports: [site.port] }).fetch(site.origin()), 'too_large');
    assert.ok(process.memoryUsage().rss - before < 150 * 1024 * 1024, 'memory stayed bounded');
  });

  test('the default limit is 5 MB', async () => {
    const site = await serve((req, res) => html(res, Buffer.alloc(5 * 1024 * 1024 + 1, 'a')));
    await refused(testFetcher({ ports: [site.port] }).fetch(site.origin()), 'too_large');
  });
});

describe('time limits', () => {
  test('a server that accepts the connection and never answers', async () => {
    const site = await serve(() => {});
    await refused(
      testFetcher({ ports: [site.port] }).fetch(site.origin(), { timeoutMs: 250 }),
      'timeout',
    );
  });

  test('a server that starts answering and then drips forever', async () => {
    const timers = [];
    const site = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      timers.push(setInterval(() => res.write('x'), 20));
    });
    const started = Date.now();
    await refused(
      testFetcher({ ports: [site.port] }).fetch(site.origin(), { timeoutMs: 300 }),
      'timeout',
    );
    assert.ok(Date.now() - started < 10_000, 'gave up on time');
    timers.forEach(clearInterval);
  });

  test('the budget covers the whole redirect chain, not each hop', async () => {
    const site = await serve((req, res) => {
      const hop = Number(req.url.slice(1)) || 0;
      setTimeout(() => {
        res.writeHead(302, { location: `/${hop + 1}` });
        res.end();
      }, 120);
    });
    const started = Date.now();
    await refused(
      testFetcher({ ports: [site.port] }).fetch(`${site.origin()}/0`, { timeoutMs: 300 }),
      'timeout',
    );
    assert.ok(Date.now() - started < 10_000);
  });
});

describe('redirects across real servers', () => {
  test('a normal chain is followed to the end', async () => {
    const last = await serve((req, res) => html(res, 'the end'));
    const middle = await serve((req, res) => {
      res.writeHead(302, { location: `${last.origin('b.test')}/final` });
      res.end();
    });
    const first = await serve((req, res) => {
      res.writeHead(301, { location: `${middle.origin('a.test')}/middle` });
      res.end();
    });
    const fetcher = testFetcher({ ports: [first.port, middle.port, last.port] });
    const res = await fetcher.fetch(`${first.origin('start.test')}/`);
    assert.equal(res.body.toString(), 'the end');
    assert.equal(res.redirects.length, 2);
    assert.equal(last.requests[0].headers.host, `b.test:${last.port}`);
  });

  test('a redirect to a service on this machine that is not allowed is never requested', async () => {
    const secret = await serve((req, res) => html(res, 'internal admin panel'));
    const front = await serve((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${secret.port}/admin` });
      res.end();
    });
    const fetcher = testFetcher({ ports: [front.port] }); // the secret's port is NOT allowed
    await refused(fetcher.fetch(`${front.origin()}/`), 'blocked_address');
    assert.equal(front.requests.length, 1);
    assert.equal(secret.requests.length, 0, 'the internal service saw nothing');
  });

  test('a redirect to the cloud metadata address is refused before any connection', async () => {
    const front = await serve((req, res) => {
      res.writeHead(302, {
        location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      });
      res.end();
    });
    await assert.rejects(
      testFetcher({ ports: [front.port] }).fetch(`${front.origin()}/`),
      (err) => {
        assert.equal(err.code, 'blocked_address');
        assert.equal(err.reason, 'cloud-metadata');
        return true;
      },
    );
  });

  test('a redirect to a name that DNS points at a private address is refused', async () => {
    const secret = await serve((req, res) => html(res, 'internal'));
    const front = await serve((req, res) => {
      res.writeHead(307, { location: `http://intranet.test:${secret.port}/` });
      res.end();
    });
    const fetcher = testFetcher({
      ports: [front.port, secret.port],
      dns: { 'intranet.test': ['10.1.2.3'] },
    });
    await refused(fetcher.fetch(`${front.origin()}/`), 'blocked_address');
    assert.equal(secret.requests.length, 0);
  });

  test('a name that points at private address is refused even when the fixture port is allowed for 127.0.0.1', async () => {
    const site = await serve((req, res) => html(res, 'x'));
    const fetcher = testFetcher({ ports: [site.port], dns: { 'private.test': ['192.168.1.20'] } });
    await refused(fetcher.fetch(`http://private.test:${site.port}/`), 'blocked_address');
    assert.equal(site.requests.length, 0);
  });
});

describe('HTTPS', () => {
  test('the certificate is checked against the name in the URL, though we connect to an address', async () => {
    const site = await serve((req, res) => html(res, 'secure hello'), { secure: true });
    const fetcher = testFetcher({ ports: [site.port] });
    const res = await fetcher.fetch(`${site.origin('fixture.test')}/`);
    assert.equal(res.body.toString(), 'secure hello');
    // Covered by the wildcard in the same certificate:
    assert.equal((await fetcher.fetch(`${site.origin('www.fixture.test')}/`)).status, 200);
  });

  test('a certificate that is not valid for that name is refused', async () => {
    const site = await serve((req, res) => html(res, 'x'), { secure: true });
    await refused(
      testFetcher({ ports: [site.port] }).fetch(`${site.origin('someone-else.test')}/`),
      'tls_failed',
    );
  });

  test('a self-signed certificate nobody trusts is refused', async () => {
    const site = await serve((req, res) => html(res, 'x'), { secure: true });
    const untrusting = testFetcher({ ports: [site.port], tls: {} });
    await refused(untrusting.fetch(`${site.origin()}/`), 'tls_failed');
  });
});

describe('skipping bodies we do not want', () => {
  test('a body whose type is not wanted is not read', async () => {
    const site = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.alloc(1024 * 1024, 'p'));
    });
    const res = await testFetcher({ ports: [site.port] }).fetch(site.origin(), {
      bodyTypes: [/^text\/html/],
    });
    assert.equal(res.status, 200);
    assert.equal(res.bodySkipped, true);
    assert.equal(res.body.length, 0);
    assert.match(res.contentType, /pdf/);
  });
});

describe('politeness', () => {
  test('requests to one host are spread out, as the pacer says', async () => {
    const arrivals = [];
    const site = await serve((req, res) => {
      arrivals.push(Date.now());
      html(res, 'ok');
    });
    // Four requests, 250 ms apart at the earliest: they start at 0, 250, 500 and 750 ms. Unpaced they would all
    // arrive within a few milliseconds. Measuring the whole spread (not each gap) keeps the test steady on a
    // machine so busy that single arrivals wobble by tens of milliseconds.
    const pacer = createHostPacer({ maxConcurrent: 2, minGapMs: 250 });
    const fetcher = testFetcher({ ports: [site.port], pacer });
    await Promise.all([1, 2, 3, 4].map((n) => fetcher.fetch(`${site.origin()}/${n}`)));
    arrivals.sort((a, b) => a - b);
    const spread = arrivals.at(-1) - arrivals[0];
    assert.equal(arrivals.length, 4);
    assert.ok(spread >= 500, `the four arrived within ${spread} ms`);
  });
});

describe('requests that change a site or carry a credential (the WordPress connector)', () => {
  test('a POST sends its body and headers, and the answer comes back', async () => {
    let received;
    const site = await serve((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received = Buffer.concat(chunks).toString();
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"id":7}');
      });
    });
    const fetcher = testFetcher({ ports: [site.port] });
    const res = await fetcher.fetch(`${site.origin()}/wp-json/wp/v2/posts`, {
      method: 'POST',
      body: '{"title":"Hi ✓"}',
      headers: { 'content-type': 'application/json', authorization: 'Basic abc' },
      accept: ['application/json'],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.toString(), '{"id":7}');
    assert.equal(received, '{"title":"Hi ✓"}');
    assert.equal(site.requests[0].method, 'POST');
    assert.equal(site.requests[0].headers.authorization, 'Basic abc');
    assert.equal(
      site.requests[0].headers['content-length'],
      String(Buffer.byteLength('{"title":"Hi ✓"}')),
    );
  });

  test('a request with a credential is never redirected, so the credential cannot follow', async () => {
    const elsewhere = await serve((req, res) => html(res, 'should not be fetched'));
    const site = await serve((req, res) => {
      res.writeHead(302, { location: `${elsewhere.origin('other.test')}/steal` });
      res.end();
    });
    const fetcher = testFetcher({ ports: [site.port, elsewhere.port] });
    const authed = await fetcher.fetch(`${site.origin()}/x`, {
      headers: { authorization: 'Basic abc' },
    });
    assert.equal(authed.status, 302);
    assert.equal(elsewhere.requests.length, 0, 'the other host was never contacted');
    const signed = await fetcher.fetch(`${site.origin()}/x`, {
      headers: { 'X-AEO-Signature': 'x' },
    });
    assert.equal(signed.status, 302);
    const write = await fetcher.fetch(`${site.origin()}/x`, { method: 'PUT', body: '{}' });
    assert.equal(write.status, 302);
    assert.equal(elsewhere.requests.length, 0);
    const plain = await fetcher.fetch(`${site.origin()}/x`);
    assert.equal(plain.status, 200, 'a plain read still follows redirects as before');
    assert.equal(elsewhere.requests.length, 1);
  });

  test('the guard still applies to writes: a private address is refused before anything is sent', async () => {
    const fetcher = testFetcher({ dns: { 'wp.test': ['10.0.0.5'] } });
    await refused(
      fetcher.fetch('http://wp.test/wp-json', {
        method: 'POST',
        body: 'x',
        headers: { authorization: 'Basic abc' },
      }),
      'blocked_address',
    );
  });

  test('a method that is not a read or a write is treated as a read, and a body on a read is ignored', async () => {
    const site = await serve((req, res) => html(res, 'ok'));
    const fetcher = testFetcher({ ports: [site.port] });
    await fetcher.fetch(`${site.origin()}/a`, { method: 'TRACE', body: 'x' });
    await fetcher.fetch(`${site.origin()}/b`, { body: 'x' });
    assert.deepEqual(
      site.requests.map((r) => r.method),
      ['GET', 'GET'],
    );
    assert.equal(site.requests[1].headers['content-length'], undefined);
  });
});
