# AEO Corner — Incident response and provider-outage runbook

| | |
|---|---|
| **Document** | What to do when something breaks: the first ten minutes, who tells customers what, one section per outside provider, and the handful of scenarios that are not a provider (a runaway bill, a leaked key, a bad deploy, a suspected cross-organization leak) |
| **Date** | 2026-10-04 |
| **Status** | Written for launch (Milestone 10, task 10.09). **Not yet drilled on a real server**: the first real incident, or a staging game day, is the test of this document. Fix any step that turns out wrong, here, in the same pass |
| **Companion docs** | [ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) §4 (flows A1–A12) and §7 (alerts) · [RUNBOOK_PROVISIONING.md](RUNBOOK_PROVISIONING.md) (the server, deploying, rolling back) · [adr/0006-engine-adapters.md](adr/0006-engine-adapters.md) decision 11 (degraded modes) · [adr/0008-queues-and-the-worker.md](adr/0008-queues-and-the-worker.md) · [adr/0012-billing-traffic-notifications-and-the-console.md](adr/0012-billing-traffic-notifications-and-the-console.md) · [MVP.md](MVP.md) §11 |

## 1. The principle behind every section

**An outage on our side or a provider's side must never look like a result.** The system is built so that waiting is not failing and "we couldn't check" is never "not mentioned" and never 0. So in almost every incident the customer's *numbers stay true*; what suffers is how fresh they are. That tells you what to do first: **protect the data, then restore the flow, then say what happened.** Do not "fix" a gap by re-running a check as a guess, and never edit a stored answer by hand.

## 2. Who, and how bad

For launch the on-call person is the founder. Write down who is on call in the team chat when that changes.

| Level | Meaning | Examples | Respond within | Customers told? |
|---|---|---|---|---|
| **S1** | Customers can't use the product, or their data is exposed | The site is down; sign-in fails for everyone; a suspected cross-organization leak; a leaked secret | At once, any hour | Yes: status note within 1 hour, email if over 2 hours |
| **S2** | Part of the product is degraded, or money is at risk | One engine is down; the worker is stopped; billing webhooks failing; a spend cap reached; email not sending | Within 1 hour in waking hours | Only if their numbers will be late by more than a day (flow A11) |
| **S3** | A nuisance with no customer effect | One failed job; a slow page; a single provider timeout | Next working day | No |

The alerts that wake someone are in [ADMIN_OPERATIONS §7](ADMIN_OPERATIONS.md). They go to the Slack channel set in `ALERT_WEBHOOK_URL` and are also in the application log.

## 3. The first ten minutes

Do these in order. Stop at the first step that finds the cause.

| # | Check | How | What it tells you |
|---|---|---|---|
| 1 | Is the web process up? | `curl -I https://aeocorner.com/healthz` (200 means yes) · `pm2 status` on the Droplet | Down: go to §5.1 |
| 2 | Is the worker up and moving? | `pm2 logs aeo-worker --lines 50` · the queues page on the staff host (`/queues`) | Stopped: §5.2. Waiting counts climbing: a provider or Redis problem |
| 3 | Is one provider unhealthy? | Staff console → **Provider health** (`/providers`): error rate, p95, open breaker | A breaker open: §4 for that provider |
| 4 | Is anything failing in a pattern? | Staff console → **Failed jobs** (`/jobs`): read the error, not the count | One error repeated: that is the cause. Many different errors: the database or Redis |
| 5 | Did we just deploy? | `git log -3` on the Droplet and the time of the last `pm2 reload` | If yes and the timing fits: roll back first (§5.5), investigate after |
| 6 | Is money moving unexpectedly? | Staff console → **Costs** | A runaway: §5.3 |

Write down what you saw and when, as you go, in the incident note (§7). Memory after the fact is unreliable.

## 4. A provider is down

What the system does by itself, for every provider that collects answers (ChatGPT and Gemini through DataForSEO, Perplexity, Google AI Overviews through SerpApi) and for Claude:

