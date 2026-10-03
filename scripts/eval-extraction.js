#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../src/lib/config.js';
import { createClaude } from '../src/llm/claude.js';
import { decideD4, meetsTargets, scoreReadings, TARGETS } from '../src/llm/eval/score.js';
import { PROMPT_VERSION } from '../src/llm/extraction-prompt.js';
import {
  buildExtractionRequest,
  mergeReading,
  readReply,
  trackedEntities,
} from '../src/llm/extraction.js';
import { costMicros, modelProfile } from '../src/llm/models.js';
import { runPrepass } from '../src/llm/prepass.js';

/**
 * The extraction golden-set eval (BUILD_PLAN Phase 6, MVP §10, decision D4):
 *
 *   npm run eval:extraction -- [--models opus55,haiku45] [--batch] [--labels reviewed|all] [--limit N] [--ci]
 *
 * Runs the production pipeline (pre-pass, request, reply check, merge: src/llm) over every labelled answer in
 * evals/extraction/, once per model, and scores it against the labels (src/llm/eval/score.js). Replies are cached
 * per model and prompt version in evals/extraction/.cache/ (git-ignored), so scoring again costs nothing; a new
 * PROMPT_VERSION asks again.
 *
 *   --batch    use the Batch API (half price, usually within the hour) instead of answering each now
 *   --labels   "reviewed" scores only answers a person has checked; "all" (the default) includes Claude's drafts
 *   --ci       one model (EXTRACTION_MODEL), reviewed labels; exits 1 if a target is missed. What CI runs.
 *   --prepass-only   score the deterministic pre-pass alone (mention detection only); free, no Claude, no key
 *
 * COSTS MONEY on a cache miss: about $1 to $4 per model for the whole set (ADR-0007). Needs ANTHROPIC_API_KEY.
 */

const args = process.argv.slice(2);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const CI = args.includes('--ci');
const PREPASS_ONLY = args.includes('--prepass-only');
const config = loadConfig();
const MODEL_KEYS = PREPASS_ONLY
  ? ['opus55']
  : CI
    ? [config.extraction.model]
    : (valueOf('--models') ?? 'opus55,haiku45').split(',');
const LABELS = valueOf('--labels') ?? (CI ? 'reviewed' : 'all');
const LIMIT = Number(valueOf('--limit') ?? Infinity);
const BATCH = args.includes('--batch');
const CONCURRENCY = 4;

