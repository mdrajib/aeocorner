# AEO Corner: deploy to one DigitalOcean Droplet, step by step

| | |
|---|---|
| **Document** | A first production deploy on a single Droplet, in the order you do it, with a check after each part |
| **Date** | 2026-10-09 |
| **Status** | Written from the code and the existing runbooks. **Not yet run on a real Droplet**: where a step turns out wrong, fix it here in the same pass |
| **Companion docs** | [RUNBOOK_PROVISIONING.md](RUNBOOK_PROVISIONING.md) (the full reference, with staging) · [RUNBOOK_CLERK.md](RUNBOOK_CLERK.md) · [adr/0018-paying-with-bkash.md](adr/0018-paying-with-bkash.md) · [RUNBOOK_INCIDENTS.md](RUNBOOK_INCIDENTS.md) · [`deploy/ecosystem.config.cjs`](../deploy/ecosystem.config.cjs) · [`deploy/nginx-aeocorner.conf`](../deploy/nginx-aeocorner.conf) · [`.env.example`](../.env.example) |

This is the short path to a live site. [RUNBOOK_PROVISIONING.md](RUNBOOK_PROVISIONING.md) is the long reference and also covers a separate staging server; read it when something here is not enough.

## 1. What you build

| Part | Choice | About per month |
|---|---|---|
| Droplet | Ubuntu 24.04 LTS, **2 vCPU / 4 GB**, backups on. Runs Nginx, the web app (2 copies) and the worker (with Chromium) | $24 + $5 |
| Managed MySQL 8 | smallest plan, same region and VPC | $15 |
| Managed Redis (Valkey) | smallest plan, same VPC, eviction policy `noeviction` | $15 |
| Spaces | the existing bucket; the app writes only under `aeo-corner/prod/` | $5 |
| Cloudflare | free plan: DNS, HTTPS, firewall rules, Turnstile | $0 |

Total about $65–80 a month before provider fees (Claude, DataForSEO, SerpApi, Perplexity, Resend).

**Why 4 GB:** Chromium (the page renderer in the worker) runs out of memory on 2 GB.

## 2. Gather these first

Do not start until you have the items you need. Put every secret in a password manager, never in a file in the repo, and never paste one into a chat.

| Needed | Where from | Used for |
|---|---|---|
| The domain on Cloudflare | Cloudflare | DNS and HTTPS |
| Clerk **production** keys (customer app, and the staff app) | [RUNBOOK_CLERK.md](RUNBOOK_CLERK.md) | Sign-in |
| Resend API key, domain verified | Resend | Every email (the server will not start without it) |
| Turnstile site key and secret | Cloudflare | The free audit's bot check |
| Anthropic, DataForSEO, SerpApi, Perplexity keys | each provider (set a low spend cap on each account) | Answers and extraction |
| bKash live keys (app key, app secret, username, password) | bKash merchant portal | Paying in taka |
| Stripe keys (optional now) | Stripe | Paying in dollars |
| GitHub deploy key | you create it in step 6 | Pulling the code |

Production refuses to start without a database, Redis, Clerk's keys and a Resend key. It also needs a way to take payment (the bKash keys **or** Stripe's) to enforce plans.

## 3. Create the DigitalOcean resources

Use one region for everything and put them all in one VPC.

1. **Managed MySQL 8.** Create the cluster. Create a database `aeo_corner` and a user `aeo_prod` for it. Download the cluster's CA certificate from its page. Leave *Trusted sources* empty for now; you add the Droplet in step 3.5.
2. **Managed Redis (Valkey).** Create it in the same VPC. In *Settings* set the eviction policy to **`noeviction`**. Any other policy deletes queued jobs when memory fills.
3. **Spaces.** Use the existing bucket; create no new one. Make an access key for this app and keep it. Add a lifecycle rule for the prefix `aeo-corner/prod/` that expires objects after 400 days and removes incomplete multipart uploads after 7 days. Check the prefix field before saving: an empty prefix would apply to the other apps' files.
4. **Droplet.** Create it: Ubuntu 24.04 LTS, 2 vCPU / 4 GB (Regular or Premium), in the VPC, with your SSH key, **backups on**. Name it `aeo-prod`. Note its public IP.
5. **Trusted sources.** Back on the MySQL and Redis clusters, add the Droplet as the only trusted source.
6. **Cloud Firewall**, attached to the Droplet:
   - Inbound **443** only from Cloudflare's address ranges ([cloudflare.com/ips](https://www.cloudflare.com/ips/)). This is what makes it safe to believe the visitor address Cloudflare reports.
   - Inbound **22** only from your own IP address.
   - No inbound 80.
   - Outbound: everything.

