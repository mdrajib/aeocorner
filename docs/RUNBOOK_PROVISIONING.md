# AEO Corner — Provisioning runbook (staging and production)

| | |
|---|---|
| **Document** | How to build a server that runs AEO Corner: a Droplet with PM2, Nginx and Chromium, the managed database and Redis, the Spaces prefix and its lifecycle rule, Cloudflare in front, and how to deploy to it |
| **Date** | 2026-10-03 |
| **Status** | Written, **not yet run on a real Droplet.** The first run (staging, task 2.09 in [MILESTONES.md](MILESTONES.md)) is the test of this document: fix any step that turns out wrong, in this file, in the same pass |
| **Companion docs** | [MVP.md](MVP.md) §7.10 (environments, delivery) and §7.11 (topology, cost) · [MILESTONES.md](MILESTONES.md) Milestone 2 · [ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) · [adr/0005-fetching-other-peoples-websites.md](adr/0005-fetching-other-peoples-websites.md) · [adr/0008-queues-and-the-worker.md](adr/0008-queues-and-the-worker.md) · [`deploy/ecosystem.config.cjs`](../deploy/ecosystem.config.cjs) · [`deploy/nginx-aeocorner.conf`](../deploy/nginx-aeocorner.conf) |

## 1. What you end up with

| Part | Staging | Production |
|---|---|---|
| Address | `staging.aeocorner.com` (and `admin.staging.aeocorner.com`) | `aeocorner.com`, `www.aeocorner.com`, `admin.aeocorner.com` |
| `APP_ENV` | `staging` (never indexed, `noindex` on every page) | `production` |
| Droplet | its own, 2 vCPU / 4 GB | its own, 2 vCPU / 4 GB |
| MySQL | its own database (`aeo_corner_staging`) on the managed cluster | `aeo_corner` on the managed cluster |
| Redis | the managed Redis, `QUEUE_PREFIX=stg` | the same Redis, `QUEUE_PREFIX=prod` |
| Spaces | the shared bucket, directory `aeo-corner/staging/` | the same bucket, directory `aeo-corner/prod/` |
| Provider budget | capped low (see §9) | the real caps |
| Deploys from | every push to `main` | a tagged release |

**Why separate Droplets.** A bug or a runaway audit on staging must not be able to slow the live site. Two 4 GB Droplets cost about $48 a month; one shared one saves $24 and removes the safety.

## 2. Before you start (founder items)

These are the Milestone 0 tasks this runbook needs. Nothing below works without them.

| Needed | Milestone 0 task | Used for |
|---|---|---|
| DigitalOcean project with a VPC | 0.09 | Everything in §3 |
| `aeocorner.com` on Cloudflare | 0.10 | DNS, TLS, WAF, Turnstile |
| Resend domain verified (`hello@aeocorner.com` can send) | 0.11 | The audit's code and report emails |
| Turnstile site key and secret key (one pair per environment) | 0.13 | The audit form's bot check |
| Anthropic, DataForSEO, SerpApi, Perplexity keys | 0.14 | The audit's engines and Claude |

**The audit is closed until the keys are in.** The web server only opens the free audit when it has a database, Redis and `TURNSTILE_SECRET_KEY`; without them the form says "The free audit opens soon" and stores nothing. Production stays in that state until you set the secret key, which is the switch in task 2.13.

## 3. Create the DigitalOcean resources

Do all of this in one region and one VPC. Record every value in a password manager, not in a file.

1. **Managed MySQL 8.** Create the cluster. Under *Trusted sources* allow only the two Droplets (add each after you create it). Create two databases and one user for each:
   - `aeo_corner_staging` with user `aeo_staging`
   - `aeo_corner` with user `aeo_prod`
   Download the cluster's CA certificate (it is shown on the cluster's page).
2. **Managed Redis (Valkey).** Create it in the same VPC, trusted sources the two Droplets. Open *Settings* and set the eviction policy to **`noeviction`**. With any other policy Redis deletes queued jobs when memory fills, and the worker logs an error at start when it is wrong.
3. **Spaces.** Use the existing bucket. Create no new bucket. See §8 for the prefix and the lifecycle rule.
4. **Cloud Firewall**, attached to both Droplets:
   - Inbound **443** only from Cloudflare's address ranges ([cloudflare.com/ips](https://www.cloudflare.com/ips/)). This is what makes it safe for Nginx to believe the `CF-Connecting-IP` header (§7).
   - Inbound **22** only from your own IP addresses.
   - Inbound 80: none. Cloudflare talks to the Droplet on 443 only.
   - Outbound: everything (the crawler, engines, Claude, Resend and Clerk are all outbound).
