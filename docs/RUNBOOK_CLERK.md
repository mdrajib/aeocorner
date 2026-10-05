# AEO Corner — Clerk setup runbook (customer app and staff app, production Droplet)

| | |
|---|---|
| **Document** | How to set up the two Clerk applications for the live site: the customer app (identity for signed-in customers) and the staff app (the admin console, behind Cloudflare Access), and how to put their keys on the production Droplet |
| **Date** | 2026-10-05 |
| **Status** | Written from the code and Clerk's documentation. **Not yet run against a real Clerk production instance** ([ADR-0004](adr/0004-clerk-hosted-sign-in.md) lists what the first run must confirm). Clerk's dashboard menu names change: where a label here differs from the screen, follow the screen and fix this file in the same pass |
| **Companion docs** | [RUNBOOK_PROVISIONING.md](RUNBOOK_PROVISIONING.md) (the Droplet, Nginx, Cloudflare, `.env`) · [adr/0004-clerk-hosted-sign-in.md](adr/0004-clerk-hosted-sign-in.md) · [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) §10.1 · [ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) · [`.env.example`](../.env.example) |

## 1. What you are setting up

| | Customer app | Staff app |
|---|---|---|
| **Who signs in** | Customers and their teams | Your own staff only |
| **Clerk application** | One production instance | A **second, separate** production instance |
| **Address** | `https://aeocorner.com` (the app lives under `/app`) | `https://admin.aeocorner.com` (`STAFF_HOST`) |
| **Sign-up** | Open (anyone can create an account) | **Restricted**: invite only |
| **Second factor** | Optional for the customer | **Required** |
| **Outer wall** | Cloudflare WAF | Cloudflare **Access** (mandatory in production) |
| **Webhook** | `POST /webhooks/clerk` | None (nothing in the code reads `CLERK_STAFF_WEBHOOK_SECRET`; leave it empty) |
| **Keys in `.env`** | `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | `CLERK_STAFF_PUBLISHABLE_KEY`, `CLERK_STAFF_SECRET_KEY`, `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `CLOUDFLARE_ACCESS_AUD`, `STAFF_HOST` |

Clerk is **identity only**: it says who a person is. Organizations, roles, invitations and project access live in our MySQL database ([DATABASE_SCHEMA §10.1](DATABASE_SCHEMA.md)). Clerk Organizations is not used. Sign-in and sign-up are Clerk's **hosted pages** (the Account Portal), so our pages never load Clerk's JavaScript ([ADR-0004](adr/0004-clerk-hosted-sign-in.md)).

**The server refuses to start in production if:** the customer or staff Clerk key is a test key (`pk_test_`, `sk_test_`), a publishable key has no matching secret key (or the reverse), or the staff app is set without Cloudflare Access. So do not try to launch with development keys.

**Cost.** Required staff multi-factor needs Clerk Pro (about $25 a month, [MVP §12.3](MVP.md)). Check Clerk's current pricing page before you subscribe. Development instances include Pro features, which is why a test passes that production would not.

## 2. Before you start

| Needed | Why |
|---|---|
| `aeocorner.com` DNS on Cloudflare ([RUNBOOK_PROVISIONING §2](RUNBOOK_PROVISIONING.md)) | Clerk's production instance needs DNS records on your domain, and Cloudflare Access protects the staff host |
| The production Droplet already serving `https://aeocorner.com/healthz` | The webhook test and the sign-in loop check need a live site |
| A Cloudflare Zero Trust account (the free plan covers up to 50 users) | Cloudflare Access for the staff host |
| The Resend domain verified | Clerk sends its own emails (sign-in codes, invitations to staff), but customers' team invitations come from us |

## 3. Customer app

### 3.1 Create the production instance