**Check:** the Droplet shows as running, and both databases show your Droplet as the only trusted source.

## 4. Prepare the server

Log in as root once: `ssh root@<droplet ip>`. Then:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy:deploy /home/deploy/.ssh
echo "deploy ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/deploy
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
passwd -l root
systemctl restart ssh
apt-get update && apt-get -y upgrade
apt-get -y install nginx fail2ban unattended-upgrades git curl
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Open a **second** terminal and confirm `ssh deploy@<droplet ip>` works before you close the root session. From here on, log in only as `deploy`.

**Root is then disabled in three ways:** SSH refuses root logins (`PermitRootLogin no`), root's password is locked (`passwd -l root`), and password logins are off for everyone (keys only). Afterwards `ssh root@<droplet ip>` must answer "Permission denied". If you ever lock yourself out, DigitalOcean's web console (Droplet → Access → Launch Droplet Console) gets you in. The `deploy` user has no password, so its `sudo` is passwordless (the `sudoers.d` line above); the only way to become it is your SSH key.

Install Node 24 and PM2:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get -y install nodejs
sudo npm install -g pm2
node --version    # v24.x
```

**Check:** `node --version` prints v24 or later.

## 5. Put the domain in Cloudflare

1. DNS records, **proxied** (orange cloud), all pointing at the Droplet's IP: `aeocorner.com`, `www`, and `admin` (the staff console).
2. SSL/TLS mode: **Full (strict)**. Turn on *Always Use HTTPS*.
3. SSL/TLS → Origin Server: create an **Origin CA certificate** for `aeocorner.com` and `*.aeocorner.com` (15 years, free). Keep the certificate and the private key; you install them in step 9. This is the Cloudflare certificate for the link between Cloudflare and your Droplet. Visitors' browsers get Cloudflare's own edge certificate, which Cloudflare issues and renews by itself. Browsers do not trust an Origin CA certificate, so the DNS records must stay **proxied** (orange cloud); if you switch one to grey, visitors see a certificate error.
4. Security → Security rules. **Managed rules need the Pro plan ($20 a month), so on Free skip them** (DDoS protection is on already). Add two custom rules (5 are free): `Block common probes`, action Block, expression `(http.request.uri.path contains "/.env") or (http.request.uri.path contains "/.git") or (http.request.uri.path contains "wp-login.php") or (http.request.uri.path contains "wp-admin") or (http.request.uri.path contains "phpmyadmin")`; and `Staff host challenge`, action Managed Challenge, hostname equals `admin.aeocorner.com`. Leave Bot Fight Mode off: on Free it cannot be exempted and can block the Clerk, Resend and Stripe webhooks. After setting up webhooks, check **Security → Events** for blocked legitimate requests.

## 6. Get the code onto the server

On the Droplet as `deploy`:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/aeo_deploy -N "" -C "aeo-prod deploy key"
cat ~/.ssh/aeo_deploy.pub
```