5. **Droplets.** Ubuntu 24.04 LTS, 2 vCPU / 4 GB (Chromium needs the memory), in the VPC, with your SSH key, **backups on**. Name them `aeo-staging` and `aeo-prod`.

## 4. Prepare the Droplet

Run as root once, then never log in as root again.

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy:deploy /home/deploy/.ssh
# Keys only, no root login:
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
apt-get update && apt-get -y upgrade
apt-get -y install nginx fail2ban unattended-upgrades git curl
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Open a second terminal and confirm `ssh deploy@<ip>` works **before** closing the root session.

Install Node (the project needs 24 or later) for the `deploy` user, then PM2:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get -y install nodejs
sudo npm install -g pm2
node --version   # v24.x
```

## 5. Install the app and Chromium

```bash
sudo mkdir -p /srv/aeo-corner && sudo chown deploy:deploy /srv/aeo-corner
git clone git@github.com:mdrajib/aeocorner.git /srv/aeo-corner   # add a read-only deploy key to the repo first
cd /srv/aeo-corner
npm ci --omit=dev
```

**Chromium.** The crawler's render step and the audit's rendered-page checks need it. Without it scans still finish, but the render checks say "couldn't check" and every audit's Readiness score is less complete, so install it on every Droplet that runs the worker:

```bash
cd /srv/aeo-corner
sudo npx playwright install --with-deps chromium    # downloads the browser and the system libraries it needs
npx playwright install chromium                     # the same browser for the deploy user's cache
```

Check it: `node -e "require('playwright').chromium.launch().then(async b => { console.log(b.version()); await b.close(); })"` prints a version.

## 6. Configure and start the processes

1. Create `/srv/aeo-corner/.env`, owned by `deploy`, mode `600` (`chmod 600 .env`). Use [`.env.example`](../.env.example) as the list and §9 below for what each environment sets. `APP_SECRET` is generated here, once per environment: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
2. Copy the database CA certificate to `/srv/aeo-corner/certs/do-mysql-ca.pem` and set `DATABASE_CA_CERT` to it.
3. Run the migrations: `npx prisma migrate deploy`. Then check the schema loaded: `npm run prisma:generate` and start the web process; `/healthz` answers.
4. Build the CSS: `npm run build:css`.
5. Start both processes with the file in `deploy/`:

```bash
cd /srv/aeo-corner
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy   # run the command it prints, with sudo
```

`aeo-web` runs two copies in cluster mode (a reload swaps them one at a time, so no request is dropped). `aeo-worker` is one process: it finishes running jobs before it stops (PM2 waits up to two minutes, enough for an audit).

Check: `pm2 status` shows both online; `curl -s localhost:3000/healthz` answers `{"status":"ok"}`; `pm2 logs aeo-worker --lines 20` shows "AEO Corner worker running" and **no** line about the eviction policy.

## 7. Nginx and Cloudflare

1. In Cloudflare, create an **Origin CA certificate** for the names in the config (15-year, free) and save the two files on the Droplet as `/etc/ssl/aeocorner/origin.pem` and `origin.key` (`chmod 600` on the key).
2. Copy [`deploy/nginx-aeocorner.conf`](../deploy/nginx-aeocorner.conf) to `/etc/nginx/sites-available/aeocorner.conf`, change `server_name` for the environment, link it into `sites-enabled`, remove the default site, then `sudo nginx -t && sudo systemctl reload nginx`.
3. In Cloudflare: DNS records for the names (proxied, orange cloud) pointing at the Droplet; SSL/TLS mode **Full (strict)**; *Always Use HTTPS* on; under *Security → WAF* turn on the free managed rules.
4. **Why the firewall matters here.** Nginx takes the visitor's address from `CF-Connecting-IP` and Express uses it for the audit's per-IP limit and the abuse blocks. That header is only believable if nothing but Cloudflare can reach port 443, which is what the Cloud Firewall rule in §3 does. If you ever open 443 to the world, delete the `real_ip` lines first.
5. **The live progress page** streams for up to 12 minutes. The config has a separate block for `/audit/<id>/events` with buffering off and a 15-minute read timeout. If you replace the config, keep that block, or the progress page will silently fall back to reloading.

Check from your laptop: `curl -I https://staging.aeocorner.com/healthz` returns 200 over HTTPS through Cloudflare, with `x-robots-tag: noindex, nofollow` on staging.

## 8. Spaces: the prefix and the lifecycle rule

