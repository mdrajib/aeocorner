# ADR-0008: Queues and the worker: waiting is not failing, every paid call has one door, and every staff change is audited first

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 (the design was built 2026-10-02 in [Phase 3](../BUILD_PLAN.md#phase-3--job-infrastructure--usage-ledger); written down as Milestone 0, task 0.03, after the queue page was tested in a browser) |
| **Context of discovery** | [BUILD_PLAN.md Phase 3](../BUILD_PLAN.md#phase-3--job-infrastructure--usage-ledger): "BullMQ is running as a separate worker process with the scheduling, rate-limiting and cost-tracking primitives every later job depends on" |
| **Spec** | [MVP §7.8](../MVP.md#78-scheduling-concurrency--resilience), [ADMIN_OPERATIONS §6](../ADMIN_OPERATIONS.md#6-background-tasks-what-the-system-does-on-its-own) |

## Context

Every later feature runs as a background job: audits, crawls, answer collection, extraction, content, syncs, digests. Those jobs spend real money (a provider charges for each answer, Claude for each reading), call services that throttle us, and run for customers who must not be able to starve each other. A mistake in the plumbing shows up as a bill, an outage for every customer at once, or a customer's data counted twice. So the rules had to be set once, before the first paid job, and every job had to be forced through them.

## Decision

**1. A separate worker process.** `npm run worker` ([`src/worker/`](../../src/worker/)) runs the jobs; the web process only adds jobs ([`src/lib/jobs.js`](../../src/lib/jobs.js)) and shows the queues to staff. A slow crawl or a provider outage can't slow a page load, and the two can be deployed and scaled separately. Redis holds the queues; MySQL stays the record of what happened.

**2. One queue per kind of work, each with its own concurrency** ([`src/lib/queues.js`](../../src/lib/queues.js)): `audit` 4, `crawl` 4, `collect` 20, `extract` 5, `content` 3, `sync` 4, `digest` 2, and `system` 4 (the hourly tick and the guards, which are ours and must not wait behind customer work). Collection waits on providers, so it gets the most; content generation holds big prompts in memory, so the least. A flood of crawls can't use up the slots that answer collection needs.

**3. Job IDs are what the job is, never when it was made** ([`src/lib/job-ids.js`](../../src/lib/job-ids.js)). Adding a job whose ID exists does nothing, so a scheduler that fires twice, a double click or a retried request can't start the same work twice (`run-<project>-<ISO week>`, `scan-<scan id>`, `answer-<snapshot id>`). IDs are joined with `-` (BullMQ forbids `:` and all-digit IDs). Payloads carry IDs as strings and nothing else (no emails, names or secrets), because Bull Board shows them to staff. Finished jobs are kept 7 days, which is also how long a repeated ID is recognised; the database's unique keys (the run slot) are the lasting guard.

**4. Waiting is not failing.** A rate limit, an organization at its concurrency cap, an open circuit breaker or a spend pause throws a `Deferral` ([`src/worker/deferral.js`](../../src/worker/deferral.js)); the worker moves the job to the delayed set and it does **not** use one of its five attempts. Without this, a busy hour would burn jobs' attempts on "not now" and fail work that was never tried. It is also how a queued provider (DataForSEO) is polled ([ADR-0006](0006-engine-adapters.md) decision 4).

**5. Retries: five attempts, exponential backoff with jitter** ([`src/core/backoff.js`](../../src/core/backoff.js)): the ceiling doubles from 5 s up to 10 min, and the real wait is between half the ceiling and the ceiling, so jobs that failed together don't come back together and hit a struggling provider in one wave. A job that fails all five stays in the queue's failed set for 30 days; that set is the dead-letter queue, and staff retry from it. A payload that can't be read, or a job nobody handles, is an `UnrecoverableError`: retrying it five times would only repeat the failure.

**6. Every call to a paid or rate-limited provider goes through one function, `callProvider`** ([`src/worker/provider-call.js`](../../src/worker/provider-call.js)), in a fixed order: spend pause → circuit breaker → the organization's slot → the provider's rate limit → the call (timed, its outcome recorded) → the ledger row → the spend check. The first four defer; the last two are why a call that returns no `usage` is a bug and throws. The one exception is the site crawler, which has no provider to trip ([CLAUDE.md](../../CLAUDE.md), "Crawler").
- **The rate limit** is a token bucket per provider ([`src/core/limits.js`](../../src/core/limits.js)), set well under each provider's stated ceiling because our polling shares the budget and a throttled account stops every customer at once.
- **The organization's slot** caps how many jobs of one kind (`collect` 8, `crawl` 2, `extract` 4, `content` 2, otherwise 4) one organization runs at once across all workers, so a large agency can't take every slot. A slot is released on completion and expires on its own if its worker dies.
- **The circuit breaker** ([`src/core/breaker.js`](../../src/core/breaker.js)) opens when more than 10% of at least 20 requests in 15 minutes failed, stays open 5 minutes, then lets one probe through per 30 seconds and closes after 3 good ones (one bad probe reopens it). The 20-request floor stops "1 failure in 3" looking like an outage. An error that is our own fault (`countsAgainstProvider: false`, such as bad credentials) never counts, so we can't trip a healthy provider's breaker.
- **The ledger row** has an idempotency key per charge, so a retry can't write it twice ([ADR-0006](0006-engine-adapters.md) decision 6).

**7. A daily spend cap per organization, in micro-dollars** ([`src/core/spend.js`](../../src/core/spend.js)). Money is whole numbers of micro-dollars so adding thousands of fractions of a cent can't drift, and the day is the UTC day. The default cap by plan is Starter $15, Growth $45, Agency $150 (about 2.5× the largest normal day, from MVP §12.3), or the organization's own figure. Hitting it pauses collection until the next UTC midnight, and the check also runs right after a ledger write rather than waiting for the 15-minute `guard.spend` job. Raising the cap or the day rolling over resumes it.

**8. The same logic exists twice on purpose.** The token bucket and the concurrency cap are a pure model in [`src/core`](../../src/core/) (unit-tested, easy to reason about) and a Lua script in [`src/lib`](../../src/lib/) (atomic in Redis, so two workers can't both take the last token). A test replays random traffic through both and they must agree. The cost is that the two are changed together; the alternative, Lua alone, would have been untestable without Redis, and the model alone would have raced.

**9. Recurring work is three jobs on the `system` queue** ([`src/worker/runtime.js`](../../src/worker/runtime.js)), created idempotently at worker start: `scheduler.tick` hourly (UTC), `guard.spend` every 15 minutes and `guard.provider_health` every 5. Each project's weekly slot is `hash(public id) mod 168` hours ([`src/core/slots.js`](../../src/core/slots.js); FNV-1a, because `Math.random` and map order differ between processes), so a thousand projects spread over the week instead of arriving on Monday morning. A tick also looks back a few hours, so a missed tick (a deploy, a crash) is caught up by the next one, and the job ID makes the catch-up harmless.

**10. The queue dashboard is Bull Board on the staff host** (`/queues`, [`src/web/staff/queues.js`](../../src/web/staff/queues.js)), behind the same wall as the rest of the console: Cloudflare Access, the staff Clerk session with a second factor, and the `ops` role. **Every request that isn't a plain read is written to `admin_audit_log` first, and if that write fails the action is refused**: there are no unrecorded changes. Cross-site requests are refused by the same-origin guard before anything is audited or changed.

## Checked in a browser, 2026-10-03

The page was run for the first time in a real browser, with the real content security policy ([ADR-0003](0003-strict-csp.md)) and real queues:

- **It works under the strict policy.** The overview, a queue, a job's detail and the pause action with its confirmation all work.
- **The policy blocks two things, each shown as a console error:** Google Fonts' stylesheet (we would rather not send staff addresses to Google anyway, so it falls back to system fonts) and some inline styles, which cost nothing visible. The earlier comment in the code said only the font was blocked; it is corrected.
- **A write from the page is recorded and takes effect:** pausing a queue wrote one audit row (staff, `queue.write`, the queue's name, the method and path, the address and the browser) and the queue was paused afterwards.
- **A found bug, fixed:** pausing or resuming *all* queues is `/api/queues/pause`, and the audit row named a queue called `pause`. It now records no target.
- **The tests** ([`tests/routes/staff-queues.test.js`](../../tests/routes/staff-queues.test.js)) cover who may open the page (ops and super admin yes; support, reviewer and finance no; no session, no Cloudflare token and the customer host no), that reads write no audit row, that a change is audited with who/what/where, that a cross-site change does nothing and records nothing, and that when the audit log is down a change is refused while reading still works. Removing the audit-first rule, or the same-origin guard, makes tests fail.

## Consequences

- **Bull Board is powerful.** Besides retry and discard it can add a job with any payload, change a job's data, set a queue's concurrency and rate limit, empty a queue, and obliterate it. All of that is staff behind a second factor, and now audited, but the audit row records the path, not the payload: it can say that someone added a job to `crawl`, not what it contained. Whether to hide the page's `add`, `obliterate` and `update-data` actions (Bull Board has a read-only mode, but it hides retry too) is left open until a staff member beyond the founder exists.
- **The inline-style errors are a standing risk.** If a Bull Board upgrade starts depending on inline styles for layout, the page breaks quietly. The fix then is a decision, not a quick edit: relax `style-src` for this one page (with an ADR) or replace the page.
- **A provider is only as safe as the door it goes through.** A new provider call that bypasses `callProvider` loses the spend cap, the breaker, the rate limit and the ledger at once. [CLAUDE.md](../../CLAUDE.md) states the rule; nothing but review enforces it yet.
- **The numbers are first guesses.** The provider rate limits (see ADR-0006's note), the organization slot sizes and the plan caps were set from documents, not from load. Milestone 10's load test and cost test are where they get measured, and this ADR should be updated with what they show.
- **Two sources for the rate-limit and concurrency logic** means a change to either is two edits and a test run. That is the price of having both testable and atomic.

## Addendum, 2026-10-03: a free audit has no organization

The free audit (Milestone 1) spends money before any organization exists, so `callProvider` takes **`auditId` instead of `orgId`** (exactly one of the two; passing both or neither throws). Everything else in decision 6 still applies. Two things change, because they belong to an organization:

- **No per-organization spend pause and no spend check after the ledger write.** An audit is held back by **the daily audit budget** instead ([`src/worker/audit-budget.js`](../../src/worker/audit-budget.js), `AUDIT_DAILY_BUDGET_USD`, default $60, about 100 audits). It is checked **once, when `audit.run` first picks an audit up**, not before each call: a visitor's audit is never cut off halfway, so a day can end a little over. When the budget is spent, a new audit is delayed to the next UTC midnight and one alert is raised for the day. An audit served from a recent one costs nothing and is served even then.
- **The ledger row is the audit's own** (`usage_ledger` with `org_id` NULL and `audit_id` set, through `db.audits.ledger`), and concurrency slots are counted **per audit** (scope `audit`, 6 at once), because the organization slot would otherwise be one shared slot for every visitor.

The same two reasons mean the audit's spend is **not** in any organization's spend (a tenancy test checks both directions).