const DIR = new URL('../evals/extraction/', import.meta.url);
const readLines = async (name) =>
  (await readFile(new URL(name, DIR), 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const { projects } = JSON.parse(await readFile(new URL('projects.json', DIR), 'utf8'));
const answers = new Map((await readLines('answers.jsonl')).map((a) => [a.id, a]));
const labels = await readLines('labels.jsonl');
const golden = labels
  .filter((l) => (LABELS === 'reviewed' ? l.status === 'reviewed' : true))
  .filter((l) => answers.get(l.id)?.status === 'ok')
  .slice(0, LIMIT)
  .map((l) => ({ ...answers.get(l.id), labels: l }));
if (golden.length === 0) {
  console.error(
    `No ${LABELS === 'reviewed' ? 'reviewed ' : ''}labelled answers in evals/extraction/labels.jsonl.`,
  );
  process.exit(1);
}

/** A project's entities numbered for the pipeline (ids 1..n), and the way back to their keys. */
const projectEntities = new Map(
  projects.map((p) => {
    const rows = p.entities.map((e, i) => ({ ...e, id: BigInt(i + 1) }));
    const entities = trackedEntities(rows);
    return [p.key, { entities, keyOf: new Map(entities.map((e) => [String(e.id), e.key])) }];
  }),
);

function prepared(item, profile) {
  const { entities } = projectEntities.get(item.project);
  const prepass = runPrepass(item, entities);
  const params = buildExtractionRequest({
    profile,
    entities,
    question: item.question,
    engine: item.engine,
    text: item.text,
    citations: prepass.citations,
  });
  return { entities, prepass, params };
}

if (!config.anthropic && !PREPASS_ONLY) {
  console.error('Set ANTHROPIC_API_KEY in .env (the eval calls Claude).');
  process.exit(1);
}
const claude = PREPASS_ONLY ? null : createClaude({ apiKey: config.anthropic.apiKey });

/** Claude's reply for every answer, from the cache or asked for now. */
async function replies(profile) {
  if (PREPASS_ONLY) return new Map();
  const cacheDir = new URL(`.cache/${profile.key}/${PROMPT_VERSION}/`, DIR);
  await mkdir(cacheDir, { recursive: true });
  const out = new Map();
  const todo = [];
  for (const item of golden) {
    const cached = await readFile(new URL(`${item.id}.json`, cacheDir), 'utf8').catch(() => null);
    if (cached) out.set(item.id, JSON.parse(cached));
    else todo.push(item);
  }
  console.log(
    `${profile.key}: ${out.size} cached, ${todo.length} to ask${BATCH ? ' (batch)' : ''}`,
  );
  const keep = async (id, message, ms, batch) => {
    const record = {
      stop_reason: message.stop_reason,
      stop_details: message.stop_details ?? null,
      content: message.content.filter((b) => b.type === 'text'),
      usage: message.usage,
      ms,
      batch,
    };
    out.set(id, record);
    await writeFile(new URL(`${id}.json`, cacheDir), JSON.stringify(record));
  };

  if (BATCH && todo.length) {
    const batch = await claude.batches.create(
      todo.map((item) => ({
        custom_id: item.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
        params: prepared(item, profile).params,
      })),
    );
    console.log(`  batch ${batch.id} submitted; checking every 30 s`);
    for (;;) {
      const status = await claude.batches.retrieve(batch.id);
      if (status.processing_status === 'ended') break;
      await sleep(30_000);
    }
    const byCustomId = new Map(todo.map((item) => [item.id.replace(/[^a-zA-Z0-9_-]/g, '_'), item]));
    for (const result of await claude.batches.results(batch.id)) {
      const item = byCustomId.get(result.custom_id);
      if (result.result.type === 'succeeded')
        await keep(item.id, result.result.message, null, true);
      else console.log(`  ${item.id}: ${result.result.type}`);
    }
  } else {
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length) {
          const item = queue.shift();
          const started = Date.now();
          try {
            await keep(
              item.id,
              await claude.extract(prepared(item, profile).params),
              Date.now() - started,
              false,
            );
          } catch (err) {
            console.log(`  ${item.id}: ${err.status ?? ''} ${err.message}`);
          }
        }
      }),
    );
  }
  return out;
}

/** What the pipeline read, by policy: the stored result (both readers), Claude alone, the pre-pass alone. */
function predictionsFor(profile, cached) {
  const policies = { stored: new Map(), claudeOnly: new Map(), prepassOnly: new Map() };
  let cost = 0;
  let ms = 0;
  let timed = 0;
  for (const item of golden) {
    const { entities, prepass } = prepared(item, profile);
    const { keyOf } = projectEntities.get(item.project);
    const prepassTracked = Object.fromEntries(
      prepass.mentions.map((m) => [
        m.entity.key,
        { mentioned: true, listRank: null, stance: null },
      ]),
    );
    policies.prepassOnly.set(item.id, { answerType: null, tracked: prepassTracked, others: [] });

    const message = cached.get(item.id);
    if (message) {
      cost += costMicros(profile, message.usage, { batch: message.batch });
      if (message.ms) {
        ms += message.ms;
        timed += 1;
      }
    }
    const reply = message ? readReply(message) : { ok: false };
    if (!reply.ok) {
      policies.stored.set(item.id, null);
      policies.claudeOnly.set(item.id, null);
      continue;
    }
    const plan = mergeReading({ entities, prepass, reading: reply.reading, text: item.text });
    const stored = {};
    const claudeOnly = {};
    for (const m of plan.mentions) {
      if (m.entityId == null) continue;
      const key = keyOf.get(String(m.entityId));
      stored[key] = { mentioned: true, listRank: m.listRank, stance: m.stance };
      if (m.detectedBy !== 'prepass') claudeOnly[key] = stored[key];
    }
    const others = plan.mentions.filter((m) => m.entityId == null).map((m) => m.discoveredName);
    policies.stored.set(item.id, { answerType: plan.answerType, tracked: stored, others });
    policies.claudeOnly.set(item.id, { answerType: plan.answerType, tracked: claudeOnly, others });
  }
  return {
    policies,
    costPerAnswerUsd: cost / 1e6 / golden.length,
    meanSeconds: timed ? ms / timed / 1000 : null,
  };
}

