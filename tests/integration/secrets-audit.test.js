import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import pino from 'pino';
import { createSecretBox, parseMasterKey } from '../../src/lib/secrets.js';
import { REDACT_PATHS } from '../../src/lib/logger.js';
import { connectTestDb, fixtures, tablesContaining } from '../../src/db/testing.js';

/**
 * The secrets audit (Milestone 10, task 10.02). Where can a customer's credential end up? The database, a log line, a
 * screen, the repository. Each is checked by planting a known password and token and looking for it.
 */

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const db = connectTestDb();
const fx = fixtures(db);
const box = createSecretBox({ current: { version: 1, key: randomBytes(32) } });
after(async () => {
  await fx.cleanup();
  await db.close();
});

const canary = (label) => `CANARY-${label}-${randomBytes(6).toString('hex')}`;

describe('the database holds no plaintext credential', () => {
  test('a WordPress password and signing secret planted through the repository appear in no column of any table', async () => {
    const o = await fx.org();
    const project = await fx.project(o.org.id, 'Secrets Dental', { status: 'active' });
    const appPassword = canary('wp-password');
    const hmacSecret = canary('wp-hmac');
    await o.scoped.integrations.saveWordpress(project.id, {
      config: { siteUrl: 'https://wp.example.test', username: 'editor' },
      secret: box.encrypt({ appPassword, hmacSecret }, `wordpress:${o.org.id}:${project.id}`),
      userId: o.owner.id,
    });
    assert.deepEqual(await tablesContaining(db, o.org.id, appPassword), []);
    assert.deepEqual(await tablesContaining(db, o.org.id, hmacSecret), []);
    // The ciphertext is really there: the connection says it has a secret.
    assert.ok(
      (await o.scoped.integrations.wordpressSecret(project.id)).secret.ciphertext.length > 28,
    );
  });

  test('a Google refresh token appears in no column of any table', async () => {
    const o = await fx.org();
    const project = await fx.project(o.org.id, 'Token Dental', { status: 'active' });
    const refreshToken = canary('google-refresh');
    await o.scoped.google.saveGrant(project.id, {
      secret: box.encrypt(refreshToken, `google:${o.org.id}:${project.id}`),
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
      properties: [{ id: '1', name: 'Site' }],
      sites: [{ url: 'https://example.test/', permission: 'siteOwner' }],
      userId: o.owner.id,
    });
    assert.deepEqual(await tablesContaining(db, o.org.id, refreshToken), []);
    assert.equal((await o.scoped.google.status(project.id)).hasSecret, true);
  });

  test('the detector works: a planted value in a plain column is found', async () => {
    const o = await fx.org();
    const project = await fx.project(o.org.id, 'Control Dental', { status: 'active' });
    const marker = canary('control');
    await o.scoped.integrations.saveWordpress(project.id, {
      config: { siteUrl: 'https://wp.example.test', note: marker },
      secret: box.encrypt('x', `wordpress:${o.org.id}:${project.id}`),
      userId: o.owner.id,
    });
    assert.deepEqual(await tablesContaining(db, o.org.id, marker), ['integrations']);
  });
});

describe('what the web-facing reads return', () => {
  test('a connection read for a screen carries no secret, no ciphertext and no key', async () => {
    const o = await fx.org();
    const project = await fx.project(o.org.id, 'Screen Dental', { status: 'active' });
    const password = canary('screen');
    await o.scoped.integrations.saveWordpress(project.id, {
      config: { siteUrl: 'https://wp.example.test', username: 'editor' },
      secret: box.encrypt({ appPassword: password }, `wordpress:${o.org.id}:${project.id}`),
      userId: o.owner.id,
    });
    await o.scoped.google.saveGrant(project.id, {
      secret: box.encrypt(password, `google:${o.org.id}:${project.id}`),
      scopes: [],
      properties: [],
      sites: [],
      userId: o.owner.id,
    });
    const shown = JSON.stringify(
      [await o.scoped.integrations.wordpress(project.id), await o.scoped.google.status(project.id)],
      (_k, v) => (typeof v === 'bigint' ? String(v) : v),
    );
    assert.ok(!shown.includes(password));
    assert.ok(!/ciphertext|wrapped|dek|keyVersion|key_version/i.test(shown), shown);
  });
});

