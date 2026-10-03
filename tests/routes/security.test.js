import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appFor, envs } from './helpers.js';

describe('security headers', () => {
  test('every page response carries the baseline set', async () => {
    const res = await appFor(envs.production).get('/').expect(200);
    const h = res.headers;
    assert.equal(h['x-powered-by'], undefined);
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.match(h['permissions-policy'], /camera=\(\)/);
    assert.match(h['strict-transport-security'], /max-age=15552000/);
    assert.equal(h['cross-origin-opener-policy'], 'same-origin');
  });

  test('HSTS is production-only', async () => {
    const dev = await appFor(envs.development).get('/').expect(200);
    assert.equal(dev.headers['strict-transport-security'], undefined);
  });

  test('the CSP has no unsafe-inline or unsafe-eval and forbids framing', async () => {
    const csp = (await appFor(envs.production).get('/')).headers['content-security-policy'];
    assert.ok(csp);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /upgrade-insecure-requests/);
  });

  test('configured integrations widen the CSP only as far as they need', async () => {
    const csp = (
      await appFor(envs.production, {
        env: { TURNSTILE_SITE_KEY: '0x4AAAAAAA', POSTHOG_API_KEY: 'phc_test' },
      }).get('/')
    ).headers['content-security-policy'];
    assert.match(
      csp,
      /script-src 'self' https:\/\/challenges\.cloudflare\.com https:\/\/us-assets\.i\.posthog\.com/,
    );
    assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
    assert.match(
      csp,
      /connect-src 'self' https:\/\/us\.i\.posthog\.com https:\/\/us-assets\.i\.posthog\.com/,
    );
    assert.doesNotMatch(csp, /unsafe-/);
  });
});

describe('optional integrations are wired into the page only when configured', () => {
  test('with nothing configured: no PostHog meta, no Turnstile widget or script', async () => {
    const { text } = await appFor(envs.production).get('/');
    assert.doesNotMatch(text, /posthog/i);
    assert.doesNotMatch(text, /turnstile|cf-turnstile/i);
  });

  test('PostHog: config meta and loader script appear, with no inline script', async () => {
    const { text } = await appFor(envs.production, { env: { POSTHOG_API_KEY: 'phc_test' } }).get(
      '/',
    );
    const meta = text.match(/<meta name="posthog-config" content="([^"]*)"/)?.[1];
    assert.ok(meta);
    const config = JSON.parse(meta.replaceAll('&#34;', '"'));
    assert.equal(config.apiKey, 'phc_test');
    assert.equal(config.assetsHost, 'https://us-assets.i.posthog.com');
    assert.match(text, /<script src="\/js\/analytics\.js\?v=[^"]+" defer>/);
  });

  test('Turnstile: the home page loads nothing from Cloudflare (the check is on the email step)', async () => {
    const { text } = await appFor(envs.production, {
      env: { TURNSTILE_SITE_KEY: '0x4AAAAAAA' },
    }).get('/');
    assert.doesNotMatch(text, /cf-turnstile|challenges\.cloudflare\.com/);
  });
});

describe('static assets', () => {
  const app = appFor(envs.production);

  test('vendored htmx and Alpine.js are served from our own origin', async () => {
    await app
      .get('/vendor/htmx.min.js')
      .expect(200)
      .expect('Content-Type', /javascript/);
    await app
      .get('/vendor/alpine-csp.min.js')
      .expect(200)
      .expect('Content-Type', /javascript/);
    await app.get('/js/components.js').expect(200);
    await app.get('/fonts/inter-latin-wght-normal.woff2').expect(200);
  });

  test('pages load scripts in the order that lets Alpine components register first', async () => {
    const { text } = await app.get('/');
    const order = ['/js/components.js', '/vendor/htmx.min.js', '/vendor/alpine-csp.min.js'].map(
      (s) => text.indexOf(s),
    );
    assert.ok(order.every((i) => i > -1));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
  });

  test('pages reference only same-origin scripts and styles by default', async () => {
    const { text } = await app.get('/');
    const urls = [...text.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    const external = urls.filter((u) => !u.startsWith('https://aeocorner.com'));
    assert.deepEqual(external, []);
  });

  test('htmx is configured for a strict CSP (no eval, no injected styles, same-origin only)', async () => {
    const { text } = await app.get('/');
    const cfg = text.match(/<meta name="htmx-config" content='([^']*)'/)?.[1];
    assert.deepEqual(JSON.parse(cfg), {
      allowEval: false,
      includeIndicatorStyles: false,
      selfRequestsOnly: true,
      historyCacheSize: 0,
    });
  });
});

describe('cross-site request guard', () => {
  const app = appFor(envs.development);
  const form = { url: 'example.com' };

  test('same-origin browser posts are accepted', async () => {
    await app
      .post('/audit')
      .set('Sec-Fetch-Site', 'same-origin')
      .type('form')
      .send(form)
      .expect(200);
  });

  test('cross-site browser posts are refused', async () => {
    for (const site of ['cross-site', 'same-site']) {
      await app.post('/audit').set('Sec-Fetch-Site', site).type('form').send(form).expect(403);
    }
  });

  test('without Sec-Fetch-Site, a foreign Origin is refused and a matching one is accepted', async () => {
    await app
      .post('/audit')
      .set('Origin', 'https://evil.example')
      .type('form')
      .send(form)
      .expect(403);
    await app.post('/audit').set('Origin', 'null').type('form').send(form).expect(403);
    const host = 'localhost:3000';
    await app
      .post('/audit')
      .set('Host', host)
      .set('Origin', `http://${host}`)
      .type('form')
      .send(form)
      .expect(200);
  });

  test('non-browser clients (no Origin, no Sec-Fetch-Site) are not blocked by this guard', async () => {
    await app.post('/audit').type('form').send(form).expect(200);
  });

  test('GET requests are never blocked', async () => {
    await app.get('/').set('Sec-Fetch-Site', 'cross-site').expect(200);
  });
});
