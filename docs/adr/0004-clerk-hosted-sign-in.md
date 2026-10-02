# ADR-0004: Sign-in through Clerk's hosted pages; sign-out and CSRF protection are ours

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Context of discovery** | [BUILD_PLAN.md Phase 2](../BUILD_PLAN.md#phase-2--auth-orgs--tenancy-foundation), first item: "sign-in/sign-up pages (Clerk hosted or embedded components)". [ADR-0003](0003-strict-csp.md) already said to prefer hosted pages |

## Context

[DATABASE_SCHEMA §10.1](../DATABASE_SCHEMA.md#101-auth-clerk-identity-only) left one choice open: show Clerk's sign-in screens as **hosted pages** on Clerk's own domain (the "Account Portal"), or **embed** Clerk's JavaScript components in our pages.

Clerk's CSP guide (read 2026-10-02) says its components need `style-src 'unsafe-inline'` unconditionally, because they style themselves at runtime. They also need script, connect, frame, image and worker sources on Clerk's and Cloudflare's domains. Allowing `unsafe-inline` styles on our pages would undo [ADR-0003](0003-strict-csp.md) for the whole app, to get sign-in screens a few shades closer to our brand.

## Decision

1. **Sign-in and sign-up use Clerk's hosted Account Portal.** `/sign-in` and `/sign-up` redirect there with a `redirect_url` back into the app. The address is derived from the publishable key (`clerk.aeocorner.com` → `accounts.aeocorner.com`), or set explicitly with `CLERK_SIGN_IN_URL` / `CLERK_SIGN_UP_URL`. Our pages never load Clerk's JavaScript, so the CSP needs no Clerk origins.
2. **The server checks the Clerk session with `@clerk/express`'s `clerkMiddleware()`, but only under `/app`, `/invite`, `/sign-out` and on the staff host.** Public pages never run it: no cookies, no redirects, no cost, and no Clerk handshake for a first-time visitor.
3. **Sign-out is ours** (`POST /sign-out`): revoke the session through Clerk's Backend API, then clear Clerk's cookies on our domain. If Clerk can't be reached, the browser is still signed out of this site.
4. **CSRF tokens are derived, not stored.** The token for a form is an HMAC of the Clerk session ID under `APP_SECRET`. There is no server-side session store to run or lose. It sits on top of the `Sec-Fetch-Site`/`Origin` check ([MVP §11.1](../MVP.md#111-identity--tenancy)).
5. **Staff** use a separate Clerk application on their own host behind Cloudflare Access. A request must carry a valid Cloudflare Access token, a staff Clerk session **with a verified second factor**, and an active `staff_users` row. The second factor is read from the `fva` claim in the session token: `[minutes since first factor, minutes since second factor]`, where a second number of `-1` means none registered or never verified (Clerk's session-token docs, read 2026-10-02).

## Consequences

- **Branding of the sign-in screens is limited to what Clerk's dashboard offers** (logo, colours). If it ever matters, the upgrade path is Clerk's *custom flows*: our own forms driving Clerk's headless JavaScript. That needs Clerk's origin in `script-src` and `connect-src` but not `unsafe-inline` styles. It is more work (sign-in, sign-up, password reset and the MFA step all become ours), so it is not done now.
- **Session refresh happens by redirect.** Clerk's session token is short-lived and is normally renewed by Clerk's JavaScript in the browser. Without it, an expired token on a page navigation makes `clerkMiddleware()` answer with a 307 redirect to Clerk and straight back (a "handshake"; see `setResponseForHandshake` in `@clerk/express`). The visible cost is an occasional extra redirect hop; how often depends on Clerk's token lifetime setting, which we have not measured. A background request (htmx, `fetch`) with an expired token gets a plain 401 instead; when htmx starts calling authenticated endpoints (Phase 8 onward), `components.js` must reload the page on a 401. Nothing in Phase 2 does: every signed-in form is a full-page post.
- **The invitation token passes through Clerk.** `/invite/<token>` sent to sign-in becomes `redirect_url=…/invite/<token>` on Clerk's page. Clerk is already a subprocessor, and a token alone is not enough: accepting also needs a Clerk-verified email matching the invitation. Invitation pages send `Referrer-Policy: no-referrer`, and they are excluded from analytics.
- **Clearing Clerk's cookies is best effort.** The session is revoked at Clerk, so a leftover cookie stops working within seconds either way.
- **Not verified against the real service yet.** No Clerk keys existed when this was built. Everything above is built to Clerk's documentation and tested against a fake with the same four methods as the real provider (`src/web/auth/provider.js`), with real Svix signatures for webhooks. The first run on a Clerk development instance must confirm: the handshake works from `localhost`, `redirect_url` is honoured on the Account Portal, the staff session token carries `fva`, and sign-out leaves the browser signed out. Any difference gets recorded here. **Most likely first problem:** a sign-in loop (Clerk says signed in, our app says signed out). The session's `azp` claim is checked against `APP_BASE_URL`, so a mismatch with the address in the browser (`localhost` vs `127.0.0.1`, `www` vs bare domain) rejects every session. Make `APP_BASE_URL` exactly the address you browse to.
- **Cost:** staff multi-factor needs Clerk Pro ($25/month), as already planned ([MVP §12.3](../MVP.md#123-plan-hypothesis--margin-check-weekly-tracking--433-runsmonth)). Development instances include Pro features.
