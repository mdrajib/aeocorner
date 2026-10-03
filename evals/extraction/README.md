# The extraction golden set

Real AI answers with hand-checked labels, used to measure how well AEO Corner reads answers ([BUILD_PLAN Phase 6](../../docs/BUILD_PLAN.md#phase-6--extraction-pipeline--golden-set-eval), [ADR-0007](../../docs/adr/0007-answer-extraction.md)) and to decide which Claude model reads them (decision D4, [MVP §17](../../docs/MVP.md#17-decisions-needed-from-the-founder)). CI runs it whenever the extraction code, its prompt or these files change.

| File | What it holds |
|---|---|
| `projects.json` | 10 imaginary customer projects using real brands: each has a brand (the customer), four competitors with their aliases and domains, and six questions |
| `answers.jsonl` | One AI answer per line, as the pipeline reads it: engine, provider, question, text, numbered sources. Collected 2026-10-03 |
| `labels.jsonl` | One label per answer: its type, and for every tracked brand whether it is named, its list rank, stance and prominence, plus the other brands it names |
| `results/` | Eval reports, one JSON file per run |
| `.cache/` | Claude's replies, cached per model and prompt version so scoring again is free (git-ignored) |

## Reviewing the labels

Claude drafted every label (`"status": "draft"`). Each one needs a person to check it, because an eval graded against Claude's own reading would flatter Claude.

```bash
npm run golden:review
```

Then open http://127.0.0.1:3999. On the left is the list of answers. In the middle is the answer, with every tracked brand's names highlighted, one colour per brand: a highlight is only a hint, so "learning curve" is not Curve Dental. On the right are the labels. Correct anything that's wrong and press **Save as reviewed & next** (Ctrl+S). Saving marks the label `reviewed` under your name, in `labels.jsonl`.

The rules are the extraction prompt's (`src/llm/extraction-prompt.js`). In short:

- **Named:** the answer names the brand, by name, alias or domain written in the text. A name that appears only inside a link or a source title is a citation, not a mention.
- **Rank:** only for list answers. It is the list item the brand heads, counting options in reading order across the whole answer (category headings don't count). Leave it empty when the brand is named inside another item, in a bullet headed by something other than a brand, or outside the list.
- **Stance:** `recommended` when offered as a good option (drawbacks in a balanced item don't change that); `neutral` when named or described without advice; `cautioned` when the warnings dominate; `not_recommended` when advised against.
- **Other brands:** companies, products or services the answer offers as options. Leave out sources, publishers, shops, tools mentioned only as integrations, and the asker's own software.

The notes on a draft say where a call was close; those are the ones most worth checking.

## Running the eval

```bash
npm run eval:extraction -- --prepass-only
npm run eval:extraction
npm run eval:extraction -- --labels reviewed
npm run eval:extraction -- --batch
```

1. `--prepass-only`: the free pre-pass alone, with no API key needed.
2. No flags: both models on every label. This costs money on a cache miss, about $1 to $4 per model.
3. `--labels reviewed`: only labels a person has checked.
4. `--batch`: the Batch API at half price, usually done within the hour.

`--ci` is what CI runs: the configured model (`EXTRACTION_MODEL`) on reviewed labels, failing if a target is missed. The targets are at least 95% agreement on "is it named" and at least 90% on stance and on rank.

## Adding answers

```bash
npm run golden:collect -- --budget 1
```

This asks every question in `projects.json` that has no answer yet through the real providers, and appends the answers to `answers.jsonl`. It costs money: about $0.004 to $0.02 an answer. New answers need labels before they count. Add hard cases from the review queue as they turn up ([ADMIN_OPERATIONS](../../docs/ADMIN_OPERATIONS.md), runbook A6).
