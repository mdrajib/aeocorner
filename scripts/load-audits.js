#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createDb } from '../src/db/index.js';
import { createJobClient } from '../src/lib/jobs.js';
import { loadConfig } from '../src/lib/config.js';
import { closeQueues, createQueues } from '../src/lib/queues.js';
import { closeRedis, createRedis } from '../src/lib/redis.js';
import { TARGETS, auditCost, describe } from '../src/core/unit-cost.js';

/**
 * The backend half of the staging load test (Milestone 10, task 10.05): start N real free audits at once, bypassing the
 * form (the Turnstile check and the per-address limits are for visitors, not for us), let the worker run them for real
 * (real providers, so it costs real money: about $0.75 each at the target), and report how long they took, how many
 * finished, and what each cost.
 *
 *   npm run load:audits -- --domains load-domains.txt --count 20
 *
 * It refuses to run unless APP_ENV is `staging`: it would spend production's provider budget and fill production with
 * fake leads. `--domains` is a file with one domain per line; each audit needs its OWN domain, or the 24-hour cache
 * serves the repeats for free and measures nothing. Use real small sites you are allowed to scan. The "reports ready"
 * emails go to Resend's test address (`delivered+<n>@resend.dev`), so no real inbox is touched.
 *
 * What it prints is the shape of the run; the verdict against the cost target comes from `npm run cost:report` over the
 * same window, which reads the ledger the worker wrote.
 */

const args = process.argv.slice(2);
const valueOf = (name, fallback = null) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;

const config = loadConfig();
if (config.appEnv !== 'staging') {
  console.error(`Refusing to run: APP_ENV is "${config.appEnv}", not "staging".`);
  process.exit(1);
}
const file = valueOf('--domains');
if (!file || args.includes('--help')) {
  console.log('Usage: npm run load:audits -- --domains <file> [--count 20] [--timeout-min 30]');
  process.exit(args.includes('--help') ? 0 : 1);
}
const domains = [
  ...new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#')),
  ),
];
const count = Number(valueOf('--count', domains.length));
const timeoutMs = Number(valueOf('--timeout-min', 30)) * 60_000;
if (!(count > 0) || domains.length < count) {
  console.error(`Need ${count} different domains in ${file}; it has ${domains.length}.`);
  process.exit(1);
}
if (!config.redis?.url) {
  console.error('Set REDIS_URL: the audits are queued for the staging worker.');
  process.exit(1);
}

const db = createDb({ databaseUrl: process.env.DATABASE_URL });
const redis = createRedis(config.redis.url, { role: 'producer', name: 'aeo-corner-load' });
const queues = createQueues({ connection: redis, prefix: config.redis.prefix });
const jobs = createJobClient(queues);

const startedAt = new Date();
const audits = [];
try {
  for (let i = 0; i < count; i += 1) {
    const lead = await db.leads.capture({ email: `delivered+load${Date.now()}x${i}@resend.dev` });
    const audit = await db.audits.create({
      inputUrl: `https://${domains[i]}`,
      domain: domains[i],
      leadId: lead.id,
    });
    await db.audits.verify(audit.id, { leadId: lead.id });
    audits.push(audit);
  }
  // All at once: that is what a burst looks like to the worker.
  await Promise.all(
    audits.map((a) => jobs.add('audit.run', { auditId: String(a.id) }, { jobId: `audit-${a.id}` })),
  );
  console.log(
    `Queued ${audits.length} audits at ${startedAt.toISOString()}. Waiting (up to ${timeoutMs / 60_000} min)…`,
  );

  const done = new Map();
  const deadline = Date.now() + timeoutMs;
  while (done.size < audits.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    for (const a of audits) {
      if (done.has(a.id)) continue;
      const fresh = await db.audits.get(a.id);
      if (['complete', 'partial', 'failed', 'blocked'].includes(fresh.status))
        done.set(a.id, fresh);
    }
    process.stdout.write(`\r${done.size}/${audits.length} finished`);
  }
  process.stdout.write('\n');

  const rows = [];
  for (const a of audits) {
    const fresh = done.get(a.id);
    const cost = await db.audits.ledger.costMicros(a.id);
    rows.push({
      status: fresh?.status ?? 'unfinished',
      seconds: fresh?.finished_at ? (fresh.finished_at - startedAt) / 1000 : null,
      costMicros: Number(cost),
    });
  }
  const finished = rows
    .filter((r) => r.seconds !== null)
    .map((r) => r.seconds)
    .sort((x, y) => x - y);
  const pick = (p) =>
    finished.length
      ? finished[Math.min(finished.length - 1, Math.floor(p * finished.length))]
      : null;
  const byStatus = rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  console.log('Outcome:', byStatus);
  console.log(
    `Time to finish: p50 ${pick(0.5)} s, p95 ${pick(0.95)} s, slowest ${finished.at(-1) ?? '—'} s`,
  );
  const cost = auditCost({
    audits: rows.length,
    costMicros: rows.reduce((s, r) => s + r.costMicros, 0),
    worstMicros: Math.max(...rows.map((r) => r.costMicros)),
  });
  console.log(describe('audit', cost));
  console.log(
    `Window for the cost report: --since ${startedAt.toISOString()}  (target ${TARGETS.auditMicros / 1_000_000} USD)`,
  );
  process.exitCode = rows.some((r) => r.status === 'unfinished' || r.status === 'failed') ? 2 : 0;
} finally {
  await closeQueues(queues);
  await closeRedis(redis);
  await db.close();
}
