import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import {
  createWordPressClient,
  normalizeSiteUrl,
  signRequest,
  verifySignature,
  WordPressError,
} from '../../src/integrations/wordpress.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';
import { startWordPressStub } from '../helpers/wordpress-stub.js';

const stubs = [];
const stub = async (options) => {
  const s = await startWordPressStub(options);
  stubs.push(s);
  return s;
};
after(() => Promise.all(stubs.map((s) => s.close())));

const SECRET = 'a'.repeat(64);
const clientFor = (s, extra = {}) =>
  createWordPressClient({
    fetcher: testFetcher({ ports: [s.port] }),
    siteUrl: s.siteUrl,
    username: s.username,
    appPassword: s.appPassword,
    ...extra,
  });
const rejectsWith = async (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof WordPressError, String(err));
    assert.equal(err.code, code, `${err.code}: ${err.message}`);
    return true;
  });

describe('signatures', () => {
  const base = {
    secret: SECRET,
    method: 'PUT',
    route: '/aeocorner/v1/schema',
    body: '{"a":1}',
    timestamp: 1_800_000_000,
    nonce: 'b'.repeat(32),
  };
  const headers = (h) => h;
  test('a signature verifies, and changing anything it covers breaks it', () => {
    const h = headers(signRequest(base));
    const ok = {
      secret: SECRET,
      headers: h,
      method: 'PUT',
      route: '/aeocorner/v1/schema',
      body: '{"a":1}',
      now: 1_800_000_010,
    };
    assert.deepEqual(verifySignature(ok), { ok: true });
    for (const change of [
      { method: 'POST' },
      { route: '/aeocorner/v1/meta' },
      { body: '{"a":2}' },
      { secret: 'c'.repeat(64) },
    ]) {
      assert.equal(
        verifySignature({ ...ok, ...change }).reason,
        'bad_signature',
        JSON.stringify(change),
      );
    }
    assert.equal(
      verifySignature({ ...ok, headers: { ...h, 'x-aeo-timestamp': '1800000001' } }).reason,
      'bad_signature',
    );
    assert.equal(
      verifySignature({ ...ok, headers: { ...h, 'x-aeo-nonce': 'c'.repeat(32) } }).reason,
      'bad_signature',
    );
  });
  test('a stale or future timestamp, a missing header and a malformed one are refused', () => {
    const h = signRequest(base);
    const ok = {
      secret: SECRET,
      headers: h,
      method: 'PUT',
      route: '/aeocorner/v1/schema',
      body: '{"a":1}',
    };
    assert.equal(verifySignature({ ...ok, now: 1_800_000_000 + 301 }).reason, 'stale');
    assert.equal(verifySignature({ ...ok, now: 1_800_000_000 - 301 }).reason, 'stale');
    assert.equal(verifySignature({ ...ok, now: 1_800_000_000 + 300 }).ok, true);
    assert.equal(verifySignature({ ...ok, headers: {}, now: 1_800_000_000 }).reason, 'missing');
    assert.equal(
      verifySignature({ ...ok, headers: { ...h, 'x-aeo-signature': 'zz' }, now: 1_800_000_000 })
        .reason,
      'bad_signature',
    );
    assert.equal(
      verifySignature({ ...ok, headers: { ...h, 'x-aeo-nonce': '../../' }, now: 1_800_000_000 })
        .reason,
      'bad_nonce',
    );
    assert.equal(
      verifySignature({ ...ok, headers: { ...h, 'x-aeo-timestamp': 'soon' }, now: 1_800_000_000 })
        .reason,
      'stale',
    );
  });
  test('a nonce is accepted once', () => {
    const seenNonces = new Set();
    const h = signRequest(base);
    const ok = {
      secret: SECRET,
      headers: h,
      method: 'PUT',
      route: '/aeocorner/v1/schema',
      body: '{"a":1}',
      now: 1_800_000_000,
      seenNonces,
    };
    assert.equal(verifySignature(ok).ok, true);
    assert.equal(verifySignature(ok).reason, 'replayed');
  });
  test('site addresses are tidied and bad ones refused before anything is sent', () => {
    assert.equal(normalizeSiteUrl('example.com'), 'https://example.com');
    assert.equal(normalizeSiteUrl(' https://Example.com/blog/?x=1#y '), 'https://example.com/blog');
    assert.equal(normalizeSiteUrl('http://example.com:8080/'), 'http://example.com:8080');
    for (const bad of ['', '   ', 'https://user:pw@example.com', 'ftp://x', 'http://']) {
      assert.throws(
        () => normalizeSiteUrl(bad),
        (e) => e instanceof WordPressError && e.code === 'bad_site_url',
        bad,
      );
    }
  });
});

