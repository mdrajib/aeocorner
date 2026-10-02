# ADR-0005: Fetching other people's websites: one safe fetcher, a browser that never touches the network, and robots.txt

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Context of discovery** | [BUILD_PLAN.md Phase 4](../BUILD_PLAN.md#phase-4--site-crawler--readiness-checks): "SSRF-safe HTTP fetcher", "Raw-HTML fetch + Playwright headless render, stored to Spaces" |

## Context

The free audit ([MVP F1](../MVP.md#f1--free-aeo-audit-lead-magnet)) reads whatever address a stranger types in, and then runs a headless browser on what it finds. That is the classic setup for **server-side request forgery**: a hostile address, redirect, page script or sitemap points our server at somewhere only our server can reach (the cloud metadata address that hands out credentials, the database, Redis, an admin port), and the response comes back to the attacker. It is also the first place the product runs code written by someone else (the page's JavaScript). The rules below are one-way doors: every later phase that fetches a URL builds on them.

## Decision

**1. Every fetch of a URL we did not choose goes through `createSafeFetcher` (`src/crawler/safe-fetch.js`).** Per request: only `http`/`https`, no `user:password@`, only ports 80 and 443; the name is resolved **once**, every answer is checked against the refused ranges ([`ip-guard.js`](../../src/crawler/ip-guard.js): loopback, private, link-local including the metadata address, CGNAT, multicast, reserved, documentation, 6to4/NAT64/Teredo, IPv4 hidden in IPv6, IPv6 unique-local), and the connection is made **to the address that was checked**, never to the name again. A name with any refused address is refused as a whole. Redirects are followed by hand (maximum 5) and every hop runs all of the above. The body is capped at 5 MB **after decompression**, the whole fetch at 15 s, and the TLS certificate is checked against the name in the URL. Requests are paced per host (at most 2 at once, 500 ms apart).

**2. The headless browser never opens a connection of its own** ([`render.js`](../../src/crawler/render.js)). Every request the page makes is intercepted and answered by the same safe fetcher, so a script, image, frame, redirect or form is held to the same rules. Only documents, scripts and data requests are allowed, only `GET`; WebSockets, service workers and downloads are refused; a page is cut off at 120 requests and 20 MB. As a second wall, Chromium starts with name resolution switched off (`--host-resolver-rules=MAP * ~NOTFOUND`), so a request that somehow escaped interception has nowhere to go. A redirect of the page itself ends that render and the renderer starts again at the new address, because Chromium follows a redirect it was handed without asking again and so would skip our check of the next hop.

**3. The guard has one test-only opening.** `createSafeFetcher({ exceptions })` lets tests reach a fixture server on this machine, on named ports of named addresses only. Production code never passes it; a test proves a fetcher without it refuses the same fixture.

**4. We obey `robots.txt` as `AEOCornerBot`** (except for a customer's own project, see the end), as RFC 9309 says: a missing file or a 4xx means nothing is off limits; a server error means stay away; `Disallow` for our user agent means the pages are not read (the scan reports "couldn't check", not a low score). Two deliberate exceptions: the handful of look-alike AI-crawler requests to the home page (check A3) are diagnostic, not crawling, and ignore it; and a robots.txt that a **firewall** answers (403 or a challenge page) does not stop the scan, because the pages will be turned away too and each records the block.

**5. Failing to look is never failing the check.** A page that could not be read, a firewall in the way, a browser that is missing: each check says `error` ("couldn't check") and is left out of the score. If less than half of the rubric could be evaluated the score is `null`. A site that blocks every bot gets "couldn't check", not 0 ([CLAUDE.md](../../CLAUDE.md): a failed collection is never counted as "not there").

**6. Everything read from a stranger's site is treated as hostile input.** Sitemaps are read with a one-pass scanner, not an XML parser (no entity expansion, no file reads) and not a regular expression with lazy matches (which went quadratic on a file of unclosed tags). HTML nesting deeper than 512 levels (the browsers' own cap) is refused before the parser sees it, because the parser's time grows with the square of the depth (50,000 nested elements took 30 s). Page text is walked without recursion; lists are capped; compressed bodies are inflated under a limit. Tests throw each of these at the code.

**7. Raw payloads are stored first and never changed** ([`spaces.js`](../../src/integrations/spaces.js)): exact bytes, under a key made of the date and a hash of the bytes (`crawl/2026/10/<sha256>.html`). Writing the same bytes again is the same key (a retried job is harmless) and different bytes can never overwrite each other. DigitalOcean Spaces in staging and production; a folder on disk for a laptop; production refuses to start without Spaces.

**8. A scan is not routed through `callProvider`.** That path rate-limits and circuit-breaks **per provider**, and a breaker on "the crawler" would stop every customer's scans because one customer's site was down. The crawler protects the sites it visits itself, and each scan writes one `usage_ledger` row (meter `crawl`, requests made, cost 0) so volume is on the record.

## Consequences

- **Chromium must be installed where the worker runs** (`npx playwright install --with-deps chromium`): CI does it for the tests, and the deployment runbook ([Phase 15](../BUILD_PLAN.md)) must do it for the Droplet. If it is missing, scans still finish; the render checks say "couldn't check".
- **`https://aeocorner.com/bot` must exist** before the crawler runs against sites we do not own: it is the address in our user agent, and site owners will look there. It is added to the public-site phase.
- **The AI-crawler look-alike check (A3) can be wrong** in one direction: firewalls that admit a crawler by its network address will still turn away our look-alike, so A3 words its result as a strong hint, not proof.
- **New code that fetches a URL must use the safe fetcher**; there is no second HTTP client in the app. Code that parses page text must be linear in its input (no lazy `[^>]*`, no `.find()` over a huge page, no recursion over the DOM).
- **Verified against the real service on 2026-10-02:** with the founder's bucket (`sgp1`, shared with other apps), the store wrote, read back (byte-identical, binary data and an accented URL in the metadata), listed and deleted objects, and a wrong bucket name is an error, not an empty store. The AWS client's newer checksum framing (which some S3-compatible services reject) is switched off (`WHEN_REQUIRED`) and works against Spaces. The settings are `DO_SPACES_*` in [`.env.example`](../../.env.example).
- **The bucket is shared, so this app lives in its own directory:** everything it stores goes under `aeo-corner/<dev|staging|prod>/` (`DO_SPACES_PREFIX` changes it). Nothing outside that directory is read or written. The 13-month retention rule is applied to `aeo-corner/prod/crawl/`.
- **Added dependencies** (versions checked 2026-10-02): `cheerio` 1.2.0 (HTML parsing), `@aws-sdk/client-s3` 3.1145.0 (Spaces), `playwright` 1.63.0 (already used for tests; now also a runtime dependency).

## Decided by the founder (2026-10-02): the project owner can override `robots.txt`

A signed-in customer scanning **their own project** is not stopped by a `robots.txt` that disallows our crawler (`runSiteScan(…, { respectRobots: false })`, which the `crawl.readiness` job always sets). Without this, a customer who shuts out all bots by mistake would see "couldn't check" and never learn why. The free audit, which reads domains that belong to strangers, keeps the default and obeys `robots.txt`.

What stays the same when the override is used: the SSRF guard, the pacing, the size and time limits. The result records that it happened (`robotsOverridden`, and a note on the scan), and check A1 still reports exactly what `robots.txt` says, so the customer is told which AI crawlers their file blocks.

**A limit to know about:** the app does not yet verify that a customer owns the domain they add as a project, so today anyone with an account could use the override on a domain that is not theirs. The exposure is small (at most 20 public pages, read politely, a handful of times) but it is real. Domain-ownership verification (a DNS record or a file on the site) should come before the override is relied on; it is noted in the Phase 8 project setup.
