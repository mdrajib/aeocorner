import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CRAWLER_USER_AGENT,
  createSafeFetcher,
  FETCH_LIMITS,
  FetchError,
  isGuardError,
} from './safe-fetch.js';

/**
 * A small pretend internet: names that resolve to addresses, and pages those addresses serve. The fetcher gets
 * a fake resolver and a fake transport, so these tests show exactly what it would have connected to, and prove
 * that for every refused URL it never connected at all.
 */
function world({ dns = {}, pages = {}, ...fetcherOptions } = {}) {
  const calls = { resolve: [], transport: [] };
  const resolve = async (host) => {
    calls.resolve.push(host);
    const answers = dns[host];
    if (!answers) throw new FetchError('dns_failed', `no such host ${host}`);
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const transport = async (request) => {
    calls.transport.push({
      url: request.url.href,
      address: request.address,
      headers: request.headers,
    });
    const page = pages[request.url.href];
    if (typeof page === 'function') return page(request);
    if (!page) return { status: 404, headers: {}, body: Buffer.from('not found') };
    return {
      status: page.status ?? 200,
      headers: page.headers ?? {},
      body: Buffer.from(page.body ?? ''),
    };
  };
  return { fetcher: createSafeFetcher({ resolve, transport, ...fetcherOptions }), calls };
}

const redirect = (to, status = 301) => ({ status, headers: { location: to } });
const PUBLIC = '93.184.216.34';

async function refused(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof FetchError, `expected a FetchError, got ${err}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

describe('addresses written out in the URL', () => {
  const FORBIDDEN = [
    'http://127.0.0.1/',
    'http://127.0.0.1:80/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://10.255.255.255/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://100.100.100.200/',
    'http://0.0.0.0/',
    // The same loopback address, spelled the ways attackers spell it:
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fd00:ec2::254]/',
    'https://[fe80::1]/',
  ];

  for (const url of FORBIDDEN) {
    test(`refuses ${url} without any network traffic`, async () => {
      const { fetcher, calls } = world();
      await refused(fetcher.fetch(url), 'blocked_address');
      assert.deepEqual(calls.resolve, [], 'no name lookup either');
      assert.deepEqual(calls.transport, [], 'and no connection');
    });
  }

  test('a public address is fetched as given', async () => {
    const { fetcher, calls } = world({ pages: { [`http://${PUBLIC}/`]: { body: 'hi' } } });
    const res = await fetcher.fetch(`http://${PUBLIC}/`);
    assert.equal(res.status, 200);
    assert.equal(calls.transport[0].address, PUBLIC);
  });
});

describe('names that point inside the network', () => {
  for (const url of [
    'http://localhost/',
    'http://localhost:8080/',
    'http://app.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    test(`refuses ${url} by name, before DNS`, async () => {
      const { fetcher, calls } = world();
      await refused(fetcher.fetch(url), 'blocked_host');
      assert.deepEqual(calls.resolve, []);
      assert.deepEqual(calls.transport, []);
    });
  }

  test('refuses a public-looking name whose DNS answer is a private address', async () => {
    for (const answer of [
      '10.0.0.5',
      '192.168.0.10',
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
    ]) {
      const { fetcher, calls } = world({ dns: { 'sneaky.test': [answer] } });
      await refused(fetcher.fetch('http://sneaky.test/'), 'blocked_address');
      assert.deepEqual(calls.transport, [], answer);
    }
  });

  test('refuses a name when ANY of its addresses is private, even if others are public', async () => {
    const { fetcher, calls } = world({ dns: { 'mixed.test': [PUBLIC, '10.0.0.5'] } });
    await refused(fetcher.fetch('http://mixed.test/'), 'blocked_address');
    assert.deepEqual(calls.transport, []);
  });

  test('connects to the address it checked, and looks the name up only once (no DNS rebinding)', async () => {
    let lookups = 0;
    const calls = [];
    const fetcher = createSafeFetcher({
      // A hostile DNS server: the first answer is public, every later answer is the metadata service.
      resolve: async () => [{ address: lookups++ === 0 ? PUBLIC : '169.254.169.254', family: 4 }],
      transport: async (request) => {
        calls.push(request.address);
        return { status: 200, headers: {}, body: Buffer.from('ok') };
      },
    });
    await fetcher.fetch('http://rebind.test/');
    assert.equal(lookups, 1);
    assert.deepEqual(calls, [PUBLIC]);
  });

  test('a name that does not resolve is reported, not guessed at', async () => {
    const { fetcher } = world();
    await refused(fetcher.fetch('http://nowhere.test/'), 'dns_failed');
  });
});

