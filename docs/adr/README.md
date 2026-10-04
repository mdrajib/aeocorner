# Architecture Decision Records

One-way-door technical decisions made while building AEO Corner, and the reasoning behind them — separate from the product/architecture decisions already tracked in [MVP.md §17](../MVP.md#17-decisions-needed-from-the-founder) and [DATABASE_SCHEMA.md §11](../DATABASE_SCHEMA.md#11-open-decisions). An ADR is written when a decision is made, not planned in advance for every phase; [BUILD_PLAN.md](../BUILD_PLAN.md) calls one out explicitly only where a phase's outcome is genuinely uncertain (Phase 5's provider verification, Phase 6's decision D4).

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-prisma-config-split.md) | Prisma 7 connection config lives in `prisma.config.ts`, not `schema.prisma` | Accepted | 2026-09-28 |
| [0002](0002-override-mariadb-driver.md) | Override the `mariadb` npm package to a patched version | Accepted | 2026-09-28 |
| [0003](0003-strict-csp.md) | Strict Content-Security-Policy: no inline scripts, handlers or styles | Accepted | 2026-10-02 |
| [0004](0004-clerk-hosted-sign-in.md) | Sign-in through Clerk's hosted pages; sign-out and CSRF protection are ours | Accepted | 2026-10-02 |
| [0005](0005-fetching-other-peoples-websites.md) | Fetching other people's websites: one safe fetcher, a browser that never touches the network, and robots.txt | Accepted | 2026-10-02 |
| [0006](0006-engine-adapters.md) | Engine adapters: one contract, the raw answer first, and Perplexity through its Agent API | Accepted | 2026-10-03 |
| [0007](0007-answer-extraction.md) | Answer extraction: a free pre-pass, Claude through the Batch API, and a golden set that decides the model (D4) | Accepted (D4 provisional: keep Opus 5.5) | 2026-10-03 |
| [0008](0008-queues-and-the-worker.md) | Queues and the worker: waiting is not failing, every paid call has one door, and every staff change is audited first | Accepted | 2026-10-03 |
| [0009](0009-charts.md) | Charts: Chart.js, self-hosted, with the data table as the chart | Accepted | 2026-10-03 |
| [0010](0010-recommendations-and-proof.md) | Recommendations and proof: stable keys, a lifecycle only the system can finish, and words that cannot claim more than the evidence | Accepted | 2026-10-04 |
| [0011](0011-content-studio-and-wordpress.md) | Content Studio and WordPress: nothing goes live without a person, nothing is trusted from a model, and the connection is signed | Accepted | 2026-10-04 |

**Format:** Status, Context, Decision, Consequences. Numbered sequentially, never renumbered or deleted — a reversed decision gets a new ADR marking the old one `Superseded by ADR-000N`, per [CLAUDE.md](../../CLAUDE.md)'s consistency rule.
