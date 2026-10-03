# AEO Corner — Build Plan

| | |
|---|---|
| **Document** | Phase-by-phase execution checklist for building the app |
| **Date** | 2026-10-03 (first written 2026-09-28; 2026-10-02 added the design-system and public-site phases and renumbered; Phase 1 engineering finished 2026-10-02; Phase 2 engineering finished 2026-10-02; Phase 5 engineering finished 2026-10-03; Phase 6 pipeline built 2026-10-03) |
| **Status** | In progress — Phases 0, 1 and 2: engineering is done and tested locally; open items are founder/infra work (accounts, brand and wireframe sign-off, legal text, Clerk and Cloudflare setup), the first run against real Clerk, and the first GitHub CI run with the Phase 2 changes. Phase 3: code and tests done, the Bull Board page and docs pass still open. Phase 4: engineering done, not yet run in CI. Phase 5: engineering done; live calls verified for Perplexity and SerpApi; DataForSEO's credentials now work (they collected the Phase 6 golden set on 2026-10-03), but its recorded live check is still to do. Phase 6: pipeline, golden set and eval built and run; D4 is provisionally "keep Opus 5.5", final after the founder's label review. Phase 7 is next, when the founder asks for it |
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

**Status (2026-10-02):** 🟠 **Started; code and the five required tests are written and passing locally, but the phase is not finished.** Still to do: tests for the Bull Board page on the staff host (`src/web/staff/queues.js`, written but never run in a browser or under the CSP), the docs pass (CLAUDE.md, MVP §7.8, ADMIN_OPERATIONS §6, an ADR for the queue design). *Done since: the CI changes shipped in `180e431` and GitHub Actions ran green on 2026-10-02; the integration test that failed once in a full run was found and fixed during Phase 4 (an "empty bucket" test that assumed the worker starts within two seconds, which a loaded machine misses; and a real MySQL deadlock when organizations are created at the same moment, now retried by `src/db/transaction.js`).* Redis for local work is the shared container on port 6379: use databases 14 (dev) and 15 (tests), never 0, never flush.

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

**Status (2026-10-02):** 🟡 **Engineering complete and tested locally; not yet pushed, so CI has not run it** (new in CI: a Chromium install step for the render tests). The storage was run against the founder's **real Spaces bucket** on 2026-10-02 and works; the founder also decided that **a customer scanning their own project is not stopped by `robots.txt`** (built; the free audit still obeys it). Left to do outside this code: the `/bot` page the crawler's user agent points to, domain-ownership verification before the override is relied on (Phase 8), and installing Chromium on the Droplet (Phase 15). The decisions behind the fetcher, the browser, `robots.txt` and storage are in [ADR-0005](adr/0005-fetching-other-peoples-websites.md).

**Goal:** given a domain, safely fetch and evaluate it for AEO readiness — this is the first real building block of the free audit (F1) and onboarding (F2).

