# ADR-0003: Strict Content-Security-Policy — no inline scripts, handlers or styles

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-02 |
| **Context of discovery** | [BUILD_PLAN.md Phase 1](../BUILD_PLAN.md#phase-1--design-system--public-site-shell), the Express skeleton item: "evaluate Alpine's CSP-safe build so the CSP doesn't need `unsafe-eval`" |

## Context

The stack ([MVP §7.4](../MVP.md#74-tech-stack)) is server-rendered EJS with htmx and Alpine.js. Out of the box, both lean on things a strict Content-Security-Policy forbids:

- Alpine's standard build evaluates every `x-data`, `x-show` and `@click` attribute with `new Function(...)`. That needs `script-src 'unsafe-eval'`.
- htmx can evaluate `hx-on:*` attributes and inline `<script>` in responses, and it injects an inline `<style>` for its loading indicators. That needs `unsafe-eval` and `style-src 'unsafe-inline'`.
- EJS makes it easy to write `onclick="…"` or `style="…"` inline.

The product's pitch is trust, and the app will hold other companies' brand strategy, WordPress credentials and Google tokens ([CUSTOMER_JOURNEY §3.3](../CUSTOMER_JOURNEY.md#33-data-inventory-what-we-hold-where-and-for-how-long)). A CSP that allows `unsafe-inline` and `unsafe-eval` gives almost no protection if an escaping bug ever lets attacker text into a page. Retrofitting a strict CSP onto a finished app is far more expensive than building to it from the first screen.

## Decision

The web app sends this policy on every response (`src/web/middleware/security.js`):

`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` (plus `upgrade-insecure-requests` in production)

Third-party origins are added **only when the feature that needs them is configured**: Cloudflare Turnstile (`script-src` and `frame-src` `https://challenges.cloudflare.com`) and PostHog (its assets host in `script-src`, its ingestion and assets hosts in `connect-src`). Both sets are verified against the vendors' current documentation (checked 2026-10-02).

To make that policy workable:

1. **Alpine.js runs as its CSP build** (`@alpinejs/csp`). Components are registered in `src/web/public/js/components.js` with `Alpine.data(...)`; attributes may only reference those names, properties and methods, not free-form expressions.
2. **htmx runs with `allowEval: false`, `includeIndicatorStyles: false`, `selfRequestsOnly: true`** (set in a `<meta name="htmx-config">` tag). The few indicator styles we need live in our CSS.
3. **No inline `<script>` blocks, `on*=` handlers or `style=""` attributes in any view.** Behaviour is wired by `components.js` (for example `data-modal-open`, `data-toast-message`). Things that would normally need an inline style use a native element instead (`<progress>` for meters) or a class.
4. **`ui.attrs()` refuses `on*` attribute names**, and tests assert that rendered pages contain no inline script, handler or `style=` attribute. The Playwright styleguide test fails on any console error, which includes CSP violations.
5. **All scripts, fonts and styles are self-hosted** (`src/web/public/vendor`, `/fonts`, `/build`). Nothing loads from a CDN at runtime.
6. **No `unsafe-inline` for styles means no email-style tricks on web pages**: the dev-only email preview route sets its own relaxed CSP for that one response, because email HTML is inline-styled by necessity.

## Consequences

- Every later phase writes views to this rule. A feature that "needs" an inline handler or free-form Alpine expression is a signal to add a small named component to `components.js` instead.
- Alpine's CSP build has a smaller expression language. Complex client-side logic (the Content Studio editor, charts) will live in dedicated modules loaded as files, not in attributes. That is already the plan for TipTap and Chart.js.
- Chart.js and TipTap are both CSP-compatible when self-hosted; check each one's CSP notes when they are added (Phases 10 and 12) and record any exception in a new ADR rather than loosening the policy quietly.
- Turnstile and PostHog are the only external origins, and neither could be exercised end to end in this phase (no keys yet). The policy matches their documented requirements; the first real run against staging with keys is the check. If either needs more, widen the CSP for that origin only.
- Clerk's embedded components (Phase 2) load scripts from Clerk's domains. Prefer Clerk's hosted pages to keep the policy as is; if embedded components are chosen, add Clerk's origins narrowly and note it here.

## Addendum 2026-10-06: `worker-src` for Clerk's token timer

First real use on a Clerk development instance (through a dev tunnel) showed the console full of "Creating a worker from 'blob:…' violates … script-src": Clerk's browser script runs its session-token renewal timer in a worker made from a `blob:` URL, and with no `worker-src` the browser falls back to `script-src`. The renewal never ran, so a form posted after about a minute got `Sign in required.` (see the ADR-0004 addendum).

- **Change:** when sign-in is configured, `worker-src 'self' blob:` is added (`buildCspDirectives`). Nothing is added to `script-src`, so no inline or `blob:` script can run. With sign-in off, there is no `worker-src` and the policy is as before.
- **Why this is safe enough:** a worker can only be started by script that is already allowed; the only `blob:` workers on the signed-in app are Clerk's.
- **Not yet confirmed:** that this alone makes a late form post succeed. Check on the dev instance after the change.

## Addendum 2026-10-06 (second): `form-action` for the Google consent redirect

"Connect Google" is a form post to our own address that is answered with a redirect to `accounts.google.com`. Chrome applies `form-action` to the redirect as well, so with `form-action 'self'` the browser refused to follow it and the page appeared to do nothing (console: "Sending form data to … violates … form-action 'self'").

- **Change:** when Google OAuth is configured (`config.google`), `form-action` is `'self' https://accounts.google.com`. Nothing else is added; with Google off it is `'self'` as before.
- **Cost:** a form on one of our pages could now also submit to Google's sign-in host. That is a Google page that cannot receive our form fields in any useful way and cannot be steered by the attacker, so the exposure is small.
