#!/usr/bin/env node
import { loadConfig } from '../src/lib/config.js';
import { createClaude } from '../src/llm/claude.js';
import { costMicros, modelProfile } from '../src/llm/models.js';
import { buildNarrativeRequest, readNarrativeReply } from '../src/llm/narrative.js';
import { CORPUS } from '../evals/narrative/corpus.js';
import { evaluateBadNarratives, evaluateTemplates, materials } from '../evals/narrative/run.js';

/**
 * The narrative eval (Milestone 6, task 6.04): does any narrative state a fact its evidence does not support?
 *
 *   npm run eval:narrative                 free, no key: the template narratives over the whole corpus, and the check
 *                                          itself over narratives that make things up
 *   npm run eval:narrative -- --live       also asks Claude (COSTS MONEY, about a cent a case on Haiku) to write each
 *                                          case's narrative, and counts how many pass the evidence check
 *            [--model haiku45|opus55] [--limit N]
 *
 * Exit code 1 when a template narrative states an unsupported fact, when the check misses a made-up one, or (live)
 * when fewer than 90% of Claude's replies pass. A reply that fails is never shown to a customer: the template stays.
 * The 90% line is for tuning the prompt, not for safety.
 */

const args = process.argv.slice(2);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const LIVE = args.includes('--live');
const LIMIT = Number(valueOf('--limit') ?? Infinity);
const PASS_LINE = 0.9;

let failed = false;

const templates = evaluateTemplates();
console.log(
  `Template narratives: ${templates.cases} cases, ${templates.failures.length} with unsupported facts`,
);
for (const f of templates.failures) console.log(`  ✖ ${f.name}: ${JSON.stringify(f.problems)}`);
if (templates.failures.length) failed = true;

const bad = evaluateBadNarratives();
console.log(`Made-up narratives: ${bad.cases} cases, ${bad.missed.length} not flagged`);
for (const m of bad.missed) console.log(`  ✖ ${m.name}: missed ${JSON.stringify(m.lacking)}`);
if (bad.missed.length) failed = true;

if (LIVE) {
  const config = loadConfig();
  if (!config.anthropic) {
    console.error('--live needs ANTHROPIC_API_KEY.');
    process.exit(2);
  }
  const profile = modelProfile(valueOf('--model') ?? 'haiku45');
  const claude = createClaude({ apiKey: config.anthropic.apiKey });
  const tally = { ok: 0, unsupported: 0, other: 0 };
  let micros = 0;
  for (const c of CORPUS.slice(0, LIMIT)) {
    const { words, facts, advice } = materials(c);
    const message = await claude.extract(
      buildNarrativeRequest({ profile, title: c.name, facts, advice, brandName: c.brandName }),
    );
    micros += costMicros(profile, message.usage ?? {});
    const read = readNarrativeReply(message, { facts, advice, ...words });
    if (read.ok) tally.ok += 1;
    else if (read.reason === 'unsupported') {
      tally.unsupported += 1;
      console.log(`  ✖ ${c.name}: ${JSON.stringify(read.detail.slice(0, 4))}`);
    } else {
      tally.other += 1;
      console.log(`  ✖ ${c.name}: ${read.reason}`);
    }
  }
  const total = tally.ok + tally.unsupported + tally.other;
  const share = total === 0 ? 0 : tally.ok / total;
  console.log(
    `${profile.id}: ${tally.ok} of ${total} replies pass (${Math.round(share * 100)}%), ${tally.unsupported} claimed more than the evidence, ${tally.other} unusable. Cost ≈ $${(micros / 1e6).toFixed(3)}`,
  );
  if (share < PASS_LINE) failed = true;
}

process.exit(failed ? 1 : 0);
