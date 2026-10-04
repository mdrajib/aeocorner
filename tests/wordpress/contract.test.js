import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSafeFetcher } from '../../src/crawler/safe-fetch.js';
import {
  createWordPressClient,
  signRequest,
  WordPressError,
} from '../../src/integrations/wordpress.js';

/**
 * The contract between this app and the AEO Corner Connector plugin, checked on a real WordPress (task 7.11, ADR-0011).
 *
 * It starts WordPress in WordPress Playground (WordPress and PHP compiled to WebAssembly, run by Node: no Docker, no
 * web host), with this repository's plugin directory mounted and activated, makes an application password for the
 * administrator, and then drives it with the same client the app uses. Everything the stand-in used by the other tests
 * only imitates is exercised for real here: the PHP signature check against the JavaScript one, the handshake, the
 * JSON-LD printed in the page's head by `wp_head`, title and description, the IndexNow key file, address resolving and
 * disconnecting.
 *
 * It is NOT part of `npm run test:all`: the first run downloads WordPress (about 25 MB) and takes a minute or two.
 *   npm run test:wordpress              (latest WordPress, PHP 8.3)
 *   WP_PHP=7.4 npm run test:wordpress   (the oldest PHP the plugin claims to support)
 *   WP_WP=6.2 npm run test:wordpress    (the oldest WordPress it claims to support)
 * Playground is fetched on demand with npx at a pinned version, not added to package.json (it is half a gigabyte).
 */

const PLAYGROUND = '@wp-playground/cli@3.1.56';
const PLUGIN_DIR = fileURLToPath(
  new URL('../../wordpress-plugin/aeo-corner-connector', import.meta.url),
);
const SECRET = 'b'.repeat(64);
const INDEXNOW_KEY = 'c'.repeat(32);

let child;
let work;
let port;
let fetcher;
let siteUrl;
let username;
let appPassword;
const log = [];

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port: p } = server.address();
      server.close(() => resolve(p));
    });
  });

before(
  async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'aeo-wp-'));
    const out = path.join(work, 'out');
    await mkdir(out);
    await writeFile(
      path.join(work, 'blueprint.json'),
      JSON.stringify({
        landingPage: '/',
        // The versions to run. (The command-line flags are ignored when a blueprint is given, so they are set here.)
        ...(process.env.WP_PHP || process.env.WP_WP
          ? {
              preferredVersions: {
                ...(process.env.WP_PHP ? { php: process.env.WP_PHP } : {}),
                ...(process.env.WP_WP ? { wp: process.env.WP_WP } : {}),
              },
            }
          : {}),
        steps: [
          { step: 'activatePlugin', pluginPath: 'aeo-corner-connector/aeo-corner-connector.php' },
          {
            step: 'runPHP',
            code: "<?php require_once '/wordpress/wp-load.php'; $r = WP_Application_Passwords::create_new_application_password(1, array('name' => 'contract')); file_put_contents('/out/app-password.txt', $r[0]); file_put_contents('/out/user.txt', get_user_by('id', 1)->user_login);",
          },
        ],
      }),
    );
    port = await freePort();
    const windows = process.platform === 'win32';
    const args = [
      '--yes',
      PLAYGROUND,
      'server',
      '--port',
      String(port),
      '--define',
      'WP_ENVIRONMENT_TYPE',
      'local', // application passwords are allowed over plain http only on a local environment
      '--mount-dir',
      PLUGIN_DIR,
      '/wordpress/wp-content/plugins/aeo-corner-connector',
      '--mount-dir',
      out,
      '/out',
      '--blueprint',
      path.join(work, 'blueprint.json'),
    ];
    child = spawn(
      windows ? 'npx.cmd' : 'npx',
      windows ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args,
      {
        shell: windows,
        env: { ...process.env, MSYS_NO_PATHCONV: '1' }, // Git Bash must not rewrite "/wordpress/..." into a Windows path
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (d) => log.push(String(d)));
    child.stderr.on('data', (d) => log.push(String(d)));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`WordPress did not start:\n${log.join('').slice(-1500)}`)),
        220_000,
      );
      const check = setInterval(() => {
        if (/Ready! WordPress is running/.test(log.join(''))) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 500);
      child.once('exit', (code) => {
        clearTimeout(timer);
        clearInterval(check);
        reject(new Error(`Playground exited with ${code}:\n${log.join('').slice(-1500)}`));
      });
    });
    appPassword = (await readFile(path.join(out, 'app-password.txt'), 'utf8')).trim();
    username = (await readFile(path.join(out, 'user.txt'), 'utf8')).trim();
    siteUrl = `http://127.0.0.1:${port}`;
    // The guard refuses a loopback address; only this one port on this machine is let through, for this test.
    fetcher = createSafeFetcher({ exceptions: [{ address: '127.0.0.1', ports: [port] }] });
  },
  { timeout: 240_000 },
);

