import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  createFileStore,
  createObjectStore,
  createSpacesStore,
  rawKey,
  sha256Hex,
  storeRaw,
} from '../../src/integrations/spaces.js';
import { loadConfig } from '../../src/lib/config.js';
import { startS3Stub } from '../helpers/s3-stub.js';

/**
 * Contract tests for object storage (BUILD_PLAN Phase 4: "a local S3-compatible stub"). The same behaviour is
 * required of the file store and of the Spaces store, and the Spaces store is exercised through the REAL AWS S3
 * client talking to a stand-in server, so the requests we build are the requests Spaces would receive.
 */

const cleanup = [];
after(async () => {
  for (const fn of cleanup) await fn();
});

async function fileStore(prefix = 'test/') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aeo-store-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return { store: createFileStore({ dir, prefix }), name: 'file store' };
}

async function spacesStore(prefix = 'test/') {
  const stub = await startS3Stub();
  cleanup.push(() => stub.close());
  const store = createSpacesStore({
    endpoint: stub.endpoint,
    region: stub.region,
    bucket: stub.bucket,
    accessKeyId: stub.accessKeyId,
    secretAccessKey: stub.secretAccessKey,
    prefix,
  });
  cleanup.push(() => store.close());
  return { store, stub, name: 'Spaces store (real S3 client, local stand-in server)' };
}

for (const make of [fileStore, spacesStore]) {
  const label = make === fileStore ? 'file store' : 'Spaces store';

  describe(`${label}: the same contract`, () => {
    test('what goes in comes out, byte for byte, with its type and metadata', async () => {
      const { store } = await make();
      const body = Buffer.from([0, 1, 2, 250, 251, 252, 255, 10, 13, 0]); // not text
      const { key, bytes } = await store.put({
        key: 'crawl/2026/10/abc.html',
        body,
        contentType: 'text/html',
        metadata: { 'source-url': 'https://acme.com/café?a=1&b=2', 'http-status': 200 },
      });
      assert.equal(key, 'test/crawl/2026/10/abc.html');
      assert.equal(bytes, body.length);

      const got = await store.get(key);
      assert.deepEqual(got.body, body);
      assert.equal(got.contentType, 'text/html');
      assert.equal(got.metadata['source-url'], 'https://acme.com/café?a=1&b=2');
      assert.equal(got.metadata['http-status'], '200');
    });

    test('a missing object is null, for get and head alike', async () => {
      const { store } = await make();
      assert.equal(await store.get('test/crawl/nothing.html'), null);
      assert.equal(await store.head('test/crawl/nothing.html'), null);
    });

    test('head reports size and type without the body', async () => {
      const { store } = await make();
      const { key } = await store.put({
        key: 'a/b.txt',
        body: Buffer.from('hello'),
        contentType: 'text/plain',
      });
      const head = await store.head(key);
      assert.equal(head.bytes, 5);
      assert.equal(head.contentType, 'text/plain');
    });

    test('delete removes the object, and deleting what is not there is not an error', async () => {
      const { store } = await make();
      const { key } = await store.put({ key: 'x.txt', body: Buffer.from('x') });
      await store.delete(key);
      assert.equal(await store.get(key), null);
      await store.delete(key);
    });

    test('a few megabytes round-trip', async () => {
      const { store } = await make();
      const big = Buffer.alloc(3 * 1024 * 1024, 'abcdefghij');
      const { key } = await store.put({ key: 'big.html', body: big, contentType: 'text/html' });
      assert.equal(sha256Hex((await store.get(key)).body), sha256Hex(big));
    });

    test('the same bytes stored twice are one object on one key', async () => {
      const { store, stub } = await make();
      const body = Buffer.from('<html>same</html>');
      const first = await storeRaw(store, {
        kind: 'html',
        body,
        contentType: 'text/html',
        url: 'https://acme.com/',
      });
      const second = await storeRaw(store, {
        kind: 'html',
        body,
        contentType: 'text/html',
        url: 'https://acme.com/',
      });
      assert.equal(first.key, second.key);
      assert.equal(first.sha256, sha256Hex(body));
      if (stub) assert.equal(stub.objects.size, 1);
    });
  });
}

