import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { closeRedis, createRedis } from '../../src/lib/redis.js';

/**
 * A Redis connection for the queue tests, with a private key prefix.
 *
 * Reads TEST_REDIS_URL only (never REDIS_URL, so a test can't touch the development queue). On a local Redis it
 * refuses database 0: that is where another project on the same machine may keep its data. Every key a test
 * creates starts with a random prefix, and cleanup removes only keys under that prefix. Nothing here ever
 * flushes a database.
 */
export function connectTestRedis({ role = 'worker' } = {}) {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error('Set TEST_REDIS_URL to run the queue tests.');
  const { hostname, pathname } = new URL(url);
  const database = Number(pathname.replace('/', '') || 0);
  const isLocal = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
  if (isLocal && database === 0) {
    throw new Error(
      'Refusing to run tests in database 0 of a local Redis (another project may be using it). ' +
        'Use TEST_REDIS_URL=redis://127.0.0.1:6379/15',
    );
  }

  const prefix = `aeotest${randomBytes(4).toString('hex')}`;
  const redis = createRedis(url, { role, name: `aeo-test-${prefix}` });

  async function removeOwnKeys() {
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
      cursor = next;
      if (found.length) await redis.del(...found);
    } while (cursor !== '0');
  }

  return {
    redis,
    prefix,
    removeOwnKeys,
    async close() {
      await removeOwnKeys();
      await closeRedis(redis);
    },
  };
}