describe('WordPress REST', () => {
  test('probe recognises a WordPress site and whether the plugin is installed', async () => {
    const withPlugin = await stub();
    const info = await clientFor(withPlugin).probe();
    assert.equal(info.name, 'Stub Site');
    assert.equal(info.pluginInstalled, true);
    assert.ok(info.wpNamespaces.includes('wp/v2'));
    const without = await stub({ pluginInstalled: false });
    assert.equal((await clientFor(without).probe()).pluginInstalled, false);
  });

  test('a site with plain permalinks is reached through ?rest_route=', async () => {
    const s = await stub({ restPlain: true });
    const client = clientFor(s);
    assert.equal((await client.probe()).restBase.includes('?rest_route='), true);
    assert.equal((await client.whoAmI()).canPublish, true);
    assert.equal(
      (await client.createPost({ title: 'Plain', content: '<p>x</p>' })).status,
      'draft',
    );
  });

  test('something that is not WordPress is said so', async () => {
    const other = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>hello</html>');
    });
    stubs.push(other);
    const client = createWordPressClient({
      fetcher: testFetcher({ ports: [other.port] }),
      siteUrl: other.origin(),
    });
    await rejectsWith(client.probe(), 'not_wordpress');
  });

  test('who am I: capabilities are read, a wrong password is auth_failed and the error holds no password', async () => {
    const s = await stub({ capabilities: { edit_posts: true, publish_posts: false } });
    const me = await clientFor(s).whoAmI();
    assert.deepEqual([me.canEdit, me.canPublish, me.canManage], [true, false, false]);
    const bad = clientFor(s, { appPassword: 'wrong password here' });
    await assert.rejects(bad.whoAmI(), (err) => {
      assert.equal(err.code, 'auth_failed');
      assert.ok(
        !err.message.includes('wrong password') && !JSON.stringify(err).includes('wrong password'),
      );
      return true;
    });
    await rejectsWith(
      clientFor(s, { username: null, appPassword: null }).whoAmI(),
      'no_credentials',
    );
  });

  test('create, read and update a post; publishing needs the right to publish', async () => {
    const s = await stub();
    const client = clientFor(s);
    const draft = await client.createPost({
      title: 'How much is a crown?',
      content: '<h2>Hi</h2>',
      status: 'draft',
    });
    assert.equal(draft.status, 'draft');
    assert.match(draft.link, /how-much-is-a-crown/);
    const live = await client.updatePost(draft.id, {
      status: 'publish',
      content: '<h2>Hi again</h2>',
    });
    assert.equal(live.status, 'publish');
    assert.equal((await client.getPost(draft.id)).id, draft.id);
    await rejectsWith(client.getPost(9999), 'not_found');
    const noPublish = await stub({ capabilities: { edit_posts: true, publish_posts: false } });
    await rejectsWith(
      clientFor(noPublish).createPost({ title: 't', content: 'c', status: 'publish' }),
      'forbidden',
    );
    assert.equal(
      (await clientFor(noPublish).createPost({ title: 't', content: 'c', status: 'draft' })).status,
      'draft',
    );
  });

  test('a busy site is retryable, a server error is retryable, a redirect is explained and not followed', async () => {
    const s = await stub();
    const client = clientFor(s);
    s.failNext(429);
    await assert.rejects(client.whoAmI(), (e) => e.code === 'rate_limited' && e.retryable === true);
    s.failNext(500);
    await assert.rejects(client.whoAmI(), (e) => e.code === 'server_error' && e.retryable === true);
    const other = await startServer((req, res) => {
      res.writeHead(200);
      res.end('x');
    });
    stubs.push(other);
    const redirecting = await startServer((req, res) => {
      res.writeHead(301, { location: `${other.origin('elsewhere.test')}/steal` });
      res.end();
    });
    stubs.push(redirecting);
    const c = createWordPressClient({
      fetcher: testFetcher({ ports: [redirecting.port, other.port] }),
      siteUrl: redirecting.origin(),
      username: 'u',
      appPassword: 'p',
    });
    await rejectsWith(c.whoAmI(), 'redirected');
    assert.equal(other.requests.length, 0, 'the application password never went to the other host');
  });

  test('a private address is refused before any request is made', async () => {
    const client = createWordPressClient({
      fetcher: testFetcher({ dns: { 'wp.test': ['10.1.2.3'] } }),
      siteUrl: 'http://wp.test',
      username: 'u',
      appPassword: 'p',
    });
    await rejectsWith(client.probe(), 'site_not_allowed');
    await rejectsWith(client.createPost({ title: 't', content: 'c' }), 'site_not_allowed');
  });

  test('an unreachable site is retryable', async () => {
    const s = await stub();
    const client = clientFor(s);
    await s.close();
    await assert.rejects(
      client.probe(),
      (e) => e.code === 'site_unreachable' && e.retryable === true,
    );
  });
});

