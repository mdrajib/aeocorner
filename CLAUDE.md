# AEO Corner

A self-serve SaaS that shows a brand how often AI answer engines (ChatGPT, Perplexity, Gemini, Google AI Overviews) mention, recommend and cite it compared with competitors. It then helps fix the gaps and proves whether the fixes worked (Measure → Diagnose → Fix → Prove). The reference product is aeoengine.ai. Always write the name as "AEO Corner".

## Current phase: design only

- **There is no application code yet.** The deliverables are the documents in `docs/` and the SQL design files in `docs/db/`.
- Don't scaffold the app (`src/`, `package.json`, `prisma/`) until the user asks to start building. SQL DDL, seed and check files count as design work when asked for.
- Put throwaway test scripts in the session scratchpad, not in the repo.
- The project is not a git repository yet.

## Documents (sources of truth)

| File | Owns |
|---|---|
| `docs/MVP.md` | Product and architecture spec: scope, features F1–F12, methodology, stack (§7.4), repo layout (§7.9), unit economics, timeline, founder decisions (§17) |
| `docs/BUILD_PLAN.md` | The actual build order: 16 phases (0–15) breaking MVP §13.2's weekly timeline into checkable work items and a required-tests checklist per phase. Work through it in order once coding starts |
| `docs/CUSTOMER_JOURNEY.md` | Customer experience stage by stage, system data flow, messages. §7 proposes 6 spec changes: the schema models them, but the MVP feature sections haven't been updated yet |
| `docs/ADMIN_OPERATIONS.md` | Internal admin console, staff roles, runbooks, background jobs, alerts |
| `docs/DATABASE_SCHEMA.md` | Schema design: conventions, table catalog, ERDs, query patterns, tenancy, retention, grants, Clerk and Prisma rules (§10), open decisions (§11) |
| `docs/db/schema.sql` | DDL: 64 tables, 101 foreign keys, 18 CHECKs. Becomes Prisma migration `0001_init` |
| `docs/db/seed_reference.sql` | Idempotent reference data (plans, engines, providers, seed domains). Becomes migration `0002_reference_data` |
| `docs/db/checks.sql` | CI guard rails. Every query must return zero rows |
| `docs/adr/` | Architecture Decision Records — one-way-door technical decisions and why, written as they happen (not planned per phase) |

Open decisions are tracked in MVP §17 and DATABASE_SCHEMA §11. Read them there; they aren't repeated here.

## Decided: don't reopen

- **Stack:**
  - Node.js LTS in plain JavaScript, with zod at every boundary.
  - Express; EJS + Tailwind CLI + htmx + Alpine.js.
  - BullMQ + Redis in a separate worker process.
  - DigitalOcean: Droplet (PM2 + Nginx), Managed MySQL 8, Redis, Spaces.
  - Stripe, Resend, Claude API.
- **Auth: Clerk, identity only.**
  - Organizations, roles (owner/admin/editor/viewer), invitations and project access stay in MySQL.
  - `users` is a local copy keyed by `clerk_user_id`.
  - Staff use a separate Clerk app with 2FA required, behind Cloudflare Access.
  - Clerk Organizations is not used.
- **ORM: Prisma 7 with SQL-first migrations.**
- The user chose Clerk and Prisma over the earlier recommendations (Better Auth, Drizzle). Design for them; don't argue for the alternatives again.

## Schema rules

- **Tenancy:**
  - Every tenant-owned row has `org_id`.
  - Project-owned rows also have `project_id`, with a composite FK `(project_id, org_id) → projects (id, org_id)`.
  - A new table without `org_id` must be added to the global list in `checks.sql`. That is a deliberate, reviewed decision.
- **Fact tables** (`answer_snapshots`, `mentions`, `citations`, `claims`, `cell_results`, `cell_entity_results`) have no foreign keys, and `run_date` is in the primary key and in every unique key, so they can be partitioned later.
- **Types:**
  - `BIGINT UNSIGNED` IDs, and `public_id CHAR(26)` (ULID) for anything shown in URLs.
  - `DATETIME(3)` in UTC.
  - `DECIMAL` for money and rates; never FLOAT or DOUBLE.
  - `utf8mb4_0900_ai_ci` everywhere.