1. In the Clerk Dashboard, create an application named "AEO Corner" and turn on the sign-in methods you want (email address plus password and/or email code; add Google if you want social sign-in).
2. **Require a verified email address.** The app accepts a team invitation only when Clerk has verified an email that matches it, so unverified emails must not be allowed.
3. Open the instance switcher (top of the dashboard) and choose **Create production instance**. Clerk asks for your domain: use `aeocorner.com`.

### 3.2 DNS records (Cloudflare)

Clerk shows a list of CNAME records for the production instance. Add each one in Cloudflare DNS as **DNS only (grey cloud, not proxied)**. Typically:

| Name | Purpose |
|---|---|
| `clerk` | Clerk's Frontend API (`clerk.aeocorner.com`) |
| `accounts` | The hosted sign-in and sign-up pages (`accounts.aeocorner.com`) |
| `clkmail` and two DKIM records | Clerk's own emails |

Use the exact names and targets Clerk shows. Click **Verify** in Clerk and wait until every row is green (it can take a few minutes, and Clerk issues its certificates after that).

The publishable key encodes the Frontend API address. The app derives the hosted-page address from it (`clerk.aeocorner.com` → `accounts.aeocorner.com`), so `CLERK_SIGN_IN_URL` and `CLERK_SIGN_UP_URL` can stay empty. Set them only if you move the pages elsewhere.

### 3.3 Paths and the sign-in loop

Clerk's hosted pages send people back to us after sign-in, using a `redirect_url` that `/sign-in` and `/sign-up` pass along.

- Under **Paths** (or the Account Portal settings), leave the application home at `https://aeocorner.com`.
- **`APP_BASE_URL` must be exactly the address people browse to**: `https://aeocorner.com`, no `www`, no trailing path. The server checks every session's `azp` claim against it, so a mismatch (bare domain against `www`) rejects every session and causes a **sign-in loop**. Cloudflare should redirect `www` to the bare domain, or `www` must be your `APP_BASE_URL`; pick one.

### 3.4 Webhook

1. **Configure → Webhooks → Add Endpoint.**
2. **Endpoint URL:** `https://aeocorner.com/webhooks/clerk`
3. **Events:** exactly `user.created`, `user.updated`, `user.deleted`.
4. Create it, then copy the **Signing Secret** (`whsec_...`).

What the endpoint does (`src/web/routes/webhooks.js`): checks the Svix signature on the raw body, dedupes by `svix-id`, drops stale events, and answers 500 on failure so Clerk retries. A user is also created on their first page view, so a late webhook is harmless.

The webhook host must be reachable by Clerk. The Droplet's firewall accepts 443 only from Cloudflare, which is fine because Clerk reaches us through Cloudflare. Do not put the customer host behind Cloudflare Access.

### 3.5 Keys

From **API Keys** in the customer instance, copy the live keys.

### 3.6 Look and feel

Branding of the hosted pages is limited to what the dashboard offers (logo, colours): ADR-0004 explains why. Set the logo, the colours and the application name now.

## 4. Staff app

### 4.1 Create a separate application

1. Create a **second** application named "AEO Corner Staff". Never reuse the customer application: the staff console trusts this one only.
2. Turn on email-code or email-and-password sign-in and a **second factor** (authenticator app, and backup codes). Do not enable social sign-in.
3. Create its production instance with a domain. Use the **same root domain**; Clerk will give you a different set of CNAME records (for example `clerk.admin.aeocorner.com` / `accounts.admin.aeocorner.com`, or similar) so the two instances do not clash. Add those as DNS only records as in §3.2 and verify them.

### 4.2 Lock it down

| Setting | Value | Why |
|---|---|---|
| **Sign-up mode** | **Restricted** (invite only) | Nobody can create a staff account themselves. The first account comes from `npm run staff:invite` (§4.5) |
| **Multi-factor** | **Required** for everyone | The server reads the `fva` claim in the session token and refuses a session without a verified second factor |
| **Session inactivity timeout** | **30 minutes** | An unattended console signs itself out |
| **Social connections** | Off | Fewer ways in |

