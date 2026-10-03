# ADR-0006: Engine adapters: one contract, the raw answer first, and Perplexity through its Agent API

| | |
|---|---|
| **Status** | Accepted. Live check (Decision 9): Perplexity and SerpApi **passed on 2026-10-03**; DataForSEO (ChatGPT, Gemini) still open, no account yet |
| **Date** | 2026-10-03 |
| **Context of discovery** | [BUILD_PLAN.md Phase 5](../BUILD_PLAN.md#phase-5--engine-adapters-spikes): "prove the `EngineAdapter` contract against all four real providers… record the result in an ADR" |

## Context

Every number the product shows starts as one AI answer bought from a data provider ([MVP §6.2](../MVP.md#62-engines--collection-methods)): ChatGPT and Gemini from DataForSEO's LLM Scraper, Perplexity from Perplexity's own API, Google AI Overviews from SerpApi. The providers differ in almost everything: one queues the question and answers within 45 minutes, the others answer at once; one reports what it charged, one reports tokens, one reports nothing; each has its own way of saying "failed", "try later" and "nothing to show". The rest of the app must not care which provider answered, must pay for each answer exactly once on the record, and must never turn a failure into "the brand wasn't mentioned".

While checking the providers' documentation on 2026-10-03 we found that **Perplexity ended Sonar Chat Completions on 2026-09-27**, the API the MVP spec was written against. Its successor is the Agent API.

## Decision

**1. One contract for every provider** ([`src/engines/contract.js`](../../src/engines/contract.js), MVP §7.5): `submit(task)` returns a handle, with the answer already in it when the provider answers at once, or the provider's task ID when it queues; `poll(handle)` returns the answer or `pending`; `normalize(raw, task)` returns one shape (text, numbered sources with domains, model, locale, provider reference) checked by a zod schema on the way out; `estimateCostUsd(task)` and `estimateCostMicros(task)` give the published price before asking. Every error is a `ProviderError` that says whether retrying could help (`retryable`) and whether it is the provider's fault (`countsAgainstProvider`: wrong credentials or a malformed request must not trip a healthy provider's circuit breaker). Errors never contain response bodies or URLs, because SerpApi's key travels in the URL and providers echo requests.

**2. "No answer" must be something the provider said.** Google showing no AI Overview, or DataForSEO's "no search results", is `no_answer`: real data that feeds the AI Overview trigger rate. A response we can't read (a field renamed, a block type changed) is an error (`bad_response`), never `no_answer`, because a silent shape change would otherwise be counted as "not mentioned anywhere" across every customer. A run Perplexity cut short (`incomplete`) is retried, never kept as a short answer. "Google can't generate an overview right now" is retried, not read as "Google showed none".

*Added 2026-10-03, found while collecting the Phase 6 golden set ([ADR-0007](0007-answer-extraction.md)):* sometimes the results page carries only a `page_token` (Google builds the overview separately), and the follow-up request for it comes back with no `ai_overview`, the error "Google hasn't returned any results for this query" and `search_information.ai_overview_state: "Fully empty"`. Google advertised an overview and then had none to show. Two queries did this on every try across three hours, including a follow-up made 10 seconds after the search, so it isn't a timing problem. The adapter used to fall back to the token-only overview and report "no readable text", an error. Because SerpApi states the cause, it is now `no_answer`. A follow-up that is empty *without* that statement is still `bad_response`. Both searches are charged either way.

**3. Perplexity through the Agent API with the `perplexity/sonar` model** (`POST /v1/agent`, the `web_search` tool, the prompt's country as `user_location`). That is the old Sonar answer in the new envelope, still labelled `api_grounded`. The model is configuration (`PERPLEXITY_MODEL`), because the Agent API also offers presets that answer with other companies' models, which would no longer be "what Perplexity says". The response reports its own cost (`usage.cost.total_cost`), and the ledger records that.

**4. A queued provider is polled by the job deferring itself.** DataForSEO's standard queue (the cheap one weekly tracking uses) is submitted once; the task ID and the charge are saved on the snapshot; the job then throws a `Deferral` and comes back every 60 seconds (15 for priority), which costs no retry attempt. After 75 minutes (20 for priority) against DataForSEO's promise of 45 (5) the snapshot is failed with `provider_timeout`. We chose this over DataForSEO's postback (it calls a URL of ours when done) because a postback needs a public endpoint, signature checks and a fallback poll anyway; it can be added later without changing the contract.

**5. Polling is free, so it writes no ledger row.** `callProvider` now accepts `usage: { free: true }`: the call still waits for the rate limit, holds an organization slot and is recorded for the provider's health, but it is not a cost. Saying so is explicit; a call that returns no usage at all is still a bug.

**6. One ledger row per charge, keyed by attempt.** The submit's ledger key ends in the job's attempt number (`collect.<job>.submit<n>`). If the provider charged us and then the job failed (the bucket refused the raw answer), the retry asks again and is charged again, and both charges are on the record under different keys; the same attempt can't be written twice. The integration test checks "ledger rows = provider charges" directly. Known gap: if a worker dies between the provider's reply and the ledger write, that charge is not recorded; DataForSEO's `tag` field carries the snapshot ID so its invoice can be reconciled.

**7. The raw answer is stored first, even when we can't read it** ([MVP §7.1](../MVP.md#71-architecture-principles) principle 4). One JSON document per answer: the provider's response exactly as parsed, our normalized reading of it, and the locale and mode, under `answers/<yyyy>/<mm>/<sha256>.json` in the same bucket directory as crawled pages (own prefix, so its lifecycle rule can differ). The snapshot keeps the key and the hash. An unreadable response is stored too, and the failed snapshot points at it so staff can see what changed.

**8. Costs.** The ledger records the provider's own figure where it gives one (DataForSEO `cost`, Perplexity `usage.cost.total_cost`), otherwise the published price (`src/engines/pricing.js`, checked 2026-10-03):

| Provider | Price | Estimate vs. charge |
|---|---|---|
| DataForSEO LLM Scraper (ChatGPT, Gemini) | $0.0012 standard · $0.0024 priority · $0.004 live, per answer | Exact (fixed price; the test compares with the reported `cost`) |
| Perplexity Agent API, `perplexity/sonar` | $1 per million tokens in and out + $0.0025 per web search: about **$0.004** a typical answer (was ~$0.006 on Sonar) | Within **±50%**: token counts vary with the question; the ledger uses the reported cost |
| SerpApi | The plan's price per search, `SERPAPI_COST_PER_SEARCH_USD` (default $0.010, the Production plan). An overview fetched with a page token takes a second request, **counted as a second search** until an invoice shows otherwise | Exact for the configured plan |

**9. Live check (still to do).** One real call per provider, with a person reading the raw answer, recorded here:

| Provider / engine | Command | Result | Date |
|---|---|---|---|
| DataForSEO / ChatGPT | `npm run engines:try -- --engine chatgpt --mode live --record "…"` | Not run: no account yet | — |
| DataForSEO / Gemini | `… --engine gemini --mode live --record "…"` | Not run | — |
| Perplexity / Perplexity | `… --engine perplexity --record "…"` | ✅ `ok` in 8.2 s, model `perplexity/sonar`, 15 sources, charged **$0.00441** (estimate $0.004). The response matches the documented shape. It used 4,269 input tokens, not the ~1,000 assumed, and its cost includes a one-off prompt-cache write ($0.00093), so repeated questions may cost less. Recorded as `perplexity/agent-recorded-2026-10-03.json` | 2026-10-03 |
| SerpApi / AI Overviews | `… --engine google_aio --query "…" --record "…"` | ✅ `ok` in 1.4 s, the overview on the results page itself (one search, no page token), 7 sources. One difference from the docs' example: real list items carry their title inside `snippet` with no `title` field; the adapter already handled that. Recorded as `serpapi/google-aio-recorded-2026-10-03.json` | 2026-10-03 |

**10. Rate limits** (`src/core/limits.js`) are set well under each provider's stated ceiling, because our polling shares the budget: DataForSEO 20/s (its limit is 2,000 a minute), Perplexity and SerpApi 2/s until the account tier and plan are known. Re-measure after the live check.

## Consequences

- Most fixtures in `tests/fixtures/engines/` are **hand-built from the documented response shapes**; they stay for the cases a live call can't produce on demand (errors, queued tasks, page tokens, no overview). Real recordings now cover Perplexity and SerpApi; DataForSEO's are still to come.
- Only the four MVP primaries have adapters. The fallbacks in the `engines` table (OpenAI and Gemini APIs, DataForSEO for Perplexity and AI Overviews) do not exist yet; when a primary's breaker is open and its fallback has no adapter, the answer waits and then becomes "couldn't check". Routing already picks a fallback that does exist (tested with a stand-in).
- Perplexity answers are a little cheaper than the spec assumed (~$0.004 rather than $0.006), so collection per prompt-run is about $0.033 rather than $0.035 ([MVP §12.2](../MVP.md#122-cost-per-tracked-prompt-run)).
- A provider is only as available as its credentials: a worker without `DATAFORSEO_*`, `PERPLEXITY_API_KEY` or `SERPAPI_API_KEY` treats that provider as unavailable.
