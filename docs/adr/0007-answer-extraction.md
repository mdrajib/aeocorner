# ADR-0007: Answer extraction: a free pre-pass, Claude through the Batch API, and a golden set that decides the model (D4)

| | |
|---|---|
| **Status** | Accepted for the pipeline. **Decision D4: keep Opus 5.5, provisionally** (first eval, 2026-10-03, on draft labels). It becomes final when the founder has reviewed the labels and the eval is re-scored on them (free: replies are cached) |
| **Date** | 2026-10-03 |
| **Context of discovery** | [BUILD_PLAN.md Phase 6](../BUILD_PLAN.md#phase-6--extraction-pipeline--golden-set-eval): "turn a raw answer into structured mentions/citations/claims, and settle decision D4 (bulk model choice) with real data" |

## Context

Every number the dashboard shows is a count over readings of AI answers: was the brand named, was it recommended, where did it rank, which sources were cited ([MVP §6.4–6.5](../MVP.md#64-answer-extraction-pipeline)). A reading that is wrong in a consistent direction is worse than no reading, because it looks like data. The spec's targets ([MVP §10](../MVP.md#10-non-functional-requirements)) are at least 95% agreement with hand labels on "is the tracked brand mentioned" and at least 90% on stance and rank.

Decision D4 ([MVP §17](../MVP.md#17-decisions-needed-from-the-founder)) is which Claude model does the bulk reading: the default Opus at low effort, or the cheaper Haiku 4.5 if it holds up against the golden set (at most 2 points lower on mention detection, and every target met).

## Decision

**1. Two readers, stored as one reading.** Every answer is read by a deterministic pre-pass ([`src/llm/prepass.js`](../../src/llm/prepass.js)) and by Claude ([`src/llm/extraction.js`](../../src/llm/extraction.js)). A tracked brand counts as mentioned when either reader found it; `mentions.detected_by` says which (`both`, `prepass`, `llm`). Where only one did, the answer goes to the review queue (`review_items`, source `disagreement`). Claude's fields (rank, stance, prominence, sentiment) are kept when Claude found the brand; a brand only the pre-pass found has them empty, never guessed. The eval scores three policies side by side (both readers, Claude alone, pre-pass alone), so this rule can be changed on evidence rather than opinion.

**2. The pre-pass** looks for each tracked brand's name, aliases and domains in the answer text: whole words, case-insensitive, possessives included, the longest overlapping name wins ("HubSpot CRM" over "HubSpot"), and "That's not us" rules (`entity_aliases.kind = exclude`) remove the matches they cover. **Names inside links don't count as mentions**: every URL, and every link whose visible text is just a domain (how ChatGPT and Gemini show sources), is blanked out before matching; those are citations. This rule came from the golden set: the first eval run found one false mention, `www.shopify.com` in a ChatGPT citation chip. A domain written in a sentence ("visit acme.com") still counts. Everything is linear in the answer's length (the answer can quote any website): `indexOf` scans, two regexes with no nested repetition, merged spans with binary search. Hostile-input tests cover 200,000-character answers, thousands of overlapping exclusions and tens of thousands of links.

**3. The request** ([`src/llm/extraction-prompt.js`](../../src/llm/extraction-prompt.js), [`extraction-schema.js`](../../src/llm/extraction-schema.js)):
- **Versioned.** `PROMPT_VERSION = 'x2'` (x1 until 2026-10-03; see decision 9), and every row carries `extraction_version = x2.<model>` (`x2.opus55`), so history can be re-read when either changes ([MVP §6.4](../MVP.md#64-answer-extraction-pipeline) step 5).
- **Structured outputs** (`output_config.format`, a JSON schema). The schema subset has no numeric ranges or string lengths, so a zod schema checks those on the way in.
- **Stable prefix first, for caching.** The system prompt (instructions plus four worked examples, about 3,900 tokens) is identical for every answer; the project's tracked-brand block (refs `E1…En`, brand first) is identical for every answer of a run. Both carry cache breakpoints. The answer and its numbered sources come last.
- **The answer is fenced and treated as data.** An answer can quote a web page that addresses the model. The instructions say nothing inside `<answer>` is an instruction, fence tags inside the text are neutralised, and structured outputs mean the reply can only be the extraction shape.
- **Sources are numbered by the pre-pass**: the provider's list in its order, then links written in the text that the list lacks. Claude says which brands each source backs, by those numbers.

**4. A reply is used whole or not at all.** `readReply` rejects a refusal, a reply cut off at `max_tokens` (even if what arrived parses), text that isn't JSON, and JSON of the wrong shape. Each marks the answer's extraction `failed` with the reason and writes nothing; rows from an earlier reading stay. A good reading replaces the snapshot's mentions, citations, claims and open disagreements in one transaction that first locks the snapshot row, so two copies of a job can't interleave. The fact tables have no foreign keys, so the repository checks that every entity ID in a reading belongs to the snapshot's project (`ENTITY_NOT_IN_PROJECT`). Brands Claude names that aren't tracked become `tracked_entities` rows of kind `discovered`, status `suggested` ([MVP §6.4](../MVP.md#64-answer-extraction-pipeline) step 3).

**5. Batch per run, polled by deferral.** `extract.batch` sends every collected, unread answer of a run as one Batch API request (half price) and records the batch on the run (`runs.llm_batch_ids`, with a fingerprint of the numbered brand list). `extract.poll` asks every 60 seconds (a `Deferral`, no attempt used). When the batch ends it downloads every result and writes **one ledger row for the batch**, keyed `extract.batch.<batch id>`, so a retried poll can't count it twice. Creating a batch is free, so that call writes no ledger row. Items Anthropic failed or let expire are read again one at a time (`extract.answer`, full price); an invalid request is marked failed. If the project's brands changed while the batch was out, the `E1…En` numbering no longer means the same thing, so none of its results are trusted: every item is read again.

**6. Models** ([`src/llm/models.js`](../../src/llm/models.js), prices checked 2026-10-03):

| Key | Model | How it's asked | Price per million tokens (in / out; Batch halves both) | Why |
|---|---|---|---|---|
| `opus55` (default) | `claude-opus-5-5` | effort `low`. Thinking can't be switched off on this model, and its default effort is `medium`, so effort is set explicitly | $4 / $20; cache reads $0.20 | **Replaces the spec's `claude-opus-5`**: Opus 5.5 is its successor on the same feature set, at a lower price |
| `haiku45` | `claude-haiku-4-5` | no effort setting (the API rejects one), no thinking | $1 / $5; cache reads $0.10 | The cheaper candidate D4 tests |

- The **server-side refusal fallback** (`fallbacks`) isn't used: the Batches API rejects it. A refusal is a visible `failed` extraction instead.
- **Haiku 4.5 only caches a prefix of at least 4,096 tokens.** Our cached prefix (about 3,900 tokens of system prompt plus the brand block) sits right at that line, so on Haiku it may not cache at all. The eval's measured cost per answer is the number to trust, not this estimate.

**7. The golden set** ([`evals/extraction/`](../../evals/extraction/README.md)): 10 imaginary customer projects using real brands (CRM, dental software, team wikis, accounting, email marketing, home services, online legal, e-commerce, password managers, running shoes), 6 questions each, asked once of each engine through the real providers on 2026-10-03: **237 answers** (60 Perplexity, 60 ChatGPT, 60 Gemini, 57 AI Overviews; three AI Overview requests failed twice), for **about $1.63**. The brands include hard cases: everyday words (Notion, Wave, Brooks, Curve), renamed brands (Kit/ConvertKit, Brevo/Sendinblue, Angi/Angie's List, Bizee/Incfile) and look-alikes (Square/Squarespace).

**Labels: drafted by Claude, reviewed by the founder** (founder decision, 2026-10-03). Claude (Opus 5.5, working in Claude Code, not the extraction prompt) read every answer and drafted labels for all 1,185 answer × brand pairs. `npm run golden:review` is a local page for checking and correcting them; a saved label becomes `reviewed` under the reviewer's name. **The known risk**: a reviewer tends to accept a draft, and the drafter is the same model family as the one being evaluated, and also wrote the pre-pass rules, so agreement may come out a few points high. Scores on draft labels and on reviewed labels are reported separately, and CI uses reviewed labels only.

**8. The D4 rule is code** ([`src/llm/eval/score.js`](../../src/llm/eval/score.js), `decideD4`): switch the bulk route to Haiku 4.5 only if it meets every [MVP §10](../MVP.md#10-non-functional-requirements) target and is no more than 2 points behind Opus on mention detection.

**9. Results so far** (`npm run eval:extraction`, reports in `evals/extraction/results/`):

First Claude run, 2026-10-03: all 237 answers, both models, answered one at a time at full price (not the Batch API), prompt `x1`, scored on the **draft** labels. "Stored" is what the app keeps (decision 1: both readers combined). Targets: mention ≥ 95%, stance ≥ 90%, rank ≥ 90%.

| Reader | Mention | Stance | Rank | Answer type | False mentions | Cost per answer (full price) | Meets targets |
|---|---|---|---|---|---|---|---|
| Pre-pass alone | **100%** (1,185 pairs; 99.9% before the link rule in decision 2) | — | — | — | 0 | free | Mention only; it reads no stance or rank |
| Claude Opus 5.5 (stored) | 99.9% | **92.0%** | **91.8%** | 86.5% | 1 | **$0.0254** (7.7 s) | ✅ all three |
| Claude Haiku 4.5 (stored) | 99.3% | **85.5%** ❌ | 90.8% | 80.6% | 8 | **$0.0047** (5.6 s) | ❌ stance |
| Claude Haiku 4.5 (alone) | 98.4% (11 brands missed) | 87.3% | 90.8% | 80.6% | 8 | | ❌ stance |

**Second run, prompt `x2`** (same day, same set): one rule added, that a brand named only in the question isn't named by the answer.

| Reader | Mention | Stance | Rank | Answer type | False mentions | Cost per answer (full price) | Meets targets |
|---|---|---|---|---|---|---|---|
| Claude Opus 5.5 (stored) | **100%** | **91.4%** | **92.0%** | 88.2% | **0** | $0.0255 | ✅ all three |
| Claude Haiku 4.5 (stored) | 99.3% | **87.8%** ❌ | 91.2% | 82.3% | 8 | $0.0046 | ❌ stance |

The fix worked: Opus's one false mention is gone, with no new ones. Stance moved from 92.0% to 91.4%. That is run-to-run variation, not the new rule: comparing Opus's two runs answer by answer, 7 of its 523 stance readings changed, all for brands the answer itself names, which the new rule doesn't touch. Haiku's 8 false mentions are a different problem (brands it reads into the answer), and it still misses stance. The x1 scores above stay as the record of that prompt.

**D4, provisional: keep Opus 5.5** (`decideD4`, both runs). Haiku is within the 2-point mention tolerance (0.6 points behind) but misses the stance target by 4.5 points, mostly by reading a recommendation as a caution (25 times) or as neutral (18). As expected, mention detection didn't decide it: the pre-pass already has it, and Claude's false mentions are what it adds.

What the misses show:
- **Opus's one false mention under x1** (`email-q4-perplexity`, Mailchimp) came from the question ("a cheaper alternative to Mailchimp?"), not the answer. **Fixed in x2** (above).
- **Opus's stance misses** are split between "recommended" read as neutral or cautioned (22) and neutral read as recommended (18), so there's no single bias. Several may be label mistakes; the founder's review settles that.
- **Opus's rank misses** are mostly ranks it left empty (30 of 43) where the label gave one. None of those 15 answers has a numbered list; the brands are in bullets or headed sections, and the labels counted their order as a rank. That is a rule to clarify in the prompt once the review shows which side is right.
- **Answer type** (86.5%) has no target. It is reported, not decided on.

Scores on reviewed labels go in these tables when the review is done (`npm run eval:extraction -- --labels reviewed`, free).

## Consequences

- **Cost per answer is about 60% higher than the spec assumed** (measured 2026-10-03). Real answers average 2,500 characters (Gemini 5,300, ChatGPT 2,300, AI Overviews 1,600, Perplexity 1,000), not about 700 tokens, and Perplexity lists about 15 sources. Opus 5.5 measured **$0.0254** per answer at full price, so about **$0.013 on the Batch API** against the spec's $0.008. Output is most of it: about 900 tokens of JSON per answer (excerpts and claims), $0.018 at full price. Low effort used **no thinking tokens** on any answer. Haiku 4.5 measured $0.0047 (about $0.0023 batched, close to the spec's $0.002), and its prefix did cache (4,894 tokens, over its 4,096 minimum). [MVP §12.1–12.3](../MVP.md#121-cost-inputs) has the margin consequence. Levers if it matters: shorter excerpts (the biggest output item), fewer claims per brand, or Haiku for low-stakes re-reads.
- **Still open:** the founder's label review, a re-score on reviewed labels (free), then D4 is final in decision 9 and MVP §17. Add `ANTHROPIC_API_KEY` as a GitHub repository secret, or the CI job warns instead of scoring.
- **Known gap:** if a worker dies between creating a batch and recording it on the run, the batch runs (and is charged) but its results are never read; the run's answers stay pending and a later `extract.batch` sends them again. Anthropic batches have no idempotency key. The admin console (Phase 10) should list batches Anthropic knows that no run recorded.
- **Nothing triggers extraction automatically yet.** The tracking orchestrator (Phase 9) enqueues `extract.batch` when a run's collection is done; the free audit (Phase 7) uses `extract.answer`. Rollups (Phase 9) decide how `detected_by = prepass` mentions with no stance are counted.
- **Found during collection, fixed the same day:** SerpApi returned two AI Overviews the adapter called "no readable text" (`crm-q1`, `dental-q5`). They were not a new layout. Google had advertised a separate overview and then returned an empty one, which SerpApi reports as "Fully empty". These are now read as `no_answer` ([ADR-0006](0006-engine-adapters.md) decision 2). Re-collecting the two questions would add two `no_answer` rows to the golden set; those don't affect extraction scores.