describe('a credential is bound to the connection it belongs to', () => {
  test('a ciphertext copied to another organization or project does not open', () => {
    const stored = box.encrypt({ appPassword: 'pw' }, 'wordpress:1:1');
    assert.equal(box.decryptJson(stored, 'wordpress:1:1').appPassword, 'pw');
    for (const other of ['wordpress:2:1', 'wordpress:1:2', 'google:1:1']) {
      assert.throws(() => box.decryptJson(stored, other), /could not be opened/);
    }
  });

  test('the master key is 32 bytes and nothing shorter is accepted', () => {
    assert.throws(() => parseMasterKey('short'), RangeError);
    assert.equal(parseMasterKey(randomBytes(32).toString('base64')).length, 32);
  });
});

describe('the logger blanks credentials', () => {
  const logged = (obj) => {
    const lines = [];
    const log = pino(
      { redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
      { write: (line) => lines.push(line) },
    );
    log.info(obj, 'event');
    return lines.join('');
  };

  test('known credential fields are replaced at the top and one level down', () => {
    const secret = canary('log');
    for (const field of [
      'password',
      'appPassword',
      'refreshToken',
      'accessToken',
      'apiKey',
      'hmacSecret',
    ]) {
      assert.ok(!logged({ [field]: secret }).includes(secret), `${field} at the top`);
      assert.ok(
        !logged({ creds: { [field]: secret } }).includes(secret),
        `${field} one level down`,
      );
    }
  });

  test('request headers that carry a credential or a signature are blanked', () => {
    const secret = canary('header');
    const line = logged({
      req: {
        headers: {
          authorization: secret,
          cookie: secret,
          'x-csrf-token': secret,
          'stripe-signature': secret,
          'svix-signature': secret,
          'x-aeo-signature': secret,
        },
      },
    });
    assert.ok(!line.includes(secret));
  });

  test('ordinary fields stay readable', () => {
    assert.ok(logged({ projectId: '42' }).includes('"projectId":"42"'));
  });
});

describe('the code keeps credentials where the design says', () => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return f === 'public' || f === 'vendor' ? [] : walk(p);
      return p.endsWith('.js') && !p.endsWith('.test.js') ? [p] : [];
    });
  const sources = walk(join(ROOT, 'src')).map((p) => ({
    path: relative(ROOT, p).replaceAll('\\', '/'),
    text: readFileSync(p, 'utf8'),
  }));

  test('only the worker opens a credential (the web process only encrypts)', () => {
    const openers = sources
      .filter((s) => /\.decrypt(Text|Json)\(|\.rewrap\(/.test(s.text))
      .map((s) => s.path)
      .filter((p) => p !== 'src/lib/secrets.js');
    for (const p of openers) assert.ok(p.startsWith('src/worker/'), `${p} opens a credential`);
    assert.ok(openers.length >= 2, 'the worker handlers are expected to open credentials');
  });

  test('credentials are encrypted in exactly the places we know of', () => {
    const where = sources
      .filter((s) => /\.encrypt\(/.test(s.text))
      .map((s) => s.path)
      .filter((p) => p !== 'src/lib/secrets.js')
      .sort();
    assert.deepEqual(where, [
      'src/web/routes/project-content.js',
      'src/web/routes/project-traffic.js',
      'src/worker/handlers/content.js',
    ]);
  });

  test('no view, route or log call prints the secret columns', () => {
    for (const s of sources) {
      assert.ok(
        !/(logger|log)\.\w+\([^)]*(secret_ciphertext|secret_wrapped_dek|appPassword|refreshToken)/.test(
          s.text,
        ),
        `${s.path} logs a credential`,
      );
    }
  });

  const tracked = () =>
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

  test('.env is not tracked, and no real-looking key is in a tracked file', () => {
    const files = tracked();
    assert.ok(!files.some((f) => /(^|\/)\.env($|\.(?!example))/.test(f)), 'a .env file is tracked');
    const patterns = [
      /sk_live_[A-Za-z0-9]{16,}/,
      /rk_live_[A-Za-z0-9]{16,}/,
      /sk-ant-[A-Za-z0-9_-]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /xox[bp]-[0-9A-Za-z-]{20,}/,
      /ghp_[A-Za-z0-9]{30,}/,
    ];
    const hits = [];
    for (const f of files) {
      if (f === 'tests/fixtures/tls/test-only-key.pem') continue; // a throwaway key for the local TLS fixture server
      if (/\.(png|jpg|jpeg|gif|ico|woff2?|zip|pdf|map)$/i.test(f) || f.includes('node_modules'))
        continue;
      let text;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      for (const re of patterns) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    assert.deepEqual(hits, []);
  });
});