If a staff member's session has no verified second factor, the console refuses it even though Clerk thinks they are signed in.

### 4.3 Cloudflare Access in front of the staff host

A staff request must carry a valid Cloudflare Access token, a staff Clerk session with a second factor, **and** an active `staff_users` row. Cloudflare Access is the outer wall, and the app checks its token itself (`Cf-Access-Jwt-Assertion`, `src/web/staff/cloudflare-access.js`), so reaching the Droplet by going around Cloudflare does not work either.

1. In **Cloudflare Zero Trust → Access → Applications**, add a **Self-hosted** application.
2. **Application domain:** `admin.aeocorner.com` (your `STAFF_HOST`). Set the session duration to match the 30-minute rule or shorter.
3. Add a policy with action **Allow** and a rule that includes only your staff emails (or your company email domain).
4. Save, open the application, and copy:
   - the **Application Audience (AUD) tag** → `CLOUDFLARE_ACCESS_AUD`;
   - your **team domain** (`<team>.cloudflareaccess.com`) → `CLOUDFLARE_ACCESS_TEAM_DOMAIN`.
5. Make sure the DNS record for `admin.aeocorner.com` is **proxied** (orange cloud), unlike Clerk's CNAMEs. Access only works on proxied names.

The Nginx config in `deploy/` already serves `admin.aeocorner.com` in the same server block ([RUNBOOK_PROVISIONING §7](RUNBOOK_PROVISIONING.md)); the Origin CA certificate must cover that name.

Staff sign-in works in two steps: Cloudflare Access asks for a one-time code or your identity provider first, then the staff Clerk page asks for the staff account and its second factor.

### 4.4 Keys

From **API Keys** in the staff instance copy the live keys.

### 4.5 Invite the first staff member

On the Droplet, as the `deploy` user, in `/srv/aeo-corner` (after §5):

```bash
npm run staff:invite -- you@aeocorner.com "Your Name" super_admin
```

Roles: `super_admin`, `ops`, `support`, `reviewer`, `finance`. Give several roles by listing them: `npm run staff:invite -- ops@aeocorner.com "On Call" ops support`. Nobody gets into the console without a `staff_users` row, which is what makes the Restricted sign-up mode safe.

The person then:

1. Passes Cloudflare Access with the same email address.
2. Opens `https://admin.aeocorner.com`, signs up in the **staff** Clerk app with that email, **verifies it**, and sets up the second factor.
3. Their row is bound to their Clerk user on first sign-in. The email must match the invitation and be verified.

## 5. Put the keys on the Droplet

On the Droplet, edit `/srv/aeo-corner/.env` (owner `deploy`, mode `600`). Never put these values in a file in the repository, in chat, or in a ticket.

```ini
APP_ENV=production
APP_BASE_URL=https://aeocorner.com

# Customer app
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
CLERK_WEBHOOK_SECRET=whsec_...

# Staff app (a separate Clerk application)
CLERK_STAFF_PUBLISHABLE_KEY=pk_live_...
CLERK_STAFF_SECRET_KEY=sk_live_...
CLOUDFLARE_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=<the application's AUD tag>
STAFF_HOST=admin.aeocorner.com
```

Then restart both processes so they read the file, web first:

```bash
cd /srv/aeo-corner
pm2 reload aeo-web --update-env
pm2 reload aeo-worker --update-env
pm2 logs aeo-web --lines 30
```

A start-up error that names a Clerk key, "needs a production Clerk instance", or "needs Cloudflare Access" means one of the rules in §1 is not met. The message names the app (customer or staff).

## 6. Checks after setup

