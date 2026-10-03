import { checkedAnswer, ProviderError } from './contract.js';
import { clip, dedupeSources, requestJson } from './http.js';
import { baseLanguage } from './locations.js';
import { PRICES, perplexityMicros, reportedMicros } from './pricing.js';

/**
 * Perplexity, through its own API (MVP §6.2, method `api_grounded`: the API's answer, which is close to but not
 * the same as perplexity.ai's page).
 *
 * Sonar Chat Completions, which the MVP spec was written against, ended on 2026-09-27. Its successor is the
 * Agent API (POST /v1/agent, docs checked 2026-10-03: https://docs.perplexity.ai/docs/agent-api/quickstart).
 * We ask the `perplexity/sonar` model with the `web_search` tool, which is the old Sonar answer in the new
 * envelope; `model` is configuration in case the founder prefers a preset. The run is synchronous: `submit`
 * already holds the answer.
 *
 * The response reports its own cost (`usage.cost.total_cost`), which is what the ledger records.
 */
export function createPerplexityAdapter({
  apiKey,
  model = 'perplexity/sonar',
  searchContextSize = 'low',
  baseUrl = 'https://api.perplexity.ai',
  fetchImpl,
  timeoutMs = 90_000,
}) {
  if (!apiKey) throw new TypeError('Perplexity needs an API key');
  const label = 'perplexity_api/perplexity';
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/agent`;

  const textOf = (raw) => {
    if (typeof raw?.output_text === 'string' && raw.output_text.trim())
      return raw.output_text.trim();
    const parts = [];
    for (const item of raw?.output ?? []) {
      if (item?.type !== 'message' || item.role !== 'assistant') continue;
      for (const c of item.content ?? []) {
        if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
      }
    }
    return parts.join('\n\n').trim();
  };

  const sourcesOf = (raw) => {
    const found = [];
    // Search results, in the order the run fetched them...
    for (const item of raw?.output ?? []) {
      if (item?.type !== 'search_results') continue;
      for (const r of item.results ?? [])
        found.push({ url: r?.url, title: r?.title, snippet: r?.snippet });
    }
    // ...and anything the message cites that the search list didn't include.
    for (const item of raw?.output ?? []) {
      if (item?.type !== 'message') continue;
      for (const c of item.content ?? []) {
        for (const a of c?.annotations ?? [])
          found.push({ url: a?.url, title: a?.title, snippet: null });
      }
    }
    for (const u of raw?.citations ?? []) found.push({ url: u, title: null, snippet: null });
    return dedupeSources(found);
  };

  return {
    engine: 'perplexity',
    provider: 'perplexity_api',
    method: 'api_grounded',

    estimateCostUsd: () => perplexityMicros(PRICES.perplexity.typical) / 1e6,
    estimateCostMicros: () => perplexityMicros(PRICES.perplexity.typical),

    async submit(task) {
      const raw = await requestJson(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: {
          model,
          input: task.text,
          // Answer in the prompt's language, as a person there would be answered.
          instructions: `Answer in the language with code "${baseLanguage(task.language)}".`,
          tools: [
            {
              type: 'web_search',
              search_context_size: searchContextSize,
              user_location: { country: task.country, ...(task.city ? { city: task.city } : {}) },
            },
          ],
        },
        timeoutMs,
        fetchImpl,
        label,
      });
      if (raw?.error) {
        throw new ProviderError(`${label}: the run reported an error`, { status: 'run_error' });
      }
      if (raw?.status && raw.status !== 'completed') {
        // `incomplete` (cut short) or `failed`: an answer we can't trust as complete.
        throw new ProviderError(`${label}: the run ended "${String(raw.status).slice(0, 32)}"`, {
          status: `run_${String(raw.status).slice(0, 20)}`,
        });
      }
      const usage = raw?.usage ?? {};
      const searches = (raw?.output ?? []).filter((i) => i?.type === 'search_results').length;
      const counted = perplexityMicros({
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        searches,
      });
      return {
        providerRef: clip(raw?.id, 128),
        raw,
        costMicros: reportedMicros(usage.cost?.total_cost) ?? counted,
        tokensIn: usage.input_tokens ?? null,
        tokensOut: usage.output_tokens ?? null,
        model: clip(raw?.model, 64),
      };
    },

    async poll(handle) {
      return handle.raw;
    },

    normalize(raw, task) {
      const text = textOf(raw);
      const answeredAt =
        typeof raw?.completed_at === 'number'
          ? new Date(raw.completed_at * 1000).toISOString()
          : null;
      const base = {
        engine: 'perplexity',
        provider: 'perplexity_api',
        method: 'api_grounded',
        locale: { country: task.country, language: task.language },
        providerRef: clip(raw?.id, 128),
        modelVersion: clip(raw?.model, 64),
        answeredAt,
      };
      if (!text) {
        // An empty answer counts only when the run finished and said nothing; a response we can't read is an error.
        const hasMessage = (raw?.output ?? []).some((i) => i?.type === 'message');
        if (raw?.status !== 'completed' || !hasMessage) {
          throw new ProviderError(`${label}: the response has no readable answer`, {
            status: 'bad_response',
          });
        }
        return checkedAnswer({ ...base, status: 'no_answer', text: '', sources: [] });
      }
      return checkedAnswer({ ...base, status: 'ok', text, sources: sourcesOf(raw) });
    },
  };
}
