import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fromApiUser, fromWebhookData, verifiedAddresses } from './clerk-user.js';
import { csrfProtection, csrfToken } from './csrf.js';
import { safeNext } from './return-to.js';

describe('safeNext (where to go after sign-in)', () => {
  test('keeps real in-app paths, with their query string', () => {
    assert.equal(safeNext('/app'), '/app');
    assert.equal(safeNext('/app/o/01ABC/settings?notice=x'), '/app/o/01ABC/settings?notice=x');
    assert.equal(safeNext('/invite/abc_DEF-123'), '/invite/abc_DEF-123');
  });

  test('anything else falls back to /app', () => {
    for (const bad of [
      undefined,
      null,
      '',
      'app',
      'https://evil.test/app',
      '//evil.test/app',
      '/\\evil.test',
      '/app\r\nSet-Cookie: x=1',
      '/app\u0000',
      'javascript:alert(1)',
      '/',
      '/sign-in',
      '/application',
      '/appendix',
      '/methodology',
      '/app/../admin',
      `/app/${'x'.repeat(1100)}`,
      ['/app'],
      { a: 1 },
    ]) {
      assert.equal(safeNext(bad), '/app', JSON.stringify(bad)?.slice(0, 40));
    }
  });

  test('honours a different fallback', () => {
    assert.equal(safeNext('https://evil.test', '/app/new-org'), '/app/new-org');
  });
});

describe('CSRF tokens', () => {
  const run = (middleware, req) => {
    let outcome = 'blocked';
    middleware({ method: 'POST', body: {}, get: () => undefined, ...req }, {}, (err) => {
      outcome = err ? `error ${err.status}` : 'allowed';
    });
    return outcome;
  };
  const protect = csrfProtection({ secret: 's3cret' });

  test('a token is tied to one session and one secret', () => {
    assert.equal(csrfToken('s3cret', 'sess_1'), csrfToken('s3cret', 'sess_1'));
    assert.notEqual(csrfToken('s3cret', 'sess_1'), csrfToken('s3cret', 'sess_2'));
    assert.notEqual(csrfToken('s3cret', 'sess_1'), csrfToken('other', 'sess_1'));
  });

  test('safe methods pass without a token', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(run(protect, { method }), 'allowed');
    }
  });

  test('a form field or a header carrying the right token passes', () => {
    const session = { sessionId: 'sess_1' };
    const token = csrfToken('s3cret', 'sess_1');
    assert.equal(run(protect, { session, body: { _csrf: token } }), 'allowed');
    const header = { get: (h) => (h === 'x-csrf-token' ? token : undefined) };
    assert.equal(run(protect, { session, ...header }), 'allowed');
  });

  test('missing, wrong, other-session and no-session requests get a 403', () => {
    const session = { sessionId: 'sess_1' };
    assert.equal(run(protect, { session }), 'error 403');
    assert.equal(run(protect, { session, body: { _csrf: 'nope' } }), 'error 403');
    assert.equal(
      run(protect, { session, body: { _csrf: csrfToken('s3cret', 'sess_2') } }),
      'error 403',
    );
    assert.equal(run(protect, { body: { _csrf: csrfToken('s3cret', 'sess_1') } }), 'error 403');
    assert.equal(run(protect, { session, body: { _csrf: ['a', 'b'] } }), 'error 403');
  });
});

describe('Clerk user shapes', () => {
  test('a webhook payload becomes our user', () => {
    const user = fromWebhookData({
      id: 'user_1',
      first_name: 'Maya',
      last_name: 'Chen',
      username: null,
      image_url: 'https://img.test/a.png',
      primary_email_address_id: 'idn_2',
      updated_at: 1_700_000_000_000,
      email_addresses: [
        { id: 'idn_1', email_address: 'Old@Example.test', verification: { status: 'verified' } },
        { id: 'idn_2', email_address: 'Maya@Example.test', verification: { status: 'verified' } },
      ],
    });
    assert.equal(user.id, 'user_1');
    assert.equal(user.email, 'maya@example.test', 'the primary address, lowercased');
    assert.equal(user.name, 'Maya Chen');
    assert.equal(user.updatedAt, 1_700_000_000_000);
    assert.deepEqual(verifiedAddresses(user), ['old@example.test', 'maya@example.test']);
  });

  test('an unverified primary does not beat a verified address for the main email', () => {
    const user = fromWebhookData({
      id: 'user_2',
      primary_email_address_id: 'idn_1',
      email_addresses: [
        { id: 'idn_1', email_address: 'typo@example.test', verification: { status: 'unverified' } },
        { id: 'idn_2', email_address: 'real@example.test', verification: { status: 'verified' } },
      ],
    });
    assert.equal(user.email, 'real@example.test');
    assert.deepEqual(verifiedAddresses(user), ['real@example.test']);
  });

  test('names fall back to the username, then to empty', () => {
    assert.equal(
      fromWebhookData({ id: 'u', username: 'mayac', email_addresses: [] }).name,
      'mayac',
    );
    assert.equal(fromWebhookData({ id: 'u', email_addresses: [] }).name, '');
    assert.equal(fromWebhookData({ id: 'u' }).email, '');
  });

  test('the Backend API object (camelCase) maps the same way', () => {
    const user = fromApiUser({
      id: 'user_3',
      firstName: 'Sam',
      lastName: null,
      imageUrl: '',
      primaryEmailAddressId: 'idn_9',
      updatedAt: 5,
      emailAddresses: [
        { id: 'idn_9', emailAddress: 'SAM@example.test', verification: { status: 'verified' } },
        { id: 'idn_8', emailAddress: 'other@example.test', verification: null },
      ],
    });
    assert.deepEqual(
      [user.email, user.name, user.imageUrl, user.updatedAt],
      ['sam@example.test', 'Sam', null, 5],
    );
    assert.deepEqual(verifiedAddresses(user), ['sam@example.test']);
  });
});
