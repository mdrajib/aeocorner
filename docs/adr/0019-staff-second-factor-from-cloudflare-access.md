# ADR-0019: The staff second factor can come from Cloudflare Access instead of Clerk

| | |
|---|---|
| **Status** | Accepted (the founder asked for it on 2026-10-09); off by default |
| **Date** | 2026-10-09 |
| **Context of discovery** | Clerk's second factor (authenticator app, passkey) is a Pro feature, about $20–25 a month. The founder wants to launch the staff console without that subscription. [ADR-0004](0004-clerk-hosted-sign-in.md), [RUNBOOK_CLERK.md](../RUNBOOK_CLERK.md) |

## Context

A staff request today needs three things: a valid Cloudflare Access token, a staff Clerk session **with a verified second factor** (`fva` claim), and an active `staff_users` row. The second item needs Clerk Pro.

## Decision

A new setting, `STAFF_SECOND_FACTOR`, chooses where the second factor comes from:

| Value | The second factor is | Needs |
|---|---|---|
| `clerk` (default) | Clerk's own, read from the `fva` claim, exactly as before | Clerk Pro |
| `cloudflare` | Cloudflare Access, which already stands in front of the staff host | Nothing extra |

With `cloudflare`:

1. The `fva` check is skipped.
2. **The person Cloudflare Access let in must be this staff member.** The email in the Access token (checked by Access with a one-time code or the identity provider, and verified by us against Cloudflare's keys) must equal the email on the `staff_users` row, ignoring case. If not, the page says "The two sign-ins don't match" and nothing is bound.
3. Cloudflare Access (team domain and AUD) is required in **every** environment, including a laptop. The server refuses to start without it.

Everything else is unchanged: invite-only, the staff Clerk app with its own user pool, roles, the 30-minute session, audit log.

## Consequences

- **This is a weaker guarantee than a Clerk authenticator app, unless Access itself is strong.** Access's default "one-time PIN" proves the person controls an email inbox. If the staff Clerk sign-in is also an email code, both steps are the same factor (the inbox). To make this really two factors, do one of:
  - set Access to log in through an **identity provider that enforces 2-step verification** (for example Google with 2-Step Verification required), and give staff Clerk accounts a **password**; or
  - turn on Clerk Pro and use `STAFF_SECOND_FACTOR=clerk`.
- Staff accounts should be few and known (the Access policy lists their emails), which limits the risk.
- Switching back is one setting. Nothing is stored differently.
- Tests: `tests/routes/staff-cloudflare-factor.test.js`; the existing `tests/routes/staff.test.js` still proves the default.
