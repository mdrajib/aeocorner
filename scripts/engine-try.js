#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectTaskSchema, PENDING } from '../src/engines/contract.js';
import { createAdapters } from '../src/engines/index.js';
import { loadConfig } from '../src/lib/config.js';

/**
 * Ask one AI engine one question through its real provider, and show what came back:
 *
 *   npm run engines:try -- --engine perplexity "best dental software for a small clinic"
 *   npm run engines:try -- --engine chatgpt --mode live --record "best dental software for a small clinic"
 *   npm run engines:try -- --engine google_aio --query "best dental software" "best dental software for a small clinic"
 *
 * This is the Phase 5 spike check (one real call per provider, a person looks at the raw answer) and the way to
 * record new contract-test fixtures (--record writes the provider's raw response to tests/fixtures/engines/recorded/).
 * It needs the provider's credentials in .env, and it COSTS MONEY: a fraction of a cent per question. It needs no
 * database or Redis, and writes nothing to the ledger.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const VALUE_FLAGS = ['--engine', '--mode', '--country', '--language', '--query'];
const question = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));
const engine = valueOf('--engine');

if (!question || !engine || flag('--help')) {
  console.log(
    'Usage: npm run engines:try -- --engine <chatgpt|gemini|perplexity|google_aio> [--mode standard|priority|live]\n' +
      '         [--country US] [--language en] [--query "keyword form"] [--record] "<question>"',
  );
  process.exit(flag('--help') ? 0 : 1);
}

const PRIMARY = {
  chatgpt: 'dataforseo',
  gemini: 'dataforseo',
  perplexity: 'perplexity_api',
  google_aio: 'serpapi',
};

const config = loadConfig();
const adapters = createAdapters(config.providers);
const adapter = adapters.get(PRIMARY[engine], engine);
if (!adapter) {
  console.error(`No credentials for ${PRIMARY[engine] ?? engine} in .env, or an unknown engine.`);
  process.exit(1);
}

const task = collectTaskSchema.parse({
  ref: `try-${Date.now()}`,
  engine,
  text: question,
  searchQuery: valueOf('--query'),
  country: (valueOf('--country') ?? 'US').toUpperCase(),
  language: valueOf('--language') ?? 'en',
  mode: valueOf('--mode') ?? 'standard',
});

console.log(
  `Asking ${engine} via ${adapter.provider} (${task.mode}); estimated cost $${adapter.estimateCostUsd(task)}`,
);
const started = Date.now();
const handle = await adapter.submit(task);
let raw = await adapter.poll(handle);
// DataForSEO's queue: ask every 30 seconds, for up to 50 minutes (its promise is 45).
while (raw === PENDING) {
  if (Date.now() - started > 50 * 60_000) {
    console.error(`Still not ready after 50 minutes. Task ID: ${handle.providerRef}`);
    process.exit(1);
  }
  process.stdout.write('.');
  await sleep(30_000);
  raw = await adapter.poll(handle);
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const answer = adapter.normalize(raw, task);

console.log(`\nStatus:   ${answer.status} after ${seconds} s`);
console.log(`Model:    ${answer.modelVersion ?? '(not given)'}`);
console.log(
  `Charged:  $${(handle.costMicros / 1e6).toFixed(6)} (provider ref ${answer.providerRef})`,
);
console.log(`Sources:  ${answer.sources.length}`);
for (const s of answer.sources.slice(0, 15)) console.log(`  ${s.position}. ${s.domain}  ${s.url}`);
console.log(`\n${answer.text}\n`);

if (flag('--record')) {
  // Our credentials should never be in a response, but check before anything is written into the repository.
  let text = JSON.stringify(raw, null, 2);
  const secrets = Object.values(config.providers ?? {})
    .filter(Boolean)
    .flatMap((p) => [p.password, p.apiKey])
    .filter((s) => typeof s === 'string' && s.length >= 6);
  for (const secret of secrets) text = text.split(secret).join('<redacted>');
  const dir = new URL('../tests/fixtures/engines/recorded/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const name = `${adapter.provider}-${engine}-${task.mode}-${new Date().toISOString().slice(0, 10)}.json`;
  await writeFile(new URL(name, dir), `${text}\n`);
  console.log(`Recorded the raw response to tests/fixtures/engines/recorded/${name}`);
}