after(async () => {
  if (child?.pid) {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else child.kill('SIGKILL');
  }
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
});

const client = (extra = {}) =>
  createWordPressClient({ fetcher, siteUrl, username, appPassword, ...extra });
const rejectsWith = (promise, code) =>
  assert.rejects(
    promise,
    (e) => e instanceof WordPressError && e.code === code,
    `expected ${code}`,
  );

describe('WordPress itself', () => {
  test('the site is recognised, the plugin is active, and the login can publish', async () => {
    const site = await client().probe();
    assert.equal(site.pluginInstalled, true);
    assert.ok(site.wpNamespaces.includes('wp/v2'));
    const me = await client().whoAmI();
    assert.deepEqual([me.canEdit, me.canPublish, me.canManage], [true, true, true]);
  });

  test('a wrong application password is refused', async () => {
    await rejectsWith(
      client({ appPassword: 'abcd efgh ijkl mnop qrst uvwx' }).whoAmI(),
      'auth_failed',
    );
  });
});

describe('the plugin', () => {
  let post;
  const signed = () => client({ hmacSecret: SECRET });

  test('nothing signed works before the handshake', async () => {
    await rejectsWith(signed().plugin.status(), 'plugin_not_connected');
  });

  test('the handshake needs an administrator and a long enough secret', async () => {
    await assert.rejects(
      client().plugin.connect({ secret: 'short' }),
      (e) => e.status === 400 || e.code === 'bad_response',
    );
    const status = await client().plugin.connect({ secret: SECRET, indexNowKey: INDEXNOW_KEY });
    assert.equal(status.pluginVersion, '1.1.0');
    assert.deepEqual(status.features, ['schema', 'meta', 'state', 'robots']);
    assert.ok(status.wpVersion && status.phpVersion);
    assert.equal(status.indexNow, true);
    // What really ran: the versions the plugin itself reports (so a run for an old PHP or WordPress proves it).
    if (process.env.WP_PHP)
      assert.ok(status.phpVersion.startsWith(process.env.WP_PHP), `PHP ${status.phpVersion}`);
    if (process.env.WP_WP)
      assert.ok(status.wpVersion.startsWith(process.env.WP_WP), `WordPress ${status.wpVersion}`);
  });

  test('a signature made here is accepted by PHP; a wrong secret, an old clock and a replay are not', async () => {
    assert.equal((await signed().plugin.status()).pluginVersion, '1.1.0');
    await rejectsWith(client({ hmacSecret: 'd'.repeat(64) }).plugin.status(), 'bad_signature');
    await rejectsWith(
      client({
        hmacSecret: SECRET,
        nowSeconds: () => Math.floor(Date.now() / 1000) - 3_600,
      }).plugin.status(),
      'bad_signature',
    );
    await rejectsWith(
      client({
        hmacSecret: SECRET,
        nowSeconds: () => Math.floor(Date.now() / 1000) + 3_600,
      }).plugin.status(),
      'bad_signature',
    );
    const headers = signRequest({
      secret: SECRET,
      method: 'GET',
      route: '/aeocorner/v1/status',
      body: '',
    });
    const send = () =>
      fetcher.fetch(`${siteUrl}/wp-json/aeocorner/v1/status`, {
        headers,
        accept: ['application/json'],
      });
    assert.equal((await send()).status, 200);
    const replay = await send();
    assert.equal(replay.status, 401);
    assert.match(replay.body.toString(), /aeo_bad_signature/);
  });

  test('a signature for another method, route or body is refused', async () => {
    const wrongRoute = signRequest({
      secret: SECRET,
      method: 'GET',
      route: '/aeocorner/v1/schema',
      body: '',
    });
    const res = await fetcher.fetch(`${siteUrl}/wp-json/aeocorner/v1/status`, {
      headers: wrongRoute,
      accept: ['application/json'],
    });
    assert.equal(res.status, 401);
    const body = JSON.stringify({
      url: `${siteUrl}/x`,
      jsonld: { '@context': 'https://schema.org' },
    });
    const forBody = signRequest({
      secret: SECRET,
      method: 'PUT',
      route: '/aeocorner/v1/schema',
      body: '{"other":1}',
    });
    const tampered = await fetcher.fetch(`${siteUrl}/wp-json/aeocorner/v1/schema`, {
      method: 'PUT',
      body,
      headers: { ...forBody, 'content-type': 'application/json' },
      accept: ['application/json'],
    });
    assert.equal(tampered.status, 401);
  });

  test('JSON-LD, title and description are printed in the page head by the server, with nothing able to close the script', async () => {
    post = await signed().createPost({
      title: 'Contract test post',
      content: '<p>Hello</p>',
      status: 'publish',
    });
    const jsonld = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: 'Contract & "test" </script><script>alert(1)</script>',
    };
    assert.deepEqual(await signed().plugin.setSchema({ url: post.link, jsonld }), { saved: true });
    assert.deepEqual(
      await signed().plugin.setMeta({
        url: post.link,
        title: 'Contract title',
        description: 'A "described" page',
      }),
      { saved: true },
    );
    const page = await fetcher.fetch(post.link);
    assert.equal(page.status, 200);
    const html = page.body.toString();
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(block, 'the structured data is in the HTML a crawler without JavaScript reads');
    assert.deepEqual(JSON.parse(block[1]), jsonld, 'and says what was sent');
    assert.ok(!/<script>alert/.test(html), 'a hostile string did not become a script');
    assert.match(html, /<title>Contract title/);
    assert.match(html, /<meta name="description" content="A &quot;described&quot; page">/);
  });

  test('a page of another site is refused, and an address resolves to its post', async () => {
    await assert.rejects(
      signed().plugin.setSchema({
        url: 'https://evil.example/x',
        jsonld: { '@context': 'https://schema.org', '@type': 'Article' },
      }),
      (e) => e.status === 400,
    );
    assert.deepEqual(await signed().plugin.resolve(post.link), {
      found: true,
      id: post.id,
      type: 'post',
      link: post.link,
    });
    assert.deepEqual(await signed().plugin.resolve(`${siteUrl}/not-a-page/`), { found: false });
  });

  test('structured data without schema.org, or too large, is refused', async () => {
    await assert.rejects(
      signed().plugin.setSchema({
        url: post.link,
        jsonld: { '@context': 'https://evil.example', '@type': 'Article' },
      }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      signed().plugin.setSchema({
        url: post.link,
        jsonld: {
          '@context': 'https://schema.org',
          '@type': 'Article',
          description: 'x'.repeat(250_000),
        },
      }),
      (e) => e.status === 400,
    );
  });

  test('the IndexNow key is served, and only for the right key', async () => {
    const ok = await fetcher.fetch(`${siteUrl}/${INDEXNOW_KEY}.txt`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.toString().trim(), INDEXNOW_KEY);
    assert.notEqual((await fetcher.fetch(`${siteUrl}/${'e'.repeat(32)}.txt`)).status, 200);
  });

  test('a refresh finds a PAGE from its address and updates it in place, through the pages route', async () => {
    const created = await fetcher.fetch(`${siteUrl}/wp-json/wp/v2/pages`, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Old services page',
        content: '<p>Old text.</p>',
        status: 'publish',
      }),
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`,
      },
      accept: ['application/json'],
    });
    assert.equal(created.status, 201);
    const page = JSON.parse(created.body.toString());
    const found = await signed().plugin.resolve(page.link);
    assert.deepEqual([found.found, found.id, found.type], [true, page.id, 'page']);
    await rejectsWith(signed().updatePost(page.id, { content: '<p>x</p>' }), 'not_found'); // a page is not under /posts/
    const updated = await signed().updatePost(
      page.id,
      { title: 'New services page', content: '<p>New text.</p>' },
      { type: 'page' },
    );
    assert.equal(updated.status, 'publish', 'a live page stays live');
    assert.match((await fetcher.fetch(page.link)).body.toString(), /New text./);
  });

  test('state shows what the plugin holds, so a change can be taken back exactly', async () => {
    const before = await signed().plugin.state({ url: post.link });
    assert.equal(before.title, 'Contract title');
    assert.equal(before.description, 'A "described" page');
    assert.equal(before.schema?.['@type'], 'Article');
    assert.deepEqual(before.robots, { lines: null, virtual: true });
    await rejectsWith(signed().plugin.state({ url: 'https://evil.example/x' }), 'bad_response');
  });

  test('a title and description emptied together give the page back its own', async () => {
    assert.deepEqual(
      await signed().plugin.setMeta({ url: post.link, title: null, description: null }),
      {
        saved: true,
        removed: true,
      },
    );
    const html = (await fetcher.fetch(post.link)).body.toString();
    assert.ok(!/<title>Contract title/.test(html), 'the saved title is gone');
    assert.ok(!html.includes('A &quot;described&quot; page'), 'and so is the description');
  });

  test('robots.txt lines are added to the file WordPress builds, only plain Allow groups are accepted, and removing them restores it', async () => {
    const lines = 'User-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /';
    const robots = async () => (await fetcher.fetch(`${siteUrl}/?robots=1`)).body.toString();
    assert.ok(!(await robots()).includes('OAI-SearchBot'));
    assert.deepEqual(await signed().plugin.setRobots({ lines }), { saved: true });
    const after = await robots();
    assert.ok(after.includes(lines), 'our groups are in the file');
    assert.match(after, /User-agent: \*/, 'and what WordPress wrote is still there');
    assert.equal((await signed().plugin.state()).robots.lines, lines);
    for (const bad of [
      'User-agent: *\nDisallow: /',
      'User-agent: GPTBot\nAllow: /\nSitemap: https://x.example/s.xml',
      '',
    ]) {
      await rejectsWith(signed().plugin.setRobots({ lines: bad }), 'bad_response');
    }
    assert.deepEqual(await signed().plugin.removeRobots(), { removed: true });
    assert.ok(!(await robots()).includes('OAI-SearchBot'));
  });

  test('removing the structured data takes it out of the page', async () => {
    assert.deepEqual(await signed().plugin.removeSchema({ url: post.link }), { removed: true });
    assert.ok(!(await fetcher.fetch(post.link)).body.toString().includes('application/ld+json'));
  });

  test('disconnecting erases the secret: nothing signed works afterwards', async () => {
    assert.deepEqual(await signed().plugin.disconnect(), { disconnected: true });
    await rejectsWith(signed().plugin.status(), 'plugin_not_connected');
    assert.notEqual((await fetcher.fetch(`${siteUrl}/${INDEXNOW_KEY}.txt`)).status, 200);
    const page = (await fetcher.fetch(post.link)).body.toString();
    assert.ok(
      !page.includes('Contract title') || !/<title>Contract title/.test(page),
      'the saved title is gone with the connection',
    );
  });
});
