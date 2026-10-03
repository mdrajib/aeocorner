# AEO Corner

A self-serve SaaS that shows a brand how often AI answer engines (ChatGPT, Perplexity, Gemini, Google AI Overviews) mention, recommend and cite it compared with competitors. It then helps fix the gaps and proves whether the fixes worked (Measure → Diagnose → Fix → Prove). The reference product is aeoengine.ai. Always write the name as "AEO Corner".

## Current phase: building

- **Building began on 2026-09-28.** The app lives in `src/`, `tests/` and `prisma/`, and the design docs in `docs/` stay the source of truth for what to build.
- **Where the build stands is in `docs/BUILD_PLAN.md`** (checked boxes and phase headers) for Phases 0–6, and in `docs/MILESTONES.md` from Phase 7 on. Read it there; this file doesn't track progress.
- Work the phases in order, with the tests each phase requires. Start the next phase only when the user asks for it.
- When code or a discovery changes a decision, update the affected docs in the same pass (see "Writing the docs"). A one-way-door technical decision gets an ADR in `docs/adr/`.
- Put throwaway test scripts in the session scratchpad, not in the repo.
- The repo is on GitHub (`origin` = `mdrajib/aeocorner`, branch `main`). Commit and push only when the user asks. Stage files by name, never with `git add -A`, and never stage `.env`.

## Documents (sources of truth)

| File | Owns |
|---|---|
| `docs/MVP.md` | Product and architecture spec: scope, features F1–F12, methodology, stack (§7.4), repo layout (§7.9), unit economics, timeline, founder decisions (§17) |
| `docs/BUILD_PLAN.md` | The actual build order: 16 phases (0–15) breaking MVP §13.2's weekly timeline into checkable work items and a required-tests checklist per phase. Work through it in order |
| `docs/MILESTONES.md` | Execution order for Phases 7–15: Milestones 0–10, single-action tasks with dependencies, parallel lanes and a Definition of Done each. Tick tasks here from Phase 7 on |
| `docs/CUSTOMER_JOURNEY.md` | Customer experience stage by stage, system data flow, messages. §7 proposes 6 spec changes: the schema models them, but the MVP feature sections haven't been updated yet |
| `docs/ADMIN_OPERATIONS.md` | Internal admin console, staff roles, runbooks, background jobs, alerts |
| `docs/UI_DESIGN.md` | UI rules, brand basics (a proposal until the founder approves it), the component kit, screen inventory, wireframes by sign-off group, key flows, and what every empty/loading/error/partial-data state says |
| `docs/DATABASE_SCHEMA.md` | Schema design: conventions, table catalog, ERDs, query patterns, tenancy, retention, grants, Clerk and Prisma rules (§10), open decisions (§11) |
| `docs/db/schema.sql` | DDL: 64 tables, 101 foreign keys, 18 CHECKs. A readable snapshot of Prisma migration `0001_init` plus later migrations (`0003`) |
| `docs/db/seed_reference.sql` | Idempotent reference data (plans, engines, providers, seed domains). Currently an identical copy of migration `0002_reference_data` |
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

## UI rules (details in `docs/UI_DESIGN.md` §1)

- **Build screens from the component kit** (`ui.badge(...)`, `ui.stat(...)` and so on in `src/web/views/components/`). A new component gets its partial, its CSS in `tailwind/components.css` and a section in the dev-only `/_styleguide` together. Register each new page in `tests/e2e/pages.js`.
- **A failed, pending or missing collection is never "not mentioned" and never 0.** Use `ui.resultCell({ status, mentioned })` and `ui.stat({ state: 'unknown' })`; they show "Couldn’t check". Only a change that passed the significance test is coloured green or red.
- **Strict CSP (ADR-0003): no inline `<script>`, `on*=` handlers or `style=""` in any view.** Behaviour goes in `src/web/public/js/components.js`; Alpine is the CSP build (only named components, no free-form expressions); htmx has eval off. Text props are escaped by the component; only props named `html`/`…Html` take trusted markup.
- **Public pages must be complete in the raw HTML**, and every public page is a registry entry in `src/web/pages.js`.
- After `src/web/` or `tailwind/` changes run `npm run build:css`, then `npm run test:routes` and `npm run test:e2e` (Playwright; `npx playwright install chromium` once).

