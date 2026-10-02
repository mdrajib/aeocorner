import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blockedHostname, classifyIp, isIpLiteral, isPublicIp, unbracket } from './ip-guard.js';

const blocked = (ip) => {
  const verdict = classifyIp(ip);
  assert.equal(verdict.allowed, false, `${ip} must be refused`);
  return verdict.reason;
};
const allowed = (ip) => assert.equal(isPublicIp(ip), true, `${ip} is an ordinary public address`);

describe('IPv4 addresses the crawler must never connect to', () => {
  test('loopback, the whole 127/8 block', () => {
    assert.equal(blocked('127.0.0.1'), 'loopback');
    assert.equal(blocked('127.255.255.254'), 'loopback');
  });

  test('the cloud metadata address and the rest of link-local', () => {
    assert.equal(blocked('169.254.169.254'), 'cloud-metadata');
    assert.equal(blocked('169.254.0.1'), 'link-local');
    assert.equal(blocked('169.254.170.2'), 'link-local'); // the AWS container credentials endpoint
    assert.equal(blocked('169.254.255.255'), 'link-local');
  });

  test('RFC 1918 private networks, at both edges of each block', () => {
    for (const ip of ['10.0.0.0', '10.255.255.255', '172.16.0.0', '172.31.255.255']) {
      assert.equal(blocked(ip), 'private');
    }
    assert.equal(blocked('192.168.0.1'), 'private');
    assert.equal(blocked('192.168.255.255'), 'private');
  });

  test('the carrier-grade NAT block, which includes Alibaba Cloud metadata', () => {
    assert.equal(blocked('100.64.0.1'), 'cgnat');
    assert.equal(blocked('100.100.100.200'), 'cgnat');
    assert.equal(blocked('100.127.255.255'), 'cgnat');
  });

  test('this-network, multicast, reserved and broadcast', () => {
    assert.equal(blocked('0.0.0.0'), 'this-network');
    assert.equal(blocked('224.0.0.1'), 'multicast');
    assert.equal(blocked('239.255.255.255'), 'multicast');
    assert.equal(blocked('240.0.0.1'), 'reserved');
    assert.equal(blocked('255.255.255.255'), 'reserved');
  });

  test('documentation and benchmarking ranges', () => {
    for (const ip of ['192.0.2.1', '198.51.100.7', '203.0.113.9']) {
      assert.equal(blocked(ip), 'documentation');
    }
    assert.equal(blocked('198.18.0.1'), 'benchmarking');
    assert.equal(blocked('198.19.255.255'), 'benchmarking');
  });

  test('addresses just outside each blocked block are fine (the edges are exact)', () => {
    for (const ip of [
      '9.255.255.255',
      '11.0.0.0',
      '100.63.255.255',
      '100.128.0.0',
      '126.255.255.255',
      '128.0.0.1',
      '169.253.255.255',
      '169.255.0.0',
      '172.15.255.255',
      '172.32.0.0',
      '192.167.255.255',
      '192.169.0.0',
      '198.17.255.255',
      '198.20.0.0',
      '223.255.255.255',
    ]) {
      allowed(ip);
    }
  });

  test('ordinary public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '151.101.1.69']) allowed(ip);
  });
});

