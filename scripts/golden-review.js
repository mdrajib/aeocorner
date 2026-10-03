#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import express from 'express';
import { z } from 'zod';

/**
 * The golden-set review page (BUILD_PLAN Phase 6, ADR-0007): a person checks and corrects the labels of each
 * collected answer, one at a time.
 *
 *   npm run golden:review          then open http://127.0.0.1:3999
 *
 * Reads evals/extraction/{projects.json, answers.jsonl, labels.jsonl} and writes labels.jsonl back on every save.
 * Saving marks the label "reviewed" with the reviewer's name. A local tool only: it listens on 127.0.0.1, has no
 * sign-in, and is not part of the app (src/web).
 */

const PORT = Number(process.env.REVIEW_PORT ?? 3999);
const DIR = new URL('../evals/extraction/', import.meta.url);
const LABELS = new URL('labels.jsonl', DIR);

const readLines = async (name) =>
  (await readFile(new URL(name, DIR), 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const STANCES = ['recommended', 'neutral', 'cautioned', 'not_recommended'];
const labelSchema = z.object({
  answer_type: z.enum(['list', 'single_recommendation', 'comparison', 'explanatory', 'refusal']),
  tracked: z.record(
    z.string(),
    z.object({
      mentioned: z.boolean(),
      list_rank: z.number().int().min(1).max(255).nullable(),
      stance: z.enum(STANCES).nullable(),
      prominence: z.enum(['primary', 'secondary', 'passing']).nullable(),
    }),
  ),
  others: z.array(z.string().min(1).max(255)).max(100),
  notes: z.string().max(2000).default(''),
  reviewer: z.string().min(1).max(64),
});

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/', async (_req, res) => {
  res.type('html').send(await readFile(new URL('golden-review.html', import.meta.url), 'utf8'));
});

app.get('/api/data', async (_req, res) => {
  const { projects } = JSON.parse(await readFile(new URL('projects.json', DIR), 'utf8'));
  res.json({
    projects,
    answers: (await readLines('answers.jsonl')).filter((a) => a.status === 'ok'),
    labels: await readLines('labels.jsonl'),
  });
});

// One save at a time, so two quick saves can't interleave their read-modify-write of the file.
let writing = Promise.resolve();
app.put('/api/labels/:id', (req, res) => {
  writing = writing
    .then(() => save(req, res))
    .catch((err) => {
      if (!res.headersSent) res.status(500).json({ error: String(err.message) });
    });
});

async function save(req, res) {
  {
    const parsed = labelSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
    const { reviewer, ...label } = parsed.data;
    for (const t of Object.values(label.tracked)) {
      if (!t.mentioned) Object.assign(t, { list_rank: null, stance: null, prominence: null });
    }
    const all = await readLines('labels.jsonl');
    const at = all.findIndex((l) => l.id === req.params.id);
    const previous = at === -1 ? {} : all[at];
    const row = {
      ...previous,
      id: req.params.id,
      status: 'reviewed',
      ...label,
      reviewed_by: reviewer,
      reviewed_at: new Date().toISOString(),
    };
    if (at === -1) all.push(row);
    else all[at] = row;
    const tmp = new URL('labels.jsonl.tmp', DIR);
    await writeFile(tmp, all.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await rename(tmp, LABELS);
    res.json(row);
  }
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Golden-set review: http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
});
