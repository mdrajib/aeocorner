import { createClaude } from '../llm/claude.js';
import { checkedAnswer, ProviderError } from './contract.js';
import { clip, dedupeSources } from './http.js';
import { baseLanguage } from './locations.js';
import { claudeMicros, PRICES } from './pricing.js';

/**
 * Claude as an answer engine (Milestone 16, founder decision F2 option A, ADR-0006 addendum): the Claude API with its
 * web-search tool on, which is close to what a person gets in claude.ai with search turned on (method
 * `api_grounded`: the API's answer, not the claude.ai page).
 *
 * This is a different use of the same vendor as answer extraction: there Claude READS answers, here it GIVES one.
 * Both go through `callProvider` as provider `anthropic`, but the circuit breaker is per engine (`anthropic/claude`).
 *
 * The run is synchronous: `submit` already holds the answer. A turn that ends in `pause_turn` (the server-side search
 * loop ran long) is continued, a few times at most, and the usage of every turn is added up.
 *
 *   refusal              Claude said no: `no_answer`, a real outcome (the contract's "the engine refuses")
 *   max_tokens, other    an answer cut short or a stop we don't know: an error, never half an answer counted as a whole
 *   no text, no refusal  a response we can't read: `bad_response`
 *
 * The stored raw response keeps what the web-search tool returned (addresses and titles), without
 * `encrypted_content`: that is Anthropic's opaque token for continuing a conversation and is of no use to us.
 */
const MAX_CONTINUATIONS = 3;

export function createClaudeAdapter({
  apiKey,
  model = PRICES.claude.model,
  effort = 'low',
  maxSearches = 3,
  maxTokens = 4_096,
  baseUrl,
  client,
  timeoutMs = 120_000,
}) {
  if (!apiKey && !client) throw new TypeError('The Claude engine needs an API key');
  const label = 'anthropic/claude';
  const claude = client ?? createClaude({ apiKey, baseURL: baseUrl, timeoutMs, maxRetries: 0 });

  const request = (task, messages) => ({
    model,
    max_tokens: maxTokens,
    // Answer in the prompt's language, as a person there would be answered.
    system: `Answer in the language with code "${baseLanguage(task.language)}".`,
    messages,
    output_config: { effort },
    tools: [
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: maxSearches,
        user_location: {
          type: 'approximate',
          country: task.country,
          ...(task.city ? { city: task.city } : {}),
        },
      },
    ],
  });

  return {
    engine: 'claude',
    provider: 'anthropic',
    method: 'api_grounded',

    estimateCostUsd: () => claudeMicros({ ...PRICES.claude.typical, model }) / 1e6,
    estimateCostMicros: () => claudeMicros({ ...PRICES.claude.typical, model }),

    async submit(task) {
      const messages = [{ role: 'user', content: task.text }];
      const content = [];
      const usage = { input: 0, output: 0, searches: 0 };
      let last = null;
      for (let turn = 0; turn <= MAX_CONTINUATIONS; turn += 1) {
        last = await claude.extract(request(task, messages));
        usage.input += last?.usage?.input_tokens ?? 0;
        usage.output += last?.usage?.output_tokens ?? 0;
        usage.searches += last?.usage?.server_tool_use?.web_search_requests ?? 0;
        const blocks = Array.isArray(last?.content) ? last.content : [];
        content.push(...blocks);
        if (last?.stop_reason !== 'pause_turn') break;
        // The turn paused inside its server-side loop: hand back what it had and let it carry on.
        messages.push({ role: 'assistant', content: blocks });
      }
      if (last?.stop_reason === 'pause_turn') {
        throw new ProviderError(`${label}: the search loop did not finish`, {
          status: 'run_pause_turn',
        });
      }
      const raw = {
        id: last?.id ?? null,
        model: last?.model ?? null,
        stop_reason: last?.stop_reason ?? null,
        stop_details: last?.stop_details ?? null,
        content: content.map(withoutOpaque),
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          web_searches: usage.searches,
        },
      };
      return {
        providerRef: clip(raw.id, 128),
        raw,
        costMicros: claudeMicros({
          inputTokens: usage.input,
          outputTokens: usage.output,
          searches: usage.searches,
          model,
        }),
        tokensIn: usage.input,
        tokensOut: usage.output,
        model: clip(raw.model, 64),
      };
    },

    async poll(handle) {
      return handle.raw;
    },

    normalize(raw, task) {
      const base = {
        engine: 'claude',
        provider: 'anthropic',
        method: 'api_grounded',
        locale: { country: task.country, language: task.language },
        providerRef: clip(raw?.id, 128),
        modelVersion: clip(raw?.model, 64),
        answeredAt: null,
      };
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.content)) {
        throw new ProviderError(`${label}: the response has no readable answer`, {
          status: 'bad_response',
        });
      }
      if (raw.stop_reason === 'refusal') {
        return checkedAnswer({ ...base, status: 'no_answer', text: '', sources: [] });
      }
      if (raw.stop_reason !== 'end_turn' && raw.stop_reason !== 'stop_sequence') {
        // `max_tokens` is an answer cut off; anything else is a stop we have not seen. Neither is "an answer".
        throw new ProviderError(
          `${label}: the run ended "${String(raw.stop_reason).slice(0, 32)}"`,
          {
            status: `run_${String(raw.stop_reason).slice(0, 20)}`,
            retryable: raw.stop_reason !== 'max_tokens',
          },
        );
      }
      const text = textOf(raw.content);
      if (!text) {
        throw new ProviderError(`${label}: the response has no readable answer`, {
          status: 'bad_response',
        });
      }
      return checkedAnswer({ ...base, status: 'ok', text, sources: sourcesOf(raw.content) });
    },
  };
}

/** The answer as the reader saw it: every text block, in order, joined. */
function textOf(content) {
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * A source is a page the answer cites, in the order it first cites it. An answer that searched but cites nothing falls
 * back to the pages the search returned (the engine did draw on them), the way the Perplexity adapter lists a run's
 * results. A search that errored contributes nothing.
 */
function sourcesOf(content) {
  const cited = [];
  const searched = [];
  for (const block of content) {
    if (block?.type === 'text') {
      for (const c of block.citations ?? []) {
        if (c?.type === 'web_search_result_location') {
          cited.push({ url: c.url, title: c.title, snippet: c.cited_text });
        }
      }
    } else if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r?.type === 'web_search_result') {
          searched.push({ url: r.url, title: r.title, snippet: null });
        }
      }
    }
  }
  return dedupeSources(cited.length ? cited : searched);
}

const omit = (object, key) =>
  Object.fromEntries(Object.entries(object ?? {}).filter(([k]) => k !== key));

/** Drop the opaque continuation tokens before the response is stored. */
function withoutOpaque(block) {
  if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) {
    return {
      ...block,
      content: block.content.map((r) => omit(r, 'encrypted_content')),
    };
  }
  if (block?.type === 'text' && Array.isArray(block.citations)) {
    return {
      ...block,
      citations: block.citations.map((c) => omit(c, 'encrypted_index')),
    };
  }
  return block;
}