describe('IPv6 addresses the crawler must never connect to', () => {
  test('unspecified and loopback', () => {
    assert.equal(blocked('::'), 'unspecified-or-compatible');
    assert.equal(blocked('::1'), 'unspecified-or-compatible');
    assert.equal(blocked('0:0:0:0:0:0:0:1'), 'unspecified-or-compatible');
  });

  test('an IPv4 address wrapped in IPv6 is judged as the IPv4 address', () => {
    assert.equal(blocked('::ffff:127.0.0.1'), 'loopback');
    assert.equal(blocked('::ffff:7f00:1'), 'loopback'); // the same address in hex
    assert.equal(blocked('::ffff:10.1.2.3'), 'private');
    assert.equal(blocked('::ffff:169.254.169.254'), 'cloud-metadata');
    assert.equal(blocked('0:0:0:0:0:ffff:c0a8:101'), 'private'); // 192.168.1.1
    allowed('::ffff:8.8.8.8');
  });

  test('link-local, site-local and unique-local (which holds the AWS IPv6 metadata address)', () => {
    assert.equal(blocked('fe80::1'), 'link-local');
    assert.equal(blocked('febf:ffff::1'), 'link-local');
    assert.equal(blocked('fec0::1'), 'site-local');
    assert.equal(blocked('fc00::1'), 'private');
    assert.equal(blocked('fd00:ec2::254'), 'private');
    assert.equal(blocked('fdff:ffff::1'), 'private');
  });

  test('a scoped address ("fe80::1%eth0") is refused', () => {
    assert.equal(blocked('fe80::1%eth0'), 'not-an-ip-address');
  });

  test('multicast, documentation, discard, Teredo, 6to4 and NAT64 (all of which can carry an IPv4 target)', () => {
    assert.equal(blocked('ff02::1'), 'multicast');
    assert.equal(blocked('2001:db8::1'), 'documentation');
    assert.equal(blocked('100::1'), 'discard');
    assert.equal(blocked('2001::1'), 'ietf-protocol');
    assert.equal(blocked('2002:7f00:1::'), '6to4'); // 127.0.0.1
    assert.equal(blocked('2002:a9fe:a9fe::1'), '6to4'); // 169.254.169.254
    assert.equal(blocked('64:ff9b::7f00:1'), 'nat64');
    assert.equal(blocked('64:ff9b::169.254.169.254'), 'nat64');
  });

  test('ordinary public addresses', () => {
    for (const ip of [
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '2a00:1450:4009:81f::200e',
      '2400:cb00::1',
    ]) {
      allowed(ip);
    }
  });
});

describe('anything that is not a clean address is refused', () => {
  test('hostnames, empty strings and junk', () => {
    for (const text of [
      '',
      'example.com',
      'localhost',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '1::2::3',
    ]) {
      assert.equal(blocked(text), 'not-an-ip-address');
    }
  });

  test('IPv4 written in tricky ways is not accepted as an address (the URL parser normalises these first)', () => {
    for (const text of ['0x7f.0.0.1', '2130706433', '0177.0.0.1', '127.1']) {
      assert.equal(classifyIp(text).allowed, false, text);
    }
  });
});

describe('URL hosts', () => {
  test('the URL parser turns every spelling of loopback into one the guard understands', () => {
    for (const spelled of [
      'http://2130706433/',
      'http://0x7f.1/',
      'http://0177.0.0.1/',
      'http://127.1/',
    ]) {
      const host = new URL(spelled).hostname;
      assert.equal(host, '127.0.0.1', spelled);
      assert.equal(isIpLiteral(host), true);
      assert.equal(classifyIp(host).allowed, false);
    }
  });

  test('IPv6 hosts arrive in brackets', () => {
    const host = new URL('http://[::ffff:7f00:1]/').hostname;
    assert.equal(isIpLiteral(host), true);
    assert.equal(unbracket(host), '::ffff:7f00:1');
    assert.equal(classifyIp(unbracket(host)).allowed, false);
  });

  test('a name is not an IP literal', () => {
    assert.equal(isIpLiteral('example.com'), false);
  });

  test('internal-only names are refused outright', () => {
    for (const name of [
      'localhost',
      'LOCALHOST.',
      'app.localhost',
      'printer.local',
      'db.internal',
      'metadata.google.internal',
      'metadata',
      'router.lan',
      'host.localdomain',
    ]) {
      assert.equal(blockedHostname(name), 'internal-hostname', name);
    }
  });

  test('ordinary names are not', () => {
    for (const name of [
      'example.com',
      'www.example.co.uk',
      'localhost.example.com',
      'internal.com',
    ]) {
      assert.equal(blockedHostname(name), null, name);
    }
  });
});