describe('the plugin routes', () => {
  test('connect hands over the secret; after that signed calls work and the page shows the JSON-LD in its head', async () => {
    const s = await stub();
    const admin = clientFor(s);
    const status = await admin.plugin.connect({ secret: SECRET, indexNowKey: 'k'.repeat(32) });
    assert.equal(status.pluginVersion, '1.1.0');
    assert.deepEqual(status.features, ['schema', 'meta', 'state', 'robots']);
    assert.equal(status.seoPlugin, 'yoast');
    assert.equal(status.indexNow, true);
    assert.equal(s.state.secret, SECRET);

    const signedClient = clientFor(s, { hmacSecret: SECRET });
    assert.equal((await signedClient.plugin.status()).wpVersion, '6.8');
    const post = await signedClient.createPost({
      title: 'Crown costs',
      content: '<p>Body</p>',
      status: 'publish',
    });
    const jsonld = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Crown costs',
    };
    await signedClient.plugin.setSchema({ url: post.link, jsonld });
    await signedClient.plugin.setMeta({
      url: post.link,
      title: 'Crown costs in Austin',
      description: 'What a crown costs.',
    });
    const page = await testFetcher({ ports: [s.port] }).fetch(post.link);
    const html = page.body.toString();
    assert.match(
      html,
      /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"Article"/,
    );
    assert.match(html, /<title>Crown costs in Austin<\/title>/);
    assert.deepEqual(await signedClient.plugin.resolve(post.link), {
      found: true,
      id: post.id,
      type: 'post',
      link: post.link,
    });
    assert.deepEqual(await signedClient.plugin.resolve(`${s.siteUrl}/nothing/`), { found: false });
    assert.deepEqual(await signedClient.plugin.indexNow([post.link]), { pinged: 1 });
    assert.deepEqual(s.state.indexNowPings, [post.link]);
    assert.deepEqual(await signedClient.plugin.removeSchema({ url: post.link }), { removed: true });
    assert.ok(
      !(await testFetcher({ ports: [s.port] }).fetch(post.link)).body
        .toString()
        .includes('ld+json'),
    );
  });

  test('a page on another site is refused by the plugin', async () => {
    const s = await stub();
    await clientFor(s).plugin.connect({ secret: SECRET });
    const c = clientFor(s, { hmacSecret: SECRET });
    await assert.rejects(
      c.plugin.setSchema({ url: 'https://evil.example/page', jsonld: {} }),
      (e) => e.code === 'bad_response',
    );
  });

  test('connect needs an administrator and the plugin; a missing plugin is plugin_missing', async () => {
    const editorOnly = await stub({ capabilities: { edit_posts: true, publish_posts: true } });
    await rejectsWith(clientFor(editorOnly).plugin.connect({ secret: SECRET }), 'forbidden');
    const none = await stub({ pluginInstalled: false });
    await rejectsWith(clientFor(none).plugin.connect({ secret: SECRET }), 'plugin_missing');
    await rejectsWith(clientFor(none, { hmacSecret: SECRET }).plugin.status(), 'plugin_missing');
  });

  test('a wrong secret, an old clock and a replayed request are all refused as a bad signature', async () => {
    const s = await stub();
    await clientFor(s).plugin.connect({ secret: SECRET });
    await rejectsWith(
      clientFor(s, { hmacSecret: 'b'.repeat(64) }).plugin.status(),
      'bad_signature',
    );
    await rejectsWith(
      clientFor(s, {
        hmacSecret: SECRET,
        nowSeconds: () => Math.floor(Date.now() / 1000) - 3_600,
      }).plugin.status(),
      'bad_signature',
    );
    const good = clientFor(s, { hmacSecret: SECRET });
    await good.plugin.status();
    const sent = s.state.calls.at(-1);
    const replay = await testFetcher({ ports: [s.port] }).fetch(
      `${s.siteUrl}/wp-json/aeocorner/v1/status`,
      {
        headers: {
          'x-aeo-timestamp': sent.headers['x-aeo-timestamp'],
          'x-aeo-nonce': sent.headers['x-aeo-nonce'],
          'x-aeo-signature': sent.headers['x-aeo-signature'],
        },
        accept: ['application/json'],
      },
    );
    assert.equal(replay.status, 401);
    assert.match(replay.body.toString(), /aeo_bad_signature/);
  });

  test('without the secret, plugin calls need no network at all; after disconnect the plugin forgets', async () => {
    const s = await stub();
    const before = s.state.calls.length;
    await rejectsWith(clientFor(s).plugin.status(), 'no_credentials');
    assert.equal(s.state.calls.length, before);
    await clientFor(s).plugin.connect({ secret: SECRET });
    const c = clientFor(s, { hmacSecret: SECRET });
    await c.plugin.disconnect();
    assert.equal(s.state.secret, null);
    await rejectsWith(c.plugin.status(), 'plugin_not_connected');
  });

  test('the signing secret is sent only as a signature, never as itself', async () => {
    const s = await stub();
    await clientFor(s).plugin.connect({ secret: SECRET });
    const c = clientFor(s, { hmacSecret: SECRET });
    await c.plugin.status();
    await c.createPost({ title: 't', content: 'c' }).catch(() => {});
    for (const call of s.state.calls.slice(1)) {
      assert.ok(!JSON.stringify(call.headers).includes(SECRET), 'not in headers');
      assert.ok(!call.body.includes(SECRET), 'not in a body');
    }
  });
});

