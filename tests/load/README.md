# Load and cost test (Milestone 10, tasks 10.05 and 10.06)

**Not run yet.** It needs the staging server (task 2.09) and a k6 install; neither exists on the development machine. This file is the plan and the pass bar, so that when staging is up the test is a matter of running three commands.

## What "2× target" means

The MVP's 90-day targets ([MVP §14](../../docs/MVP.md)) are 1,000 free audits a month and a few hundred weekly-tracked projects. Averaged over a month that is a trickle; the test is about **bursts**, so the target is defined as the worst realistic hour, and the test runs twice that.

| | Target (worst realistic hour) | **Test at 2×** | Where it bites |
|---|---|---|---|
| Free audits started in one hour (a launch post, a newsletter) | 10 | **20 at once** | The `audit` queue runs 4 at a time ([`src/lib/queues.js`](../../src/lib/queues.js)), so 20 queue up; the question is how long the last waits and whether anything fails |
| Visitors reading the public site | 50 at once | **100 at once** (`PEAK_VUS=100`) | Web process (2 PM2 instances), Nginx, the database for the pricing page |
| Weekly runs due in the same hour | 25 projects | **50 projects** | The `collect` queue (20 at a time), provider rate limits, the spend caps |

Change the numbers here if the founder revises the target; the scripts take them as arguments.

## The three commands (on staging only)

All three refuse to run against production. The audit driver spends real provider money (about $0.75 an audit at the target: **20 audits ≈ $15**); the web script spends nothing.

```bash
# 1. The public site and audit pages under load (k6: https://k6.io/docs/get-started/installation/)
k6 run -e BASE_URL=https://staging.aeocorner.com -e PEAK_VUS=100 tests/load/web.k6.js

# 2. Twenty real audits at once, with different domains (one per line in the file; real small sites you may scan)
npm run load:audits -- --domains load-domains.txt --count 20

# 3. What it all cost, over the window the previous command printed
npm run cost:report -- --since <the time load:audits printed>
```

For the weekly-run half (50 projects), create the projects on staging with a normal account, press "Start tracking" on each within the same minute (each makes a first run at once), then run `cost:report` over that window too.

## Pass bar

| Check | Pass |
|---|---|
| Web: failed requests | under 1% (k6 threshold `http_req_failed`) |
| Web: speed | p95 under 800 ms and p99 under 2 s for everything; p95 under 600 ms for pages (k6 thresholds) |
| 20 audits at once | every one finishes `complete` or `partial` (none stuck, none `failed` for a reason of ours); the last finishes within 30 minutes; no error alerts other than ones a provider caused |
| Nothing is lost in the burst | the queues drain to zero; the staff console's Failed jobs page is empty of jobs that are not a provider's fault |
| **Cost per audit** | at most **$0.75** on average, and no single audit above it (`cost:report` says `met`) |
| **Cost per prompt-run** | at most **$0.12** (`cost:report` says `met`). See the open point below |
| Resources | Droplet CPU and memory under 85% for the web and worker together at the peak; Chromium never pushes the worker past its 1.5 GB restart line |
| Spend caps hold | covered by an automated test (`tests/integration/collect-job.test.js`, "the daily spend cap holds back real collection"); on staging, set one organization's cap to $0.05 and confirm collection pauses and the owner is told |

## Open point: the prompt-run target is probably missed by design

[MVP §12.1](../../docs/MVP.md) records, from the 2026-10-03 extraction eval, that with Opus 5.5 a prompt-run costs **about $0.16** (collection $0.03 plus extraction $0.13), above the $0.12 target in §13.3. The target and the model choice (D4 in [MVP §17](../../docs/MVP.md)) can't both stand. Haiku 4.5 at about $0.0023 an answer batched would put a prompt-run near $0.05, but did not meet the stance-accuracy target in the eval. This is the founder's decision, and the measured number from step 3 is its input: **either** accept ≈ $0.16 and amend §13.3 (margins in §12.1), **or** switch to Haiku and accept the accuracy it gives, **or** cut extraction output length. The report prints the split so the lever is visible.

## Results

Fill in when run.

| Date | Environment | Web p95 / failures | Audits (done / of) and slowest | $ per audit (worst) | $ per prompt-run | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
