# AEO Corner — Build Plan

| | |
|---|---|
| **Document** | Phase-by-phase execution checklist for building the app |
| **Date** | 2026-10-02 (first written 2026-09-28; 2026-10-02 added the design-system and public-site phases and renumbered; Phase 1 engineering finished 2026-10-02; Phase 2 engineering finished 2026-10-02) |
| **Status** | In progress — Phases 0, 1 and 2: engineering is done and tested locally; open items are founder/infra work (accounts, brand and wireframe sign-off, legal text, Clerk and Cloudflare setup), the first run against real Clerk, and the first GitHub CI run with the Phase 2 changes. Phase 3 is next, when the founder asks for it |
| **Companion docs** | [MVP.md](MVP.md) §13 (narrative timeline, team, Definition of Done) · [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md) · [ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) · [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) · [CLAUDE.md](../CLAUDE.md) |

## 1. Purpose and how to use this plan

[MVP.md §13.2](MVP.md#132-12-week-timeline) says *what* ships each week. This document breaks each of those weeks into the actual units of work, so a phase is never "in progress" without a defined, checkable end. Rules:

1. **Work phases in order.** A phase's work items assume every earlier phase's exit criteria are met.
2. **A phase is not done until its Tests checklist passes**, in addition to its work checklist. Tests from earlier phases must still pass (no regressions) — this is what CI enforces from Phase 0 onward.
3. **Check boxes as work lands**, in this file, in the same commit/PR as the work. When every box in a phase is checked, mark the phase header `✅ Complete <date>`.
4. **If a phase reveals that an earlier decision was wrong**, stop and update the relevant doc ([MVP.md](MVP.md), [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)) in the same pass, per [CLAUDE.md](../CLAUDE.md)'s consistency rule — don't silently drift from the written design.
5. **Building began on 2026-09-28 with Phase 0.** Start each later phase only when the founder asks for it.

## 2. Testing conventions (apply to every phase)

| Category | Tool | Where | When it runs |
|---|---|---|---|
| Unit tests | **`node:test`** (Node's built-in runner) + `node:assert` — no new dependency, matches the founder's plain-JS/familiar-tools stack | Next to the code, `*.test.js` | Every commit (CI), every phase |
| HTTP route tests | **supertest** against the Express app in-process | `tests/routes/` | Every commit (CI), from Phase 1 on |
| DB integration tests | Real MySQL, not mocks — native MySQL 8 with `sql_require_primary_key` ON (the local Windows service; GitHub's pre-installed MySQL in CI; **no Docker**, see [CLAUDE.md](../CLAUDE.md#verifying-schema-changes)), migrated with `prisma migrate deploy` | `tests/integration/` | Every commit (CI), from Phase 2 on |
| Cross-tenant leak tests | For every tenant-scoped repository function in `src/db/`, assert org A can never read or write org B's rows | `tests/tenancy/` | Every commit (CI), from Phase 2 on — this is [MVP §7.1](MVP.md#71-architecture-principles) principle 7's "second line of defense" |
| Adapter/contract tests | Recorded fixture responses per provider, replayed — no paid calls in CI | `tests/fixtures/engines/`, `tests/adapters/` | Every commit (CI), from Phase 5 on |
| Public-page raw-HTML tests | supertest asserts each public page's real content is in the raw HTML response with no JavaScript run — the marketing site must be readable by AI crawlers ([MVP §7.3](MVP.md#73-components)) | `tests/routes/` | Every commit (CI), from Phase 1 on |
| Accessibility & responsive | **axe-core** through Playwright over every page listed in `tests/e2e/pages.js`, plus width checks at 375 / 768 / 1280 px — WCAG 2.1 AA ([MVP §10](MVP.md#10-non-functional-requirements)) | `tests/e2e/a11y/` | CI whenever `src/web/**` or `tailwind/**` changes, from Phase 1 on |
| Extraction eval | The 200-answer golden set scored against the [MVP §10](MVP.md#10-non-functional-requirements) accuracy targets | `evals/` | CI, whenever `src/llm/**` or prompt/schema files change (already specified in [MVP §7.10](MVP.md#710-environments--delivery)) |
| E2E smoke tests | **Playwright** (already in the stack for the crawler's render comparison, reused here) | `tests/e2e/` | Against staging before each milestone (M1/M2/M3), not on every commit |
| Load & cost tests | k6 (or autocannon) at 2× target load, plus the usage-ledger cost-per-audit / cost-per-run check from [MVP §13.3](MVP.md#133-mvp-definition-of-done) | `tests/load/` | Before Phase 15 (M3) only |

**Settled in Phase 0:** `node:test` + supertest are the unit and route test tools (see the `package.json` scripts).

**UI rule (from Phase 1 on):** every phase that adds screens builds them from the Phase 1 component kit, adds any new component to `/_styleguide`, and registers each new page in `tests/e2e/pages.js`, so the accessibility sweep covers it with no extra work. A screen built outside the kit needs a reason written in its phase.

**CI gate (from [MVP §7.10](MVP.md#710-environments--delivery)):** lint, unit tests, cross-tenant leak tests, migration drift check, extraction eval (conditional), accessibility sweep (conditional, from Phase 1), `npm audit` — all required to merge, starting Phase 0.

## 3. Phase overview

| # | Phase | Roughly maps to MVP §13.2 week(s) | Milestone |
|---|---|---|---|
| 0 | Prerequisites & project setup | Week 0 | — |
| 1 | Design system & public site shell | Weeks 1–2 | — |
| 2 | Auth, orgs & tenancy foundation | Weeks 1–2 | — |
| 3 | Job infrastructure & usage ledger | Weeks 1–2 | — |
| 4 | Site crawler & readiness checks | Weeks 1–2 | — |
| 5 | Engine adapters (spikes) | Weeks 1–2 | — |
| 6 | Extraction pipeline & golden-set eval | Week 3 | Decision D4 recorded |
| 7 | Free audit | Week 4 | 🚩 **M1: Free audit live** |
| 8 | Projects, Brand Kit & Prompt Manager | Weeks 5–6 | — |
| 9 | Tracking orchestrator, rollups & significance | Weeks 5–6 | — |
| 10 | Visibility Dashboard & Citation Intelligence | Weeks 7–8 | 🚩 **M2: Design-partner beta** |
| 11 | Action Center & closed loop | Week 9 | — |
| 12 | Content Studio & WordPress Connector | Week 10 | — |
| 13 | AI traffic analytics, digest & billing | Week 11 | — |
| 14 | Public marketing site & launch content | Weeks 11–12 | — |
| 15 | Hardening, load/cost testing & launch | Week 12 | 🚩 **M3: Public launch** |

**Capacity note.** Phase 1 runs alongside Phases 2–5 in weeks 1–2. With the [MVP §13.1](MVP.md#131-team-mvp) team, the designer and the UI-leaning engineer carry Phase 1 (plus Phase 2's auth screens), and the backend-leaning engineer carries Phases 3–5. The 12-week total does not change, because the public-site work that used to be crammed into week 12 now has its own phases. But weeks 1–2 are now the tightest stretch of the plan, and they slip first if the team is smaller than that.

## Phase 0 — Prerequisites & project setup

**Goal:** everything that has to exist before the first line of app code, so Phase 1 isn't blocked mid-stream.

**Founder/infra work (not engineering):**
- [ ] Register `aeocorner.com`.
- [ ] Create accounts: Clerk (customer app + staff app), Stripe, DigitalOcean, Resend, Anthropic (Claude API key), Cloudflare.
- [ ] Provision DigitalOcean: Droplet, Managed MySQL, Redis, Spaces, one region/VPC ([MVP §7.11](MVP.md#711-digitalocean-deployment-topology)).
- [ ] Fill in the `NULL` plan limits in [seed_reference.sql](db/seed_reference.sql) (seats, "run now" quota) — [DATABASE_SCHEMA §11 O7](DATABASE_SCHEMA.md#11-open-decisions).
- [ ] Submit Google OAuth verification (GA4/Search Console scopes) — long lead time, start early per [MVP §13.2](MVP.md#132-12-week-timeline) week 0.
- [ ] Draft ToS, Privacy Policy, DPA, subprocessor list ([MVP §11.3](MVP.md#11-security-privacy-compliance--ethics)). The ToS and Privacy drafts are needed before Phase 1 can publish them, and Phase 7 can't collect real emails without them.
- [ ] Brand basics for Phase 1: wordmark/logo, colour palette, typeface — or approve the designer's proposal in Phase 1. Always written "AEO Corner".

**Repo & tooling setup:**
- [x] `git init` (already done by the desktop app's session setup) — confirmed `node:test` + supertest per §2 above.
- [x] Scaffold the repo layout from [MVP §7.9](MVP.md#79-repository-layout-planned): `src/web`, `src/worker`, `src/core`, `src/db`, `src/engines`, `src/llm`, `src/crawler`, `src/integrations`, `src/lib`, `tailwind/`, `plugins/wordpress-connector/`, `evals/`, `tests/`, `deploy/`.
- [x] `.gitignore` (secrets, `node_modules/`, build output, Prisma generated client, Playwright artifacts).
- [x] **No Docker on this project** ([CLAUDE.md](../CLAUDE.md#verifying-schema-changes)). Local dev uses MySQL 8.0 installed natively on Windows (`aeo_corner_dev` / `aeo_corner_test` databases, `sql_require_primary_key` persisted ON) and a DigitalOcean-hosted Redis instance reached by its public URL — nothing to install for Redis.
- [x] `package.json` (plain JS, ESM, `node --test` + supertest scripts), ESLint 10 flat config + Prettier, `.env` / `.env.example` (every variable named; `.env` is git-ignored, real local values only).
- [x] Moved `docs/db/schema.sql` and `seed_reference.sql` into `prisma/migrations/0001_init/` and `0002_reference_data/`; added `prisma.config.ts` (Prisma 7 moved the datasource URL out of `schema.prisma` — CLI connection now lives here, loaded via `dotenv/config`); generated `schema.prisma`'s 64 models via `prisma db pull` against the migrated `aeo_corner_dev`; `prisma generate` outputs the client to `src/db/generated/` (git-ignored).
- [x] GitHub Actions CI skeleton ([.github/workflows/ci.yml](../.github/workflows/ci.yml)): lint, format, migrate deploy, `checks.sql`, migration-drift check, unit/smoke/route/integration/tenancy/adapter test scripts, `npm audit`. Runs on `ubuntu-latest` using its pre-installed MySQL 8 service (`sudo systemctl start mysql.service`, root/root) instead of a Docker service container, consistent with no-Docker.
- [ ] Sentry, PostHog, Langfuse projects created (keys only, wired later per phase) — founder task, still open.
- [x] `docs/adr/` created; backfilled [ADR-0001](adr/0001-prisma-config-split.md) (Prisma 7's config split) and [ADR-0002](adr/0002-override-mariadb-driver.md) (mariadb driver CVE override) for the two real architectural decisions this phase's work surfaced.

**Tests required before moving on:**
- [x] `docs/db/schema.sql`, `seed_reference.sql` and `checks.sql` load cleanly into the local `aeo_corner_dev` database with `sql_require_primary_key=ON` (persisted globally, survives a MySQL restart); `checks.sql` prints nothing; 64 tables confirmed.
- [x] `prisma migrate deploy` applies both migrations to the empty `aeo_corner_test` database; `_prisma_migrations` shows both finished; `checks.sql` still prints nothing (65 tables including `_prisma_migrations`).
- [x] `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code` reports no differences.
- [x] Lint, format check, and `npm run test:all` (unit/smoke/routes/integration/tenancy/adapters — the four empty suites pass cleanly via glob patterns that don't error on zero matches) all pass locally, matching what CI runs.
- [x] `npm audit` and `npm audit --omit=dev` both report 0 vulnerabilities — caught and fixed a real one along the way: `@prisma/adapter-mariadb@7.10.0` pins a `mariadb` driver version with a high-severity advisory (SSL doesn't actually protect the password from a MITM); overridden to a patched `3.4.x`/`3.5.x` via `package.json` `overrides`, without touching the pinned Prisma version.

**Exit criteria:** a developer can clone the repo, run `npm ci`, point `.env` at their local MySQL + a DO Redis URL, and have a working app skeleton with CI green. **Met**, except the external SaaS accounts (Sentry/PostHog/Langfuse) and the founder/infra checklist above.

## Phase 1 — Design system & public site shell

**Status (2026-10-02):** 🟡 **Engineering complete; waiting on founder items.** Everything buildable is built and tested locally. Open: founder sign-off (brand, wireframes, live homepage), the Terms and Privacy text, and the first CI run on GitHub. See the unchecked boxes below and [UI_DESIGN.md §11](UI_DESIGN.md#11-open-items-for-the-founder).

**Goal:** a designed, accessible, server-rendered public site shell and one reusable UI kit, so every later phase builds screens from the same system instead of inventing its own. The free audit goes live in week 4 (M1) on a public site, so the shell, the legal pages and the methodology page can't wait for launch week.

**Owner:** the product designer (≈50%, [MVP §13.1](MVP.md#131-team-mvp)) with the UI-leaning engineer.

**Design work (before code):**
- [x] [UI_DESIGN.md](UI_DESIGN.md): the screen inventory for every stage in [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md), a low-fidelity wireframe per screen group, the key flows, and content rules for empty, loading, error and partial-data states. **Drafted 2026-10-02; the wireframes are drafts for sign-off (below).** Added to [CLAUDE.md](../CLAUDE.md)'s Documents table.
- [x] A written UI rule in `UI_DESIGN.md` ([§1 rule 1](UI_DESIGN.md#1-ui-rules), [§7](UI_DESIGN.md#7-what-every-state-looks-like)): a failed or missing collection is never shown as "not mentioned" or as zero. It gets its own "Couldn't check" state, enforced in code by `ui.resultCell()` and unit-tested.
- [ ] Brand basics settled (wordmark, palette, typeface) — a **designer proposal is built and documented** ([UI_DESIGN.md §2](UI_DESIGN.md#2-brand-basics)); **needs founder approval**.
- [ ] **Founder sign-off on wireframes, one group at a time, before the phase that builds them starts:** public site + audit flow → before Phase 7; onboarding + Brand Kit + prompts → before Phase 8; dashboard + citations → before Phase 10; Action Center + Content Studio → before Phase 11; billing + settings → before Phase 13. *All five groups are drafted in [UI_DESIGN.md §5](UI_DESIGN.md#5-wireframes); none is signed off yet.*

**Build:**
- [x] Express app skeleton `src/web/server.js` / `app.js`: EJS, static files, error handler, structured request logging with request ids, and security headers including a strict CSP. Alpine's CSP-safe build was evaluated and adopted, so the CSP needs no `unsafe-inline` or `unsafe-eval` ([ADR-0003](adr/0003-strict-csp.md)). A cross-site guard protects the public form (session-based CSRF tokens arrived with auth in Phase 2).
- [x] Tailwind CLI pipeline (`npm run build:css`) with design tokens (colour, type scale, radius, shadow) in `tailwind/tokens.css`; the built CSS stays git-ignored under `src/web/public/build/`.
- [x] htmx and Alpine.js (CSP build) and the Inter font vendored and self-hosted from `src/web/public/` (`npm run vendor`) — no third-party CDN at runtime.
- [x] Layouts and partials: a `public` layout (header, footer, audit call-to-action) and an `app` layout (sidebar/top-bar shell, empty until Phase 2 fills it); a head partial with title, description, canonical URL, Open Graph tags and JSON-LD; flash messages (dismissible banners) and a toast region.
- [x] Component kit as EJS partials: buttons, form fields with validation errors, cards, tables, tabs, badges, modals, stat tiles, banners (including the "incomplete data" banner), empty/loading/error states, progress stepper — plus meters, the result cell and the answer excerpt ([UI_DESIGN.md §3](UI_DESIGN.md#3-design-tokens-and-component-kit)).
- [x] Dev-only `/_styleguide` route (404 in production) that renders every component in every state.
- [x] Transactional email base (HTML + plain-text) for Resend (`src/lib/email.js`), with the verification-code email as the first template; reused later by the audit report, invitation and weekly digest. *Sending through Resend is wired in Phase 7; this phase renders only.*
- [ ] Public pages:
  - [x] **home** (the audit form above the fold, per [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md) stage 1; posts to a stub that validates the address and stores nothing until Phase 7)
  - [x] **methodology v1** (content from [MVP §6](MVP.md#6-measurement-methodology-core-ip); the audit report will link here)
  - [ ] **Terms** and **Privacy Policy** — pages are built from a **working draft with `[bracketed]` gaps and a visible draft banner**, not the "Phase 0 drafts as approved by the founder" (those don't exist yet). Replace the text and remove the banner once a lawyer has reviewed it.
  - [x] 404, 500 and maintenance pages
- [x] Public-site SEO/AEO basics: `robots.txt` that allows the AI crawlers in [MVP Appendix A](MVP.md#appendix-a--ai-crawler-user-agents-readiness-checks) by name (list kept as config in `src/core/ai-crawlers.js`), `sitemap.xml`, canonical URLs, FAQPage/Organization/WebSite structured data, social-share image. Indexing is controlled by `APP_ENV`: only `production` is indexable.
- [x] Decide whether PostHog runs cookieless or behind a consent notice, and implement that choice: **cookieless, no banner** ([UI_DESIGN.md §9](UI_DESIGN.md#9-analytics-and-consent)). Needs the founder to switch on "Cookieless server hash mode" in PostHog and supply a key; with no key nothing loads.
- [ ] CI: a `build:css` step, the conditional accessibility job and the page registry `tests/e2e/pages.js`. *Workflow and registry are written; **the workflow has not run on GitHub yet**. Tick this once the first push is green.*

**Tests required before moving on:**
- [x] Route tests (supertest): every public page returns 200 with a unique `<title>`, a meta description and a canonical URL; an unknown path renders the 404 page with status 404; a thrown error renders the 500 page without leaking a stack trace. (`tests/routes/`: 74 tests covering all the route-level items in this phase.)
- [x] Raw-HTML test: each public page's main content (headings, body copy, the audit form) is present in the raw HTML response with no JavaScript run.
- [x] Accessibility: axe-core over every page in `tests/e2e/pages.js` and over `/_styleguide` — zero serious or critical violations (WCAG 2.1 AA, [MVP §10](MVP.md#10-non-functional-requirements)). Also covers the form's error state, the open modal and the open mobile menu.
- [x] Responsive: Playwright at 375, 768 and 1280 px — no horizontal overflow on any page, and the audit form is usable at 375 px.
- [x] Third-party requests: a Playwright run of the public pages shows no requests to third-party hosts other than PostHog and Cloudflare Turnstile (neither is configured in the sweep, so it asserts none at all). *Turnstile and PostHog themselves are not yet exercised against the real services (no keys); the CSP unit tests cover their configured form.*
- [x] `/_styleguide` returns 404 when `NODE_ENV=production`, and renders every component with no console errors (including CSP violations) in development.
- [x] Email base: HTML and plain-text variants both render; no unreplaced template tokens.
- [x] Indexing config: staging responds with `noindex`; the production config does not (route and config tests).
- [ ] `npm run build:css` succeeds in CI. *It succeeds locally; tick after the first green CI run.*

**Local results (2026-10-02):** lint and Prettier clean; `npm test` 42 passing; `npm run test:routes` 74 passing; `npm run test:e2e` 44 passing (Chromium); `npm audit` 0 vulnerabilities.

**Exit criteria:** the founder has signed off the public-site and audit-flow wireframes and the live homepage; every public page passes the raw-HTML, accessibility and responsive checks in CI; `/_styleguide` documents the whole kit; the Terms and Privacy pages are live, so Phase 7 can collect real emails. **Not yet met:** founder sign-off, approved Terms/Privacy text, and a green CI run. The checks themselves pass locally.

## Phase 2 — Auth, orgs & tenancy foundation

**Status (2026-10-02):** 🟡 **Engineering complete; waiting on a first run against real Clerk.** Everything buildable is built and tested locally, but no Clerk keys existed, so the Clerk-facing parts were tested against a fake with the same four methods as the real provider, and webhooks against real Svix signatures. The founder's Clerk and Cloudflare setup (below) is the remaining work. See [ADR-0004](adr/0004-clerk-hosted-sign-in.md) for the decision and its first-run checklist.

**Goal:** a signed-in user can create an org and see an empty authenticated shell; every tenant-scoped query is provably isolated.

**Work:**
- [x] `@clerk/express` wired into `src/web`: `clerkMiddleware()` (run only under `/app`, `/invite` and `/sign-out`, never on public pages), sign-in/sign-up through **Clerk's hosted pages** (embedded components would need `style-src 'unsafe-inline'`, undoing [ADR-0003](adr/0003-strict-csp.md); see [ADR-0004](adr/0004-clerk-hosted-sign-in.md)), and the authenticated shell on Phase 1's `app` layout with an organization switcher and sign-out.
- [x] `users` upsert-on-first-request path (lazy create, catch `P2002` per [DATABASE_SCHEMA §10.1](DATABASE_SCHEMA.md#101-auth-clerk-identity-only)); the webhook and the first request can race and both win safely (tested).
- [x] Clerk webhook endpoint `POST /webhooks/clerk` (`user.created`/`updated`/`deleted`): Svix signature verified on the raw body, `webhook_events` dedupe by `svix-id`, stale events dropped by `updated_at`, failures answer 500 so Clerk retries.
- [x] `organizations`, `memberships`, `membership_projects`, `invitations` + the four roles (owner/admin/editor/viewer). The Team page (`/app/o/:org/settings`) lists members, changes roles, removes members, and sends, resends and cancels invitations. An organization always keeps at least one owner, even when two owners demote each other at the same moment. *`membership_projects` (limited client seats) is implemented and tested in the repository, with no screen until projects exist in Phase 8.*
- [x] Invitation email flow: random token (only its SHA-256 is stored), emailed link, acceptance needs the token **and** a Clerk-verified email matching the invitation. Sending goes through Resend (`src/lib/mailer.js`); with no `RESEND_API_KEY` emails are written to the server log instead, and the server refuses to start in production without a key.
- [x] Tenant-scoped repository layer in `src/db/` — the only place `prisma.*`/`$queryRaw` may appear ([DATABASE_SCHEMA §10.2](DATABASE_SCHEMA.md#102-orm-prisma-7-with-sql-first-migrations) rule 7). Enforced by an ESLint rule that applies to tests too, and `src/db/boundary.test.js` proves the rule fires.
- [x] Staff app skeleton on its own host: separate Clerk app, invite-only (`npm run staff:invite`), `staff_users`/`staff_roles`, Cloudflare Access token verified by the app itself, mandatory second factor (Clerk's `fva` claim), role checks. Only the doorway exists (a "Staff console" page showing who you are and your roles); the admin modules come with the phases that need them.
- [x] *Added in this phase:* CSRF tokens on every signed-in form (an HMAC of the Clerk session ID, nothing stored); organization in the URL (`/app/o/:org`); analytics (PostHog) made opt-in per page so it never sees signed-in, invitation or staff URLs; a `stack` option for tables on phones; `tests/e2e/server.js` (the real app with a fake Clerk and the test database) so the signed-in screens get the same accessibility and overflow sweeps as the public ones.
- [ ] *Carried forward:* the first htmx request that changes data on a signed-in page must send the CSRF token. The server already accepts it in an `X-CSRF-Token` header; the client side (a `<meta>` tag and an `htmx:configRequest` listener in `components.js`), and reloading the page on a `401`, are added together with that first request (Phase 8 onward), because there is no htmx call on a signed-in page yet to test them against.
- [ ] **Run it once against real Clerk** (a development instance, customer and staff), following the checklist in [ADR-0004](adr/0004-clerk-hosted-sign-in.md): the handshake from `localhost`, `redirect_url` on the hosted page, the staff token carrying `fva`, sign-out. Needs the founder's keys.
- [ ] **Founder setup** (not engineering): in the customer Clerk app, a webhook endpoint `<APP_BASE_URL>/webhooks/clerk` with the three user events, its signing secret in `CLERK_WEBHOOK_SECRET`; in the staff Clerk app, invite-only sign-up, multi-factor required, 30-minute inactivity timeout; a Cloudflare Access application on the staff host (team name and AUD tag into `.env`); the first staff member from `npm run staff:invite`.

**Tests required before moving on:**
- [x] Unit: role-permission matrix (who can do what) for owner/admin/editor/viewer (`src/core/permissions.test.js`, every cell written out by hand; plus the team rules: admins can't touch owners or make owners).
- [x] Integration: sign-in → org creation → membership row exists, against real MySQL (`tests/integration/identity.test.js`; the same flow through the web routes in `tests/routes/app.test.js`).
- [x] Integration: webhook replay (same `svix-id` twice) is a no-op; out-of-order `updated_at` is dropped; a deleted user can't be revived; a failed delivery is retried and succeeds (`tests/routes/webhooks.test.js`, with real Svix signatures, and `tests/integration/webhooks-staff.test.js`).
- [x] **Cross-tenant leak suite goes live here** (`tests/tenancy/`) — every repository function and every organization route is called as org A against org B's data and must find nothing and change nothing. Both suites **fail if a function or route is added without a test**, so they grow with every later phase. Checked by mutation: removing an `org_id` filter makes them fail.
- [x] Route tests: unauthenticated requests to any authenticated route redirect (pages) or answer `401` (everything else), and create nothing.
- [x] Staff: a Clerk session without a second factor is rejected by the admin middleware; so are a missing, expired, wrong-audience or wrongly signed Cloudflare token, an uninvited account, a suspended member and a second Clerk account claiming a bound email (`tests/routes/staff.test.js`).
- [x] Also: CSRF (missing, wrong, other-session and cross-site tokens), open-redirect attempts on the sign-in return address, invitation edge cases (wrong or unverified email, expired, withdrawn, double accept, two tabs at once), analytics absent from private pages, and the accessibility, overflow and flow checks for every new screen in Chromium.

**Local results (2026-10-02):** lint and Prettier clean; `npm test` 136 passing; `npm run test:routes` 156 (74 from Phase 1); `npm run test:integration` 42; `npm run test:tenancy` 27; `npm run test:e2e` 88 (44 from Phase 1); `npm audit` 0 vulnerabilities. Two concurrency tests were confirmed to fail when their protection (a row lock) is removed.

**Exit criteria:** sign-up, org creation, invitations and role checks work end to end against real MySQL — **met, with Clerk faked**; the cross-tenant suite exists and passes — **met**; no direct Prisma/raw-SQL calls exist outside `src/db/` — **met** (lint rule). **Not yet met:** the first run against real Clerk, and the founder's Clerk and Cloudflare setup.

## Phase 3 — Job infrastructure & usage ledger

**Status (2026-10-02):** 🟠 **Started; code and the five required tests are written and passing locally, but the phase is not finished.** Still to do: tests for the Bull Board page on the staff host (`src/web/staff/queues.js`, written but never run in a browser or under the CSP), the CI changes (Redis in the workflow, plus `SHADOW_DATABASE_URL` for the accessibility job, which is edited locally and not pushed), the docs pass (CLAUDE.md, MVP §7.8, ADMIN_OPERATIONS §6, an ADR for the queue design) and one flaky integration test seen once in a full run (passed on rerun). Redis for local work is the shared container on port 6379: use databases 14 (dev) and 15 (tests), never 0, never flush.

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

## Phase 4 — Site crawler & readiness checks

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

## Phase 5 — Engine adapters (spikes)

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

## Phase 6 — Extraction pipeline & golden-set eval

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

## Phase 7 — Free audit (🚩 M1)

**Goal:** the first public-facing, revenue-relevant surface — F1 end to end, target under 10 minutes.

**Work:**
- [ ] Public audit endpoint: Cloudflare Turnstile, OTP email verification, rate limiting.
- [ ] Orchestrates: crawler (Phase 4) → lite Brand Kit → 5 prompts → live-mode collection across all 4 engines (Phase 5) → synchronous extraction (Phase 6) → scores → fixes.
- [ ] Audit screens — URL form → work email → 6-digit code → live progress page (server-sent events) → report — built from Phase 1's kit and the signed-off wireframes. The report email uses Phase 1's email base.
- [ ] The email step has the marketing-consent checkbox and links to the Terms and Privacy pages from Phase 1; the choice is stored on `leads`.
- [ ] The report carries the one-sample honesty note and links to Phase 1's methodology page ([CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md) honesty rules).
- [ ] Lead capture into `leads`; audit analytics funnel (PostHog).

**Tests required before moving on:**
- [ ] E2E (Playwright): submit a domain → receive a report, against staging, using recorded/fixture provider responses so it's not paid per CI run. Run at a 375 px mobile viewport as well as desktop.
- [ ] Accessibility: every audit screen is in `tests/e2e/pages.js` and passes the axe sweep (WCAG 2.1 AA).
- [ ] Integration: a lead row stores the consent flag exactly as ticked (unticked is stored as no consent, never defaulted to yes).
- [ ] Integration: rate limiting and Turnstile bypass attempts are rejected.
- [ ] Integration: OTP flow — correct code passes, expired/wrong code fails, per [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md) verification-code row.
- [ ] Load: the audit path holds up under a burst of concurrent submissions without exceeding the per-org/global provider rate limits.
- [ ] Cost check: measured cost per audit against the ≤ $0.75 target in [MVP §13.3](MVP.md#133-mvp-definition-of-done).

**Exit criteria:** matches [MVP §13.2](MVP.md#132-12-week-timeline) M1 — free audit is live and generating leads while later phases are built, with Phase 1's Terms, Privacy and methodology pages already live.

## Phase 8 — Projects, Brand Kit & Prompt Manager

**Goal:** F2 and F3 — the setup a paying customer does before tracking starts.

**Work:**
- [ ] `projects` CRUD, scoped by org; composite FK `(project_id, org_id)` pattern used everywhere from here on.
- [ ] Brand Kit auto-extraction (domain → brand profile, products, competitors, voice), editable and versioned.
- [ ] `tracked_entities` (brand + competitors), generated column `brand_project_id`.
- [ ] Prompt Manager: generate/import/edit prompts, with intent, cluster, locale.
- [ ] Onboarding screens ([CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md) stage 5: confirm brand → competitors → questions → integrations) and the Brand Kit and Prompt Manager screens, built from Phase 1's kit and the signed-off wireframes. The customer is never shown an empty screen while the first run is pending.

**Tests required before moving on:**
- [ ] Accessibility: onboarding, Brand Kit and Prompt Manager screens are in `tests/e2e/pages.js` and pass the axe sweep ([MVP §10](MVP.md#10-non-functional-requirements) requires WCAG 2.1 AA for onboarding).
- [ ] Cross-tenant leak tests extended to `projects`, Brand Kit and prompt tables (§2 suite grows).
- [ ] Unit: Brand Kit versioning — editing creates a new version without losing history.
- [ ] Integration: prompt generation respects the intent-coverage rules from [MVP §7.7](MVP.md#77-llm-usage-map-claude).
- [ ] Unit: `tracked_entities.brand_project_id` generated column matches expectations across insert/update.

**Exit criteria:** a customer can create a project, get a Brand Kit, and have a prompt set ready for tracking — all tenant-isolated and tested.

## Phase 9 — Tracking orchestrator, rollups & significance

**Goal:** F4 — the scheduled engine that actually produces ongoing visibility data.

**Work:**
- [ ] Scheduler → orchestrator: expand prompts × engines × samples into tasks, respecting per-provider concurrency (Phase 3) and using the adapters (Phase 5) and extraction pipeline (Phase 6).
- [ ] `cell_results`/`cell_entity_results` fact-table writes (no FKs, `run_date` in every key, per [DATABASE_SCHEMA](DATABASE_SCHEMA.md#schema-rules) fact-table rules).
- [ ] Daily rollups by project × engine × cluster × intent × locale.
- [ ] Significance tests and change-event emission; partial runs marked `partial` and excluded from trend significance (never counted as zero).

**Tests required before moving on:**
- [ ] Integration: a full scheduled run (mocked adapters) produces the expected fact rows and rollups.
- [ ] Unit: significance test math against known statistical fixtures.
- [ ] Unit: a partial/failed collection is excluded from trend calculations, not counted as "not mentioned" ([MVP §7.1](MVP.md#71-architecture-principles) principle 4/schema rollup rule).
- [ ] Integration: re-running the same scheduled slot twice does not double-count (idempotency via unique keys, [DATABASE_SCHEMA](DATABASE_SCHEMA.md#schema-rules)).

**Exit criteria:** a project runs on its weekly slot automatically, unattended, and produces correct rollups even when one engine's collection partially fails.

## Phase 10 — Visibility Dashboard & Citation Intelligence (🚩 M2)

**Goal:** F5 and F6 — the screens design partners will actually look at.

**Work:**
- [ ] Dashboard: score, mention rate, share of voice, position, sentiment, trends, per-prompt drilldown (EJS + htmx + Alpine + Chart.js/ECharts), built from Phase 1's kit and the signed-off dashboard wireframes.
- [ ] Charts are accessible: meaning is never carried by colour alone, each chart has a data-table alternative, and tooltips are reachable by keyboard.
- [ ] Partial and failed data follow the Phase 1 UI rule: an engine that failed this week shows the "incomplete data" banner and "couldn't check" cells, never 0% or "not mentioned".
- [ ] Competitor comparison views.
- [ ] Citation & Source Intelligence: which domains/URLs get cited, citation-gap vs. competitors.
- [ ] Design-partner onboarding flow (10–15 partners per [MVP §13.2](MVP.md#132-12-week-timeline)).

**Tests required before moving on:**
- [ ] Route tests for every dashboard endpoint (auth required, org-scoped).
- [ ] Unit: score/share-of-voice calculations against hand-computed fixtures.
- [ ] E2E (Playwright): a logged-in user views their dashboard and drills into a single prompt.
- [ ] Render test: a project whose latest run is partial shows the "incomplete data" banner and "couldn't check" cells, not zeros.
- [ ] Accessibility: dashboard, prompt drilldown, competitor and citation screens are in `tests/e2e/pages.js` and pass the axe sweep (WCAG 2.1 AA, [MVP §10](MVP.md#10-non-functional-requirements)).
- [ ] Cross-tenant leak tests extended to all new read queries.

**Exit criteria:** matches M2 — dashboard and citation intelligence are live, 10–15 design partners are onboarded and using it.

## Phase 11 — Action Center & closed loop

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

## Phase 12 — Content Studio & WordPress Connector

**Goal:** F8 and F9 — close the loop by publishing fixes.

**Work:**
- [ ] Evidence pack → research (Claude + web search/fetch) → brief → draft (streamed) → QC → JSON-LD → human approval.
- [ ] TipTap editor integration in `src/web/views`.
- [ ] WordPress REST integration + `plugins/wordpress-connector/` PHP plugin (schema/meta injection, IndexNow) — contractor work per [MVP §13.1](MVP.md#131-team-mvp).

**Tests required before moving on:**
- [ ] Unit: JSON-LD output validates against schema.org before save.
- [ ] Integration: draft → publish flow against a WordPress test instance. No Docker on this project ([CLAUDE.md](../CLAUDE.md#verifying-schema-changes)), so decide the test-instance approach when this phase starts (for example a throwaway WordPress install on the staging Droplet).
- [ ] Contract: the WordPress plugin's schema/meta injection tested against a real WP install, not just unit-level PHP tests.
- [ ] Unit: QC rubric scoring against fixture drafts (good and bad examples).

**Exit criteria:** a recommendation can be turned into a published WordPress post with correct structured data, and the originating recommendation is marked done with a closed-loop baseline captured.

## Phase 13 — AI traffic analytics, digest & billing

**Goal:** F10, F11, F12 — the retention and revenue layer.

**Work:**
- [ ] GA4 + Search Console OAuth and sync; AI-referral session/conversion charts ([MVP Appendix B](MVP.md#appendix-b--ai-referrer-sources-ga4)).
- [ ] Weekly digest email; alerts on significant drops or negative claims.
- [ ] Stripe: plans, Checkout, Customer Portal, usage meters for add-ons, plan-limit guard. The `plans` table is the single source for plan limits and prices; Phase 14's pricing page reads from it too.
- [ ] Billing and settings screens (plan picker, trial state, limit-reached and upgrade prompts) built from Phase 1's kit and the signed-off wireframes.
- [ ] Internal admin: ops, cost dashboards, provider health, job retries, extraction review, feature flags.

**Tests required before moving on:**
- [ ] Integration: Stripe webhook handling (subscription created/updated/canceled) idempotent against replay, mirroring the Clerk webhook pattern from Phase 2.
- [ ] Unit: plan-limit guard blocks an over-quota action and allows an in-quota one.
- [ ] Integration: GA4/GSC sync against recorded fixture responses (no live Google calls in CI).
- [ ] Unit: digest content generation against a fixture week of data (no drops → no alert; a real drop → alert fires).
- [ ] Admin: staff-only routes reject non-staff sessions (reuses Phase 2's 2FA-required check).
- [ ] Accessibility: billing and settings screens are in `tests/e2e/pages.js` and pass the axe sweep.

**Exit criteria:** a customer can subscribe, get billed correctly, see AI-traffic charts, and receive a weekly digest; staff can operate the system from internal admin.

## Phase 14 — Public marketing site & launch content

**Goal:** the full public website that earns the traffic the funnel needs, built on Phase 1's shell, using the real plan data from Phase 13 — and one that passes our own AEO readiness checks. A product that sells AI visibility has to be visible and readable to AI engines itself.

**Owner:** the founder (positioning and content) with the designer and the UI-leaning engineer.

**Work:**
- [ ] Product pages: one per stage of Measure → Diagnose → Fix → Prove, plus an agency page for the secondary persona in [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md). Every page carries the audit form above the fold.
- [ ] Pricing page: plans, limits, trial terms and FAQ, **rendered from the `plans` table** so no number is copied by hand.
- [ ] Methodology page, final version: expand Phase 1's v1 with sample sizes, significance testing, known limits and the honesty rules ([MVP §6](MVP.md#6-measurement-methodology-core-ip)), plus the blind-comparison credibility check if it has been run ([MVP §14](MVP.md#14-success-metrics--validation)).
- [ ] Design-partner case studies from the M2 beta. The Day-5 nurture email in [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md) links to one.
- [ ] Launch content: an initial set of guides and articles for the "search and AI answers" entry point in [CUSTOMER_JOURNEY.md](CUSTOMER_JOURNEY.md), with the topic list agreed with the founder.
- [ ] Structured data (JSON-LD) for the organisation, the product and FAQ content, validated against schema.org.
- [ ] Analytics funnel in PostHog: page view → audit started → audit completed → "track weekly" click → sign-up ([MVP §14](MVP.md#14-success-metrics--validation) "audit as demand test"), with UTM capture. Anonymous events only.
- [ ] Dogfood: run Phase 4's readiness checks against our own site using the **production** indexing config (staging's deliberate `noindex` would trip the F1 indexability check), and fix every critical failure.
- [ ] `sitemap.xml` lists every public page.

**Tests required before moving on:**
- [ ] The Phase 1 route, raw-HTML, accessibility and responsive checks cover every new page (each one is registered in `tests/e2e/pages.js`).
- [ ] Integration: every price and limit on the pricing page equals the `plans` table. Change a row and the page changes.
- [ ] Link check: crawl from the sitemap — no broken internal links, every public page is in the sitemap, and no app or admin page is.
- [ ] JSON-LD on every page that carries it validates against schema.org (reuse Phase 12's validator).
- [ ] Dogfood: the readiness checks against the site (production indexing config) return no critical failures.
- [ ] Config: production serves indexable pages and a `robots.txt` that allows the AI crawlers in [MVP Appendix A](MVP.md#appendix-a--ai-crawler-user-agents-readiness-checks); staging blocks all crawlers.
- [ ] Analytics: the funnel events fire in the Playwright run (against a PostHog stub) and none carries personal data.

**Exit criteria:** the founder has signed off all public copy; every page is live on the production domain, indexable, and passes the accessibility sweep; the pricing page matches billing; the site passes our own readiness checks.

## Phase 15 — Hardening, load/cost testing & launch (🚩 M3)

**Goal:** everything in [MVP §13.3 Definition of Done](MVP.md#133-mvp-definition-of-done) is true, not just each feature in isolation.

**Work:**
- [ ] Security review: SSRF, auth, tenancy tests re-run as a full suite; secrets-encryption audit; webhook signature verification audit (Clerk, Stripe, providers).
- [ ] Onboarding polish: first-run experience, empty states and copy, driven by design-partner feedback. (The methodology and pricing pages are done in Phases 1 and 14.)
- [ ] Runbooks in `deploy/` (provisioning, incident response, provider outage playbook).
- [ ] Legal: the Terms and Privacy pages have been live since Phase 1. Publish the DPA and subprocessor list (Clerk, DigitalOcean, Anthropic, providers, etc.), and check the list against the vendors actually wired into the code.

**Tests required before moving on:**
- [ ] Full regression: every test suite from Phases 0–14 green in one CI run.
- [ ] Accessibility: the complete axe sweep (every page in `tests/e2e/pages.js`) is green — [MVP §10](MVP.md#10-non-functional-requirements) requires WCAG 2.1 AA for the audit, onboarding and dashboard.
- [ ] Load test at 2× target concurrent load against staging (k6).
- [ ] Cost test: measured cost per prompt-run ≤ $0.12 and per audit ≤ $0.75 under real load, spend caps verified to actually pause collection.
- [ ] Security: an automated cross-tenant leak sweep across every table with `org_id` (not just spot checks).
- [ ] E2E (Playwright): the full new-user journey — free audit → trial signup → first weekly run → first executed recommendation — with no manual steps.

**Exit criteria:** every checkbox in [MVP §13.3](MVP.md#133-mvp-definition-of-done) is checked. This is the public launch.
