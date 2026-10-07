import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Object storage for raw payloads (MVP §7.1 principle 4: "raw-first storage"): the exact bytes we fetched, kept
 * so a better extractor can be run over them later without fetching again. DigitalOcean Spaces speaks the S3
 * protocol, so the real store is the AWS S3 client pointed at a Spaces address.
 *
 * Two stores share one small interface:
 *   - the Spaces store, for staging and production
 *   - a file store on local disk, for a laptop with no Spaces keys (development and tests only)
 *
 * Keys are CONTENT-ADDRESSED: the name contains a hash of the bytes. Writing the same bytes twice (a retried
 * job) writes the same key, and different bytes can never overwrite each other. Raw data is immutable.
 *
 * The store never sees a customer's identity. Keys carry a date and a hash, nothing else; who a payload belongs
 * to is recorded in MySQL, which is what tenancy rules protect.
 */

const EXTENSIONS = {
  html: 'html',
  rendered: 'rendered.html',
  robots: 'robots.txt',
  sitemap: 'sitemap.xml',
  llms: 'llms.txt',
  // An AI engine's answer: the provider's raw response and our normalized reading of it, as one JSON document.
  answer: 'json',
};

// Answers live apart from crawled pages, so each can have its own lifecycle rule.
const AREAS = { answer: 'answers' };

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * `crawl/2026/10/<sha256>.html` or `answers/2026/10/<sha256>.json`. The year and month make it possible to apply
 * Spaces' lifecycle rule ("delete raw payloads after 13 months", MVP §8.3) by prefix.
 */
export function rawKey({ kind, body, at = new Date() }) {
  const extension = EXTENSIONS[kind];
  if (!extension) throw new TypeError(`Unknown raw payload kind: ${kind}`);
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${AREAS[kind] ?? 'crawl'}/${y}/${m}/${sha256Hex(body)}.${extension}`;
}

/** S3 metadata travels as HTTP headers: plain ASCII, short. The page URL is percent-encoded and clipped. */
function headerSafe(metadata) {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).map(([k, v]) => [
      k.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      encodeURIComponent(String(v)).slice(0, 500),
    ]),
  );
}
const readMetadata = (metadata) =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).map(([k, v]) => {
      try {
        return [k, decodeURIComponent(v)];
      } catch {
        return [k, v];
      }
    }),
  );

/** A store backed by a Spaces (or any S3-compatible) bucket. `client` can be supplied for tests. */
export function createSpacesStore({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  prefix = '',
  client,
}) {
  const host = new URL(endpoint).hostname;
  const s3 =
    client ??
    new S3Client({
      region,
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // A local or IP-addressed S3 stand-in has no bucket subdomains; Spaces does.
      forcePathStyle: /^(localhost|127\.|\[|\d+\.\d+\.\d+\.\d+$)/.test(host),
      // Since early 2025 the AWS client adds CRC checksums that several S3-compatible services reject.
      // Asking only when an operation requires it keeps Spaces working.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });

  // Only "no such object" means missing. A missing BUCKET (a typo in DO_SPACES_BUCKET) is a 404 too, and must
  // surface as an error instead of looking like an empty store.
  const notFound = (err) => err?.name === 'NoSuchKey' || err?.name === 'NotFound';

  return {
    kind: 'spaces',
    bucket,

    /** Write bytes under `prefix + key`. Idempotent for content-addressed keys. */
    async put({ key, body, contentType = 'application/octet-stream', metadata }) {
      const fullKey = `${prefix}${key}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fullKey,
          Body: body,
          ContentType: contentType,
          Metadata: headerSafe(metadata),
        }),
      );
      return { key: fullKey, bytes: body.length };
    },

    /** `key` is the full key `put` returned. Null if there is no such object. */
    async get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return {
          body: Buffer.from(await res.Body.transformToByteArray()),
          contentType: res.ContentType,
          metadata: readMetadata(res.Metadata),
        };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    async head(key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return {
          bytes: res.ContentLength,
          contentType: res.ContentType,
          metadata: readMetadata(res.Metadata),
        };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },

    prefix,

    close: () => s3.destroy?.(),
  };
}

/**
 * A store on local disk, for development and tests when there are no Spaces keys. Same interface, same keys.
 * Refuses keys that try to climb out of its folder.
 */
export function createFileStore({ dir, prefix = '' }) {
  const root = path.resolve(dir);
  const locate = (key) => {
    const target = path.resolve(root, key);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new RangeError('That key points outside the storage folder');
    }
    return target;
  };
  const exists = async (file) => {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  };

  return {
    kind: 'file',
    root,
    prefix,

    async put({ key, body, contentType = 'application/octet-stream', metadata }) {
      const fullKey = `${prefix}${key}`;
      const file = locate(fullKey);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body);
      await writeFile(
        `${file}.meta.json`,
        JSON.stringify({ contentType, metadata: headerSafe(metadata) }),
      );
      return { key: fullKey, bytes: body.length };
    },

    async get(key) {
      const file = locate(key);
      if (!(await exists(file))) return null;
      const meta = JSON.parse(await readFile(`${file}.meta.json`, 'utf8').catch(() => '{}'));
      return {
        body: await readFile(file),
        contentType: meta.contentType,
        metadata: readMetadata(meta.metadata),
      };
    },

    async head(key) {
      const file = locate(key);
      if (!(await exists(file))) return null;
      const meta = JSON.parse(await readFile(`${file}.meta.json`, 'utf8').catch(() => '{}'));
      return {
        bytes: (await stat(file)).size,
        contentType: meta.contentType,
        metadata: readMetadata(meta.metadata),
      };
    },

    async delete(key) {
      const file = locate(key);
      await rm(file, { force: true });
      await rm(`${file}.meta.json`, { force: true });
    },

    close: () => {},
  };
}

/**
 * The store this environment should use: Spaces when it is configured, local disk otherwise. Production must
 * have Spaces; writing customer payloads to one server's disk would lose them at the next rebuild.
 */
export function createObjectStore(config, { logger, localDir = '.data/spaces' } = {}) {
  if (config.spaces) return createSpacesStore(config.spaces);
  if (config.isProduction) {
    throw new Error(
      'Object storage (Spaces) must be configured in production: set the DO_SPACES_* variables.',
    );
  }
  logger?.warn(
    { dir: localDir },
    'DO_SPACES_* is not set: raw pages are being written to local disk. Fine for development, never for production.',
  );
  return createFileStore({ dir: localDir, prefix: `${config.appEnv}/` });
}

/**
 * Store one raw payload and say where it went. The same bytes always land on the same key, so this is safe to
 * repeat: a retried job writes the same object again.
 *
 * @returns {{ key: string, sha256: string, bytes: number }}
 */
export async function storeRaw(
  store,
  { kind, body, contentType, url, status, fetchedAt = new Date() },
) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const key = rawKey({ kind, body: bytes, at: fetchedAt });
  const { key: stored } = await store.put({
    key,
    body: bytes,
    contentType,
    metadata: {
      'source-url': url,
      'http-status': status ?? '',
      'fetched-at': fetchedAt.toISOString(),
      sha256: sha256Hex(bytes),
    },
  });
  return { key: stored, sha256: sha256Hex(bytes), bytes: bytes.length };
}