1. Each call goes through `callProvider`. When more than 10% of the last 15 minutes' calls fail (at least 20 calls), the provider's **circuit breaker opens**, and the team is alerted.
2. While it is open, jobs for that provider are **put back a minute at a time without using up an attempt**. Nothing fails and nothing is charged.
3. After five minutes the breaker lets one probe through at a time; three good probes close it again.
4. A weekly run waits for its answers for up to **4 hours**. An outage shorter than that is ridden out and the run completes with nothing missing.
5. After four hours the answers still missing become "couldn't check", the run ends `partial` (some engines answered) or `failed` (none did), and **the customer's numbers leave those answers out**. A day on which an engine did not finish cleanly is also left out of that engine's trend tests, so our outage is never reported as the customer's decline.
6. **There are no fallback adapters for the MVP** (a decision, not an omission: ADR-0006 decision 11). The next weekly run starts clean and asks again.

So for a collection provider the human's job is: confirm, tell the right people, and decide whether to re-run.

| Provider | Which engines | Look for | What you do | What customers see |
|---|---|---|---|---|
| **DataForSEO** | ChatGPT, Gemini (and the audit's answers for both) | `/providers` shows `dataforseo` degraded; failed `collect.answer` jobs mention task errors or 40xxx codes | Check DataForSEO's status page and your balance (a drained balance looks like an outage: top up). Do nothing else: the breaker is already waiting. If it lasts past the 4-hour deadline, see "Re-running" below | "Couldn't check" cells for those engines; "The last check is incomplete: N of M answers couldn't be checked" |
| **Perplexity** | Perplexity | `perplexity_api` degraded; HTTP 429 or 5xx in failed jobs | A 429 means we are calling faster than the provider allows: the worker spaces calls by a per-provider rate limit and puts back what it can't send, so a lasting 429 is a bug or a changed limit: read the failed job before changing anything. A 401 means the key was revoked or expired: rotate `PERPLEXITY_API_KEY` and `pm2 reload aeo-worker` | Same |
| **SerpApi** | Google AI Overviews | `serpapi` degraded; "no AI Overview shown" is **normal** and is not an outage | Check the plan's search quota in SerpApi's dashboard (running out looks like an outage). Remember a response we can't read is an error, never "no answer" | Same; "No AI Overview" stays correct for questions Google didn't answer |
| **Anthropic** (Claude) | Reading every answer; Brand Kit, questions and content drafts | `anthropic` degraded; batches stuck `in_progress`; extraction errors | Answers are **stored first** and read later: nothing is lost and no engine is asked or paid twice. Extraction retries from the stored answer. A refusal or a reply that doesn't fit the schema marks that answer's extraction `failed` and keeps its earlier rows | Numbers appear later than usual; drafts show "failed" with a plain reason and give the monthly allowance back |
| **Resend** (email) | Audit codes and reports, invites, the digest, alerts | Mail jobs failing; people say "no email" | Audit codes are the visible symptom: the verify step lets a person ask for a new code once a minute. Check Resend's status and the domain's DNS records (SPF, DKIM). Digest and alerts are at most one proactive email per person per day, so a missed day is not repeated twice | Audit "report ready" email late; the report is still in the browser at its address |
| **Stripe** | Checkout, plan changes, the portal, usage reporting | Webhook failures in Stripe's dashboard; `billing.reconcile` reporting differences | Stripe retries a failed delivery for days. **We re-ask Stripe for the truth on every event**, and `billing.reconcile` (05:15 UTC daily) repairs anything missed, so the fix is usually "wait, then run `billing.reconcile`". Do not edit an organization's plan by hand unless Stripe is the one that is wrong | A plan change may take until the next reconcile to show |
| **Clerk** | Sign-in | Sign-in page errors; `provider.js` errors in the log | Nothing in our code can fix Clerk. Customers already signed in keep their session until it expires. Check Clerk's status; put the maintenance page up (§5.1) only if it lasts and people are stuck on a broken page | People can't sign in; public pages and the free audit are unaffected |
| **Google** (GA4, Search Console) | AI traffic | `sync.google` failing; "needs reconnecting" on the traffic screen | A failed read marks the connection `broken` with a plain reason; weeks not yet read stay "not read yet", never 0. A revoked grant needs the customer to reconnect. A Google-side outage resolves itself at the next daily sweep (03:40 UTC) | Traffic cards say "Couldn't check" |
| **DigitalOcean Spaces** | Raw pages and answers | Stores failing in the log (`storeRaw`) | Raw data is written **first**, so a failing bucket stops collection safely: the job retries and writes the same content-addressed key. Check DigitalOcean's status and the Spaces keys | Runs wait, then become `partial` as above |
| **Cloudflare** | DNS, protection, Turnstile, staff sign-in | Site unreachable though `pm2 status` is fine; the audit form can't pass the bot check | If Turnstile is down the audit **fails closed** (no audits start): that is intended, say so rather than switching the check off. Staff sign-in sits behind Cloudflare Access, so a Cloudflare outage also locks staff out of the console: the Droplet's shell and the database are the fallback | The audit form shows an error; app and public pages may be slow |
| **WordPress sites** (the customer's) | Publishing | `content.publish` failing for one project | This is the customer's site, not ours. The item stays `approved` and says why ("couldn't reach your site", "the plugin is not installed"). Never retry in a loop: the connection is marked broken and the screen tells the owner | A message on the content item and the WordPress screen |

**Re-running after an outage.** A "check now" costs the customer one of their monthly runs, so staff do not use it on their behalf. For a missed weekly run, either let the next week run, or retry the run's failed `tracking.*` job from the staff console's **Failed jobs** page: a run is keyed by project and slot, so asking twice is the same run and nothing is counted twice. Only do this once the provider is healthy again, or the same answers will fail again. A run that already ended `partial` stays as it is: its missing answers are "couldn't check" for that week.

**Switching a provider off on purpose.** If a provider is misbehaving but not failing (wrong answers, a price change), stop spending on it by stopping the worker (`pm2 stop aeo-worker`, §5.2): jobs wait in Redis. There is no per-provider kill switch in the console yet (see §8).

## 5. Incidents that are not a provider

### 5.1 The site is down, or shows an error page

1. `pm2 status`. If `aeo-web` is `errored` or restarting, `pm2 logs aeo-web --lines 100` and read the first error after the last "started" line.
2. Common causes, in order of likelihood: a bad deploy (§5.5); the database refusing connections (check DigitalOcean's managed database page: connection limit, maintenance window, a failed failover); Redis unreachable; a changed or missing environment value (the app refuses to start rather than run misconfigured, and the log says which).
3. If it will take more than a few minutes, set `MAINTENANCE_MODE=true` in `.env` and `pm2 reload aeo-web`: every page answers 503 with a "back soon" page while `/healthz` and static files stay up. Remove it and reload when fixed.
4. Tell customers (§6) if it lasted more than an hour.

### 5.2 The worker is stopped, stuck or crashing

1. `pm2 status`, then `pm2 logs aeo-worker --lines 100`.
2. A stop is safe: **jobs wait in Redis and every step is repeatable**. The worker takes up to two minutes to stop cleanly, because it finishes the job it is on (`kill_timeout` 120 s in `deploy/ecosystem.config.cjs`).
3. A crash loop with "eviction policy" means Redis is set to evict keys: it must be `noeviction` (BullMQ requires it).
4. Restart with `pm2 restart aeo-worker`. The hourly scheduler plans any due run again; a run is keyed by project and week, so planning twice is harmless.
5. If Chromium has gone missing the crawl checks that need a browser say "couldn't check" and scans still finish ([RUNBOOK_PROVISIONING §5](RUNBOOK_PROVISIONING.md)).
6. After Redis was lost or flushed (it holds the queues only, never the customer's data): the database is the truth. Queued jobs are gone; weekly runs are re-planned by the next hourly tick, and the daily sweeps (`outcomes.sweep`, `billing.reconcile`, `sync.google.sweep`) re-find overdue work. Free audits that were waiting stay `queued`: list them in the console and re-queue or fail them; do not start a second audit for the same address.

### 5.3 The bill is climbing: a spend cap, a retry loop or abuse

1. **Costs** page: which organization, which provider, which step? The ledger has one row per charge, so "what was bought" is always answerable.
2. Each organization has a **daily cap** (its own, or its plan's default). Reaching it **pauses that organization's collection** until the next UTC midnight, tells its owners and the team, and holds jobs without failing them. Raising the cap (`organizations.spend_cap_usd_daily`, until the console gets an edit form) and the 15-minute guard resume it.
3. Free audits have their own **daily budget** (`AUDIT_DAILY_BUDGET_USD`) across all visitors: when it is spent, new audits are delayed to the next day and one alert goes out. A burst of audits from one address, IP or domain is the abuse flow (A7): block in the console's audits and abuse page; five refusals block an IP for a day by themselves.
4. A **retry loop** shows as many ledger rows for one answer. Every charge is keyed by attempt, so a loop would be visible, and the circuit breaker should stop it; if it didn't, stop the worker (§5.2) first and read the code second.
5. Never "refund" the ledger by deleting rows; add a note and fix the cause.

### 5.4 A secret may have leaked

Treat any of these as S1 until proven otherwise: a key in a screenshot, a log, a commit, a former helper's laptop.

| Secret | Rotate by | Notes |
|---|---|---|
| A provider key (`ANTHROPIC_API_KEY`, `DATAFORSEO_*`, `PERPLEXITY_API_KEY`, `SERPAPI_API_KEY`) | Create a new key at the provider, change `.env`, `pm2 reload aeo-worker`, revoke the old key | Check the provider's usage page for spend you didn't make |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Roll the key and the endpoint secret in Stripe (Stripe allows both secrets to work together while you switch), change `.env`, reload `aeo-web` and `aeo-worker` | A webhook secret that leaked means someone could forge billing events; we re-ask Stripe for the truth on every event, so a forged event changes nothing, but rotate anyway |
| `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET`, `CLERK_*` | Roll at the provider, change `.env`, reload | Clerk's webhook secret is checked by Clerk's library; a wrong one answers 400 and is never recorded |
| `APP_SECRET` | Change it and reload: every session and signed link (unsubscribe, OTP, `/app/google/callback` state) stops working at once | Warn customers; everyone signs in again |
| `SECRETS_MASTER_KEY` (opens customers' WordPress and Google credentials) | Set `SECRETS_MASTER_KEY_VERSION` to the next number, put the new key in `SECRETS_MASTER_KEY` and the old in `SECRETS_MASTER_KEY_PREVIOUS`, reload both processes. The old key still **opens** secrets while the new one wraps new ones | **There is no script yet to re-wrap every stored secret** (`secrets.rewrap` exists and is tested; the loop that calls it does not): until it is written, the old key must stay available. If the master key itself leaked, assume every connection secret is exposed: tell the affected customers to change their WordPress application passwords and reconnect Google |
| A customer's WordPress application password or Google token | The customer disconnects (the secret is cleared) and reconnects | We can disconnect for them from the staff console on request |
| The database or Redis password | Rotate in DigitalOcean, change `.env`, reload both | Rotate the bucket keys the same way |

If personal data may have been exposed, the DPA promises notice within [72] hours of becoming aware: write down the time you became aware, who and what was exposed, and ask counsel about the regulator before the deadline, not at it.

### 5.5 A bad deploy

1. Roll back first: on the Droplet check out the previous tag, `npm ci --omit=dev`, `npm run build:css`, `pm2 reload aeo-web` and `pm2 reload aeo-worker` ([RUNBOOK_PROVISIONING §10](RUNBOOK_PROVISIONING.md)).
2. **Never roll a migration back.** Migrations run before the reload and are written to work with the old code and the new for a few seconds; if the new migration is the problem, write a new forward migration.
3. Investigate on staging, with the same data shape, after the site is healthy.

### 5.6 Someone sees another organization's data

S1, always, even if it looks like a mistake.

1. **Stop the exposure**: if you can name the screen, set `MAINTENANCE_MODE=true` and reload `aeo-web`; if you can't, do it anyway.
2. Write down exactly what was seen, by whom, when, and the URL.
3. Run the leak suites against the code that is live: `npm run test:security` (the cross-tenant repository and route suites, the automated sweep over every table with an `org_id`, the SSRF, auth and webhook suites). A failing test names the table or route.
4. The route layer answers a plain 404 for a stranger's organization and project, so a leak is most likely a **repository function that skipped `org_id`**: the sweep (`tests/tenancy/leak-sweep.test.js`) reads every query for exactly that. Fix, add the test that would have caught it, deploy, lift maintenance.
5. Tell the affected organizations and counsel; treat it as a breach under §5.4's last paragraph.

### 5.7 Data lost or damaged: the database

The managed database backs up daily and can restore to a point in time. **A restore has not been drilled** ([RUNBOOK_PROVISIONING §12](RUNBOOK_PROVISIONING.md)): do the first one on a throwaway cluster before you need it. In a real loss: restore to a *new* database, check it with `docs/db/checks.sql` (every query must return zero rows), then point `DATABASE_URL` at it and reload. Raw pages and answers are in Spaces under content-addressed keys, so extraction can be re-run from them for any gap.

## 6. Telling customers

| When | Say | Where |
|---|---|---|
| Customer-visible and over 1 hour | What is affected, what is not, when you'll next update | The maintenance page (S1), and a short note to anyone who writes in |
| Over 2 hours, or numbers will be a day late | The same, by email to the owners of affected organizations | From the team's own address (the console has no customer-detail or broadcast screen yet; see §8) |
| Resolved | What broke, what it meant for their numbers ("N answers couldn't be checked and are left out; nothing was counted as not mentioned"), what changed | Same channels, and the incident note |

Rules: say what is **known**, not what is hoped; never blame a named provider before they have confirmed it; never promise a time you can't keep; never tell a customer their data is safe until you have checked it.

## 7. After the incident

Within two working days write a short note in `docs/incidents/YYYY-MM-DD-title.md` (create the folder at the first one). Keep it blameless and short:

```
# <date> — <what happened in six words>
Severity / duration / who was affected (organizations, not names)
Timeline (UTC): first sign, detected, cause found, fixed, customers told
What the system did on its own, and what a person had to do
Why it happened (the cause, not the trigger)
What we are changing: each item is a task in MILESTONES.md or an issue
```

A follow-up that changes a rule updates the affected doc in the same pass (the CLAUDE.md "Writing the docs" rule). A provider outage that happens twice for paying customers is the signal in ADR-0006 decision 11 to build that engine's fallback.

## 8. Known gaps

| Gap | Effect | When |
|---|---|---|
| No console form to change an organization's spend cap | Edit `organizations.spend_cap_usd_daily` in MySQL | Before the first customer asks |
| No per-provider kill switch | Stop the worker to stop spending | Before launch if a provider shows price drift |
| No status page, announcement banner UI or customer-detail screen (the `announcements` table exists) | Use the maintenance page and email the owners from the team's address | When the first S2 reaches customers |
| No loop that re-wraps stored secrets after a master-key change | The old master key must be kept | Before the first rotation |
| The purge deletes a closed account's rows, but not the raw files in Spaces, the users' Clerk accounts or old `webhook_events` payloads | Raw answer and page files are content-addressed and shared between organizations, so they expire by the 13-month Spaces lifecycle rule instead; Clerk accounts stay until deleted in Clerk | The DPA wording must say so, or the three leftovers must be built; counsel to decide before launch |
| A database restore has not been drilled | Unknown restore time | Before launch, on a throwaway cluster |
| Redis loss leaves free audits `queued` | A person re-queues them | If it ever happens |
