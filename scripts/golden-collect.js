#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectTaskSchema, PENDING } from '../src/engines/contract.js';
import { createAdapters } from '../src/engines/index.js';
import { loadConfig } from '../src/lib/config.js';

/**
 * Collect real AI answers for the extraction golden set (BUILD_PLAN Phase 6, ADR-0007):
 *
 *   npm run golden:collect -- [--engines perplexity,google_aio,chatgpt,gemini] [--budget 3] [--concurrency 3] [--dry-run]
 *
 * Asks every question of every project in evals/extraction/projects.json, once per engine, through the real
 * providers, and appends each answer to evals/extraction/answers.jsonl in the normalized shape the pipeline reads
 * (src/engines/contract.js). Safe to run again: an answer already in the file is not asked for twice. Stops before
 * spending more than --budget dollars (default $3) in one run.
 *
 * COSTS MONEY (about $0.004 to $0.02 per answer). Needs the providers' credentials in .env; no database or Redis.
 */

const args = process.argv.slice(2);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const ENGINES = (valueOf('--engines') ?? 'perplexity,google_aio,chatgpt,gemini').split(',');
const BUDGET_MICROS = Math.round(Number(valueOf('--budget') ?? 3) * 1e6);
const DRY_RUN = args.includes('--dry-run');
const CONCURRENCY = Number(valueOf('--concurrency') ?? 3);

const PRIMARY = {
  chatgpt: 'dataforseo',
  gemini: 'dataforseo',
  perplexity: 'perplexity_api',
  google_aio: 'serpapi',
};
const DIR = new URL('../evals/extraction/', import.meta.url);
const OUT = new URL('answers.jsonl', DIR);

const { projects } = JSON.parse(await readFile(new URL('projects.json', DIR), 'utf8'));
const have = new Set(
  (await readFile(OUT, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).id),
);

const config = loadConfig();
const adapters = createAdapters(config.providers);
const work = [];
for (const project of projects) {
  project.questions.forEach((q, i) => {
    for (const engine of ENGINES) {
      const id = `${project.key}-q${i + 1}-${engine}`;
      if (!have.has(id)) work.push({ id, project, question: q, engine });
    }
  });
}
const missing = ENGINES.filter((e) => !adapters.get(PRIMARY[e], e));
if (missing.length) {
  console.error(
    `No credentials for: ${missing.join(', ')}. Set them in .env or leave those engines out.`,
  );
  process.exit(1);
}
console.log(
  `${have.size} answers already collected; ${work.length} to ask. Budget $${BUDGET_MICROS / 1e6}.`,
);
if (DRY_RUN) process.exit(0);

let spent = 0;
let stopped = false;
const tally = { ok: 0, no_answer: 0, failed: 0 };

async function ask({ id, project, question, engine }) {
  const adapter = adapters.get(PRIMARY[engine], engine);
  const task = collectTaskSchema.parse({
    ref: id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64),
    engine,
    text: question.text,
    searchQuery: question.search,
    country: 'US',
    language: 'en',
    // DataForSEO's live queue answers in about a minute; the cheaper standard queue can take 45.
    mode: PRIMARY[engine] === 'dataforseo' ? 'live' : 'standard',
  });
  if (spent + adapter.estimateCostMicros(task) > BUDGET_MICROS) {
    stopped = true;
    return;
  }
  const started = Date.now();
  try {
    const handle = await adapter.submit(task);
    spent += handle.costMicros ?? adapter.estimateCostMicros(task);
    let raw = handle.raw ?? (await adapter.poll(handle));
    while (raw === PENDING) {
      if (Date.now() - started > 10 * 60_000) throw new Error('not ready after 10 minutes');
      await sleep(10_000);
      raw = await adapter.poll(handle);
    }
    const answer = adapter.normalize(raw, task);
    tally[answer.status] += 1;
    const row = {
      id,
      project: project.key,
      engine,
      provider: adapter.provider,
      method: adapter.method,
      question: engine === 'google_aio' ? question.search : question.text,
      collectedAt: new Date().toISOString(),
      status: answer.status,
      modelVersion: answer.modelVersion,
      costUsd: (handle.costMicros ?? 0) / 1e6,
      text: answer.text,
      sources: answer.sources.map(({ url, domain, title, position }) => ({
        url,
        domain,
        title,
        position,
      })),
    };
    await appendFile(OUT, `${JSON.stringify(row)}\n`);
    console.log(
      `${id}: ${answer.status}, ${answer.text.length} chars, ${answer.sources.length} sources (${((Date.now() - started) / 1000).toFixed(1)} s)`,
    );
  } catch (err) {
    tally.failed += 1;
    console.log(`${id}: FAILED ${err.status ?? ''} ${err.message}`);
  }
}

const queue = [...work];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !stopped) await ask(queue.shift());
  }),
);
console.log(
  `\nDone: ${tally.ok} answers, ${tally.no_answer} no answer, ${tally.failed} failed. Spent about $${(spent / 1e6).toFixed(4)}.` +
    (stopped ? ' Stopped at the budget; run again to continue.' : ''),
);