**Work:**
- [x] SSRF-safe HTTP fetcher (`src/crawler/safe-fetch.js`, `ip-guard.js`): refuses private, loopback, link-local, metadata, CGNAT and reserved addresses (IPv4, IPv6 and IPv4 hidden in IPv6); resolves the name once and connects to the address it checked; re-checks every redirect (max 5); ports 80/443 only; 5 MB after decompression, 15 s in total; certificate checked against the name; politeness per host (2 at once, 500 ms apart).
- [x] robots.txt + sitemap parsing; AI-crawler user-agent checks ([MVP Appendix A](MVP.md#appendix-a--ai-crawler-user-agents-readiness-checks)). robots.txt follows RFC 9309 (`src/crawler/robots.js`) and is **obeyed** by our crawler. Sitemaps are read with a one-pass scanner (`sitemap.js`) that cannot be tricked into reading files or expanding entities. The look-alike AI-crawler user-agent strings for check A3 are in `src/core/ai-crawlers.js`, **checked against OpenAI's and Perplexity's documentation on 2026-10-02** (Anthropic publishes the names but not the full string, so that one is built in the same shape).
- [x] Raw-HTML fetch + Playwright headless render, stored to Spaces (`src/crawler/render.js`, `src/integrations/spaces.js`). **Chromium never opens a connection of its own**: every request the page makes is answered by the safe fetcher, and name resolution is switched off inside the browser as a second wall. Raw bytes are stored under content-addressed keys (`crawl/2026/10/<sha256>.html`), so a retry writes the same key. *Tested against an S3-compatible stand-in server with the real AWS client, **not** against a real DigitalOcean Spaces bucket.*
- [x] Page-selection heuristics (`src/crawler/select-pages.js`): the home page, then up to 19 more from the menu and the sitemap, ranked by what the page is (about, pricing, product, service, FAQ, contact, recent articles), with logins, carts, search, archives and legal pages left out; 5 of them are rendered.
- [x] Readiness checks v0 (`src/crawler/readiness/`): all **24** checks of [MVP §6.6](MVP.md#66-aeo-readiness-rubric-v0) (A1–F4, 100 points, rubric version `v0.1`). A page that could not be read, a firewall in the way or a missing browser makes a check say "couldn't check" and leaves it out of the score; with less than half the rubric evaluated the score is empty, never 0.
- [x] *Fixed along the way (a bug from Phase 2):* creating organizations at the same moment could make MySQL abandon one transaction as a deadlock, and the person's request failed. Every repository transaction now goes through `transaction()` (`src/db/transaction.js`), which retries it; a lint rule keeps it that way, and `tests/integration/org-concurrency.test.js` makes MySQL deadlock two transactions for real and checks both finish. It surfaced as an unrelated test failing whenever the whole suite ran at once.
- [x] *Added in this phase:* the `crawl.readiness` job on the `crawl` queue and `forOrg(orgId).scans` (queued → running → complete / partial / failed, results replaced on retry, `site_pages` refreshed); `requestScan()` to start one; one `usage_ledger` row per scan (meter `crawl`, requests made, cost 0); `npm run scan -- <domain>` to scan any site from the command line with no database; `DO_SPACES_*` configuration (all or none; production refuses to start the worker without it); the page-type, platform (WordPress, Shopify, Next.js, client-rendered app…) and charset detection the checks need.
- [ ] *Carried forward:* persistence for **audit-owned** scans (no organization yet) arrives with the audit pipeline in Phase 8; the code path is the same, only the owner differs.
- [x] The first run against real Spaces (2026-10-02, bucket `dbs-central-space` in `sgp1`, shared with other apps): write, read-back, delete and a real scan's raw and rendered pages all work, inside this app's own directory `aeo-corner/dev/`. The AWS client's checksum setting is proven there. Environment variables are the project's existing `DO_SPACES_*` names.
- [x] *Founder decision (2026-10-02):* a signed-in customer scanning **their own project** is not stopped by `robots.txt` (`respectRobots: false`, set by the `crawl.readiness` job; `--ignore-robots` on the command line). The free audit keeps obeying it. The scan notes when it went ahead, and check A1 still reports what the file says. See [ADR-0005](adr/0005-fetching-other-peoples-websites.md) for the limit: domains are not yet verified as the customer's own.
- [ ] *Carried forward:* publish `https://aeocorner.com/bot` (what the crawler is, what it fetches, how to block it) before the crawler visits sites we do not own — tracked in Phase 7, whose audit is the first thing to do that.

**Tests required before moving on:**
- [x] Unit: SSRF guard rejects `127.0.0.1`, `169.254.x.x`, RFC1918 ranges, and a redirect chain that ends up there (`src/crawler/ip-guard.test.js`, `safe-fetch.test.js`: 74 cases including decimal, hex and octal spellings, IPv6 forms, DNS that answers with a private address, and a name whose DNS answer changes between lookups; and `tests/integration/crawler-fetch.test.js` with real sockets, compressed bombs, oversized and endless responses, and TLS). Checked by mutation: removing any one protection (the redirect re-check, the "any address" rule, the port rule, the metadata range, the IPv4-in-IPv6 unwrapping…) makes a test fail.
- [x] Integration: fetching a fixture site produces the expected raw payload in the test Spaces bucket (`tests/integration/crawler-scan.test.js`: every page's stored bytes equal what the server sent, byte for byte, through the real S3 client; a second scan writes nothing new).
- [x] Unit: each readiness check has at least one fixture that should pass and one that should fail (`src/crawler/readiness/checks-*.test.js`: 136 cases for the 24 checks, plus the scoring rules). Checked by mutation on thresholds and logic.
- [x] Contract: Playwright render matches raw HTML fetch on a stable fixture page (`tests/adapters/render.test.js`: same text, title, structured data, links and content blocks; and a page whose content is added by JavaScript shows exactly that difference). The same file proves the browser reaches nothing the guard would refuse: a page that calls an internal service by `fetch`, XHR, WebSocket, beacon, image, frame, script, form, meta refresh and redirect never reaches it.
- [x] Also: `crawl.readiness` as a queued job against real Redis and MySQL (retry without doubled results, dead-letter set and a scan marked failed, a payload naming another organization's scan refused — `tests/integration/crawler-job.test.js`); the scan repository in the cross-tenant suite, eight mutations of its tenant filters all caught; hostile input (a 5 MB sitemap of unclosed tags, HTML nested 100,000 deep, a gzip bomb, a robots.txt with 20,000 rules) handled in linear time.

**Local results (2026-10-02):** lint and Prettier clean; `npm test` 566 passing; `npm run test:routes` 156; `npm run test:integration` 155 (six full runs in a row, all passing, before the last five tests were added); `npm run test:tenancy` 50; `npm run test:adapters` 38; `npm run test:e2e` 88; `npm audit` 0 vulnerabilities.

**Exit criteria:** pointing the crawler at a handful of real, varied domains (a WordPress site, a SPA, a site that blocks bots) produces sane, storable readiness results without ever touching a private IP — **met**, run by hand on 2026-10-02 with `npm run scan`, and each run listed the addresses it connected to (all public):

| Site | What it is | Result |
|---|---|---|
| wpbeginner.com | WordPress, large | Score **85**, 20 pages read, all 24 checks answered; about 70–80 s (mostly the 500 ms politeness gap and a big sitemap, now capped at 20 s) |
| excalidraw.com | JavaScript-only app | Score 41; **B1 fails**: 2% of the text is in the raw HTML, the rest appears only after scripts run; platform recognised as a client-rendered app |
| nytimes.com | blocks bots | robots.txt blocks six AI crawlers by name (A1 partial); every automated request gets 403: **no score ("couldn't check")**, not 0 |
| glassdoor.com | blocks bots | Cloudflare turns away every automated request: A3 fails, the page checks say "couldn't check", **no score** |
| example.com | tiny | Score 31; B1 fails correctly, since the page now adds most of its text with a script |

**Not yet met:** a green CI run (the work is not pushed yet).

## Phase 5 — Engine adapters (spikes)

**Status (2026-10-03):** 🟡 **Engineering complete and tested; live check passed for Perplexity and SerpApi (AI Overviews), still open for DataForSEO (ChatGPT, Gemini)**, which has no account yet. Real responses from both live calls are now test fixtures; the other fixtures are built by hand from the documented response shapes. **Found while checking the providers: Perplexity ended Sonar Chat Completions on 2026-09-27**, the API the spec was written against; the adapter uses its successor, the Agent API, with the `perplexity/sonar` model ([ADR-0006](adr/0006-engine-adapters.md)). Left to do: open the DataForSEO account, run its two live calls with `npm run engines:try`, record them, and fill in the rest of ADR-0006's results table.

**Goal:** prove the `EngineAdapter` contract ([MVP §7.5](MVP.md#75-engine-adapter-contract-design-sketch)) against all four real providers before building the orchestrator around them.

**Work:**
- [x] `src/engines/` adapter per engine/provider pair: DataForSEO (ChatGPT + Gemini UI), Perplexity (Agent API, `perplexity/sonar`; Sonar Chat Completions ended 2026-09-27), SerpApi (AI Overviews). `createAdapters(config.providers)` builds one per provider whose credentials are set; a provider without credentials is unavailable.
- [x] Each adapter implements `submit`/`poll`/`normalize`/`estimateCostUsd` (`src/engines/contract.js`; plus `estimateCostMicros`). Every error is a `ProviderError` that says whether retrying helps and whether it is the provider's fault (so our bad credentials can't trip its breaker). A response we can't read is an error, never "no answer"; Google showing no AI Overview is `no_answer`, a real result.
- [x] Raw payload storage to Spaces + `answer_snapshots` insert + `usage_ledger` insert per answer: the `collect.answer` job (`src/worker/handlers/collect.js`) and `forOrg(orgId).snapshots`. The raw response and our reading of it are stored first as one JSON document (`answers/2026/10/<sha256>.json`), even when unreadable; one ledger row per charge, at the provider's own reported cost where it gives one; DataForSEO's queue is polled by the job deferring itself (no attempt used), and polling is free so it writes no ledger row (`callProvider` now accepts `usage: { free: true }`); the fallback provider is used when the primary's breaker is open, if it has an adapter. Provider rate limits in `src/core/limits.js`.
- [ ] Record real provider responses as fixtures for the contract-test suite (§2). *Perplexity and SerpApi recorded 2026-10-03 (`*-recorded-2026-10-03.json`) and replayed by the tests; DataForSEO still to record. The hand-built files stay for errors and other cases a live call can't produce on demand.*
- [x] *Added in this phase:* `npm run engines:try -- --engine <engine> "<question>"`, a paid live call from the command line (no database), for the spike check and for recording fixtures; provider credentials and `PERPLEXITY_MODEL` / `SERPAPI_COST_PER_SEARCH_USD` in the config.
- [ ] *Carried forward:* adapters for the fallbacks in the `engines` table (OpenAI and Gemini APIs; DataForSEO for Perplexity and AI Overviews). Until then a tripped primary means "couldn't check" for that engine.

**Tests required before moving on:**
- [x] Contract tests per adapter, replayed from recorded fixtures (no live calls in CI): `tests/adapters/engines.test.js`, 17 tests over real HTTP to a server on this machine, checking what we send (endpoint, credentials, fields, locale) as well as what we read, and how every failure is classified (credentials, no credit, rate limit, server error, timeout, an answer cut short, an overview Google can't build right now, a page-token follow-up). *Replayed from the hand-built fixtures until real recordings replace them.*
- [x] Unit: `normalize()` produces the same shape regardless of provider (text, sources[], model_version, locale): `src/engines/engines.test.js`, one zod schema for all four, plus "a changed shape is an error, never `no_answer`".
- [x] Unit: `estimateCostUsd()` matches the provider's published pricing within a documented tolerance: DataForSEO exact, SerpApi exact for the configured plan, Perplexity within ±50% of its reported cost (ADR-0006 Decision 8).
- [ ] Manual/spike check (not CI): one real, live call per provider succeeds and a human confirms the raw payload looks right — record the result in an ADR. *Perplexity ✅ and SerpApi ✅ on 2026-10-03 (ADR-0006 Decision 9: both match the documented shapes; Perplexity charged $0.00441 against a $0.004 estimate); DataForSEO not run, no account.*
- [x] Also: `collect.answer` as a queued job against real Redis and MySQL (`tests/integration/collect-job.test.js`, 12 tests): raw stored and hash-checked, snapshot completed, ledger rows equal provider charges (including a job that fails after paying), free polls, no-answer, non-retryable and retryable failures, an unreadable answer kept in storage, a queued task given up on after its deadline, the fallback route, and a forged payload naming another organization refused; the snapshot repository in the cross-tenant suite (`answer_snapshots` has no foreign keys, so the repository is the only guard), five mutations of its tenant filters all caught.

**Local results (2026-10-03):** lint and Prettier clean; `npm test` 586 passing; `npm run test:routes` 156 (one failure in one full run, in the Clerk webhook retry test, not reproduced in three reruns or alone; that code is untouched by this phase); `npm run test:integration` 167; `npm run test:tenancy` 54; `npm run test:adapters` 55. `test:e2e` not run: no change under `src/web/` or `tailwind/`.

**Exit criteria:** all four adapters pass their contract tests and have at least one verified live call; provider pricing is recorded in the usage ledger correctly — **contract tests and ledger pricing met; live calls verified for Perplexity and SerpApi, not yet for DataForSEO.**

## Phase 6 — Extraction pipeline & golden-set eval

**Status (2026-10-03):** 🟡 **Pipeline built and tested; both models evaluated; D4 provisionally "keep Opus 5.5".** On the draft labels, with prompt `x2`, Opus 5.5 meets every target (mention 100%, stance 91.4%, rank 92.0%) and Haiku 4.5 misses stance (87.8%). Two runs (prompt `x1`, then `x2`, which stopped a brand named only in the question counting as mentioned) cost about $14. D4 becomes final after the founder's review of the labels (`npm run golden:review`; founder decision 2026-10-03: Claude drafts, the founder corrects) and a re-score on them, which is free because replies are cached. **Extraction costs about 60% more than the spec assumed** (Opus ≈ $0.013 an answer batched, not $0.008), which lowers the Starter margin from ≈ 64% to ≈ 52% ([MVP §12.1](MVP.md#121-cost-inputs)). Everything is in [ADR-0007](adr/0007-answer-extraction.md). **The spec's `claude-opus-5` is now `claude-opus-5-5`**, its successor: same features, cheaper.

**Goal:** turn a raw answer into structured mentions/citations/claims, and settle decision D4 (bulk model choice) with real data.

**Work:**
- [x] Deterministic pre-pass (alias matching, domain/citation extraction) before any LLM call: `src/llm/prepass.js`. Whole words, case-insensitive, possessives, a domain written in the text, "That's not us" exclusions, the longest name wins. Names inside links are citations, not mentions. Sources are numbered (the provider's first, then links from the text, with tracking parameters and fragments removed), each with the brand that owns it. Linear-time on hostile text.
- [x] Claude Batch API request builder with prompt caching + structured outputs (`src/llm/`):
  - `extraction.js`: the request, a strict check of the reply, and the merge with the pre-pass.
  - `extraction-prompt.js`: the versioned prompt (`x2`) with four worked examples; the stable prefix comes first with two cache breakpoints, and the answer is fenced as data.
  - `extraction-schema.js`: the JSON schema for structured outputs, plus zod for the limits the schema can't express.
  - `models.js`: Opus 5.5 at low effort and Haiku 4.5, their prices, and cost in micro-dollars.
  - `claude.js`: the SDK wrapper; errors are classified like the engine adapters'.
- [x] 200-answer golden set in `evals/`: **237 real answers** in `evals/extraction/answers.jsonl` (10 projects × 6 questions × 4 engines, collected 2026-10-03 for about $1.63; three AI Overview requests failed twice), and labels for all of them in `labels.jsonl`. *Claude drafted the labels; the founder's review is still to do (`npm run golden:review`).*
- [x] Eval harness comparing `claude-opus-5-5` (low effort; it replaced the spec's `claude-opus-5`) vs `claude-haiku-4-5` against the golden set: `npm run eval:extraction` (`scripts/eval-extraction.js`; scoring and the D4 rule are in `src/llm/eval/score.js`). Replies are cached per model and prompt version; `--batch` runs at half price; `--prepass-only` is free. *First run 2026-10-03, both models, all 237 answers: results in ADR-0007 decision 9.*
- [x] `mentions`, `citations`, `claims` inserts from parsed batch results, keyed by `custom_id` (`s<snapshot>_<run date>`): `forOrg(orgId).extractions` (`src/db/repos/org-extractions.js`) and the `extract.batch`, `extract.poll` and `extract.answer` jobs (`src/worker/handlers/extract.js`). One ledger row per batch. Disagreements between the two readers go to `review_items`; untracked brands become `discovered` entities.
- [ ] Decision D4 recorded (ADR-0007 decision 9 and [MVP §17](MVP.md#17-decisions-needed-from-the-founder)). *Recorded as provisional (keep Opus 5.5) on draft labels; final after the label review and a re-score.*
- [x] *Fixed along the way (a Phase 2 bug):* the Clerk webhook route test failed about one run in three. Every test file's cleanup deleted *all* webhook rows starting `msg_test_`, including rows another file was still using. Each fixtures instance now has its own prefix (`src/db/testing.js`, `webhookId()`).

**Tests required before moving on:**
- [x] Eval run produces the accuracy numbers needed to decide D4, checked against the [MVP §10](MVP.md#10-non-functional-requirements) targets. *2026-10-03, draft labels: pre-pass 100% on mentions; Opus 5.5 meets all three targets; Haiku 4.5 misses stance. To repeat on reviewed labels.*
- [x] Unit: the deterministic pre-pass alone (no LLM) on fixture answers: `src/llm/prepass.test.js` (names, possessives, domains, exclusions, overlaps, links, list items, non-English letters, citations, URL normalisation, and hostile input in linear time).
- [x] Integration: a batch result with a malformed/partial LLM response is handled without corrupting `mentions`/`citations`: `tests/integration/extract-job.test.js`.
  - A reply cut off at `max_tokens`, broken JSON, the wrong shape and a refusal each mark the answer failed and write nothing, and an earlier reading of the same answer survives intact.
  - The same file covers the whole batch path against real Redis and MySQL: one batch per run; one ledger row per batch at batch prices; retried polls not double-counted; items Anthropic failed re-read one by one; everything re-read when the brand list changed; a forged batch ID or another organization's run refused.
- [x] CI: the eval is wired to run automatically whenever `src/llm/**` or the extraction schema changes ([MVP §7.10](MVP.md#710-environments--delivery)): the `extraction-eval` job in `.github/workflows/ci.yml` (also on `evals/extraction/**`). The pre-pass part always runs. *The Claude part needs `ANTHROPIC_API_KEY` as a repository secret and reviewed labels; until then it warns instead of scoring.*
- [x] Also:
  - The extraction repository in the cross-tenant suite (6 tests). Six of its tenant filters were removed one at a time; the five that a test can catch were caught. The sixth, the organization filter on `requeue`'s update, is a second layer behind an organization-scoped lookup.
  - Unit tests for the request, the reply check, the merge, costs and error classification (`src/llm/extraction.test.js`), and for the scorer and the D4 rule (`src/llm/eval/score.test.js`).

**Local results (2026-10-03):** lint and Prettier clean; `npm test` 632 passing; `npm run test:routes` 156 (four clean runs in a row after the webhook fix); `npm run test:integration` 176; `npm run test:tenancy` 60; `npm run test:adapters` 57; `npm audit --omit=dev` 0 vulnerabilities. `test:e2e` not run: no change under `src/web/` or `tailwind/`.

**Exit criteria:** D4 is decided and recorded as an ADR ([MVP §17](MVP.md#17-decisions-needed-from-the-founder)); the eval runs in CI going forward. **Not yet met:** D4 is provisional until the label review. The CI job is in place, but it scores Claude only once `ANTHROPIC_API_KEY` is a repository secret.

## Phase 7 — Free audit (🚩 M1)

**Goal:** the first public-facing, revenue-relevant surface — F1 end to end, target under 10 minutes.

**Work:**
- [ ] Public audit endpoint: Cloudflare Turnstile, OTP email verification, rate limiting.
- [ ] Publish `https://aeocorner.com/bot` before the audit goes public: the address in our crawler's user agent ([MVP §11.2](MVP.md#112-application-security)). It says what `AEOCornerBot` is, what it fetches, how it paces itself, how to block it in `robots.txt`, and who to write to. The audit reads strangers' sites ([ADR-0005](adr/0005-fetching-other-peoples-websites.md)), and site owners will look it up.
- [ ] Persist audit-owned scans (`site_scans` with an `audit_id` and no organization): the Phase 4 pipeline `runSiteScan()` is unchanged; only the owner differs.
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
- [ ] Domain-ownership verification for a project (a DNS TXT record or a file on the site), so that a customer scan can rely on being the owner: a Phase 4 scan of a customer's project does not stop at `robots.txt` ([ADR-0005](adr/0005-fetching-other-peoples-websites.md)), which is only right for a domain the customer really owns.
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
- [ ] Provisioning runbook includes installing Chromium for the worker (`npx playwright install --with-deps chromium`, [ADR-0005](adr/0005-fetching-other-peoples-websites.md)) and the Spaces keys and the 13-month lifecycle rule for `aeo-corner/prod/crawl/` (the bucket is shared with other apps, so the rule must be scoped to that prefix) ([MVP §8.3](MVP.md#83-volume-scaling--retention)).
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