In GitHub: repository `mdrajib/aeocorner` → Settings → Deploy keys → Add key. Paste the public key and leave **write access off**. Then:

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/aeo_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
sudo mkdir -p /srv/aeo-corner && sudo chown deploy:deploy /srv/aeo-corner
git clone git@github.com:mdrajib/aeocorner.git /srv/aeo-corner
cd /srv/aeo-corner
npm ci --omit=dev
```

**Check:** `ls /srv/aeo-corner` shows `src`, `prisma`, `deploy`.

## 7. Install Chromium (the worker needs it)

```bash
cd /srv/aeo-corner
sudo npx playwright install --with-deps chromium
npx playwright install chromium
node -e "require('playwright').chromium.launch().then(async b => { console.log(b.version()); await b.close(); })"
```

**Check:** the last command prints a version. Without Chromium the app still works, but the page-rendering checks say "couldn't check".

## 8. Create the `.env`

1. Copy the database certificate to the server: `mkdir -p /srv/aeo-corner/certs`, then put the file at `/srv/aeo-corner/certs/do-mysql-ca.pem` (use `scp` from your laptop).
2. Create the file with `nano /srv/aeo-corner/.env`, then `chmod 600 /srv/aeo-corner/.env`. Use [`.env.example`](../.env.example) as the full list. The essentials for production:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_ENV` | `production` (the bKash live address is only accepted with this) |
| `APP_BASE_URL` | `https://aeocorner.com` |
| `TRUST_PROXY` | `1` |
| `APP_SECRET` | make one: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `DATABASE_URL` | the cluster's connection string for `aeo_corner`, ending `?ssl-mode=REQUIRED` |
| `DATABASE_CA_CERT` | `/srv/aeo-corner/certs/do-mysql-ca.pem` |
| `REDIS_URL`, `QUEUE_PREFIX` | the Valkey connection string from the DigitalOcean page (it starts `rediss://`, with two s: DigitalOcean's managed Valkey only accepts TLS); `prod` |
| `DO_SPACES_KEY`, `DO_SPACES_SECRET`, `DO_SPACES_BUCKET`, `DO_SPACES_ENDPOINT`, `DO_SPACES_REGION` | from step 3; leave the prefix on its default (`aeo-corner/prod/`) |
| `CLERK_*` (customer) and `CLERK_STAFF_*`, `STAFF_HOST`, `CLOUDFLARE_ACCESS_*` | production keys, see [RUNBOOK_CLERK.md](RUNBOOK_CLERK.md) |
| `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO` | from Resend |
| `ANTHROPIC_API_KEY`, `DATAFORSEO_*`, `SERPAPI_API_KEY`, `PERPLEXITY_API_KEY` | from the providers |
| `SECRETS_MASTER_KEY` | a 32-byte key, generated once. **Back it up in the password manager: losing it makes saved WordPress and Google credentials unreadable** |
| `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD` | the live bKash keys. **Leave `BKASH_BASE_URL` out**: production uses the live address by itself |
| `STAFF_SECOND_FACTOR` | `cloudflare` if you do not have Clerk Pro (the staff second factor then comes from Cloudflare Access; see [adr/0019](adr/0019-staff-second-factor-from-cloudflare-access.md)), otherwise leave out |
| `AUDIT_DAILY_BUDGET_USD` | `5` at first, raise it when you know the cost of an audit |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | **leave the secret out until the end** (step 13): setting it opens the free audit to the public |

Never commit this file and never paste it into a chat.

## 9. Install the Nginx config

```bash
sudo mkdir -p /etc/ssl/aeocorner
sudo nano /etc/ssl/aeocorner/origin.pem    # paste the Origin CA certificate
sudo nano /etc/ssl/aeocorner/origin.key    # paste its private key
sudo chmod 600 /etc/ssl/aeocorner/origin.key
sudo cp /srv/aeo-corner/deploy/nginx-aeocorner.conf /etc/nginx/sites-available/aeocorner.conf
sudo ln -s /etc/nginx/sites-available/aeocorner.conf /etc/nginx/sites-enabled/aeocorner.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The file already lists `aeocorner.com`, `www.aeocorner.com` and `admin.aeocorner.com`. Keep its separate block for `/audit/<id>/events`; without it the audit's live page cannot stream.

**Check:** `sudo nginx -t` says "syntax is ok".

## 10. Create the tables and start the app

```bash
cd /srv/aeo-corner
npx prisma migrate deploy
npm run build:css
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy     # run the command it prints, with sudo
```

**Checks:**
- `pm2 status` shows `aeo-web` (two copies) and `aeo-worker` online.
- `curl -s localhost:3000/healthz` prints `{"status":"ok"}`.
- `pm2 logs aeo-worker --lines 20` shows "AEO Corner worker running" and **no** line about the eviction policy.
- If a process keeps restarting, run `pm2 logs aeo-web --lines 50`. The usual cause is a missing or wrong `.env` value, and the message names it.

## 11. Set the plan prices

Plans exist already (they come with the migrations). With bKash, a plan with no taka price is "Not open yet". Connect to the database from the Droplet (`mysql` client with the connection details from the DigitalOcean page), and for the first test only open one plan at ৳10:

```sql
UPDATE plans SET price_bdt_month = 10 WHERE code = 'starter';
```

Put the real prices in after the test in step 14. Then restart so nothing is cached: `pm2 reload aeo-web aeo-worker`.

## 12. Check it through Cloudflare

From your laptop:

```bash
curl -I https://aeocorner.com/healthz
```

You should see HTTP 200 over HTTPS. Then open `https://aeocorner.com` in a browser and look at the home page and the pricing page (it shows taka prices and "How do I pay with bKash?").

Webhooks to register while you are here:
- Clerk: `https://aeocorner.com/webhooks/clerk` ([RUNBOOK_CLERK.md](RUNBOOK_CLERK.md)).
- Resend: `https://aeocorner.com/webhooks/resend`, with `RESEND_WEBHOOK_SECRET` in `.env`.
- Stripe, only if you use it: `https://aeocorner.com/webhooks/stripe`, then `npm run stripe:sync` once.
- bKash has no webhook. Ask bKash whether the return address `https://aeocorner.com/app/o/<org>/billing/bkash/return` must be registered.

## 13. Open the free audit

Only when steps 10–12 are healthy: add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to `.env`, then `pm2 reload aeo-web aeo-worker`. The audit form now works. Run one real audit with your own address and watch the cost. It should finish in under 10 minutes, the code email should arrive, and the cost (`audits.cost_usd`) should be at most $0.75.

## 14. Test the bKash payment with ৳10

1. Sign up as a new customer, create an organization and a project.
2. Open *Plan and billing* as the owner, start the trial, then press **Renew with bKash** and approve it in the bKash app.
3. You should return to the billing page with "Payment received" and a transaction ID in the payments list.
4. Refund the ৳10 in the bKash merchant portal.
5. Set the real prices (`UPDATE plans SET price_bdt_month = <taka> WHERE code = '<plan>';`).

If it fails, the page shows a message and no money moves. Send the message (never the keys) so the client can be corrected: it has never run against bKash.

## 15. Deploy an update later

```bash
cd /srv/aeo-corner
git fetch --tags && git checkout main && git pull
npm ci --omit=dev
npm run build:css
npx prisma migrate deploy
pm2 reload aeo-web          # no dropped requests
pm2 reload aeo-worker       # waits for running jobs to finish
```

- Run migrations **before** the reload. A migration must work with the old and the new code side by side for a few seconds (add a column in one release, use it in the next).
- **Roll back** by checking out the previous commit or tag, `npm ci --omit=dev`, `npm run build:css`, and reloading. Never undo a migration: write a new one forward.
- **Maintenance page:** set `MAINTENANCE_MODE=true` in `.env` and `pm2 reload aeo-web`.
- Production branch: deploy a tagged release rather than whatever is on `main` once you have customers: `git tag v0.1.0 && git push --tags` from your laptop, then `git checkout v0.1.0` on the server.

## 16. Keep it healthy

- **Uptime:** add an uptime check on `https://aeocorner.com/healthz` (DigitalOcean Monitoring or a free external one), and alerts for CPU and memory above 70%.
- **Backups:** the Droplet backup is on; the managed database backs up daily. The restore has never been tried: do the drill in [RUNBOOK_RESTORE_DRILL.md](RUNBOOK_RESTORE_DRILL.md) before you rely on it.
- **Logs:** `pm2 logs`. Set `SENTRY_DSN` for error reports and `ALERT_WEBHOOK_URL` for alerts to a channel.
- **Spend:** keep a cap on every provider account, and watch `/spend` in the staff console.
- **When to grow:** when CPU or memory stays above 70% or audits queue up, move the worker to its own Droplet (a second Droplet running only `aeo-worker`, with the same `.env`).
- **Security updates:** `unattended-upgrades` installs them. Reboot when `/var/run/reboot-required` exists.

## 17. If something goes wrong

| Symptom | Likely cause | What to do |
|---|---|---|
| `pm2 status` shows `errored` or restarts in a loop | missing or wrong `.env` value | `pm2 logs aeo-web --lines 50` names it |
| "bKash’s live address is only allowed in the production environment" | `APP_ENV` is not `production` | set it and reload |
| 521 or 522 from Cloudflare | Nginx or the app is down, or the firewall blocks Cloudflare | `sudo systemctl status nginx`, `pm2 status`, check the firewall rule |
| 502 from Nginx | the web app is not listening on port 3000 | `pm2 logs aeo-web` |
| Audit progress page keeps reloading | Nginx is buffering the events block | keep the `/audit/<id>/events` block from the shipped config |
| Worker log mentions the eviction policy | Redis is not on `noeviction` | change it in the Redis settings |
| Scans say "couldn't check" for rendering | Chromium missing | repeat step 7 |
| Customers cannot sign in | Clerk keys or webhook wrong | [RUNBOOK_CLERK.md](RUNBOOK_CLERK.md) |


-----BEGIN CERTIFICATE-----
MIIEpjCCA46gAwIBAgIUPvSr4OfM/eqb70oHg5EwxbhDkgQwDQYJKoZIhvcNAQEL
BQAwgYsxCzAJBgNVBAYTAlVTMRkwFwYDVQQKExBDbG91ZEZsYXJlLCBJbmMuMTQw
MgYDVQQLEytDbG91ZEZsYXJlIE9yaWdpbiBTU0wgQ2VydGlmaWNhdGUgQXV0aG9y
aXR5MRYwFAYDVQQHEw1TYW4gRnJhbmNpc2NvMRMwEQYDVQQIEwpDYWxpZm9ybmlh
MB4XDTI2MTAwOTA5MTcwMFoXDTQxMTAwNTA5MTcwMFowYjEZMBcGA1UEChMQQ2xv
dWRGbGFyZSwgSW5jLjEdMBsGA1UECxMUQ2xvdWRGbGFyZSBPcmlnaW4gQ0ExJjAk
BgNVBAMTHUNsb3VkRmxhcmUgT3JpZ2luIENlcnRpZmljYXRlMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAppzQCshHEr9fXIiu/q402zUwCQ0DtjtL0vpB
fjbCqJIE8RwEI+o8qxc6EsSbkBItQn8KtQZMJSv2N/pQkTVKA1JZoQOO24q7a0qc
Q98SKJmCRfZ1WMus6UFa2c1U2+/ZYSlOFqMukvdV0MZ5itI8Of8vX8FXMNT6rHdm
ehJ4mgWw4sTup/UKQ26hkMXARjBLcR4ICMIVJab3pF5oWum+cr7PEv83uSdKGIAy
N71AHOc6Up/LFacuhc+dO3vSZyKTmYl+oQzXaQQdlZhcu0hscaW4aaM1j1TL6Pc6
eturzIbJe19++2ja6h7IhzZDCGoVhF4D2MyNYVnlzCQwxUgRUQIDAQABo4IBKDCC
ASQwDgYDVR0PAQH/BAQDAgWgMB0GA1UdJQQWMBQGCCsGAQUFBwMCBggrBgEFBQcD
ATAMBgNVHRMBAf8EAjAAMB0GA1UdDgQWBBRYhvfnBCC2tkuxp4tKqhTbT34JizAf
BgNVHSMEGDAWgBQk6FNXXXw0QIep65TbuuEWePwppDBABggrBgEFBQcBAQQ0MDIw
MAYIKwYBBQUHMAGGJGh0dHA6Ly9vY3NwLmNsb3VkZmxhcmUuY29tL29yaWdpbl9j
YTApBgNVHREEIjAggg8qLmFlb2Nvcm5lci5jb22CDWFlb2Nvcm5lci5jb20wOAYD
VR0fBDEwLzAtoCugKYYnaHR0cDovL2NybC5jbG91ZGZsYXJlLmNvbS9vcmlnaW5f
Y2EuY3JsMA0GCSqGSIb3DQEBCwUAA4IBAQCg3FYkMW9Qrkq32L+hzwijRv4UUQDB
KMq2jhMwKZ3mF4ZLP6Fqrp1j7+NEhMAVwRLp+3DIiuDd+KNs6BlfiPxJODVYkqo8
wuTYnn3ujsPwuYaamIWl0x26hSqEOWJJLsV4CXudcJzanW2lhXRU1djxI/bnrfwD
Nx0pD+l66gaZun00Sw26WjFSGJB2E1rTIloon/X37nejj7wji6j5Mlh+XaCwb/R0
HVFMjqOfYT93CCiuTEqnAilQq7aZXOAfIcRPURqiaH4huO7dAnwcydL64P0uUemf
dbRsiekLDJo2ekvITf8EEjrwkNIlCtBNLy1ZKWxUh/zoZbiZb0C7LO4Q
-----END CERTIFICATE-----


Private key

-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQCmnNAKyEcSv19c
iK7+rjTbNTAJDQO2O0vS+kF+NsKokgTxHAQj6jyrFzoSxJuQEi1Cfwq1BkwlK/Y3
+lCRNUoDUlmhA47birtrSpxD3xIomYJF9nVYy6zpQVrZzVTb79lhKU4Woy6S91XQ
xnmK0jw5/y9fwVcw1Pqsd2Z6EniaBbDixO6n9QpDbqGQxcBGMEtxHggIwhUlpvek
Xmha6b5yvs8S/ze5J0oYgDI3vUAc5zpSn8sVpy6Fz507e9JnIpOZiX6hDNdpBB2V
mFy7SGxxpbhpozWPVMvo9zp626vMhsl7X377aNrqHsiHNkMIahWEXgPYzI1hWeXM
JDDFSBFRAgMBAAECggEABrYqa0TGGCs9XCzlX70ExA/Qb4zmqWCaHVWXbc4m6UN4
j33hbNDywLGe1UK2QYd560PS2pf2WUj8EiUzOaY75QZcNfA+wPlFs3y97r39rUUB
ym+zKnCJ9pt7XWq4EGQJDbDsRF0ucx0jh9V27/CoHG37KpBPQthRgMEOj7xOv2WK
pIf+cNOaVMB3N2iua+WbSr+S5RhoO7rFpVa55lB8TLnyf9zpJHr0fDzKHCNnR7Rf
++aJw71/ClsrxGbi51Y4d48zKk7ZumonS28bmh2qXy4xf6oRBEjEmNgZDLmhdMMx
RsqCftqoUQ0A+gAOEFjGF08MIw5Wr3LTe0meiujgAQKBgQDVrs7rUhMX4Hwxxsuq
5lylff16YwBvRuVgJzNODsHndZw51cLP8eM43DeKObBiR2TVTphinBZLL5pqt2fw
wZ7BJbVMRVOHt1c++7jW09JbDNresEuUOwy0YPi2TcCfGg2Obt6d781zCkk8AsLM
8SEhY7H3UEvbBb3jUXYPE9aFMQKBgQDHm6gmKj30reyfH1H0WTrnFDTzmD+UZv+E
3CmgA8dkcnHJChfY53NLfuAW1fO1+BBjcACnFx3OZ9X2DFqK7xpWi+jgwe2r4vKF
n3VWdtp7M91nHp7vEJ4dlLoQ5XneTrnPBrS65qWSLnIOKlz1RrgJ10CpCEM+NXNi
2ye/gi3GIQKBgQCqMBlDmVH1sWiZKJEsI19ku4z4PgOpnRixVWdqYxyS4bw04AjS
IABuWA6wO7Q9AknQDlIWL+UdquNc3YieW0e64/KatZiKvj5xvoEAMSMYO4vS0yzO
+ZzryVQtto2U6mYjrDAIMGc8mdOsRTKrkd1mP4YNyNkxr0gG1emmppEz8QKBgQCP
WOjL58AwrIrmx15axY34j1lrquXWFJXh+x5ljPEv4MR4ZSg1HBp/mDEkFSh9gRV7
496EIKTGK2nL1plbd1UJ3FY0uvCNZWFXtulUW+yRV/DjcmkfNGboxXtOUQ5RKWZl
F+LI6oTzUymTpLa3ar8WSiBkg8uOrGIeF1cXQEzRIQKBgQDMGjh1V23AMI/l5eZk
1ovKBjbOGlfMeqWjaSsNiHC6+2D/lMeJFck4x7xFK3x3Rki5xJRbFEso50D90G7f
bL9hzbUFzVwZRsYMbZnj6S07jKTp3gkqd3eL+PxPsTYB/xajq/OwheLfFNzmPEJR
5giiFaDALmbwHt4EZxyx4LGJTw==
-----END PRIVATE KEY-----
