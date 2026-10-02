import { readFileSync } from 'node:fs';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/client/client.ts';

/**
 * Turn a `mysql://user:pass@host:port/db` URL into the adapter's settings.
 * `?ssl-mode=REQUIRED` (what DigitalOcean's connection string carries) turns on TLS; pass the
 * cluster's CA certificate as a file path in `caCertPath` so the server is verified, not just encrypted.
 */
export function parseDatabaseUrl(databaseUrl, { caCertPath } = {}) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'mysql:') throw new Error('DATABASE_URL must start with mysql://');
  const sslMode = (
    url.searchParams.get('ssl-mode') ??
    url.searchParams.get('sslmode') ??
    ''
  ).toLowerCase();
  const tls = ['required', 'require', 'verify_ca', 'verify_identity', 'true'].includes(sslMode);

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ...(tls && {
      ssl: caCertPath ? { ca: readFileSync(caCertPath, 'utf8') } : { rejectUnauthorized: true },
    }),
  };
}

/**
 * The one Prisma client. Everything is stored and read in UTC (DATABASE_SCHEMA §1): the session time
 * zone is pinned so `CURRENT_TIMESTAMP(3)` defaults agree with the dates the app sends.
 * `connectionLimit` is per process; web + worker together must stay under the cluster's cap (§10.2).
 */
export function createPrisma({ databaseUrl, caCertPath, connectionLimit = 5 }) {
  const adapter = new PrismaMariaDb({
    ...parseDatabaseUrl(databaseUrl, { caCertPath }),
    connectionLimit,
    timezone: 'Z',
    initSql: "SET time_zone = '+00:00'",
  });
  return new PrismaClient({ adapter });
}
