# AEO Corner — Build Plan

| | |
|---|---|
| **Document** | Phase-by-phase execution checklist for building the app |
| **Date** | 2026-09-28 |
| **Status** | Draft — no application code exists yet |
| **Companion docs** | [MVP.md](MVP.md) §13 (narrative timeline, team, Definition of Done) · [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md) · [ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) · [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) · [CLAUDE.md](../CLAUDE.md) |

## 1. Purpose and how to use this plan

[MVP.md §13.2](MVP.md#132-12-week-timeline) says *what* ships each week. This document breaks each of those weeks into the actual units of work, so a phase is never "in progress" without a defined, checkable end. Rules:

1. **Work phases in order.** A phase's work items assume every earlier phase's exit criteria are met.
2. **A phase is not done until its Tests checklist passes**, in addition to its work checklist. Tests from earlier phases must still pass (no regressions) — this is what CI enforces from Phase 0 onward.
3. **Check boxes as work lands**, in this file, in the same commit/PR as the work. When every box in a phase is checked, mark the phase header `✅ Complete <date>`.
4. **If a phase reveals that an earlier decision was wrong**, stop and update the relevant doc ([MVP.md](MVP.md), [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)) in the same pass, per [CLAUDE.md](../CLAUDE.md)'s consistency rule — don't silently drift from the written design.
5. **No phase below starts until the user says to start building.** Per [CLAUDE.md](../CLAUDE.md), this repository is design-only today; this document is itself a design artifact.

## 2. Testing conventions (apply to every phase)

| Category | Tool | Where | When it runs |
|---|---|---|---|
| Unit tests | **`node:test`** (Node's built-in runner) + `node:assert` — no new dependency, matches the founder's plain-JS/familiar-tools stack | Next to the code, `*.test.js` | Every commit (CI), every phase |
| HTTP route tests | **supertest** against the Express app in-process | `tests/routes/` | Every commit (CI), from Phase 1 on |
| DB integration tests | Real MySQL, not mocks — the same `mysql:8.4` container pattern already used to verify `docs/db/*.sql` ([CLAUDE.md](../CLAUDE.md#verifying-schema-changes)), migrated with `prisma migrate deploy` | `tests/integration/` | Every commit (CI), from Phase 1 on |
| Cross-tenant leak tests | For every tenant-scoped repository function in `src/db/`, assert org A can never read or write org B's rows | `tests/tenancy/` | Every commit (CI), from Phase 1 on — this is [MVP §7.1](MVP.md#71-architecture-principles) principle 7's "second line of defense" |
| Adapter/contract tests | Recorded fixture responses per provider, replayed — no paid calls in CI | `tests/fixtures/engines/`, `tests/adapters/` | Every commit (CI), from Phase 4 on |
| Extraction eval | The 200-answer golden set scored against the [MVP §10](MVP.md#10-non-functional-requirements) accuracy targets | `evals/` | CI, whenever `src/llm/**` or prompt/schema files change (already specified in [MVP §7.10](MVP.md#710-environments--delivery)) |
| E2E smoke tests | **Playwright** (already in the stack for the crawler's render comparison, reused here) | `tests/e2e/` | Against staging before each milestone (M1/M2/M3), not on every commit |
| Load & cost tests | k6 (or autocannon) at 2× target load, plus the usage-ledger cost-per-audit / cost-per-run check from [MVP §13.3](MVP.md#133-mvp-definition-of-done) | `tests/load/` | Before Phase 13 (M3) only |

**Open item:** `node:test` + supertest is a recommendation, not yet a founder decision — flag it for a quick confirm in Phase 0 alongside the other setup choices (§4 below). Nothing later in this plan depends on which way that goes.

**CI gate (from [MVP §7.10](MVP.md#710-environments--delivery)):** lint, unit tests, cross-tenant leak tests, migration drift check, extraction eval (conditional), `npm audit` — all required to merge, starting Phase 0.

## 3. Phase overview

| # | Phase | Roughly maps to MVP §13.2 week(s) | Milestone |
|---|---|---|---|
| 0 | Prerequisites & project setup | Week 0 | — |
| 1 | Auth, orgs & tenancy foundation | Weeks 1–2 | — |
| 2 | Job infrastructure & usage ledger | Weeks 1–2 | — |
| 3 | Site crawler & readiness checks | Weeks 1–2 | — |
| 4 | Engine adapters (spikes) | Weeks 1–2 | — |
| 5 | Extraction pipeline & golden-set eval | Week 3 | Decision D4 recorded |
| 6 | Free audit | Week 4 | 🚩 **M1: Free audit live** |
| 7 | Projects, Brand Kit & Prompt Manager | Weeks 5–6 | — |
| 8 | Tracking orchestrator, rollups & significance | Weeks 5–6 | — |
| 9 | Visibility Dashboard & Citation Intelligence | Weeks 7–8 | 🚩 **M2: Design-partner beta** |
| 10 | Action Center & closed loop | Week 9 | — |
| 11 | Content Studio & WordPress Connector | Week 10 | — |
| 12 | AI traffic analytics, digest & billing | Week 11 | — |
| 13 | Hardening, load/cost testing & launch | Week 12 | 🚩 **M3: Public launch** |

## Phase 0 — Prerequisites & project setup

**Goal:** everything that has to exist before the first line of app code, so Phase 1 isn't blocked mid-stream.

**Founder/infra work (not engineering):**
- [ ] Register `aeocorner.com`.
- [ ] Create accounts: Clerk (customer app + staff app), Stripe, DigitalOcean, Resend, Anthropic (Claude API key), Cloudflare.
- [ ] Provision DigitalOcean: Droplet, Managed MySQL, Redis, Spaces, one region/VPC ([MVP §7.11](MVP.md#711-digitalocean-deployment-topology)).
- [ ] Fill in the `NULL` plan limits in [seed_reference.sql](db/seed_reference.sql) (seats, "run now" quota) — [DATABASE_SCHEMA §11 O7](DATABASE_SCHEMA.md#11-open-decisions).
- [ ] Submit Google OAuth verification (GA4/Search Console scopes) — long lead time, start early per [MVP §13.2](MVP.md#132-12-week-timeline) week 0.
- [ ] Draft ToS, Privacy Policy, DPA, subprocessor list ([MVP §11.3](MVP.md#11-security-privacy-compliance--ethics)).

**Repo & tooling setup:**
- [x] `git init` (already done by the desktop app's session setup) — confirmed `node:test` + supertest per §2 above.
- [x] Scaffold the repo layout from [MVP §7.9](MVP.md#79-repository-layout-planned): `src/web`, `src/worker`, `src/core`, `src/db`, `src/engines`, `src/llm`, `src/crawler`, `src/integrations`, `src/lib`, `tailwind/`, `plugins/wordpress-connector/`, `evals/`, `tests/`, `deploy/`.
- [x] `.gitignore` (secrets, `node_modules/`, build output, Prisma generated client, Playwright artifacts).
- [x] **No Docker on this project** ([CLAUDE.md](../CLAUDE.md#verifying-schema-changes)). Local dev uses MySQL 8.0 installed natively on Windows (`aeo_corner_dev` / `aeo_corner_test` databases, `sql_require_primary_key` persisted ON) and a DigitalOcean-hosted Redis instance reached by its public URL — nothing to install for Redis.
- [x] `package.json` (plain JS, ESM, `node --test` + supertest scripts), ESLint 10 flat config + Prettier, `.env` / `.env.example` (every variable named; `.env` is git-ignored, real local values only).
- [x] Moved `docs/db/schema.sql` and `seed_reference.sql` into `prisma/migrations/0001_init/` and `0002_reference_data/`; added `prisma.config.ts` (Prisma 7 moved the datasource URL out of `schema.prisma` — CLI connection now lives here, loaded via `dotenv/config`); generated `schema.prisma`'s 64 models via `prisma db pull` against the migrated `aeo_corner_dev`; `prisma generate` outputs the client to `src/db/generated/` (git-ignored).
- [x] GitHub Actions CI skeleton ([.github/workflows/ci.yml](../.github/workflows/ci.yml)): lint, format, migrate deploy, `checks.sql`, migration-drift check, unit/smoke/route/integration/tenancy/adapter test scripts, `npm audit`. Runs on `ubuntu-latest` using its pre-installed MySQL 8 service (`sudo systemctl start mysql.service`, root/root) instead of a Docker service container, consistent with no-Docker.
- [ ] Sentry, PostHog, Langfuse projects created (keys only, wired later per phase) — founder task, still open.

**Tests required before moving on:**
- [x] `docs/db/schema.sql`, `seed_reference.sql` and `checks.sql` load cleanly into the local `aeo_corner_dev` database with `sql_require_primary_key=ON` (persisted globally, survives a MySQL restart); `checks.sql` prints nothing; 64 tables confirmed.
- [x] `prisma migrate deploy` applies both migrations to the empty `aeo_corner_test` database; `_prisma_migrations` shows both finished; `checks.sql` still prints nothing (65 tables including `_prisma_migrations`).
- [x] `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code` reports no differences.
- [x] Lint, format check, and `npm run test:all` (unit/smoke/routes/integration/tenancy/adapters — the four empty suites pass cleanly via glob patterns that don't error on zero matches) all pass locally, matching what CI runs.
- [x] `npm audit` and `npm audit --omit=dev` both report 0 vulnerabilities — caught and fixed a real one along the way: `@prisma/adapter-mariadb@7.10.0` pins a `mariadb` driver version with a high-severity advisory (SSL doesn't actually protect the password from a MITM); overridden to a patched `3.4.x`/`3.5.x` via `package.json` `overrides`, without touching the pinned Prisma version.

**Exit criteria:** a developer can clone the repo, run `npm ci`, point `.env` at their local MySQL + a DO Redis URL, and have a working app skeleton with CI green. **Met**, except the external SaaS accounts (Sentry/PostHog/Langfuse) and the founder/infra checklist above.

## Phase 1 — Auth, orgs & tenancy foundation

**Goal:** a signed-in user can create an org and see an empty authenticated shell; every tenant-scoped query is provably isolated.

**Work:**
- [ ] `@clerk/express` wired into `src/web`: `clerkMiddleware()`, sign-in/sign-up pages (Clerk hosted or embedded components).
- [ ] `users` upsert-on-first-request path (lazy create, catch `P2002` per [DATABASE_SCHEMA §10.1](DATABASE_SCHEMA.md#101-auth-clerk-identity-only)).
- [ ] Clerk webhook endpoint (`user.created`/`updated`/`deleted`), Svix signature verification, `webhook_events` dedupe.
- [ ] `organizations`, `memberships`, `membership_projects`, `invitations` CRUD + the four roles (owner/admin/editor/viewer).
- [ ] Invitation email flow (token + verified-Clerk-email match).
- [ ] Tenant-scoped repository layer in `src/db/` — the only place `prisma.*`/`$queryRaw` may appear ([DATABASE_SCHEMA §10.2](DATABASE_SCHEMA.md#102-orm-prisma-7-with-sql-first-migrations) rule 7).
- [ ] Staff app skeleton: separate Clerk app, invite-only, `staff_users`/`staff_roles`, Cloudflare Access in front, 2FA-required middleware check.

**Tests required before moving on:**
- [ ] Unit: role-permission matrix (who can do what) for owner/admin/editor/viewer.
- [ ] Integration: sign-in → org creation → membership row exists, against real MySQL.
- [ ] Integration: webhook replay (same `svix-id` twice) is a no-op; out-of-order `updated_at` is dropped.
- [ ] **Cross-tenant leak suite goes live here** — every repository function gets a test proving org A cannot touch org B's rows. This suite grows with every later phase that adds a repository function.
- [ ] Route tests: unauthenticated requests to any authenticated route redirect/`401`.
- [ ] Staff: a Clerk session without a second factor is rejected by the admin middleware.

**Exit criteria:** sign-up, org creation, invitations and role checks work end to end against real MySQL; the cross-tenant suite exists and passes; no direct Prisma/raw-SQL calls exist outside `src/db/` (enforce with an ESLint rule or a CI grep check).

## Phase 2 — Job infrastructure & usage ledger

**Goal:** BullMQ is running as a separate worker process with the scheduling, rate-limiting and cost-tracking primitives every later job depends on.

**Work:**
- [ ] `src/worker/index.js` entry point; Redis connection; one BullMQ queue per job type (audit, crawl, collect, extract, content, sync, digest) per [MVP §7.8](MVP.md#78-scheduling-concurrency--resilience).
- [ ] Hourly job scheduler; deterministic job IDs (`project_id + slot`) so double-fires can't duplicate a run.
- [ ] Per-provider Redis token buckets + per-org concurrency caps.
- [ ] Retry policy: exponential backoff with jitter, max 5, failed jobs visible in Bull Board inside internal admin.
- [ ] `usage_ledger` writes on every external call (provider + LLM), with `idempotency_key`.
- [ ] Per-org daily spend cap check that pauses collection and notifies the org when hit.
- [ ] Provider circuit breaker (>10% error rate over 15 min switches to fallback, alerts on-call).

**Tests required before moving on:**
- [ ] Unit: token-bucket and concurrency-cap logic under simulated load.
- [ ] Integration: enqueuing the same job ID twice results in one job, not two (idempotency).
- [ ] Integration: a forced job failure retries with backoff and lands in the dead-letter set after max retries.
- [ ] Integration: `usage_ledger` rows are never double-written on a retried job (idempotency key holds).
- [ ] Unit: spend-cap logic pauses collection at the threshold and resumes correctly after reset.

**Exit criteria:** a hand-triggered no-op job runs through the full queue → retry → ledger path with nothing hard-coded to one project.

## Phase 3 — Site crawler & readiness checks

**Goal:** given a domain, safely fetch and evaluate it for AEO readiness — this is the first real building block of the free audit (F1) and onboarding (F2).

**Work:**
- [ ] SSRF-safe HTTP fetcher (block private/link-local IP ranges, redirects re-checked, size/time limits).
- [ ] robots.txt + sitemap parsing; AI-crawler user-agent checks ([MVP Appendix A](MVP.md#appendix-a--ai-crawler-user-agents-readiness-checks)).
- [ ] Raw-HTML fetch + Playwright headless render, stored to Spaces (raw-first storage, [MVP §7.1](MVP.md#71-architecture-principles) principle 4).
- [ ] Page-selection heuristics (which pages matter for AEO).
- [ ] Readiness checks v0 (schema.org presence, crawlability, entity clarity signals — [MVP §5 F1](MVP.md#f1--free-aeo-audit-lead-magnet)).

**Tests required before moving on:**
- [ ] Unit: SSRF guard rejects `127.0.0.1`, `169.254.x.x`, RFC1918 ranges, and a redirect chain that ends up there.
- [ ] Integration: fetching a fixture site produces the expected raw payload in the test Spaces bucket (or a local S3-compatible stub).
- [ ] Unit: each readiness check has at least one fixture that should pass and one that should fail.
- [ ] Contract: Playwright render matches raw HTML fetch on a stable fixture page (regression guard for the render pipeline itself).

**Exit criteria:** pointing the crawler at a handful of real, varied domains (a WordPress site, a SPA, a site that blocks bots) produces sane, storable readiness results without ever touching a private IP.

## Phase 4 — Engine adapters (spikes)

**Goal:** prove the `EngineAdapter` contract ([MVP §7.5](MVP.md#75-engine-adapter-contract-design-sketch)) against all four real providers before building the orchestrator around them.

**Work:**
- [ ] `src/engines/` adapter per engine/provider pair: DataForSEO (ChatGPT + Gemini UI), Perplexity Sonar API, SerpApi (AI Overviews).
- [ ] Each adapter implements `submit`/`poll`/`normalize`/`estimateCostUsd`.
- [ ] Raw payload storage to Spaces + `answer_snapshots` insert + `usage_ledger` insert per answer.
- [ ] Record real provider responses as fixtures for the contract-test suite (§2).

**Tests required before moving on:**
- [ ] Contract tests per adapter, replayed from recorded fixtures (no live calls in CI).
- [ ] Unit: `normalize()` produces the same shape regardless of provider (text, sources[], model_version, locale).
- [ ] Unit: `estimateCostUsd()` matches the provider's published pricing within a documented tolerance.
- [ ] Manual/spike check (not CI): one real, live call per provider succeeds and a human confirms the raw payload looks right — record the result in an ADR.

**Exit criteria:** all four adapters pass their contract tests and have at least one verified live call; provider pricing is recorded in the usage ledger correctly.

## Phase 5 — Extraction pipeline & golden-set eval

**Goal:** turn a raw answer into structured mentions/citations/claims, and settle decision D4 (bulk model choice) with real data.

**Work:**
- [ ] Deterministic pre-pass (alias matching, domain/citation extraction) before any LLM call.
- [ ] Claude Batch API request builder with prompt caching + structured outputs (`src/llm/`).
- [ ] 200-answer golden set hand-labeled into `evals/`.
- [ ] Eval harness comparing `claude-opus-5` (low effort) vs `claude-haiku-4-5` against the golden set.
- [ ] `mentions`, `citations`, `claims` inserts from parsed batch results, keyed by `custom_id`.

**Tests required before moving on:**
- [ ] Eval run produces the accuracy numbers needed to decide D4, checked against the [MVP §10](MVP.md#10-non-functional-requirements) targets.
- [ ] Unit: the deterministic pre-pass alone (no LLM) on fixture answers.
- [ ] Integration: a batch result with a malformed/partial LLM response is handled without corrupting `mentions`/`citations`.
- [ ] CI: the eval is wired to run automatically whenever `src/llm/**` or the extraction schema changes ([MVP §7.10](MVP.md#710-environments--delivery)).

**Exit criteria:** D4 is decided and recorded as an ADR ([MVP §17](MVP.md#17-decisions-needed-from-the-founder)); the eval runs in CI going forward.

## Phase 6 — Free audit (🚩 M1)

**Goal:** the first public-facing, revenue-relevant surface — F1 end to end, target under 10 minutes.

**Work:**
- [ ] Public audit endpoint: Cloudflare Turnstile, OTP email verification, rate limiting.
- [ ] Orchestrates: crawler (Phase 3) → lite Brand Kit → 5 prompts → live-mode collection across all 4 engines (Phase 4) → synchronous extraction (Phase 5) → scores → fixes.
- [ ] Report page + email delivery (Resend).
- [ ] Lead capture into `leads`; audit analytics funnel (PostHog).

**Tests required before moving on:**
- [ ] E2E (Playwright): submit a domain → receive a report, against staging, using recorded/fixture provider responses so it's not paid per CI run.
- [ ] Integration: rate limiting and Turnstile bypass attempts are rejected.
- [ ] Integration: OTP flow — correct code passes, expired/wrong code fails, per [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md) verification-code row.
- [ ] Load: the audit path holds up under a burst of concurrent submissions without exceeding the per-org/global provider rate limits.
- [ ] Cost check: measured cost per audit against the ≤ $0.75 target in [MVP §13.3](MVP.md#133-mvp-definition-of-done).

**Exit criteria:** matches [MVP §13.2](MVP.md#132-12-week-timeline) M1 — free audit is live and generating leads while later phases are built.

## Phase 7 — Projects, Brand Kit & Prompt Manager

**Goal:** F2 and F3 — the setup a paying customer does before tracking starts.

**Work:**
- [ ] `projects` CRUD, scoped by org; composite FK `(project_id, org_id)` pattern used everywhere from here on.
- [ ] Brand Kit auto-extraction (domain → brand profile, products, competitors, voice), editable and versioned.
- [ ] `tracked_entities` (brand + competitors), generated column `brand_project_id`.
- [ ] Prompt Manager: generate/import/edit prompts, with intent, cluster, locale.

**Tests required before moving on:**
- [ ] Cross-tenant leak tests extended to `projects`, Brand Kit and prompt tables (§2 suite grows).
- [ ] Unit: Brand Kit versioning — editing creates a new version without losing history.
- [ ] Integration: prompt generation respects the intent-coverage rules from [MVP §7.7](MVP.md#77-llm-usage-map-claude).
- [ ] Unit: `tracked_entities.brand_project_id` generated column matches expectations across insert/update.

**Exit criteria:** a customer can create a project, get a Brand Kit, and have a prompt set ready for tracking — all tenant-isolated and tested.

## Phase 8 — Tracking orchestrator, rollups & significance

**Goal:** F4 — the scheduled engine that actually produces ongoing visibility data.

**Work:**
- [ ] Scheduler → orchestrator: expand prompts × engines × samples into tasks, respecting per-provider concurrency (Phase 2) and using the adapters (Phase 4) and extraction pipeline (Phase 5).
- [ ] `cell_results`/`cell_entity_results` fact-table writes (no FKs, `run_date` in every key, per [DATABASE_SCHEMA](DATABASE_SCHEMA.md#schema-rules) fact-table rules).
- [ ] Daily rollups by project × engine × cluster × intent × locale.
- [ ] Significance tests and change-event emission; partial runs marked `partial` and excluded from trend significance (never counted as zero).

**Tests required before moving on:**
- [ ] Integration: a full scheduled run (mocked adapters) produces the expected fact rows and rollups.
- [ ] Unit: significance test math against known statistical fixtures.
- [ ] Unit: a partial/failed collection is excluded from trend calculations, not counted as "not mentioned" ([MVP §7.1](MVP.md#71-architecture-principles) principle 4/schema rollup rule).
- [ ] Integration: re-running the same scheduled slot twice does not double-count (idempotency via unique keys, [DATABASE_SCHEMA](DATABASE_SCHEMA.md#schema-rules)).

**Exit criteria:** a project runs on its weekly slot automatically, unattended, and produces correct rollups even when one engine's collection partially fails.

## Phase 9 — Visibility Dashboard & Citation Intelligence (🚩 M2)

**Goal:** F5 and F6 — the screens design partners will actually look at.

**Work:**
- [ ] Dashboard: score, mention rate, share of voice, position, sentiment, trends, per-prompt drilldown (EJS + htmx + Alpine + Chart.js/ECharts).
- [ ] Competitor comparison views.
- [ ] Citation & Source Intelligence: which domains/URLs get cited, citation-gap vs. competitors.
- [ ] Design-partner onboarding flow (10–15 partners per [MVP §13.2](MVP.md#132-12-week-timeline)).

**Tests required before moving on:**
- [ ] Route tests for every dashboard endpoint (auth required, org-scoped).
- [ ] Unit: score/share-of-voice calculations against hand-computed fixtures.
- [ ] E2E (Playwright): a logged-in user views their dashboard and drills into a single prompt.
- [ ] Cross-tenant leak tests extended to all new read queries.

**Exit criteria:** matches M2 — dashboard and citation intelligence are live, 10–15 design partners are onboarded and using it.

## Phase 10 — Action Center & closed loop

**Goal:** F7 — turn data into prioritized, provable actions.

**Work:**
- [ ] Rules engine over checks/metrics/citations → recommendation upserts with stable keys (`recommendations.open_key` generated column), no duplicates.
- [ ] ICE scoring; LLM narrative generation (evidence-only, no free-form facts, per [MVP §7.7](MVP.md#77-llm-usage-map-claude)).
- [ ] Closed-loop baselines and before/after comparison (`action_outcomes`, `week_2`/`week_4` horizons).

**Tests required before moving on:**
- [ ] Unit: rules engine produces the same recommendation key for the same underlying condition (no duplicate spam on re-run).
- [ ] Unit: ICE scoring math.
- [ ] Integration: a recommendation marked "done" correctly captures a baseline and later compares against it at the 2-week/4-week horizon.
- [ ] Unit: narrative generation never asserts a fact absent from the evidence passed in (a golden-set-style check on narrative outputs).

**Exit criteria:** a design partner can see a prioritized fix, mark it done, and later see a measured before/after.

## Phase 11 — Content Studio & WordPress Connector

**Goal:** F8 and F9 — close the loop by publishing fixes.

**Work:**
- [ ] Evidence pack → research (Claude + web search/fetch) → brief → draft (streamed) → QC → JSON-LD → human approval.
- [ ] TipTap editor integration in `src/web/views`.
- [ ] WordPress REST integration + `plugins/wordpress-connector/` PHP plugin (schema/meta injection, IndexNow) — contractor work per [MVP §13.1](MVP.md#131-team-mvp).

**Tests required before moving on:**
- [ ] Unit: JSON-LD output validates against schema.org before save.
- [ ] Integration: draft → publish flow against a WordPress test instance (Docker).
- [ ] Contract: the WordPress plugin's schema/meta injection tested against a real WP install, not just unit-level PHP tests.
- [ ] Unit: QC rubric scoring against fixture drafts (good and bad examples).

**Exit criteria:** a recommendation can be turned into a published WordPress post with correct structured data, and the originating recommendation is marked done with a closed-loop baseline captured.

## Phase 12 — AI traffic analytics, digest & billing

**Goal:** F10, F11, F12 — the retention and revenue layer.

**Work:**
- [ ] GA4 + Search Console OAuth and sync; AI-referral session/conversion charts ([MVP Appendix B](MVP.md#appendix-b--ai-referrer-sources-ga4)).
- [ ] Weekly digest email; alerts on significant drops or negative claims.
- [ ] Stripe: plans, Checkout, Customer Portal, usage meters for add-ons, plan-limit guard.
- [ ] Internal admin: ops, cost dashboards, provider health, job retries, extraction review, feature flags.

**Tests required before moving on:**
- [ ] Integration: Stripe webhook handling (subscription created/updated/canceled) idempotent against replay, mirroring the Clerk webhook pattern from Phase 1.
- [ ] Unit: plan-limit guard blocks an over-quota action and allows an in-quota one.
- [ ] Integration: GA4/GSC sync against recorded fixture responses (no live Google calls in CI).
- [ ] Unit: digest content generation against a fixture week of data (no drops → no alert; a real drop → alert fires).
- [ ] Admin: staff-only routes reject non-staff sessions (reuses Phase 1's 2FA-required check).

**Exit criteria:** a customer can subscribe, get billed correctly, see AI-traffic charts, and receive a weekly digest; staff can operate the system from internal admin.

## Phase 13 — Hardening, load/cost testing & launch (🚩 M3)

**Goal:** everything in [MVP §13.3 Definition of Done](MVP.md#133-mvp-definition-of-done) is true, not just each feature in isolation.

**Work:**
- [ ] Security review: SSRF, auth, tenancy tests re-run as a full suite; secrets-encryption audit; webhook signature verification audit (Clerk, Stripe, providers).
- [ ] Public methodology page, pricing page, onboarding polish.
- [ ] Runbooks in `deploy/` (provisioning, incident response, provider outage playbook).
- [ ] Legal: ToS, Privacy Policy, DPA, subprocessor list published (Clerk, DigitalOcean, Anthropic, providers, etc.).

**Tests required before moving on:**
- [ ] Full regression: every test suite from Phases 0–12 green in one CI run.
- [ ] Load test at 2× target concurrent load against staging (k6).
- [ ] Cost test: measured cost per prompt-run ≤ $0.12 and per audit ≤ $0.75 under real load, spend caps verified to actually pause collection.
- [ ] Security: an automated cross-tenant leak sweep across every table with `org_id` (not just spot checks).
- [ ] E2E (Playwright): the full new-user journey — free audit → trial signup → first weekly run → first executed recommendation — with no manual steps.

**Exit criteria:** every checkbox in [MVP §13.3](MVP.md#133-mvp-definition-of-done) is checked. This is the public launch.