describe('raw keys', () => {
  const at = new Date('2026-10-02T12:00:00Z');

  test('are named by date and by a hash of the bytes', () => {
    const body = Buffer.from('hello');
    assert.equal(rawKey({ kind: 'html', body, at }), `crawl/2026/10/${sha256Hex(body)}.html`);
    // AI answers have their own area, so their lifecycle rule can differ from crawled pages'.
    assert.equal(rawKey({ kind: 'answer', body, at }), `answers/2026/10/${sha256Hex(body)}.json`);
    assert.equal(
      sha256Hex(body),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  test('the same bytes always give the same key, and different bytes never do', () => {
    assert.equal(
      rawKey({ kind: 'html', body: Buffer.from('a'), at }),
      rawKey({ kind: 'html', body: Buffer.from('a'), at }),
    );
    assert.notEqual(
      rawKey({ kind: 'html', body: Buffer.from('a'), at }),
      rawKey({ kind: 'html', body: Buffer.from('b'), at }),
    );
  });

  test('the kind decides the extension; the month decides the folder (for the 13-month lifecycle rule)', () => {
    const body = Buffer.from('x');
    assert.match(rawKey({ kind: 'rendered', body, at }), /\.rendered\.html$/);
    assert.match(rawKey({ kind: 'robots', body, at }), /\.robots\.txt$/);
    assert.match(rawKey({ kind: 'sitemap', body, at }), /\.sitemap\.xml$/);
    assert.match(
      rawKey({ kind: 'html', body, at: new Date('2027-01-31T23:59:59Z') }),
      /^crawl\/2027\/01\//,
    );
  });

  test('an unknown kind is a bug, not a file', () => {
    assert.throws(() => rawKey({ kind: 'exe', body: Buffer.from('x') }), TypeError);
  });
});

describe('storeRaw', () => {
  test('records where the bytes came from, in a form that survives HTTP headers', async () => {
    const { store } = await spacesStore('dev/');
    const url = 'https://acme.com/страница?q=a b&x=é';
    const { key } = await storeRaw(store, {
      kind: 'html',
      body: Buffer.from('<p>hi</p>'),
      contentType: 'text/html; charset=utf-8',
      url,
      status: 200,
      fetchedAt: new Date('2026-10-02T12:00:00Z'),
    });
    assert.match(key, /^dev\/crawl\/2026\/10\/[0-9a-f]{64}\.html$/);
    const got = await store.get(key);
    assert.equal(got.metadata['source-url'], url);
    assert.equal(got.metadata['fetched-at'], '2026-10-02T12:00:00.000Z');
    assert.equal(got.metadata.sha256, sha256Hex(Buffer.from('<p>hi</p>')));
  });
});

describe('the Spaces store, as Spaces would see it', () => {
  test('sends signed requests to /<bucket>/<key> and does not use the checksum framing some S3 services reject', async () => {
    const { store, stub } = await spacesStore('dev/');
    await store.put({
      key: 'crawl/2026/10/a.html',
      body: Buffer.from('<p>x</p>'),
      contentType: 'text/html',
    });
    const put = stub.requests.find((r) => r.method === 'PUT');
    assert.equal(put.bucket, 'test-bucket');
    assert.equal(put.key, 'dev/crawl/2026/10/a.html');
    assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=TESTKEY\//);
    assert.doesNotMatch(String(put.headers['content-encoding'] ?? ''), /aws-chunked/);
    assert.equal(put.headers['x-amz-trailer'], undefined);
  });

  test('wrong credentials are an error, never "not found"', async () => {
    const stub = await startS3Stub();
    cleanup.push(() => stub.close());
    const store = createSpacesStore({
      endpoint: stub.endpoint,
      region: 'x',
      bucket: stub.bucket,
      accessKeyId: 'WRONG',
      secretAccessKey: 'nope',
    });
    cleanup.push(() => store.close());
    await assert.rejects(store.get('anything'));
    await assert.rejects(store.put({ key: 'a', body: Buffer.from('a') }));
  });

  test('a mistyped bucket name is an error too, not an empty store', async () => {
    const stub = await startS3Stub();
    cleanup.push(() => stub.close());
    const store = createSpacesStore({
      endpoint: stub.endpoint,
      region: 'x',
      bucket: 'no-such-bucket',
      accessKeyId: stub.accessKeyId,
      secretAccessKey: 'x',
    });
    cleanup.push(() => store.close());
    await assert.rejects(store.get('anything'), /NoSuchBucket|bucket/i);
  });
});

describe('the local file store', () => {
  test('refuses a key that climbs out of its folder', async () => {
    const { store } = await fileStore('');
    await assert.rejects(store.put({ key: '../escape.txt', body: Buffer.from('x') }), RangeError);
    await assert.rejects(store.get('../../etc/passwd'), RangeError);
    await assert.rejects(
      store.put({ key: 'a/../../escape.txt', body: Buffer.from('x') }),
      RangeError,
    );
  });
});

describe('choosing a store from the configuration', () => {
  test('Spaces keys give a Spaces store', async () => {
    const config = loadConfig({
      DO_SPACES_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
      DO_SPACES_BUCKET: 'aeo-corner-raw',
      DO_SPACES_KEY: 'k',
      DO_SPACES_SECRET: 's',
    });
    const store = createObjectStore(config);
    assert.equal(store.kind, 'spaces');
    assert.equal(store.bucket, 'aeo-corner-raw');
    store.close();
  });

  test('no keys in development gives local disk, with a warning', async () => {
    const warnings = [];
    const store = createObjectStore(loadConfig({}), {
      logger: { warn: (...args) => warnings.push(args) },
      localDir: path.join(os.tmpdir(), 'aeo-dev-store-unused'),
    });
    assert.equal(store.kind, 'file');
    assert.equal(warnings.length, 1);
  });

  test('no keys in production is a startup error, not a quiet write to one server’s disk', () => {
    const config = loadConfig({ NODE_ENV: 'production', APP_SECRET: 'x'.repeat(40) });
    assert.throws(() => createObjectStore(config), /Spaces\) must be configured in production/);
  });
});