- **ENUM values start with a letter** (Prisma can't name `2w`). Append new values at the end. Avoid MySQL reserved words.
- **Rollups store sums (n, k, weighted sums), never rates.** A failed collection is never counted as "not mentioned".
- **Idempotency comes from unique keys** (run slot, collection task, cost ledger key, webhook ID, notification dedupe key).
- **Minimum version is MySQL 8.0.19**, because the seed file uses `INSERT … AS new`. Every table needs a primary key (DigitalOcean enforces `sql_require_primary_key`).

## Prisma rules (details in DATABASE_SCHEMA.md §10.2)

- **The SQL files in `prisma/migrations/` are the source of truth.**
  - Never run `prisma db push`.
  - `schema.prisma` can't express CHECKs, generated columns, `ON UPDATE CURRENT_TIMESTAMP` or partitions, so add those to the migration SQL by hand.
- **IDs are JavaScript `BigInt`.** Convert them to strings in one JSON serializer.
- **`upsert` isn't atomic on MySQL.** Catch `P2002` and re-read, or use `INSERT … ON DUPLICATE KEY UPDATE` through `$executeRaw`.
- **Never use `createMany({ skipDuplicates: true })`.** It becomes `INSERT IGNORE`, which silently truncates data and skips CHECK violations.
- **`prisma.*` and `$queryRaw` are used only inside `src/db/`** (the tenant-scoped repositories).

## Verifying schema changes

**No Docker on this project.** MySQL 8.0 runs natively on the dev machine (Windows service `MySQL80`, port 3306), with `sql_require_primary_key` persisted ON globally so it always mirrors DigitalOcean's rule — no per-test container needed. Two databases exist: `aeo_corner_dev` and `aeo_corner_test`.

After editing anything in `docs/db/`, reload `aeo_corner_dev` (or `aeo_corner_test`) from scratch and confirm `checks.sql` prints nothing:

```bash
MYSQL="/c/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe"
MYSQL_PWD=<root password> "$MYSQL" -uroot -h127.0.0.1 -e "DROP DATABASE IF EXISTS aeo_corner_dev; CREATE DATABASE aeo_corner_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
for f in schema seed_reference checks; do MYSQL_PWD=<root password> "$MYSQL" -uroot -h127.0.0.1 aeo_corner_dev < docs/db/$f.sql; done
```

- Also test the specific rule you changed. Insert rows that should fail (a CHECK, a unique key, a composite FK) and confirm MySQL rejects each one for the intended reason, not an unrelated error.
- For Prisma-relevant changes, check the schema in a scratch project with Prisma 7: run `prisma db pull`, then `prisma validate`, then `prisma migrate diff`, which must report no differences.
- After a change, update the counts wherever they appear: the DATABASE_SCHEMA.md header and §0, the MVP.md companion-docs row, and the `schema.sql` footer.

The dev machine runs Windows 11. MySQL is a native Windows install, not Docker. Redis is a DigitalOcean-hosted instance reached over its public URL (`REDIS_URL` in `.env`) — nothing to install locally for it either. The Bash tool is Git Bash, so use absolute paths or `/c/...` paths; call Windows `.exe` tools by their full path since they aren't on the Git Bash `PATH`. The root MySQL password lives only in `.env` (gitignored) — never put it in a doc or commit it.

## Writing the docs

- **Audience:** the founder. Write plain, direct English, and explain technical trade-offs by their consequences (cost, risk, effort).
- **Structure:**
  - Each doc opens with a header table (Document, Date, Status, Companion docs).
  - Sections are numbered, and cross-references use relative links plus § numbers.
  - Use tables for catalogs and decisions, with a "Why" column where it helps.
- **Dates:** always absolute (`2026-09-28`). Mark settled decisions `✅ Decided <date>` in the decision tables.
- **Consistency:** when a decision changes, search all of `docs/` and update every mention in the same pass.
- **Vendor facts** (pricing, SDK APIs, versions): check them against current sources before writing, and record the date checked.