## Auth and tenancy rules (details in `docs/DATABASE_SCHEMA.md` §6 and §10.1, `docs/adr/0004-clerk-hosted-sign-in.md`)

- **Tenant data is reached only through `db.forOrg(orgId)`** (`src/db/index.js`). `orgId` comes from the `loadOrg` middleware, which proves the signed-in user is a member of the organization in the URL (`/app/o/:org`). No repository function takes an `org_id` from its arguments.
- **Prisma and raw SQL live only in `src/db/`.** An ESLint rule enforces it, tests included. Test-only database helpers are in `src/db/testing.js` (it refuses any database not named `*_test`).
- **A new repository function or organization route needs a cross-tenant leak test in the same change.** `tests/tenancy/` has a coverage test that lists them and fails if one is missing.
- **Signed-in routes** run `auth.identify` then `auth.requireUser`; every state-changing form carries the hidden `_csrf` field; what a role may do comes from `src/core/permissions.js` (`auth.requirePermission(action)`), never from an ad-hoc role check. Anything that isn't a plain 404 for a non-member leaks that an organization exists.
- **Clerk is behind `src/web/auth/provider.js`** (four methods). Sign-in is Clerk's hosted pages. Tests and the Playwright server use a fake provider, so no test needs Clerk keys.
- **Analytics is opt-in per page** (`analytics: true` in `res.page`); only public marketing pages opt in, because PostHog records URLs.
- Database tests (`test:routes`, `test:integration`, `test:tenancy`, `test:e2e`) run against `aeo_corner_test`. Each file creates uniquely named data through `fixtures(db)` and removes it afterwards; none truncates tables.
- **Test commands:** `npm test` (unit tests beside the code), `test:smoke`, `test:routes`, `test:integration`, `test:tenancy`, `test:adapters` (fixture servers; the render tests need Chromium) and `test:e2e`. `npm run test:all` runs everything except e2e. Give `node --test` a glob, never a directory: a directory runs almost nothing. A test that checks "linear time" uses a deliberately loose wall-clock bound so a busy machine can't fail it; keep it loose.
- Staff are invite-only: `npm run staff:invite -- email "Name" role`.

## Queues and the worker (Phase 3; the why is in `docs/adr/0008-queues-and-the-worker.md`, details in `docs/MVP.md` §7.8)

- **The worker is a separate process** (`npm run worker`, `src/worker/`). The web process only adds jobs (`src/lib/jobs.js`, `createJobClient`) and shows the queues to staff at `/queues` on the staff host.
- **Every call to a paid or rate-limited provider goes through `callProvider`** (`src/worker/provider-call.js`; the site crawler is the one exception, see "Crawler"): spend pause, circuit breaker, per-organization slot, provider rate limit, the call, the ledger row, then the spend check. Waiting throws a `Deferral` (a delayed job that does not use up an attempt), never a failure. A call that returns no `usage` is a bug.
- **Job IDs are what the job is** (`src/lib/job-ids.js`: no `:`, not only digits), never when it was made. Payloads carry IDs as strings and nothing else: no emails, names or secrets, because Bull Board shows them.
- **Money is micro-dollars** (whole numbers, `src/core/spend.js`); the day is the UTC day.
- **Rate-limit and concurrency logic exist twice on purpose:** a pure model in `src/core` (unit-tested) and a Lua script in `src/lib` (atomic in Redis). A test replays random traffic through both; change them together.
- **Redis for tests is `TEST_REDIS_URL`** (never `REDIS_URL`). On a local Redis it must name a database other than 0. The local container on port 6379 is shared with another project: use databases 14 (dev) and 15 (tests), keep every key under a prefix, and never run FLUSHDB/FLUSHALL. CI installs Redis with apt (no Docker).
- A new cross-organization lookup in `src/db/repos/system.js` is a reviewed decision: list it in the tenancy coverage test.

## Crawler (Phase 4; the why is in `docs/adr/0005-fetching-other-peoples-websites.md`, the rubric in `docs/MVP.md` §6.6)