describe('what a URL may say', () => {
  test('only http and https', async () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.test/',
      'gopher://example.test:70/',
      'data:text/html,hi',
      'javascript:alert(1)',
      'ws://example.test/',
    ]) {
      const { fetcher, calls } = world({ dns: { 'example.test': [PUBLIC] } });
      await refused(fetcher.fetch(url), 'blocked_scheme');
      assert.deepEqual(calls.transport, [], url);
    }
  });

  test('no user name or password in the address', async () => {
    for (const url of ['http://user:pass@example.test/', 'https://admin@example.test/']) {
      const { fetcher } = world({ dns: { 'example.test': [PUBLIC] } });
      await refused(fetcher.fetch(url), 'blocked_credentials');
    }
  });

  test('only ports 80 and 443', async () => {
    for (const port of [21, 22, 25, 3306, 5432, 6379, 8080, 8443, 9200]) {
      const { fetcher, calls } = world({ dns: { 'example.test': [PUBLIC] } });
      await refused(fetcher.fetch(`http://example.test:${port}/`), 'blocked_port');
      assert.deepEqual(calls.transport, [], `port ${port}`);
    }
    const { fetcher } = world({
      dns: { 'example.test': [PUBLIC] },
      pages: { 'http://example.test:443/': { body: 'ok' } },
    });
    assert.equal((await fetcher.fetch('http://example.test:443/')).status, 200);
  });

  test('nonsense and over-long addresses are refused', async () => {
    const { fetcher } = world();
    await refused(fetcher.fetch('not a url'), 'bad_url');
    await refused(fetcher.fetch(`http://example.test/${'a'.repeat(2100)}`), 'bad_url');
  });
});

