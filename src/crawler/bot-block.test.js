import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectBotBlock } from './bot-block.js';

const normalPage =
  '<html><head><title>Acme</title></head><body><h1>Welcome to Acme</h1><p>We make widgets.</p></body></html>';

describe('responses that are blocks', () => {
  test('a Cloudflare challenge, served with 403 or even with 200', () => {
    const body =
      '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
    for (const status of [403, 503, 200]) {
      const r = detectBotBlock({
        status,
        headers: { server: 'cloudflare', 'cf-ray': 'abc' },
        body,
      });
      assert.equal(r.blocked, true, `status ${status}`);
      assert.equal(r.vendor, 'Cloudflare');
    }
  });

  test('Cloudflare says so in a header', () => {
    const r = detectBotBlock({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '' });
    assert.deepEqual([r.blocked, r.vendor], [true, 'Cloudflare']);
  });

  test('plain refusals: 401, 403, 406, 429, 451 and LinkedIn’s 999', () => {
    for (const status of [401, 403, 406, 429, 451, 999]) {
      const r = detectBotBlock({ status, body: 'no' });
      assert.equal(r.blocked, true, String(status));
      assert.match(r.reason, new RegExp(String(status)));
    }
  });

  test('other firewalls’ pages', () => {
    const cases = [
      ['Imperva', '<h1>Pardon Our Interruption</h1>'],
      ['Imperva', 'Request unsuccessful. Incapsula incident ID: 123-456'],
      ['HUMAN', '<div id="px-captcha"></div>'],
      ['DataDome', '<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>'],
      [
        'Akamai',
        '<h1>Access Denied</h1>You don\'t have permission to access "http://example.com/" on this server. Reference #18.5a',
      ],
      ['Sucuri', 'Access Denied - Sucuri Website Firewall'],
      ['Wordfence', 'Your access to this site has been limited by the site owner'],
    ];
    for (const [vendor, body] of cases) {
      const r = detectBotBlock({ status: 200, body });
      assert.deepEqual([r.blocked, r.vendor], [true, vendor], vendor);
    }
  });

  test('a challenge with no known vendor is still a block, with no vendor named', () => {
    const r = detectBotBlock({
      status: 200,
      body: '<p>Please verify you are human to continue.</p>',
    });
    assert.equal(r.blocked, true);
    assert.equal(r.vendor, null);
  });

  test('the vendor can come from headers when the page does not name it', () => {
    const r = detectBotBlock({ status: 403, headers: { 'x-datadome': 'protected' }, body: 'nope' });
    assert.equal(r.vendor, 'DataDome');
    assert.equal(
      detectBotBlock({ status: 403, headers: { 'x-sucuri-id': '123' }, body: '' }).vendor,
      'Sucuri',
    );
    assert.equal(
      detectBotBlock({ status: 403, headers: { server: 'AkamaiGHost' }, body: '' }).vendor,
      'Akamai',
    );
  });

  test('a 503 from a firewall that is challenging, but not a plain 503', () => {
    assert.equal(
      detectBotBlock({
        status: 503,
        headers: { server: 'AkamaiGHost' },
        body: 'Complete the captcha challenge',
      }).blocked,
      true,
    );
    assert.equal(detectBotBlock({ status: 503, body: 'Service Unavailable' }).blocked, false);
  });

  test('works on a Buffer body too', () => {
    assert.equal(
      detectBotBlock({ status: 200, body: Buffer.from('<title>Just a moment...</title>') }).blocked,
      true,
    );
  });
});

describe('responses that are not blocks', () => {
  test('a normal page', () => {
    assert.deepEqual(detectBotBlock({ status: 200, headers: {}, body: normalPage }), {
      blocked: false,
      vendor: null,
      reason: 'HTTP 200',
    });
  });

  test('a page that talks about captchas or Cloudflare is still a page', () => {
    const body =
      '<html><body><form>Protected by reCAPTCHA. <div class="g-recaptcha"></div></form><p>We moved our CDN to Cloudflare in 2024 and love it.</p><p>Just a moment of your time, please.</p></body></html>';
    assert.equal(
      detectBotBlock({ status: 200, headers: { server: 'cloudflare', 'cf-ray': 'x' }, body })
        .blocked,
      false,
    );
  });

  test('ordinary errors and redirects are not blocks', () => {
    for (const status of [301, 302, 404, 410, 500, 502]) {
      assert.equal(detectBotBlock({ status, body: 'x' }).blocked, false, String(status));
    }
  });

  test('only the start of a long page is read', () => {
    const body = `${'<p>filler</p>'.repeat(5000)}Just a moment...`;
    assert.equal(detectBotBlock({ status: 200, body }).blocked, false);
  });
});
