# Architecture Decision Records

One-way-door technical decisions made while building AEO Corner, and the reasoning behind them — separate from the product/architecture decisions already tracked in [MVP.md §17](../MVP.md#17-decisions-needed-from-the-founder) and [DATABASE_SCHEMA.md §11](../DATABASE_SCHEMA.md#11-open-decisions). An ADR is written when a decision is made, not planned in advance for every phase; [BUILD_PLAN.md](../BUILD_PLAN.md) calls one out explicitly only where a phase's outcome is genuinely uncertain (Phase 5's provider verification, Phase 6's decision D4).

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-prisma-config-split.md) | Prisma 7 connection config lives in `prisma.config.ts`, not `schema.prisma` | Accepted | 2026-09-28 |
| [0002](0002-override-mariadb-driver.md) | Override the `mariadb` npm package to a patched version | Accepted | 2026-09-28 |
| [0003](0003-strict-csp.md) | Strict Content-Security-Policy: no inline scripts, handlers or styles | Accepted | 2026-10-02 |
| [0004](0004-clerk-hosted-sign-in.md) | Sign-in through Clerk's hosted pages; sign-out and CSRF protection are ours | Accepted | 2026-10-02 |
| [0005](0005-fetching-other-peoples-websites.md) | Fetching other people's websites: one safe fetcher, a browser that never touches the network, and robots.txt | Accepted | 2026-10-02 |
| [0006](0006-engine-adapters.md) | Engine adapters: one contract, the raw answer first, and Perplexity through its Agent API | Accepted (live check open) | 2026-10-03 |

**Format:** Status, Context, Decision, Consequences. Numbered sequentially, never renumbered or deleted — a reversed decision gets a new ADR marking the old one `Superseded by ADR-000N`, per [CLAUDE.md](../../CLAUDE.md)'s consistency rule.
