# ADR-0001: Prisma 7 connection config lives in `prisma.config.ts`, not `schema.prisma`

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-28 |
| **Context of discovery** | [BUILD_PLAN.md Phase 0](../BUILD_PLAN.md#phase-0--prerequisites--project-setup), while generating `schema.prisma` from the migrated local database |

## Context

[DATABASE_SCHEMA.md §10.2](../DATABASE_SCHEMA.md#102-orm-prisma-7-with-sql-first-migrations) was written and tested against Prisma 7.10.0 before this project had its own `schema.prisma`. Writing the real file for the first time, the classic pattern —

```prisma
datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}
```

— fails schema validation on Prisma 7.10.0 (`P1012`):

> The datasource property `url` is no longer supported in schema files. Move connection URLs for Migrate to `prisma.config.ts` and pass either `adapter` for a direct database connection or `accelerateUrl` for Accelerate to the `PrismaClient` constructor.

Confirmed against `node_modules/@prisma/config`'s own type definitions (`PrismaConfig.datasource: { url?, shadowDatabaseUrl? }`) rather than guessed from the error text alone. This is a genuine breaking change in Prisma 7's config model, not a version-pinning mistake — `@prisma/config` explicitly disables its own `.env` autoloading when reading `prisma.config.ts` (`dotenv: false` in its `c12` loader call), so the config file must load `.env` itself.

## Decision

- `prisma/schema.prisma` keeps only `datasource db { provider = "mysql" }` — no `url`.
- A new `prisma.config.ts` at the repo root supplies the connection for CLI commands (`migrate deploy`, `migrate dev`, `db pull`, `studio`):

  ```ts
  import 'dotenv/config';
  import { defineConfig, env } from 'prisma/config';

  export default defineConfig({
    schema: 'prisma/schema.prisma',
    datasource: {
      url: env('DATABASE_URL'),
      shadowDatabaseUrl: env('SHADOW_DATABASE_URL'),
    },
  });
  ```
- At **runtime**, `src/db/`'s Prisma client is instead constructed with the `@prisma/adapter-mariadb` driver adapter (`new PrismaClient({ adapter })`), per the stack decision already in [MVP §7.4](../MVP.md#74-tech-stack) — the CLI's `datasource.url` and the app's runtime `adapter` are two separate connection paths that happen to point at the same database.
- `prisma.config.ts` is plain TypeScript even though the app itself is plain JavaScript ([CLAUDE.md](../../CLAUDE.md)) — the Prisma CLI executes it with its own bundled loader and needs no project-wide TypeScript toolchain.

## Consequences

- `docs/DATABASE_SCHEMA.md` §10.2's description of the Prisma setup is now slightly incomplete (it doesn't mention `prisma.config.ts`); this ADR is the authoritative record until that section gets a documentation pass.
- Anyone running a Prisma CLI command locally needs a `.env` with `DATABASE_URL` (and `SHADOW_DATABASE_URL` for `migrate dev`) — `prisma.config.ts` will throw if they're missing, since `@prisma/config` won't load `.env` on its own.
- If Prisma 8 (currently RC, per [CLAUDE.md](../../CLAUDE.md)'s "don't reopen" list) changes this shape again, re-verify this ADR before upgrading.
