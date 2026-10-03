# Engine provider fixtures

Responses from the answer-engine providers, replayed by the adapter contract tests (`tests/adapters/engines.test.js`) and the unit tests beside the adapters (`src/engines/*.test.js`). No test ever calls a real provider.

| Folder | Provider | Endpoints |
|---|---|---|
| `dataforseo/` | DataForSEO LLM Scraper (ChatGPT, Gemini) | `task_post`, `task_get/advanced`, `live/advanced` |
| `perplexity/` | Perplexity Agent API (`perplexity/sonar` + `web_search`) | `POST /v1/agent` |
| `serpapi/` | SerpApi Google Search (AI Overviews) | `search.json?engine=google`, `engine=google_ai_overview` |

## Where they came from

Files named `*-recorded-<date>.json` are **real responses** from a live call (credentials removed; for SerpApi only the search response is kept). **Every other file is built by hand from the provider's documented response shape** (the docs pages are linked at the top of each adapter in `src/engines/`): the field names and nesting follow the documentation, the answers are invented. Hand-built files stay for cases a live call can't produce on demand: errors, queued tasks, page tokens, no overview.

Record a new real response with:

```bash
npm run engines:try -- --engine chatgpt --mode live --record "What is the best dental practice management software for a small clinic?"
```

`--record` writes the provider's raw response to `recorded/<provider>-<engine>-<mode>-<date>.json` in this folder, with credentials removed. Move it into the provider's folder as `*-recorded-<date>.json`, add a test that replays it, and note it in the table below. If a real response differs in shape from the documented one, the adapter is wrong: fix it and keep the recording as the fixture that proves it.

| File | Source | Date |
|---|---|---|
| `perplexity/agent-recorded-2026-10-03.json` | live call, `perplexity/sonar` | 2026-10-03 |
| `serpapi/google-aio-recorded-2026-10-03.json` | live call, Google US, English | 2026-10-03 |
| everything else | documented shape, hand-built | 2026-10-03 |