- **Prefix.** The app writes only inside `aeo-corner/<dev|staging|prod>/` (`DO_SPACES_PREFIX`; the default follows `APP_ENV`). The bucket is shared with other apps, so never point a tool at the bucket root.
- **Keys.** Create a Spaces access key for this app. DigitalOcean's keys are per account or per bucket, not per directory, so treat the key as able to read the whole bucket: keep it in `.env` only.
- **Lifecycle rule** (raw payloads are kept 13 months, [MVP §8.3](MVP.md#8-data-model)). In the Spaces console: *Settings → Lifecycle Rules → Add*, with the prefix `aeo-corner/prod/` (and a second rule for `aeo-corner/staging/`, 30 days), *Expire* after **400 days** for the 13 months plus a margin, and **Delete incomplete multipart uploads** after 7 days. A rule with the prefix left empty would apply to the other apps' files: check the prefix field before saving.
- **Check:** `npm run scan -- example.com` on the Droplet writes under the prefix; list the bucket and confirm nothing is outside `aeo-corner/`.

## 9. What each environment sets

Everything is in [`.env.example`](../.env.example); this is only what differs or is easy to get wrong.

| Variable | Staging | Production |
|---|---|---|
| `NODE_ENV` | `production` | `production` |
| `APP_ENV` | `staging` | `production` |
| `APP_BASE_URL` | `https://staging.aeocorner.com` | `https://aeocorner.com` |
| `TRUST_PROXY` | `1` | `1` |
| `APP_SECRET` | its own | its own (never shared) |
| `DATABASE_URL` | staging database, `?ssl-mode=REQUIRED` | production database, same |
| `REDIS_URL`, `QUEUE_PREFIX` | managed Redis, `stg` | same Redis, `prod` |
| `DO_SPACES_*` | the bucket, prefix `aeo-corner/staging/` | the bucket, prefix `aeo-corner/prod/` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | its own pair | its own pair. **Setting the secret opens the audit** |
| `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` | set (required in production mode) | set |
| `EMAIL_BILL_ADDRESS`, `EMAIL_SUPPORT_ADDRESS` | optional; billing notices and support notices send from these, and from `EMAIL_FROM_ADDRESS` when empty. Their domain must be verified in Resend | same |
| `EMAIL_REPLY_TO` | a real mailbox on the webmail (e.g. `support@aeocorner.com`), so replies to mail sent from the sending subdomain are not lost | same |
| `ANTHROPIC_API_KEY`, `DATAFORSEO_*`, `SERPAPI_API_KEY`, `PERPLEXITY_API_KEY` | set, with the **account-side caps** at a few dollars | set, with the real caps |
| `AUDIT_DAILY_BUDGET_USD` | `5` | `60` (the default) until the first real cost-per-audit is known |
| `POSTHOG_API_KEY` | empty | set, so the audit funnel is counted |
| `SENTRY_DSN` | set | set |
| `CLERK_*` | a development instance | a production instance (`pk_live_`, `sk_live_`) |
| `ALERT_WEBHOOK_URL` | a test channel | the alerts channel |

The server refuses to start in production mode without a database, Redis, Clerk's keys and a Resend key. It starts without Turnstile and then keeps the audit closed, and says so in its log.

## 10. Deploying

[MVP §7.10](MVP.md#710-environments--delivery) describes the automated path (GitHub Actions over SSH). By hand, the same steps, in this order:

```bash
cd /srv/aeo-corner
git fetch --tags && git checkout <main for staging | the release tag for production>
npm ci --omit=dev
npm run build:css
npx prisma migrate deploy
pm2 reload aeo-web          # zero downtime
pm2 reload aeo-worker       # waits for running jobs, then restarts
```

Migrations run **before** the reload and must work with both the old and the new code running side by side for a few seconds (add a column, then use it in the next release; never rename in one step).

**Rollback.** Check out the previous tag, `npm ci --omit=dev`, `npm run build:css`, reload both. Do **not** roll a migration back: write a new forward migration instead.

**Maintenance page.** Set `MAINTENANCE_MODE=true` in `.env` and `pm2 reload aeo-web`: every page answers 503 with a "back soon" page, while `/healthz` and the static files stay up.

## 11. After the first deploy: the checks

| # | Check | How | Expect |
|---|---|---|---|
| 1 | Web is up through Cloudflare | `curl -I https://<host>/healthz` | 200, HTTPS |
| 2 | Staging is not indexable | `curl -sI https://staging.<host>/ \| grep -i x-robots` and `/robots.txt` | `noindex, nofollow`; `Disallow: /` |
| 3 | Redis is safe for queues | `pm2 logs aeo-worker --lines 50` | no "eviction policy" error |
| 4 | Database over TLS | the app starts with `?ssl-mode=REQUIRED` and `DATABASE_CA_CERT` | no TLS error in the logs |
| 5 | Chromium works | the command in §5 | prints a version |
| 6 | Spaces prefix | `npm run scan -- example.com`, then list the bucket | objects only under `aeo-corner/<env>/` |
| 7 | The audit is open | open `/`, run the form | the email step appears (not "opens soon") |
| 8 | Mail works | finish step 2 with your own address | the 6-digit code arrives |
| 9 | One real audit | verify the code and wait | a report in under 10 minutes; the email arrives; **record the cost** from `audits.cost_usd` (Milestone 1's open item: it must be at most $0.75) |
| 10 | The funnel is counted | PostHog, *Events* | `audit_form_submitted` … `audit_report_viewed`, with no email or domain on any of them |
| 11 | A lead row exists | the staff console or `SELECT … FROM leads` | one row for your address |
| 12 | The budget guard | set `AUDIT_DAILY_BUDGET_USD=0.01`, reload, start an audit | the audit says it is delayed rather than running, and one alert goes to the channel; then restore the value |

## 11b. Billing, email and Google (Milestone 8)

Three outside services need one thing each from you before billing, the digest and AI traffic work in production. None is needed for a laptop.

| Service | What to do | Where it goes |
|---|---|---|
| **Stripe** | In the dashboard (test mode first): create a restricted or secret key and a webhook endpoint at `https://<app host>/webhooks/stripe` that sends `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` and `invoice.payment_failed`. Turn on the Customer Portal (cancel, update card, invoices). Then run `npm run stripe:sync` once on the server: it makes the products, prices and the extra-drafts meter and stores each plan's price ID. | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, optional `STRIPE_API_VERSION` (a test key on staging, a live key only in production; a mismatch is refused at start). **With the key set, plans are enforced**: an organization with no subscription can set up but nothing is tracked |
| **bKash** (ADR-0018) | In the bKash merchant portal, get the **tokenized checkout** credentials: app key, app secret, username and password (sandbox first). Then set each plan's price in taka: `UPDATE plans SET price_bdt_month = 2500 WHERE code = 'starter';` (and so on; `NULL` keeps a plan closed to bKash). **Run one payment in bKash's sandbox before going live**: the API paths and field names in `src/integrations/bkash.js` follow bKash's documentation but have never been run against it. Ask bKash which callback URL to whitelist: `https://<app host>/app/o/<org>/billing/bkash/return` differs per organization, so ask whether a wildcard or the app host is accepted. | `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, optional `BKASH_BASE_URL` (the sandbox address outside production, the live one only in production; a mismatch is refused at start). **With the keys set, plans are enforced** and the plan screen takes payment through bKash. The worker needs the same keys. There is no webhook: the hourly `billing.bkash_sweep` settles a payment whose customer never came back |
| **Resend** | Add a webhook at `https://<app host>/webhooks/resend` for `email.delivered`, `email.bounced` and `email.complained`. | `RESEND_WEBHOOK_SECRET` (`whsec_…`). Without it bounces and complaints are not recorded |
| **Google** | In Google Cloud: an OAuth client (web) with the redirect address `https://<app host>/app/google/callback`, scopes `analytics.readonly` and `webmasters.readonly`, then submit the verification (weeks: MILESTONES 0.18). Until Google approves it, only the app's listed test users can connect. | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`; `SECRETS_MASTER_KEY` must also be set |

The worker runs these on a schedule: `billing.reconcile` (05:15 UTC), `billing.report_usage` (hourly), `retention.sweep` (05:45), `billing.notices` (15:00), `digest.tick` (hourly), `sync.google.sweep` (03:40). A failed webhook delivery is retried by Stripe and Resend; `billing.reconcile` is the safety net for Stripe's.

## 12. Things this runbook does not cover yet

| Gap | Why | When |
|---|---|---|
| GitHub Actions deploy workflow | Written when staging exists, from the manual steps above | Task 2.09 |
| Backups restore drill | The managed database backs up daily; the drill is written ([RUNBOOK_RESTORE_DRILL.md](RUNBOOK_RESTORE_DRILL.md)) but a restore has not been tried on a real cluster | Before launch |
| Log shipping and uptime checks | DigitalOcean Monitoring and an uptime check on `/healthz` are set in the console, not in code | Task 2.09 |
| Scaling the worker to its own Droplet | Not needed until CPU or memory stays above 70% ([MVP §7.11](MVP.md#711-digitalocean-deployment-topology)) | When it happens |