- **Every fetch of a URL we did not choose goes through `createSafeFetcher`** (`src/crawler/safe-fetch.js`). There is no second HTTP client. Its `exceptions` option exists for tests only (a fixture server on this machine) and is never set by app code.
- **The headless browser never opens a connection of its own** (`src/crawler/render.js`): every request it makes is answered by the safe fetcher, and Chromium starts with name resolution off. Don't add `route.continue()`, a proxy flag, or more allowed resource types without reading the ADR; `tests/adapters/render.test.js` attacks it with a hostile page.
- **Page content is hostile input.** Code that reads it must be linear: no lazy `[^>]*` patterns on page text, no cheerio `.find()` over a whole page, no recursion over the DOM, nesting capped at 512 (`nestsDeeperThan`). A new parser gets a hostile-input test, as the existing ones have.
- **A check that could not look says `error` ("couldn't check"), never `fail`**, and is left out of the score; with less than half the rubric evaluated the score is `null`, not 0. A new check: a runner in `src/crawler/readiness/`, an entry in `rubric.js` (the points must still total 100), and a passing and a failing fixture.
- **Raw pages are stored first** (`storeRaw`, `src/integrations/spaces.js`), under content-addressed keys, so a retry writes the same key. Production needs `DO_SPACES_*`; a laptop writes to `.data/spaces` (gitignored). The bucket is shared with other apps, so everything goes inside this app's directory `aeo-corner/<dev|staging|prod>/` (`DO_SPACES_PREFIX`); never read or write outside it. Tests use the S3 stand-in (`tests/helpers/s3-stub.js`) and must never be pointed at the real bucket.
- **We obey robots.txt as `AEOCornerBot`, except for a signed-in customer's own project** (founder decision, `respectRobots: false`, set by the job; `--ignore-robots` on the command line). The free audit always obeys it. Project domains are not yet verified as owned by the customer (Phase 8), so don't extend the override to anything else until they are. A scan is `forOrg(orgId).scans`, started with `requestScan()` and run by the `crawl.readiness` job; it does not go through `callProvider` (a breaker on "the crawler" would stop every customer's scans because one site was down), and writes one `usage_ledger` row (meter `crawl`, cost 0) instead.
- **Chromium must be installed wherever the worker runs** (CI installs it; the Droplet runbook is Phase 15). Without it scans still finish and the render checks say "couldn't check".
- **Try it:** `npx playwright install chromium` once, then `npm run scan -- example.com` (add `--timing` to see where the time goes). Test helpers: `tests/helpers/http-fixture.js` (fixture servers and a test fetcher), `fixture-sites.js`, `s3-stub.js` (an S3-compatible stand-in, no Docker), `readiness.js`.

## Engine adapters (Phase 5; the why is in `docs/adr/0006-engine-adapters.md`)

- **Every provider sits behind the contract in `src/engines/contract.js`** (`submit`, `poll`, `normalize`, `estimateCostUsd`/`estimateCostMicros`); `createAdapters(config.providers)` builds one per provider whose credentials are set. Errors are `ProviderError`s with `retryable` and `countsAgainstProvider`; they never contain response bodies or URLs (SerpApi's key is in the URL).
- **"No answer" must be something the provider said** (no AI Overview shown, DataForSEO 40102). A response we can't read is `bad_response`, an error; never `no_answer`. A new adapter gets a "changed shape throws" test.
- **Perplexity is the Agent API** (`/v1/agent`, model `perplexity/sonar`): Sonar Chat Completions ended on 2026-09-27.
- **`collect.answer`** stores the raw response first (`answers/<yyyy>/<mm>/<sha256>.json`, even when unreadable), then completes `forOrg(orgId).snapshots`. One ledger row per charge, keyed by attempt; a free call (polling DataForSEO) passes `usage: { free: true }` to `callProvider` and writes none. A queued provider is polled by the job throwing a `Deferral`.
- **Fixtures in `tests/fixtures/engines/`:** `*-recorded-<date>.json` are real responses (all three providers); the rest are hand-built from the providers' docs for errors and other cases a live call can't produce. `npm run engines:try -- --engine <engine> [--mode live] [--record] "<question>"` makes a real, paid call; `--record` writes to `recorded/` (gitignored) for review before it becomes a fixture. Tests never call a real provider.

## Answer extraction (Phase 6; the why is in `docs/adr/0007-answer-extraction.md`)

- **Two readers, one stored reading.** The deterministic pre-pass (`src/llm/prepass.js`) and Claude (`src/llm/extraction.js`) both read every answer. A brand counts as mentioned when either finds it (`mentions.detected_by`); where only one does, the answer goes to `review_items`. Claude's fields stay empty for a brand only the pre-pass found: never guess them. The pre-pass is linear in the answer's length, like the crawler's parsers, and has hostile-input tests.
- **A reply is stored whole or not at all.** `readReply` rejects a refusal, `max_tokens`, broken JSON and the wrong shape; the answer's extraction is marked `failed` and its earlier rows stay. `forOrg(orgId).extractions.save()` replaces a snapshot's rows in one transaction and checks every entity ID against the project (the fact tables have no foreign keys).
- **Changing the prompt or the schema means bumping `PROMPT_VERSION`** (`src/llm/extraction-prompt.js`). It changes `extraction_version` on every row and re-runs the eval. Keep the stable parts first (system prompt, then the tracked-brand block) so the cache holds.
- **Models:** `claude-opus-5-5` at low effort (default; it replaced the spec's `claude-opus-5`) or `claude-haiku-4-5` (`EXTRACTION_MODEL`, `src/llm/models.js`). On Opus 5.5, thinking can't be switched off, so `effort` is the only control; Haiku 4.5 rejects `effort` altogether. Decision D4 between them comes from the golden set.
- **Jobs:** `extract.batch` (one Batch API request per run, recorded in `runs.llm_batch_ids`), `extract.poll` (a `Deferral` until the batch ends, then one ledger row per batch keyed `extract.batch.<id>`), and `extract.answer` (one answer now). All go through `callProvider` with provider `anthropic`.
- **The golden set is `evals/extraction/`:** see its README. `npm run eval:extraction -- --prepass-only` is free; anything else calls Claude and costs money. `npm run golden:review` is the local label-review page; `npm run golden:collect` makes paid provider calls.

## Free audit (Milestone 1; the pipeline is MVP F1, the budget decision is the addendum to `docs/adr/0008-queues-and-the-worker.md`)

- **`audit.run` is one job per audit** (`src/worker/handlers/audit.js`, job ID `audit-<id>`; the payload is the audit's ID and nothing else): scan, lite Brand Kit, five questions, four engines in live mode, each answer read at once, score, fixes, one "report ready" email. Every step is safe to repeat. An answer is saved as `pending` right after it is collected and completed after it is read, so a Claude outage is retried from the stored answer and never asks (or pays) an engine twice.
- **An audit's provider calls pass `auditId`, not `orgId`, to `callProvider`.** The ledger row has `org_id` NULL, and `db.audits.ledger.spentSinceMicros` is what the daily audit budget (`AUDIT_DAILY_BUDGET_USD`) is measured against.
- **Scores are pure and never turn "couldn't check" into 0** (`src/core/visibility.js`, `src/core/fix-list.js`): a failed or pending answer leaves the visibility score; an engine that says it has no answer (no AI Overview) is left out too; with fewer than half the answers readable the score is null, and so is the AEO Score (0.6 × readiness + 0.4 × visibility). Every fix links to a failing check or to the answers it came from.
- **The Brand Kit (`src/llm/brand-kit.js`) and the question generator (`src/llm/questions.js`) are pure request/reply code** like `extraction.js`; page text is fenced and declared to be data. A question set is only accepted if it has exactly the audit's intents, discovery and problem questions do not name the brand, and brand and comparison questions do. Bump `BRAND_KIT_VERSION` / `QUESTIONS_VERSION` when a prompt or schema changes. Neither has been run against the live model yet; the Milestone 1 live run is the first check.
- **Abuse guards, in this order:** Turnstile (`src/lib/turnstile.js`, fails closed), a throwaway-email list and `abuse_blocks` (`db.abuse`), then the daily counters per email, IP and domain in Redis (`src/lib/audit-limits.js`; one refusal never spends another allowance, five refusals block the IP for a day). An email counts as one mailbox ignoring case, `+tags` and Gmail dots (`mailboxKey`). The OTP (`src/lib/otp.js`) is a keyed hash in Redis: 10 minutes, 5 wrong guesses kill it, one new code a minute and 3 an hour per audit.
- **A repeat audit of the same domain within 24 hours is served from the earlier `complete` one** (`audits.findReusable`, `completeFromCache`): no cost of its own, and `answers()` and `scans.forAudit()` read through `cached_from_audit_id`. A lead must exist before the audit row (`ck_audits_owner`), so the form step captures the lead first.
- **`audits.finish`, `fail` and `completeFromCache` only write while the audit is queued or running:** a finished audit is final. A new `db.audits`, `db.abuse` or `db.leads` function needs a line in the pinned key lists in `tests/tenancy/repositories.test.js` and its own test.

## Free audit pages (Milestone 2; routes in `src/web/routes/audit.js`, deployment in `docs/RUNBOOK_PROVISIONING.md`)

- **The audit is live only when `createApp` gets `audit` services** (`{ otp, limiter, turnstile, mail, jobs, funnel }`, built in `src/web/server.js` when there is a database, Redis and `TURNSTILE_SECRET_KEY`). Without them `auditStubRoutes()` answers "The free audit opens soon" and stores nothing: that is how production stays closed until task 2.13. The public-page tests run in that stub mode.
- **The flow:** `POST /audit` (address OK → the email step) → `POST /audit/email` (Turnstile, limits, lead, audit row, code emailed) → `/audit/:id/verify` → `/audit/:id/progress` (+ `/events`, server-sent) → `/r/:id`. The Turnstile widget is on the email step only (a token is single-use), and only that page loads Cloudflare's script (`turnstile: true` in the page's locals).
- **The address is the secret.** `/r/:id` and everything under `/audit/:id/` use the audit's `public_id`; an unknown, malformed or unverified id is the same plain 404. These pages send `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and noindex, and they never load PostHog (`QUIET` in the route file).
- **The funnel is counted on the server** (`src/lib/funnel.js`, five events), with a random id per event and an allow-list of properties: no email, domain or audit id can be sent. Add an event or a property there, never inline.
- **What a visitor sees is decided in `src/core/audit-progress.js`** (pure, tested): step states, answer cards, engine cards, the headline. An engine with no readable answer is "Couldn't check", never "Not mentioned"; a missing score is a `ui.stat` in the unknown state, never 0.
- **The live page is complete in the HTML**; `components.js` swaps in the server's newer rendering (`partials/audit-feed.ejs`) and goes to the report on `done`. Nginx must not buffer `/audit/:id/events` (the config in `deploy/` has its own block for it).
- **Browser tests:** `tests/e2e/server.js` mounts the real audit routes with a Redis prefix of its own, a Turnstile that passes and a job queue that only remembers; `/__e2e/audit/live` and `/finish` stand in for the worker. `tests/helpers/audit-fixtures.js` makes audits in any state for route and browser tests.

## Projects and setup (Milestone 3; repositories in `src/db/repos/org-projects.js` and `org-prompts.js`, routes in `src/web/routes/projects.js`)

- **A project is made with its brand entity and every live engine, in one transaction** (`forOrg().projects.create`). One live project per domain per organization; archiving frees the domain. A project's domain never changes. `sourceAuditPublicId` (the audit's secret address) is how a project is prefilled from an audit; an audit already owned by another organization is refused.
- **Repositories that hang off a project:** `projectEngines`, `entities` (brand, competitors, aliases; the brand can't be switched off), `brandKits` (every save is a new immutable version; `expectedVersion` makes a stale screen fail with `STALE_VERSION`; the brand's aliases follow the kit) and `prompts` (text is immutable: a reword archives and replaces; `importMany` answers every row; `limit` is the plan's cap on active questions). Each has a leak test in `tests/tenancy/repositories.test.js` and the pinned key list there.
- **Pure rules live in `src/core`:** `project-rules.js` (fields, weekly slot, name normalizing), `brand-kit.js` (Brand Kit v1 schema; competitors are NOT in it, they are `tracked_entities`), `prompt-rules.js` (duplicates, near duplicates, naming rule, intent coverage) and `domain-verification.js`.
- **robots.txt is ignored only for a verified domain** (DNS TXT on `_aeocorner.<domain>` or `/.well-known/aeocorner-verification.txt`; `src/crawler/verify-domain.js`, through the safe fetcher). The crawl job reads `projects.domain_verified_at`; the free audit always obeys. This replaces the old "signed-in customer's own project" rule above.
- **The first migration after `0001`/`0002` is `0003_domain_verification`.** `docs/db/schema.sql` is now the readable snapshot of 0001 plus later migrations. `prisma migrate deploy` on both dev and test databases, then `prisma generate`; `migrate diff` must say no difference.
- **htmx requests carry the CSRF token** from `<meta name="csrf-token">` (header `X-CSRF-Token`), and a 401 reloads the page into sign-in (`components.js`).
- **Setup jobs (`src/worker/handlers/setup.js`, queue `content`):** `brandkit.extract` reads the site (up to 30 pages, same robots rule as the scan) and saves a draft kit plus suggested competitors; `questions.generate` writes 25–50 questions. Both go through `callProvider` as the organization, save only from the state they started in (a kit saved by a person since wins), and are deduplicated by job ID per ten-minute slot (`brandKitJobId`, `questionsJobId`). Suggested competitors are `tracked_entities` with status `suggested`, never tracked until confirmed. Neither prompt has run against the live model yet.
- **Screens (routes in `project-brand.js`, `project-questions.js`, `project-setup.js`, `member-access.js`; they register on the project router in `projects.js`):** Brand Kit (per-section forms, `expectedVersion`, history and restore), Prompt Manager (filters, coverage, CSV paste import in `src/core/prompt-csv.js`, every import row answered), setup steps `/setup/:step`, client seats (`chosenProjects`). A form shared by several screens returns only to places in `returnPath`, never to an address from the form. Pages that wait for a job refresh with `res.locals.refreshSeconds` (a meta refresh, CSP-safe). Plans arrive in Milestone 8, so `QUESTION_LIMIT` is 50 for everyone.
- **From a report to a project:** "Track this every week" sets the `aeo_audit` cookie (`src/web/auth/audit-claim.js`, HttpOnly, path `/app`, 2 hours); the audit's address is never put in the sign-up URL. `projects.create` with `sourceAuditPublicId` claims the audit for the organization; the route prefills the kit (`source: 'audit'`) and suggests the audit's competitors.
- **Setup does not switch tracking on.** A project stays `onboarding` until Milestone 4, because marking it `active` would make the hourly scheduler pick it up with nothing to run.

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
- **Transactions in a repository go through `transaction(prisma, async (tx) => …)`** (`src/db/transaction.js`), never `prisma.$transaction` directly (lint enforces it). It retries a transaction MySQL abandons as a deadlock, so the callback may run more than once and must touch the database only through `tx`.
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

The dev machine runs Windows 11. MySQL is a native Windows install, not Docker. Redis for local work is the shared container on port 6379 (see "Queues and the worker"); nothing to install for it. The Bash tool is Git Bash, so use absolute paths or `/c/...` paths; call Windows `.exe` tools by their full path since they aren't on the Git Bash `PATH`. The root MySQL password lives only in `.env` (gitignored) — never put it in a doc or commit it.

## Writing the docs

- **Audience:** the founder. Write plain, direct English, and explain technical trade-offs by their consequences (cost, risk, effort).
- **Structure:**
  - Each doc opens with a header table (Document, Date, Status, Companion docs).
  - Sections are numbered, and cross-references use relative links plus § numbers.
  - Use tables for catalogs and decisions, with a "Why" column where it helps.
- **Dates:** always absolute (`2026-09-28`). Mark settled decisions `✅ Decided <date>` in the decision tables.
- **Consistency:** when a decision changes, search all of `docs/` and update every mention in the same pass.
- **Vendor facts** (pricing, SDK APIs, versions): check them against current sources before writing, and record the date checked.