describe('redirects are checked at every hop', () => {
  test('a public page that redirects to the cloud metadata address is stopped there', async () => {
    const { fetcher, calls } = world({
      dns: { 'public.test': [PUBLIC] },
      pages: { 'http://public.test/': redirect('http://169.254.169.254/latest/meta-data/iam/') },
    });
    await assert.rejects(fetcher.fetch('http://public.test/'), (err) => {
      assert.equal(err.code, 'blocked_address');
      assert.equal(err.reason, 'cloud-metadata');
      assert.equal(err.redirects[0].to, 'http://169.254.169.254/latest/meta-data/iam/');
      assert.ok(isGuardError(err));
      return true;
    });
    assert.deepEqual(
      calls.transport.map((c) => c.url),
      ['http://public.test/'],
      'only the first, public, hop was ever requested',
    );
  });

  test('a chain of redirects whose last link is a private network is stopped', async () => {
    const { fetcher, calls } = world({
      dns: { 'a.test': [PUBLIC], 'b.test': [PUBLIC], 'c.test': ['192.168.0.7'] },
      pages: {
        'http://a.test/': redirect('https://b.test/step'),
        'https://b.test/step': redirect('http://c.test/admin', 302),
      },
    });
    await refused(fetcher.fetch('http://a.test/'), 'blocked_address');
    assert.deepEqual(
      calls.transport.map((c) => c.url),
      ['http://a.test/', 'https://b.test/step'],
    );
  });

  test('every way a redirect can point at something forbidden', async () => {
    const targets = [
      ['http://127.0.0.1/', 'blocked_address'],
      ['//127.0.0.1/admin', 'blocked_address'], // scheme-relative, resolved against the page's scheme
      ['http://[::1]:80/', 'blocked_address'],
      ['http://2130706433/', 'blocked_address'],
      ['http://localhost/', 'blocked_host'],
      ['file:///etc/passwd', 'blocked_scheme'],
      ['gopher://public.test/', 'blocked_scheme'],
      ['http://public.test:6379/', 'blocked_port'],
      ['http://user:pw@public.test/', 'blocked_credentials'],
    ];
    for (const [target, code] of targets) {
      const { fetcher, calls } = world({
        dns: { 'public.test': [PUBLIC] },
        pages: { 'http://public.test/': redirect(target) },
      });
      await refused(fetcher.fetch('http://public.test/'), code);
      assert.equal(calls.transport.length, 1, `${target}: nothing was fetched after the redirect`);
    }
  });

  test('relative redirects are followed, and the chain is reported', async () => {
    const { fetcher } = world({
      dns: { 'site.test': [PUBLIC] },
      pages: {
        'http://site.test/old': redirect('/new', 301),
        'http://site.test/new': redirect('final?x=1', 302),
        'http://site.test/final?x=1': { body: 'done' },
      },
    });
    const res = await fetcher.fetch('http://site.test/old');
    assert.equal(res.url, 'http://site.test/final?x=1');
    assert.equal(res.body.toString(), 'done');
    assert.deepEqual(
      res.redirects.map((r) => [r.status, r.to]),
      [
        [301, 'http://site.test/new'],
        [302, 'http://site.test/final?x=1'],
      ],
    );
  });

  test('five redirects are followed; the sixth is an error even if the page after it is fine', async () => {
    // /0 -> /1 -> ... and the page at /N is fine. Five redirects land on /5; six would land on /6.
    const chain = (redirectsBeforeTheEnd) => {
      const pages = {};
      for (let i = 0; i < redirectsBeforeTheEnd; i += 1) {
        pages[`http://loop.test/${i}`] = redirect(`/${i + 1}`);
      }
      pages[`http://loop.test/${redirectsBeforeTheEnd}`] = { body: 'arrived' };
      return world({ dns: { 'loop.test': [PUBLIC] }, pages }).fetcher;
    };

    const five = await chain(5).fetch('http://loop.test/0');
    assert.equal(five.body.toString(), 'arrived');
    assert.equal(five.redirects.length, 5);

    await refused(chain(6).fetch('http://loop.test/0'), 'too_many_redirects');
  });

  test('a redirect that points back at itself ends at the limit', async () => {
    const { fetcher } = world({
      dns: { 'loop.test': [PUBLIC] },
      pages: { 'http://loop.test/': redirect('/') },
    });
    await refused(fetcher.fetch('http://loop.test/'), 'too_many_redirects');
  });

  test('a redirect without a Location header is just a response', async () => {
    const { fetcher } = world({
      dns: { 'odd.test': [PUBLIC] },
      pages: { 'http://odd.test/': { status: 302, headers: {} } },
    });
    assert.equal((await fetcher.fetch('http://odd.test/')).status, 302);
  });

  test('with followRedirects off the redirect itself is returned (the renderer handles hops itself)', async () => {
    const { fetcher, calls } = world({
      dns: { 'site.test': [PUBLIC] },
      pages: { 'http://site.test/': redirect('/next') },
    });
    const res = await fetcher.fetch('http://site.test/', { followRedirects: false });
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/next');
    assert.equal(calls.transport.length, 1);
  });
});

describe('limits and failures', () => {
  test('the defaults are the ones MVP §11.2 names', () => {
    assert.equal(FETCH_LIMITS.maxBytes, 5 * 1024 * 1024);
    assert.equal(FETCH_LIMITS.timeoutMs, 15_000);
    assert.equal(FETCH_LIMITS.maxRedirects, 5);
    assert.equal(CRAWLER_USER_AGENT, 'AEOCornerBot/1.0 (+https://aeocorner.com/bot)');
  });

  test('a site that never answers times out', async () => {
    const { fetcher } = world({
      dns: { 'slow.test': [PUBLIC] },
      pages: {
        'http://slow.test/': (request) =>
          new Promise((_, reject) =>
            request.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            ),
          ),
      },
    });
    await refused(fetcher.fetch('http://slow.test/', { timeoutMs: 40 }), 'timeout');
  });

  test('a name lookup that never finishes also times out', async () => {
    const fetcher = createSafeFetcher({
      resolve: () => new Promise(() => {}),
      transport: async () => {},
    });
    await refused(fetcher.fetch('http://hangs.test/', { timeoutMs: 40 }), 'timeout');
  });

  test('if the first address will not connect, the next is tried', async () => {
    const tried = [];
    const fetcher = createSafeFetcher({
      resolve: async () => [
        { address: '93.184.216.1', family: 4 },
        { address: '93.184.216.2', family: 4 },
      ],
      transport: async (request) => {
        tried.push(request.address);
        if (request.address.endsWith('.1')) throw new FetchError('connect_failed', 'refused');
        return { status: 200, headers: {}, body: Buffer.from('ok') };
      },
    });
    const res = await fetcher.fetch('http://two.test/');
    assert.deepEqual(tried, ['93.184.216.1', '93.184.216.2']);
    assert.equal(res.address, '93.184.216.2');
  });

  test('a certificate problem is not retried on another address', async () => {
    const tried = [];
    const fetcher = createSafeFetcher({
      resolve: async () => [
        { address: '93.184.216.1', family: 4 },
        { address: '93.184.216.2', family: 4 },
      ],
      transport: async (request) => {
        tried.push(request.address);
        throw new FetchError('tls_failed', 'bad certificate');
      },
    });
    await refused(fetcher.fetch('https://two.test/'), 'tls_failed');
    assert.equal(tried.length, 1);
  });

  test('every connection is recorded, so a scan can prove it never touched a private address', async () => {
    const { fetcher } = world({
      dns: { 'a.test': [PUBLIC], 'b.test': ['93.184.216.99'] },
      pages: { 'http://a.test/': redirect('http://b.test/x'), 'http://b.test/x': { body: 'ok' } },
    });
    const res = await fetcher.fetch('http://a.test/');
    assert.deepEqual(res.connections, [
      { host: 'a.test', address: PUBLIC, port: 80 },
      { host: 'b.test', address: '93.184.216.99', port: 80 },
    ]);
  });
});