describe('the plugin routes added in 1.1.0', () => {
  const GROUP = 'User-agent: OAI-SearchBot\nAllow: /';
  const connected = async (options) => {
    const s = await stub(options);
    await clientFor(s).plugin.connect({ secret: SECRET });
    return { s, c: clientFor(s, { hmacSecret: SECRET }) };
  };

  test('state reads what the plugin holds for a page and for robots.txt', async () => {
    const { s, c } = await connected();
    const url = `${s.siteUrl}/about`;
    assert.deepEqual(await c.plugin.state({ url }), {
      schema: null,
      title: null,
      description: null,
      robots: { lines: null, virtual: true },
    });
    const jsonld = { '@context': 'https://schema.org', '@type': 'AboutPage', name: 'About' };
    await c.plugin.setSchema({ url, jsonld });
    await c.plugin.setMeta({ url, title: 'About us', description: null });
    await c.plugin.setRobots({ lines: GROUP });
    assert.deepEqual(await c.plugin.state({ url }), {
      schema: jsonld,
      title: 'About us',
      description: null,
      robots: { lines: GROUP, virtual: true },
    });
    assert.equal((await c.plugin.state()).schema, null, 'no address, no page state');
  });

  test('a title and description both emptied go back to the site’s own', async () => {
    const { s, c } = await connected();
    const url = `${s.siteUrl}/about`;
    await c.plugin.setMeta({ url, title: 'About us', description: 'Who we are.' });
    assert.equal(s.state.meta.has(url), true);
    await c.plugin.setMeta({ url, title: null, description: null });
    assert.equal(s.state.meta.has(url), false);
  });

  test('robots.txt lines: saved, shown by the site, removed; only plain Allow groups are accepted', async () => {
    const { s, c } = await connected();
    await c.plugin.setRobots({ lines: GROUP });
    const res = await testFetcher({ ports: [s.port] }).fetch(`${s.siteUrl}/robots.txt`, {
      accept: ['text/plain'],
      bodyTypes: [/text/i],
    });
    assert.match(
      res.body.toString(),
      /Disallow: \/wp-admin\/\n\nUser-agent: OAI-SearchBot\nAllow: \//,
    );
    assert.deepEqual(await c.plugin.removeRobots(), { removed: true });
    assert.deepEqual(await c.plugin.removeRobots(), { removed: false });
    for (const lines of [
      'User-agent: *\nDisallow: /',
      'User-agent: GPTBot\nAllow: /\nSitemap: https://x.example/s.xml',
      '',
    ]) {
      await rejectsWith(c.plugin.setRobots({ lines }), 'bad_response');
    }
  });

  test('a real robots.txt file on the site is robots_file, in plain words', async () => {
    const { c } = await connected({ robotsFile: true });
    assert.equal((await c.plugin.state()).robots.virtual, false);
    await assert.rejects(c.plugin.setRobots({ lines: GROUP }), (e) => {
      assert.equal(e.code, 'robots_file');
      assert.match(e.message, /real robots\.txt file/);
      return true;
    });
  });

  test('a plugin from before these routes is plugin_outdated, not plugin_missing', async () => {
    const { c } = await connected({ pluginVersion: '1.0.0' });
    await rejectsWith(c.plugin.state({ url: 'x' }), 'plugin_outdated');
    await rejectsWith(c.plugin.setRobots({ lines: GROUP }), 'plugin_outdated');
    await rejectsWith(c.plugin.removeRobots(), 'plugin_outdated');
    assert.deepEqual((await c.plugin.status()).features, [], 'and the status says what it can do');
  });

  test('a page on another site is refused for its state too', async () => {
    const { c } = await connected();
    await assert.rejects(
      c.plugin.state({ url: 'https://evil.example/page' }),
      (e) => e.code === 'bad_response',
    );
  });
});
