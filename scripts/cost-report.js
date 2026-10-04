#!/usr/bin/env node
import 'dotenv/config';
import { createDb } from '../src/db/index.js';
import { TARGETS, auditCost, describe, promptRunCost } from '../src/core/unit-cost.js';

/**
 * Cost per prompt-run and per free audit over a window, from the usage ledger, against the launch targets
 * (MVP §13.3: ≤ $0.12 and ≤ $0.75). Read-only. Run it on staging after a load test, and on production weekly.
 *
 *   npm run cost:report -- --since 2026-10-05T09:00:00Z [--until 2026-10-05T12:00:00Z] [--json]
 *
 * `--since` is required: a window you did not choose is a number you can't explain. It reads DATABASE_URL.
 */

const args = process.argv.slice(2);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const since = valueOf('--since');
const until = valueOf('--until');

if (!since || args.includes('--help')) {
  console.log('Usage: npm run cost:report -- --since <ISO time> [--until <ISO time>] [--json]');
  process.exit(args.includes('--help') ? 0 : 1);
}

const from = new Date(since);
const to = until ? new Date(until) : new Date();
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
  console.error('The window is not valid: --since must be an ISO time before --until.');
  process.exit(1);
}

const db = createDb({ databaseUrl: process.env.DATABASE_URL });
try {
  const unit = await db.system.costs.unitCosts({ from, to });
  const prompt = promptRunCost(unit.meters, unit.promptRuns);
  const audit = auditCost({
    audits: unit.audits.count,
    costMicros: unit.audits.costMicros,
    worstMicros: unit.audits.worstMicros,
  });
  const report = {
    from: from.toISOString(),
    to: to.toISOString(),
    targets: TARGETS,
    prompt,
    audit,
  };
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Window ${report.from} to ${report.to}`);
    console.log(describe('prompt-run', prompt));
    console.log(describe('audit', audit));
    if (prompt.otherMicros > 0) {
      console.log(
        `Not counted in a prompt-run: $${(prompt.otherMicros / 1_000_000).toFixed(4)} of content, Brand Kit, narrative and other spend.`,
      );
    }
  }
  process.exitCode = [prompt.verdict, audit.verdict].includes('missed') ? 2 : 0;
} finally {
  await db.close();
}
