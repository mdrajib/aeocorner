# Engine provider fixtures

Responses from the answer-engine providers, replayed by the adapter contract tests (`tests/adapters/engines.test.js`) and the unit tests beside the adapters (`src/engines/*.test.js`). No test ever calls a real provider.

| Folder | Provider | Endpoints |
|---|---|---|
| `dataforseo/` | DataForSEO LLM Scraper (ChatGPT, Gemini) | `task_post`, `task_get/advanced`, `live/advanced` |
| `perplexity/` | Perplexity Agent API (`perplexity/sonar` + `web_search`) | `POST /v1/agent` |
| `serpapi/` | SerpApi Google Search (AI Overviews) | `search.json?engine=google`, `engine=google_ai_overview` |

## Where they came from

**As of 2026-10-03 every file here is built by hand from the provider's documented response shape** (the docs pages are linked at the top of each adapter in `src/engines/`), because no provider account existed yet. The field names and nesting follow the documentation; the answers themselves are invented.

Replace each with a real recording once the accounts exist:

```bash
npm run engines:try -- --engine chatgpt --mode live --record "What is the best dental practice management software for a small clinic?"
```

`--record` writes the provider's raw response to `recorded/<provider>-<engine>-<date>.json` in this folder, with credentials removed. Copy what it shows over the hand-built file it replaces, keep the test names, and note the date in the table below. If a real response differs in shape from the documented one, the adapter is wrong: fix it and keep the recording as the fixture that proves it.

| File | Source | Date |
|---|---|---|
| everything | documented shape, hand-built | 2026-10-03 |
