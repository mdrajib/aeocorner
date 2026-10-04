import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for the credentials of a customer's integrations (MVP §7.11, DATABASE_SCHEMA `integrations`).
 *
 * Each secret is encrypted with its own random 256-bit data key (AES-256-GCM); the data key is itself encrypted
 * ("wrapped") with a master key that lives in the environment, never in the database or the repository. A copy of the
 * database alone therefore opens nothing, and rotating the master key means re-wrapping 60-byte data keys, not
 * re-encrypting every secret.
 *
 * Both layers are bound to a context string (`wordpress:<org>:<project>`) as GCM additional data: a ciphertext copied
 * from one integration row to another does not open. Stored shape, the three integration columns:
 *   ciphertext  iv(12) | encrypted | tag(16)
 *   wrappedDek  iv(12) | encrypted data key(32) | tag(16)
 *   keyVersion  which master key wrapped it
 *
 * The worker opens secrets; nothing renders or logs one. `open` throws a plain Error that never contains the secret.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function seal(key, plaintext, aad) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
}

function unseal(key, blob, aad) {
  if (!Buffer.isBuffer(blob) || blob.length < IV_BYTES + TAG_BYTES)
    throw new Error('The stored secret is damaged.');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const body = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** A master key as given in the environment: 32 bytes, base64 (or base64url). */
export function parseMasterKey(value) {
  const key = Buffer.from(String(value ?? '').trim(), 'base64');
  if (key.length !== KEY_BYTES)
    throw new RangeError('A secrets master key must be 32 bytes, base64-encoded.');
  return key;
}

/**
 * @param {{ current: {version: number, key: Buffer}, previous?: {version: number, key: Buffer}[] }} keys
 *   `current` wraps new secrets; `previous` keys can still open old ones until they are re-wrapped
 */
export function createSecretBox({ current, previous = [] }) {
  const byVersion = new Map([current, ...previous].map((k) => [k.version, k.key]));
  for (const key of byVersion.values()) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES)
      throw new RangeError('Master keys must be 32-byte buffers.');
  }
  const opens = (blobs, context) => {
    const key = byVersion.get(blobs.keyVersion);
    if (!key) throw new Error(`No master key for version ${blobs.keyVersion}.`);
    try {
      const dek = unseal(key, blobs.wrappedDek, `dek|${context}`);
      return unseal(dek, blobs.ciphertext, `secret|${context}`);
    } catch {
      throw new Error('The stored secret could not be opened (wrong key or it was moved).');
    }
  };
  return {
    currentVersion: current.version,

    /** @returns {{ ciphertext: Buffer, wrappedDek: Buffer, keyVersion: number }} */
    encrypt(value, context) {
      const dek = randomBytes(KEY_BYTES);
      const plaintext = Buffer.from(
        typeof value === 'string' ? value : JSON.stringify(value),
        'utf8',
      );
      return {
        ciphertext: seal(dek, plaintext, `secret|${context}`),
        wrappedDek: seal(current.key, dek, `dek|${context}`),
        keyVersion: current.version,
      };
    },

    /** The text that was encrypted. */
    decryptText(blobs, context) {
      return opens(blobs, context).toString('utf8');
    },

    /** The JSON value that was encrypted. */
    decryptJson(blobs, context) {
      return JSON.parse(opens(blobs, context).toString('utf8'));
    },

    /** Wrap the same data key with the current master key (after a rotation); the ciphertext is untouched. */
    rewrap(blobs, context) {
      const key = byVersion.get(blobs.keyVersion);
      if (!key) throw new Error(`No master key for version ${blobs.keyVersion}.`);
      let dek;
      try {
        dek = unseal(key, blobs.wrappedDek, `dek|${context}`);
      } catch {
        throw new Error('The stored secret could not be opened (wrong key or it was moved).');
      }
      return {
        ciphertext: blobs.ciphertext,
        wrappedDek: seal(current.key, dek, `dek|${context}`),
        keyVersion: current.version,
      };
    },
  };
}
