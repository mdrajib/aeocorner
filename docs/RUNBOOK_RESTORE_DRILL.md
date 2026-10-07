# AEO Corner — Database restore drill

| | |
|---|---|
| **Document** | How to prove, on a throwaway copy, that the managed database can be restored and that the copy is whole: the steps, what to record, what counts as a pass, and what to do in a real loss |
| **Date** | 2026-10-07 |
| **Status** | Written. **Never run on a real cluster:** the first drill is the test of this document, so fix any step that turns out wrong, here, in the same pass. The checker it uses (`npm run restore:check`) is tested against the local test database, not yet against a DigitalOcean restore |
| **Companion docs** | [RUNBOOK_INCIDENTS.md](RUNBOOK_INCIDENTS.md) §5.7 (data lost or damaged) and §6 (telling customers) · [RUNBOOK_PROVISIONING.md](RUNBOOK_PROVISIONING.md) §3 (the cluster) and §12 · [ADMIN_OPERATIONS.md](ADMIN_OPERATIONS.md) §5 (the monthly task) · [MVP.md](MVP.md) §10 (RPO and RTO targets) · [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) §8 (what is kept and purged) · [`docs/db/checks.sql`](db/checks.sql) |

## 1. What the drill proves

A backup you have never restored is a hope. This drill answers four questions, once before launch and then every month (ADMIN_OPERATIONS §5):

