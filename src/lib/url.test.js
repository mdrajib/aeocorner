import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWebsite } from './url.js';

test('accepts what people actually type', () => {
  for (const [input, domain] of [
    ['yourcompany.com', 'yourcompany.com'],
    ['  YourCompany.com  ', 'yourcompany.com'],
    ['www.yourcompany.com', 'yourcompany.com'],
    ['https://www.yourcompany.com/', 'yourcompany.com'],
    ['http://shop.example.co.uk/about', 'shop.example.co.uk'],
    ['example.com/pricing?x=1', 'example.com'],
  ]) {
    const r = normalizeWebsite(input);
    assert.equal(r.ok, true, input);
    assert.equal(r.domain, domain, input);
  }
});

test('adds https:// when the scheme is missing and keeps the path', () => {
  assert.equal(normalizeWebsite('example.com/pricing').url, 'https://example.com/pricing');
  assert.equal(normalizeWebsite('http://example.com').url, 'http://example.com');
});

test('rejects empty input with a specific message', () => {
  const r = normalizeWebsite('   ');
  assert.equal(r.ok, false);
  assert.match(r.message, /Enter your website address/);
});

test('rejects things that are not public website addresses', () => {
  for (const input of [
    'localhost',
    'http://localhost:3000',
    '127.0.0.1',
    'http://169.254.169.254/latest/meta-data',
    '[::1]',
    'intranet',
    'foo.123',
    'ftp://example.com',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'not a website',
    'exa mple.com',
    '-bad-.com',
    'https://example.com:8080',
    'a'.repeat(2100),
  ]) {
    assert.equal(normalizeWebsite(input).ok, false, input);
  }
});

test('accepts standard ports written out and internationalised domains', () => {
  assert.equal(normalizeWebsite('https://example.com:443').ok, true);
  assert.equal(normalizeWebsite('münchen.de').ok, true);
});