describe('what is sent', () => {
  test('the crawler identifies itself and asks for compressed pages', async () => {
    const { fetcher, calls } = world({
      dns: { 'site.test': [PUBLIC] },
      pages: { 'http://site.test/': { body: '' } },
    });
    await fetcher.fetch('http://site.test/');
    const headers = calls.transport[0].headers;
    assert.equal(headers['user-agent'], CRAWLER_USER_AGENT);
    assert.match(headers['accept-encoding'], /gzip/);
  });

  test('a caller can change the user agent and add headers, but not the Host header', async () => {
    const { fetcher, calls } = world({
      dns: { 'site.test': [PUBLIC] },
      pages: { 'http://site.test/': { body: '' } },
    });
    await fetcher.fetch('http://site.test/', {
      userAgent: 'SomeOtherBot/2.0',
      headers: { host: 'evil.example', referer: 'http://site.test/' },
    });
    const headers = calls.transport[0].headers;
    assert.equal(headers['user-agent'], 'SomeOtherBot/2.0');
    assert.equal(headers.referer, 'http://site.test/');
    assert.equal(headers.host, undefined);
  });

  test('every hop waits its turn at the politeness pacer, under that hop’s own host', async () => {
    const turns = [];
    const pacer = { run: async (host, fn) => (turns.push(host), fn()) };
    const { fetcher } = world({
      dns: { 'a.test': [PUBLIC], 'b.test': [PUBLIC] },
      pages: { 'http://a.test/': redirect('http://b.test/'), 'http://b.test/': { body: 'ok' } },
      pacer,
    });
    await fetcher.fetch('http://a.test/');
    assert.deepEqual(turns, ['a.test', 'b.test']);
  });
});

describe('the test-only exceptions', () => {
  const dns = { 'fixture.test': ['127.0.0.1'], 'other.test': ['10.0.0.1'] };
  const exceptions = [{ address: '127.0.0.1', ports: [4567] }];

  test('allow one address on one port, and nothing else', async () => {
    const { fetcher } = world({
      dns,
      exceptions,
      pages: { 'http://fixture.test:4567/': { body: 'fixture' } },
    });
    assert.equal((await fetcher.fetch('http://fixture.test:4567/')).body.toString(), 'fixture');
    await refused(fetcher.fetch('http://fixture.test:4568/'), 'blocked_address'); // wrong port
    await refused(fetcher.fetch('http://other.test:4567/'), 'blocked_address'); // wrong address
    await refused(fetcher.fetch('http://169.254.169.254:4567/'), 'blocked_address');
  });

  test('a fetcher built without them refuses the same fixture', async () => {
    const { fetcher } = world({ dns });
    await refused(fetcher.fetch('http://fixture.test:4567/'), 'blocked_address');
    await refused(fetcher.fetch('http://127.0.0.1/'), 'blocked_address');
  });
});
