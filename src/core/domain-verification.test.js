import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  dnsRecord,
  fileProof,
  fileProves,
  isVerificationToken,
  newVerificationToken,
  txtProves,
} from './domain-verification.js';

const token = newVerificationToken();

describe('tokens', () => {
  test('are 128 random bits as hex, and never repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i += 1) {
      const t = newVerificationToken();
      assert.match(t, /^[0-9a-f]{32}$/);
      seen.add(t);
    }
    assert.equal(seen.size, 500);
    assert.equal(isVerificationToken(token), true);
    assert.equal(isVerificationToken('abc'), false);
    assert.equal(isVerificationToken(null), false);
  });
});

describe('what the customer is asked to publish', () => {
  test('a TXT record on a name of ours under their domain', () => {
    assert.deepEqual(dnsRecord('acme.test', token), {
      type: 'TXT',
      name: '_aeocorner.acme.test',
      value: `aeocorner-verification=${token}`,
    });
  });

  test('a file under /.well-known/ holding the token', () => {
    const f = fileProof('acme.test', token);
    assert.equal(f.url, 'https://acme.test/.well-known/aeocorner-verification.txt');
    assert.equal(f.body, token);
  });
});

describe('txtProves', () => {
  test('accepts the record, with split chunks, case and spaces ignored', () => {
    const wanted = `aeocorner-verification=${token}`;
    assert.equal(txtProves([[wanted]], token), true);
    assert.equal(
      txtProves([['v=spf1 -all'], [wanted.slice(0, 20), wanted.slice(20)]], token),
      true,
    );
    assert.equal(txtProves([[`  ${wanted.toUpperCase()} `]], token), true);
  });

  test('refuses another token, a record that only contains ours, and garbage', () => {
    const other = newVerificationToken();
    assert.equal(txtProves([[`aeocorner-verification=${other}`]], token), false);
    assert.equal(txtProves([[`x aeocorner-verification=${token} y`]], token), false);
    assert.equal(txtProves(null, token), false);
    assert.equal(txtProves([null, 5, 'x'], token), false);
    assert.equal(txtProves([[`aeocorner-verification=${token}`]], 'short'), false);
  });
});

describe('fileProves', () => {
  test('accepts the token alone on the first line, with a BOM or line endings', () => {
    assert.equal(fileProves(token, token), true);
    assert.equal(fileProves(String.fromCharCode(0xfeff) + token + '\r\n', token), true);
    assert.equal(fileProves(`\n\n${token}\nmore`, token), true);
  });

  test('refuses a page that merely mentions it, another token, empty text and non-text', () => {
    assert.equal(fileProves(`<html>${token}</html>`, token), false);
    assert.equal(fileProves(`your code is ${token}`, token), false);
    assert.equal(fileProves(newVerificationToken(), token), false);
    assert.equal(fileProves('', token), false);
    assert.equal(fileProves(Buffer.from(token), token), false);
  });
});
