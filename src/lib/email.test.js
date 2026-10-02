import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emailNames, renderEmail } from './email.js';
import { emailTokens } from './email-tokens.js';

const context = { baseUrl: 'https://aeocorner.com' };
const sample = { 'verification-code': { code: '482915', expiresMinutes: 10 } };

// Snapshot-style guard: nothing may leak template syntax or JavaScript placeholders into an email.
const LEAKS = [/<%/, /%>/, /\bundefined\b/, /\bnull\b/, /\[object Object\]/, /\{\{/, /\bNaN\b/];

for (const name of emailNames()) {
  test(`${name}: HTML and plain-text variants render with no unreplaced tokens`, () => {
    const email = renderEmail(name, sample[name], context);
    assert.ok(email.subject.length > 0);
    for (const [variant, body] of [
      ['html', email.html],
      ['text', email.text],
    ]) {
      assert.ok(body.length > 100, `${variant} should not be empty`);
      for (const leak of LEAKS) assert.doesNotMatch(body, leak, `${variant} leaks ${leak}`);
    }
    assert.match(email.html, /<!doctype html>/);
    assert.doesNotMatch(email.text, /<[a-z][^>]*>/i, 'plain text must contain no HTML tags');
    assert.doesNotMatch(
      email.text,
      /&(amp|lt|gt|quot|#39);/,
      'plain text must not be HTML-escaped',
    );
  });
}

test('verification-code: the code and expiry appear in both variants and the subject', () => {
  const email = renderEmail('verification-code', sample['verification-code'], context);
  assert.equal(email.subject, 'Your AEO Corner code: 482915');
  for (const body of [email.html, email.text]) {
    assert.match(body, /482915/);
    assert.match(body, /10 minutes/);
  }
  assert.match(email.html, /aeocorner\.com/);
  assert.match(email.text, /https:\/\/aeocorner\.com/);
});

test('the unsubscribe link only appears when one is supplied (marketing emails only)', () => {
  const without = renderEmail('verification-code', sample['verification-code'], context);
  assert.doesNotMatch(without.html, /Unsubscribe/);
  assert.doesNotMatch(without.text, /Unsubscribe/);
  const withLink = renderEmail('verification-code', sample['verification-code'], {
    ...context,
    unsubscribeUrl: 'https://aeocorner.com/unsubscribe/abc',
  });
  assert.match(withLink.html, /Unsubscribe/);
  assert.match(withLink.text, /Unsubscribe: https:\/\/aeocorner\.com\/unsubscribe\/abc/);
});

test('HTML output escapes data; plain text does not double-escape', () => {
  const email = renderEmail('verification-code', { code: '<b>1</b>', expiresMinutes: 10 }, context);
  assert.doesNotMatch(email.html, /<b>1<\/b>/);
  assert.match(email.html, /&lt;b&gt;1&lt;\/b&gt;/);
});

test('an unknown template is an error, not an empty email', () => {
  assert.throws(() => renderEmail('nope', {}, context), /Unknown email template/);
});

test('email colours match the design tokens in tailwind/tokens.css', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tailwind', 'tokens.css'),
    'utf8',
  );
  for (const [name, hex] of Object.entries(emailTokens)) {
    const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
    assert.ok(match, `--color-${name} is missing from tokens.css`);
    assert.equal(
      match[1].toLowerCase(),
      hex.toLowerCase(),
      `--color-${name} drifted from email-tokens.js`,
    );
  }
});