const pct = (x) => (x === null ? '  n/a ' : `${(x * 100).toFixed(1).padStart(5)}%`);
const results = {};
for (const key of MODEL_KEYS) {
  const profile = modelProfile(key);
  const cached = await replies(profile);
  const { policies, costPerAnswerUsd, meanSeconds } = predictionsFor(profile, cached);
  results[key] = {
    model: profile.id,
    costPerAnswerUsd,
    meanSeconds,
    scores: Object.fromEntries(
      Object.entries(policies).map(([p, preds]) => [p, scoreReadings(golden, preds)]),
    ),
  };
}

console.log(
  `\nGolden set: ${golden.length} answers (${LABELS} labels), prompt ${PROMPT_VERSION}. Targets: mention ≥ ${pct(TARGETS.mention)}, stance ≥ ${pct(TARGETS.stance)}, rank ≥ ${pct(TARGETS.rank)}\n`,
);
console.log(
  'model     policy        mention  stance    rank   type  others P/R      FP  FN  failed  $/answer',
);
for (const [key, r] of Object.entries(results)) {
  for (const [policy, s] of Object.entries(r.scores)) {
    if (PREPASS_ONLY && policy !== 'prepassOnly') continue;
    console.log(
      `${key.padEnd(9)} ${policy.padEnd(12)} ${pct(s.mention)} ${pct(s.stance)} ${pct(s.rank)} ${pct(s.answerType)} ${pct(s.othersPrecision)}/${pct(s.othersRecall)} ${String(s.falsePositives).padStart(3)} ${String(s.falseNegatives).padStart(3)} ${String(s.failed).padStart(6)}  ${policy === 'stored' ? r.costPerAnswerUsd.toFixed(5) : ''}`,
    );
  }
}
for (const [key, r] of Object.entries(results)) {
  const byEngine = Object.entries(r.scores[PREPASS_ONLY ? 'prepassOnly' : 'stored'].byEngine)
    .map(([e, v]) => `${e} ${pct(v.mention)}`)
    .join(', ');
  console.log(`${key} mention by engine: ${byEngine}`);
}

let d4 = null;
if (results.opus55 && results.haiku45) {
  d4 = decideD4(results.opus55.scores.stored, results.haiku45.scores.stored);
  console.log(
    `\nD4: ${d4.switchToCheaper ? 'Haiku 4.5 qualifies' : 'keep Opus 5.5'} (mention gap ${(d4.mentionGap * 100).toFixed(1)} points; Haiku meets ${JSON.stringify(d4.cheaperMeetsTargets)})`,
  );
}

const date = new Date().toISOString().slice(0, 10);
const reportDir = new URL('results/', DIR);
await mkdir(reportDir, { recursive: true });
const name = `${date}-${PROMPT_VERSION}-${PREPASS_ONLY ? 'prepass' : MODEL_KEYS.join('+')}-${LABELS}.json`;
await writeFile(
  new URL(name, reportDir),
  `${JSON.stringify({ date, promptVersion: PROMPT_VERSION, labels: LABELS, answers: golden.length, targets: TARGETS, results, d4 }, null, 2)}\n`,
);
console.log(`\nReport: evals/extraction/results/${name}`);

if (CI) {
  const met = meetsTargets(results[MODEL_KEYS[0]].scores.stored);
  if (!met.mention || !met.stance || !met.rank) {
    console.error(`Below target: ${JSON.stringify(met)}`);
    process.exit(1);
  }
}
