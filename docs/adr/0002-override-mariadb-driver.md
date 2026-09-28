# ADR-0002: Override the `mariadb` npm package to a patched version

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-09-28 |
| **Context of discovery** | [BUILD_PLAN.md Phase 0](../BUILD_PLAN.md#phase-0--prerequisites--project-setup), first `npm install` and `npm audit` |

## Context

`@prisma/adapter-mariadb@7.10.0` — the runtime driver adapter [MVP §7.4](../MVP.md#74-tech-stack) and [DATABASE_SCHEMA §10.2](../DATABASE_SCHEMA.md#102-orm-prisma-7-with-sql-first-migrations) decided on for Prisma's MySQL connection — pins its `mariadb` dependency to the exact version `3.4.5`. `npm audit` flagged it high severity:

- **[GHSA-cqhc-2h57-wpxf](https://github.com/advisories/GHSA-cqhc-2h57-wpxf):** the connector leaks the password in cleartext to a man-in-the-middle *despite* `ssl: true` being set — this directly undermines the TLS requirement in [MVP §7.11](../MVP.md#711-digitalocean-deployment-topology) ("use TLS with DigitalOcean's CA certificate").
- **[GHSA-42r5-vhpq-m858](https://github.com/advisories/GHSA-42r5-vhpq-m858):** cleartext transmission / insufficiently protected credentials.
- **[GHSA-g5xc-5w98-jfvm](https://github.com/advisories/GHSA-g5xc-5w98-jfvm):** possible SQL injection in buffer-parameter escaping under the `big5`/`gbk`/`sjis`/`cp932`/`gb18030` client charsets.

`npm audit` reported "no fix available" only because `@prisma/adapter-mariadb@7.10.0` pins the exact vulnerable version — checking the `mariadb` package directly showed patched releases exist in the same minor line (`3.4.7`, and `3.5.x`).

Two further high-severity advisories surfaced the same way from the `prisma` CLI's own transitive dependencies (dev-only, but still worth pinning correctly):
- `mysql2 <=3.23.0` — [GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr) (auth-plugin downgrade leaking plaintext credentials) and [GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3) (decompression-bomb DoS).
- `deepmerge-ts <8.0.0` — [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) (stack exhaustion on recursive object graphs).

`npm audit fix --force` would resolve all three by downgrading to `prisma@6.19.3` — reopening the Prisma-version decision that [CLAUDE.md](../../CLAUDE.md) explicitly says not to reopen, and undoing schema/migration testing already done against 7.10.0. That path was rejected.

## Decision

Keep `prisma@7.10.0` / `@prisma/client@7.10.0` / `@prisma/adapter-mariadb@7.10.0` exactly as decided, and force the three vulnerable transitive dependencies to patched versions via `package.json`'s `overrides`:

```json
"overrides": {
  "mariadb": "^3.4.7",
  "mysql2": "^3.24.4",
  "deepmerge-ts": "^8.0.2"
}
```

Verified after the override: `npm audit` and `npm audit --omit=dev` both report 0 vulnerabilities, and the full Prisma pipeline (`migrate deploy`, `db pull`, `generate`, `migrate diff`) still runs clean end to end against the local MySQL database — the newer driver versions are compatible in practice, not just on paper.

## Consequences

- This override must be re-checked whenever `@prisma/adapter-mariadb` or `prisma` is upgraded — a new Prisma release may bump these pins itself, at which point the override becomes redundant (harmless to leave, but worth removing for clarity).
- `npm install` will print an `ERESOLVE overriding peer dependency` warning for `mysql2` — expected and safe; it's `prisma`'s own peer range being overridden, not a real conflict.
- Run `npm audit` again after any future `npm install` in this project; if a new "no fix available" high/critical finding appears, check for a patched version the same way before accepting the audit's "no fix" verdict at face value.