| Question | How it is answered | Pass |
|---|---|---|
| Can we get a working database back at all? | Restore to a **new** cluster and connect to it | The cluster comes online and accepts a connection |
| Is it the same database? | `npm run restore:check`: every table of the live database is there, every migration of the code is applied or can be, and `docs/db/checks.sql` returns no rows | The script prints `RESULT: the copy passes` and exits 0 |
| How much would we lose? | The script's "newest rows" lines against the restore point you chose | Newest written rows within **15 minutes** of the restore point (the target in MVP §10; DigitalOcean's own promise is any point in the last 7 days, so this is our number to measure, not theirs) |
| How long would it take? | Write down the clock times | Online within **4 hours** of asking, and the whole recovery (§6) within the same four (MVP §10's target). Both are targets, not measurements yet |

A drill that fails is a good drill: it found the problem on a Wednesday afternoon and not during an outage.

## 2. What DigitalOcean says (checked 2026-10-07)

| Fact | Source |
|---|---|
| A full backup of a MySQL cluster is taken once a day and kept **7 days**; write-ahead logs let you restore to **any point in the previous 7 days**. Backups cause no downtime and the time of day is not configurable | [Restore MySQL clusters from backups](https://docs.digitalocean.com/products/databases/mysql/how-to/restore-from-backups/) |
| **A restore never goes into the existing cluster.** It makes a new cluster (a new primary node) so there is one linear history. In the control panel: the cluster → **Actions** → **Restore from backup** → choose the latest transaction or a point in time → name it → **Restore to New Cluster** | the same page |
| A **fork** is the same idea with options: a new cluster from the latest transaction or any point in the last 7 days; `doctl databases fork <new-name> --restore-from-cluster-id <id> --restore-from-timestamp "<time>"`. A fork takes longer than creating an empty cluster because the data is copied. Billing is hourly and stops when the new cluster is destroyed | [Fork a MySQL cluster](https://docs.digitalocean.com/products/databases/mysql/how-to/fork-clusters/) |
| A fork copies all databases and users, including `doadmin` and `defaultdb` | the fork page |
| **Destroying a cluster destroys its backups.** Never destroy the source cluster as part of a drill | the restore page |
| After a restore you can add standby and read-only nodes | the restore page |

**What the pages do not say, so do not assume it:** whether the new cluster keeps the source's **trusted sources**, its **VPC**, its **connection pools**, or the same hostname. Treat all of it as new: set the trusted sources yourself (§4, step 3) and read the connection details off the new cluster. The cluster holds **both** databases (`aeo_corner_staging` and `aeo_corner`, RUNBOOK_PROVISIONING §3), so the copy has both: the drill looks only at `aeo_corner`, and the copy is just as sensitive as production. Our application users (`aeo_prod`, `aeo_staging`) should come with the users the fork copies, but check them (§4, step 4); the restore page does not mention users at all.

If a fact above stops being true, change this table and the date.

## 3. Rules for the drill

1. **Never restore over, or point anything live at, the production cluster.** The drill makes a copy and looks at it.
2. **Never run the web app or the worker against the copy.** They send email, call paid providers, charge cards and write. The checker below only reads; that is all a drill needs. (The one full rehearsal of switching over is on **staging, with staging's own data**, §6.)
3. **The copy holds real customer data.** Treat it as production: trusted sources limited to the one machine you work from (not the Droplets), nothing copied out of it, the connection string kept in your shell and never in a file, a chat or a document, and the cluster destroyed the same day.
4. **Do not destroy the source cluster.** That deletes its backups too.
5. Write the result down (§5) before you destroy the copy.

## 4. The drill

Allow about an hour, most of it waiting. You need: the DigitalOcean control panel (or `doctl`), a machine with this repository and `npm install` done, and its public IP address.

| # | Do | Check | Record |
|---|---|---|---|
| 1 | Decide the **restore point**. Do the drill twice over the first few runs: once at *the latest transaction*, once at *a point two hours ago*. Write the restore point down as a UTC time. For "latest transaction" the point is the time you press the button | The point is inside the last 7 days | T0 (when you asked) and the restore point |
| 2 | Control panel: **Databases** → the production cluster → **Actions** → **Restore from backup** → choose the point → name it `aeo-drill-yyyymmdd` → **Restore to New Cluster**. (Or `doctl databases fork aeo-drill-yyyymmdd --restore-from-cluster-id <id> --restore-from-timestamp "<UTC time>"`.) | The new cluster appears in the list and reaches **Online** | Minutes from T0 to Online |
| 3 | On the **new** cluster: **Settings** → **Trusted sources**. Remove anything it carried over and add **only your own IP address**. Note what it had carried over: that answers the open question in §2 | Only your address is listed | What was carried over: trusted sources, VPC, pools |
| 4 | **Overview** → **Connection details**: pick the `aeo_corner` database (production's, not `aeo_corner_staging`) and the `doadmin` user, download the **CA certificate** to a scratch folder outside the repository. In your shell: `export RESTORE_DATABASE_URL='mysql://…?ssl-mode=REQUIRED'` (paste the connection string; do not put it in `.env`). Check that the production application user and its grants are there with `SHOW GRANTS FOR 'aeo_prod'` | You can connect, and the application user exists | Whether the application user came across |
| 5 | Run the checker (below) | `RESULT: the copy passes`, exit code 0 | The output, saved |
| 6 | Read every `warn` line and the table list. `behind` is normal (an earlier moment). `ahead` is normal only for the tables a purge or retention sweep deletes from (`audit_answers`, `leads`, `webhook_events`, `org_activity_log`, a closed organization's rows). An `empty` table is normal only if it was first written after the restore point | Every warning has an explanation, written down | The explanations |
| 7 | If the checker says migrations are **not applied**, the copy is older than the code. On the **copy only**, run `DATABASE_URL="$RESTORE_DATABASE_URL" npx prisma migrate deploy` and run the checker again. This writes to the copy and nowhere else; read the command twice | The second run has no migration warning | What was applied |
| 8 | Spot-check one real organization by hand against the staff console (read only): its project count, question count and the status and time of its latest run, from SQL on the copy and from the console on the live system | They match, allowing for the minutes between the restore point and now | The organization's ID and the counts |
| 9 | **Destroy the copy:** the copy's **Settings** → **Destroy**. Confirm the name is `aeo-drill-…` and not the production cluster, then check **Billing** shows it gone | Only the production cluster is left | Time destroyed |
| 10 | Fill in the log (§5) and fix this document wherever a step was wrong | A row in the log | n/a |

The checker (step 5), from the repository:

```bash
npm run restore:check -- --restored "$RESTORE_DATABASE_URL" --live --restore-point 2026-10-07T09:30:00Z --ca /path/to/ca-certificate.crt
```

`--live` compares with `DATABASE_URL`, so run it where that points at production (on the production Droplet, or with the variable set for the one command). It is read only on both databases: the session is switched to read-only before anything is asked. It refuses to treat `DATABASE_URL` as the copy. Without `--live` it still judges the copy's structure, migrations and guard rails, just not row counts. Counts are exact, so expect it to take longer on the largest tables.

## 5. The log

Add one row per drill. The first real one replaces the targets in §1 with numbers.

| Date | Who | Restore point | Minutes to Online | Newest-row gap (s) | Checker result | Warnings explained | Fixes made to this document |
|---|---|---|---|---|---|---|---|
| *(none yet)* | | | | | | | |

## 6. In a real loss

The drill is the dress rehearsal for this. Use [RUNBOOK_INCIDENTS §5.7](RUNBOOK_INCIDENTS.md) and §6 for who to tell. The order matters:

| # | Do | Why |
|---|---|---|
| 1 | **Stop the damage first.** Set `MAINTENANCE_MODE=true` in `.env` and `pm2 reload aeo-web`; `pm2 stop aeo-worker` | A worker still running keeps writing to a database that is about to be replaced, and a half-run job is worse than a stopped one |
| 2 | Work out the **moment just before the damage** (the admin audit log, the Droplet's logs, the deploy time). For a total loss use the latest transaction | The restore point is the only choice that matters |
| 3 | Restore to a **new** cluster at that point (§4 steps 1 and 2) | Never over the old one: it may still hold the evidence, and a second timeline makes everything harder |
| 4 | Trusted sources: add the two Droplets and the VPC to the new cluster. Run the checker with `--restored` set to it | A copy that fails the checker is not switched to |
| 5 | If the checker says migrations are not applied: `npx prisma migrate deploy` against the new cluster | The code and the data must agree before the app starts |
| 6 | Set `DATABASE_URL` (and the CA certificate path) in `.env` on the Droplet to the new cluster, then `pm2 reload aeo-web` with maintenance still on, and `curl -s localhost:3000/healthz` | The health check proves the app can read the database |
| 7 | Start the worker (`pm2 start aeo-worker`), then lift maintenance (`MAINTENANCE_MODE=false`, reload) | Customers come back to a worker that is already running |
| 8 | Catch up what the restore point left out: Stripe and Clerk re-send failed webhooks for days and `billing.reconcile` repairs the rest, so run it; raw answers and pages are in Spaces under content-addressed keys, so extraction can be re-run for any answer that has a stored file but no reading; free audits that were waiting stay `queued`: list and re-queue or fail them (RUNBOOK_INCIDENTS §5.2, point 6) | Redis and Spaces are not part of the database and are not rolled back, so they may be ahead of the restored database |
| 9 | Tell the customers (RUNBOOK_INCIDENTS §6): what the restore point was, what may be missing (anything after it), and that nothing was changed by hand | Say it plainly and early |
| 10 | Keep the old cluster until the cause is understood, then destroy it deliberately (it holds the old backups) | Destroying it destroys the evidence and the backups |

**One full rehearsal of steps 1 to 7 on staging, once, with staging's own data and never production's.** Restore staging's database to a new cluster, point staging at it, and bring it back up. That is the only way to find the step the table above gets wrong. Write the time it took in the log.

## 7. What is not covered

| Gap | Why | When |
|---|---|---|
| The drill has not been run on a real cluster | There was no cluster to run it on | Before launch |
| How long a restore of a full-size database takes | The numbers only exist once there is data | The monthly drills will show it; revisit the 4 hour target when they do |
| Restoring a single organization's rows without replacing the rest | The tools restore a whole cluster. A partial restore means restoring to a copy and copying rows across by hand, which has never been written down or tried | When the first case that needs it appears, as its own runbook section |
| Redis | It holds queues only (RUNBOOK_INCIDENTS §5.2, point 6); the database is the truth | n/a |
