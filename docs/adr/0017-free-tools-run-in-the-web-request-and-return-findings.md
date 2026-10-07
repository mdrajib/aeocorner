# ADR-0017: Free tools run in the web request and return findings, never the content they fetched

| | |
|---|---|
| **Status** | Accepted (founder decisions G1–G5 taken as the recommended answers on 2026-10-06, provisional until the founder answers) |
| **Date** | 2026-10-06 |
| **Context of discovery** | [MILESTONES_FREE_TOOLS.md](../MILESTONES_FREE_TOOLS.md), Milestone 17, task 17.01. [ADR-0005](0005-fetching-other-peoples-websites.md) (the safe fetcher, robots.txt), [ADR-0003](0003-strict-csp.md) (no inline script), the free audit's abuse guards (Milestone 1, [CLAUDE.md](../../CLAUDE.md) "Free audit") |

## Context

We plan six free tools with no sign-up: a robots.txt checker for AI crawlers, a structured-data validator, a sitemap checker, and robots.txt, schema and llms.txt generators. They exist to win searches such as "robots.txt checker" and lead people to the free audit.

Three of them fetch a site the visitor names. That is the risky part: an open form that makes our servers request any address is a way to scan or flood other people's sites, to reach private addresses, or to carry hostile text to a visitor's browser. The audit already solves most of this, but it asks for an email, runs as a queued job and costs real money, none of which fit a tool that must answer in seconds for nothing.

## Decision

**1. The tools run inside the web request.** No job, no queue, no polling page. A run has a total deadline of 10 seconds (kept by clamping every request's timeout to the time left and refusing any request after it, because the safe fetcher takes no abort signal), at most 5 fetches and 15 connections (a redirect is a connection, so five fetches cannot become thirty), and the process allows at most 4 tools in flight at once; the fifth visitor is told "Busy, try again in a minute". Why: one robots.txt or sitemap is a quick fetch, and a queue would triple the work. The in-flight cap is what keeps a burst of visitors from slowing the site for customers.

**2. A tool returns findings, never what it fetched.** A result is built from the parsed file: states, counts, the bot or rule that decided, and a few lines of the file cut to 300 characters each (at most 20 lines). It never returns a byte range of a response, never a header and never a body, so the tool cannot work as a proxy. Everything from a fetched file is escaped; nothing from it goes into an `html` prop.

**3. "Couldn't check" is its own answer.** A 404 on `/robots.txt` means "no rules, so everything is allowed" (that is what the file means). A timeout, a 5xx, a firewall or sign-in page, a refusal by robots.txt, or an error in our own code is "Couldn't check" with a plain reason. It is never "missing", "blocked" or "none". Any exception a tool throws is turned into that answer by the runner; the error text is never shown.

**4. One safe fetcher, and robots.txt as for the free audit.** Every request goes through `createSafeFetcher`; there is no second HTTP client. The tool fetches `/robots.txt`, `/sitemap.xml` (and the sitemaps robots.txt names) and `/llms.txt` directly, because those files exist for crawlers. A page fetched for the validator's "check a page" mode obeys robots.txt as `AEOCornerBot`. Domain verification belongs to signed-in projects and does not apply. The sitemap checker follows an index one level deep and at most 3 children, inside the 5-request cap.

**5. Who may run a tool.**
- **Turnstile once per run on the three fetching tools** (founder decision G1), verified before the limiter and failing closed. The generators and the paste-in validator need none.
- **Its own limiter**, not the audit's (that one is keyed by email). Fetching tools: 6 runs an IP a minute, 40 an IP a day, and 20 a target domain an hour. Generators and the paste-in validator: 20 an IP a minute only. One Lua script in Redis with the counting rule also in `src/core`, tested against it, as the audit limiter and the provider limits are.
- A refusal never spends another allowance. An IP that is refused 5 times in a day is blocked for a day through the existing `abuse_blocks` (the audit's strike rule), and a blocked IP is refused before anything is counted.
- **Redis down means closed**, never open: the page says the tool is unavailable.
- **A staff flag `free_tools`** (on by default) is checked per request; switching it off in the console's Feature flags closes all six at once, audited like any flag.

**6. Nothing is stored, sent or paid.** No new table, no repository, no email, no provider call and no new vendor. A tool's route may not import `callProvider` or the mailer, and a test fails if it does. Pasted input is validated with zod and cut to 200 KB. The only record of a run is one funnel event (`tool_used`, with the tool's slug and nothing else) counted on the server.

**7. Result pages are quiet and the explainer pages are normal.** A result (the response to `POST /tools/:slug`) sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, noindex, and loads no analytics. The tool's own page (the form and the explainer) is the indexed page, a registry entry like the other marketing pages. Without JavaScript the form posts and the result is a full page; htmx only swaps the result in.

**8. Honest about what it cannot see.** Each page says in a sentence what its tool cannot tell you (founder decision G5). Allowed in robots.txt is not the same as let in by a firewall; a valid schema block is not a promise of any result; the page about llms.txt says plainly that no engine is known to need the file. No tool page claims rankings, citations or traffic, and the marketing-claims test covers the new pages.

## Consequences

- **Cost to run:** zero in provider fees. The cost is web-process time, bounded by the deadline and the in-flight cap.
- **Risk we accept:** a visitor can make us fetch one robots.txt, sitemap or page of any public site a few times a day. The limits, Turnstile, the `AEOCornerBot` user agent and robots.txt keep that below what an ordinary crawler does.
- **Risk we remove:** private addresses, redirects to them, endless bodies and compression bombs are the safe fetcher's job and each tool gets a test that attacks it.
- **What this makes harder:** a tool that needs more than 10 seconds or a model call does not fit this shape. It would need a job and a new ADR.
- **Work this causes:** the robots.txt, sitemap and llms.txt reads inside `runSiteScan` become exported functions that the scan and the tools share (task 17.03). The scan's behaviour and tests do not change.
