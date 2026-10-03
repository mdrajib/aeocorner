import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emailDomain, ipPrefix, isDisposableEmail, mailboxKey } from './audit-abuse.js';

describe('what counts as the same mailbox', () => {
  test('case, +tags and (for Gmail) dots do not make a new address', () => {
    const one = mailboxKey('Jo.Smith+audit2@gmail.com');
    assert.equal(one, 'josmith@gmail.com');
    assert.equal(mailboxKey('josmith@googlemail.com'), one);
    assert.equal(mailboxKey('  JOSMITH+x+y@GMAIL.COM '), one);
  });

  test('dots matter on other providers, and the +tag is dropped everywhere', () => {
    assert.equal(mailboxKey('jo.smith@acme.com'), 'jo.smith@acme.com');
    assert.equal(mailboxKey('jo+tag@acme.com'), 'jo@acme.com');
  });

  test('a text with no usable address is returned as it is, never throws', () => {
    assert.equal(mailboxKey('nonsense'), 'nonsense');
    assert.equal(mailboxKey('@acme.com'), '@acme.com');
    assert.equal(emailDomain('A@Acme.COM'), 'acme.com');
  });
});

describe('the network of an IP address', () => {
  test('IPv4 gives its /24, including when written as an IPv4-mapped IPv6 address', () => {
    assert.equal(ipPrefix('203.0.113.77'), '203.0.113.0/24');
    assert.equal(ipPrefix('::ffff:203.0.113.77'), '203.0.113.0/24');
  });

  test('IPv6 gives its /64, short forms included', () => {
    assert.equal(ipPrefix('2001:db8:abcd:12:1:2:3:4'), '2001:db8:abcd:12::/64');
    assert.equal(ipPrefix('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipPrefix('::1'), '0:0:0:0::/64');
  });

  test('anything that is not an IP gives null', () => {
    const bad = [
      '',
      null,
      undefined,
      'abc',
      '1.2.3',
      '1:2:3',
      '2001:::1',
      'g::1',
      '1:2:3:4:5:6:7:8:9',
    ];
    for (const value of bad) assert.equal(ipPrefix(value), null, String(value));
  });
});

describe('throwaway email addresses', () => {
  test('known providers and their subdomains are caught; ordinary domains are not', () => {
    assert.equal(isDisposableEmail('x@mailinator.com'), true);
    assert.equal(isDisposableEmail('x@Mail.YopMail.com'), true);
    assert.equal(isDisposableEmail('x@acme.com'), false);
    assert.equal(isDisposableEmail('x@gmail.com'), false);
    assert.equal(isDisposableEmail('x@notmailinator.com'), false);
  });
});