| # | Check | How | Expect |
|---|---|---|---|
| 1 | The server started with the live keys | `pm2 logs aeo-web --lines 30` | No Clerk or Cloudflare error |
| 2 | Customer sign-up works | A private browser window: `https://aeocorner.com/sign-up`, then finish on Clerk's page | You come back to the app, signed in, and no loop |
| 3 | The user was recorded | Staff console or `SELECT email, clerk_user_id FROM users ORDER BY id DESC LIMIT 1` | One row with your email |
| 4 | The webhook works | Clerk → Webhooks → your endpoint → **Testing** → send `user.created` | 200 in Clerk; a repeat of the same event changes nothing |
| 5 | Wrong webhook secret is refused | Compare with a bad `CLERK_WEBHOOK_SECRET` on staging only | 400/401, and the app does not store the event |
| 6 | Sign-out works | Press Sign out in the app | You are signed out, and `/app` sends you to sign-in |
| 7 | Staff are walled off | Open `https://admin.aeocorner.com` in a fresh window | Cloudflare Access asks you to prove who you are first |
| 8 | Staff need a second factor | Sign in as the invited staff member with no second factor set up | The console refuses the session until one is verified |
| 9 | A stranger cannot be staff | Try to sign up on the staff Clerk page with an uninvited address | Refused (Restricted mode) |
| 10 | The staff session times out | Leave the console 30 minutes | You are asked to sign in again |

## 7. When it goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Sign-in loop (Clerk says signed in, the app says signed out) | `APP_BASE_URL` differs from the address in the browser (`www` against the bare domain, `http` against `https`) | Make `APP_BASE_URL` exactly the browsed address; reload the web process |
| Clerk's hosted page shows an error or a certificate warning | The Clerk DNS records are proxied (orange cloud) or not yet verified | Set them to DNS only and re-verify in Clerk |
| Webhook returns 400 or 401 | Missing or wrong `CLERK_WEBHOOK_SECRET` (the secret belongs to one endpoint) | Copy the secret from the right endpoint; reload |
| Webhook returns 5xx and Clerk keeps retrying | The database is down, or a handler failed | `pm2 logs aeo-web`; Clerk retries, so fix the cause and the event is applied |
| Server will not start: "needs a production Clerk instance" | A `pk_test_` or `sk_test_` key in `.env` | Use the production instance's live keys |
| Server will not start: "needs Cloudflare Access" | The staff keys are set but `CLOUDFLARE_ACCESS_TEAM_DOMAIN` or `_AUD` is empty | Add both |
| Staff get 403 after Cloudflare Access | No `staff_users` row, an unverified email, the wrong email, or no verified second factor | Run `staff:invite`; check the email; set up the second factor |
| Staff cannot reach the host at all | The DNS record is not proxied, or the AUD tag belongs to a different application | Proxy the record; copy the AUD again |
| A staff member left | They still have a Clerk account | Remove their `staff_users` roles in the console, delete their staff Clerk user, and remove them from the Cloudflare Access policy |

## 8. Rotating keys

| Key | How |
|---|---|
| Customer or staff secret key | Roll it in Clerk (API Keys), put the new value in `.env`, `pm2 reload aeo-web --update-env` and `aeo-worker`. Sessions in flight keep working because they are checked against Clerk's public keys |
| Webhook signing secret | Roll it on the endpoint in Clerk, put the new value in `CLERK_WEBHOOK_SECRET`, reload. Events sent in between fail with 400 and Clerk retries them |
| Cloudflare Access AUD | Changes only if you recreate the application. Update `CLOUDFLARE_ACCESS_AUD` straight away, or the staff console refuses everyone |

## 9. Open items

| Item | Owner |
|---|---|
| The first real run against Clerk. ADR-0004 lists what to confirm: the handshake, `redirect_url` on the Account Portal, the `fva` claim on the staff token, and sign-out | Founder, with the first staging run |
| Staging uses a Clerk **development** instance for both apps (`pk_test_`), as [RUNBOOK_PROVISIONING §9](RUNBOOK_PROVISIONING.md) says; the production-instance rule applies only when `APP_ENV=production` | — |
| Wording of Clerk's dashboard labels (§3 and §4) is from Clerk's documentation, not from the live screens | Fix this file during the first run |
