import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSecretBox, parseMasterKey } from './secrets.js';

const k1 = { version: 1, key: randomBytes(32) };
const k2 = { version: 2, key: randomBytes(32) };

test('a secret round-trips as text and as JSON, and the stored bytes do not contain it', () => {
  const box = createSecretBox({ current: k1 });
  const sealed = box.encrypt(
    { appPassword: 'abcd efgh ijkl mnop', hmacSecret: 'topsecret' },
    'wordpress:1:2',
  );
  assert.ok(!sealed.ciphertext.includes('topsecret') && !sealed.ciphertext.includes('abcd'));
  assert.equal(sealed.keyVersion, 1);
  assert.ok(sealed.wrappedDek.length <= 512 && sealed.ciphertext.length <= 4096);
  assert.deepEqual(box.decryptJson(sealed, 'wordpress:1:2'), {
    appPassword: 'abcd efgh ijkl mnop',
    hmacSecret: 'topsecret',
  });
  const text = box.encrypt('plain', 'c');
  assert.equal(box.decryptText(text, 'c'), 'plain');
});

test('two encryptions of the same secret differ (fresh key and nonce every time)', () => {
  const box = createSecretBox({ current: k1 });
  const a = box.encrypt('same', 'c');
  const b = box.encrypt('same', 'c');
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.notDeepEqual(a.wrappedDek, b.wrappedDek);
});

test('a secret copied to another integration does not open (the context is bound in)', () => {
  const box = createSecretBox({ current: k1 });
  const sealed = box.encrypt('mine', 'wordpress:1:2');
  assert.throws(() => box.decryptText(sealed, 'wordpress:1:3'), /could not be opened/);
});

test('tampering with the ciphertext, the wrapped key or the version is detected', () => {
  const box = createSecretBox({ current: k1 });
  const sealed = box.encrypt('mine', 'c');
  const flip = (buf, at) => {
    const copy = Buffer.from(buf);
    copy[at] ^= 1;
    return copy;
  };
  assert.throws(
    () => box.decryptText({ ...sealed, ciphertext: flip(sealed.ciphertext, 14) }, 'c'),
    /could not be opened/,
  );
  assert.throws(
    () =>
      box.decryptText(
        { ...sealed, ciphertext: flip(sealed.ciphertext, sealed.ciphertext.length - 1) },
        'c',
      ),
    /could not be opened/,
  );
  assert.throws(
    () => box.decryptText({ ...sealed, wrappedDek: flip(sealed.wrappedDek, 20) }, 'c'),
    /could not be opened/,
  );
  assert.throws(
    () => box.decryptText({ ...sealed, keyVersion: 9 }, 'c'),
    /No master key for version 9/,
  );
  assert.throws(
    () => box.decryptText({ ...sealed, ciphertext: Buffer.alloc(5) }, 'c'),
    /could not be opened|damaged/,
  );
});

test('the error never contains the secret or the key', () => {
  const box = createSecretBox({ current: k1 });
  const sealed = box.encrypt('hunter2-secret', 'c');
  try {
    box.decryptText({ ...sealed, wrappedDek: Buffer.alloc(60) }, 'c');
    assert.fail('should throw');
  } catch (err) {
    assert.ok(!String(err.message).includes('hunter2'));
    assert.ok(!String(err.stack).includes(k1.key.toString('hex')));
  }
});

test('a rotated master key opens old secrets until they are re-wrapped, and rewrap keeps the data intact', () => {
  const old = createSecretBox({ current: k1 }).encrypt({ s: 1 }, 'c');
  const rotated = createSecretBox({ current: k2, previous: [k1] });
  assert.deepEqual(rotated.decryptJson(old, 'c'), { s: 1 });
  const moved = rotated.rewrap(old, 'c');
  assert.equal(moved.keyVersion, 2);
  assert.deepEqual(moved.ciphertext, old.ciphertext);
  assert.deepEqual(rotated.decryptJson(moved, 'c'), { s: 1 });
  const onlyNew = createSecretBox({ current: k2 });
  assert.deepEqual(
    onlyNew.decryptJson(moved, 'c'),
    { s: 1 },
    'the old key is not needed after the rewrap',
  );
  assert.throws(() => onlyNew.decryptJson(old, 'c'), /No master key for version 1/);
  assert.throws(() => rotated.rewrap(old, 'other'), /could not be opened/);
});

test('master keys must be 32 bytes', () => {
  assert.equal(parseMasterKey(randomBytes(32).toString('base64')).length, 32);
  assert.equal(parseMasterKey(randomBytes(32).toString('base64url')).length, 32);
  assert.throws(() => parseMasterKey(randomBytes(16).toString('base64')), RangeError);
  assert.throws(() => parseMasterKey(''), RangeError);
  assert.throws(
    () => createSecretBox({ current: { version: 1, key: Buffer.alloc(8) } }),
    RangeError,
  );
});
