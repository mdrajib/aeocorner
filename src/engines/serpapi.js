import { checkedAnswer, ProviderError } from './contract.js';
import { clip, dedupeSources, requestJson } from './http.js';
import { baseLanguage } from './locations.js';
import { PRICES } from './pricing.js';

/**
 * Google AI Overviews through SerpApi's Google Search API (MVP §6.2, method `serp`). Docs checked 2026-10-03:
 * https://serpapi.com/ai-overview
 *
 * One Google search for the prompt's keyword form. Three outcomes:
 *   - the results page has an `ai_overview` with text blocks: the answer
 *   - it has an `ai_overview` with only a `page_token`: Google builds the overview separately, so a second
 *     request (`engine=google_ai_overview`) fetches it. The token expires within a minute, so it is fetched
 *     straight away, inside `submit`
 *   - a page token whose follow-up says Google returned nothing ("Fully empty"): Google advertised an overview
 *     but had none to show. Also `no_answer` (seen live 2026-10-03)
 *   - no `ai_overview` at all: Google showed none for this query. That is `no_answer`, a real result (it feeds
 *     the AI Overview trigger rate), never a failure and never "not mentioned"
 *
 * SerpApi bills a monthly plan per successful search, and its response says nothing about cost, so the cost is
 * the plan's price per search (configuration) times the searches made. The follow-up request is counted as a
 * search too, to be safe, until an invoice shows otherwise.
 *
 * The API key travels in the query string (SerpApi has no header for it), so URLs are never logged or put in
 * errors; requestJson's errors carry only the status.
 */
const NO_RESULTS = /hasn['’]t returned any results/i;

export function createSerpApiAdapter({
  apiKey,
  costPerSearchMicros = PRICES.serpapi.defaultPerSearch,
  baseUrl = 'https://serpapi.com',
  fetchImpl,
  timeoutMs = 60_000,
}) {
  if (!apiKey) throw new TypeError('SerpApi needs an API key');
  const label = 'serpapi/google_aio';
  const root = baseUrl.replace(/\/+$/, '');

  const get = (params) => {
    const qs = new URLSearchParams({ ...params, api_key: apiKey });
    return requestJson(`${root}/search.json?${qs}`, { timeoutMs, fetchImpl, label });
  };

  /** An `error` in an HTTP 200 body: "no results" is an answer (Google had nothing); anything else is a failure. */
  function checkError(body) {
    if (!body?.error) return;
    if (NO_RESULTS.test(String(body.error))) return;
    throw new ProviderError(`${label}: SerpApi reported an error`, { status: 'serp_error' });
  }

  return {
    engine: 'google_aio',
    provider: 'serpapi',
    method: 'serp',

    estimateCostUsd: () => costPerSearchMicros / 1e6,
    estimateCostMicros: () => costPerSearchMicros,

    async submit(task) {
      const search = await get({
        engine: 'google',
        q: task.searchQuery || task.text,
        gl: task.country.toLowerCase(),
        hl: baseLanguage(task.language),
        ...(task.city ? { location: task.city } : {}),
      });
      checkError(search);
      let searches = 1;
      let followUp = null;
      const token = search?.ai_overview?.page_token;
      if (typeof token === 'string' && token && !search.ai_overview.text_blocks) {
        followUp = await get({ engine: 'google_ai_overview', page_token: token });
        searches += 1;
        checkError(followUp);
      }
      const overview = followUp?.ai_overview ?? search?.ai_overview;
      if (overview?.error) {
        // "Can't generate an AI overview right now. Try again later."
        throw new ProviderError(`${label}: Google could not build the overview right now`, {
          status: 'aio_unavailable',
        });
      }
      return {
        providerRef: clip(search?.search_metadata?.id, 128),
        raw: { search, followUp },
        costMicros: costPerSearchMicros * searches,
        quantity: searches,
      };
    },

    async poll(handle) {
      return handle.raw;
    },

    normalize(raw, task) {
      const overview = raw?.followUp?.ai_overview ?? raw?.search?.ai_overview ?? null;
      const meta = raw?.search?.search_metadata ?? {};
      const processed = meta.processed_at ? new Date(meta.processed_at) : null;
      const base = {
        engine: 'google_aio',
        provider: 'serpapi',
        method: 'serp',
        locale: { country: task.country, language: task.language },
        providerRef: clip(meta.id, 128),
        modelVersion: null,
        answeredAt:
          processed && !Number.isNaN(processed.getTime()) ? processed.toISOString() : null,
      };
      if (!raw?.search?.search_metadata) {
        throw new ProviderError(`${label}: not a search response`, { status: 'bad_response' });
      }
      // The results page promised a separate overview (a page token) and the follow-up for it has none. When
      // SerpApi says why (Google returned nothing; the overview state is "Fully empty"), Google showed no overview:
      // `no_answer`. Seen live 2026-10-03, stable across retries hours apart. Without that statement it stays an
      // error, so a changed follow-up shape is never read as "Google showed none".
      if (raw?.followUp && !raw.followUp.ai_overview) {
        const state = String(raw.followUp.search_information?.ai_overview_state ?? '');
        if (NO_RESULTS.test(String(raw.followUp.error ?? '')) || /fully empty/i.test(state)) {
          return checkedAnswer({ ...base, status: 'no_answer', text: '', sources: [] });
        }
        throw new ProviderError(`${label}: the overview follow-up returned nothing we can read`, {
          status: 'bad_response',
        });
      }
      // No `ai_overview` at all: Google showed none. An overview we can't turn into text is a changed shape,
      // and must not be counted as "Google showed none".
      if (!overview) return checkedAnswer({ ...base, status: 'no_answer', text: '', sources: [] });
      const text = blocksToMarkdown(overview.text_blocks ?? []);
      if (!text) {
        throw new ProviderError(`${label}: the overview has no readable text`, {
          status: 'bad_response',
        });
      }

      const references = [...(overview.references ?? [])].sort(
        (a, b) => (a?.index ?? Infinity) - (b?.index ?? Infinity),
      );
      return checkedAnswer({
        ...base,
        status: 'ok',
        text,
        sources: dedupeSources(
          references.map((r) => ({ url: r?.link, title: r?.title, snippet: r?.snippet })),
        ),
      });
    },
  };
}

const MAX_DEPTH = 8;

/**
 * SerpApi's text blocks (paragraph, heading, list, expandable, table...) as Markdown. Nested lists and expandable
 * sections are followed to a fixed depth; a block type we don't know contributes its snippet if it has one.
 */
export function blocksToMarkdown(blocks, depth = 0) {
  if (!Array.isArray(blocks) || depth > MAX_DEPTH) return '';
  const out = [];
  const indent = '  '.repeat(depth);
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const snippet = typeof b.snippet === 'string' ? b.snippet.trim() : '';
    switch (b.type) {
      case 'heading':
        if (snippet) out.push(`### ${snippet}`);
        break;
      case 'list':
        for (const item of b.list ?? []) {
          const title = typeof item?.title === 'string' ? item.title.trim() : '';
          const body = typeof item?.snippet === 'string' ? item.snippet.trim() : '';
          const line = [title && `**${title}**`, body].filter(Boolean).join(' ');
          if (line) out.push(`${indent}- ${line}`);
          const nested = listToMarkdown(item?.list, depth + 1);
          if (nested) out.push(nested);
        }
        break;
      case 'expandable': {
        const title = [b.title, b.subtitle].filter((t) => typeof t === 'string' && t.trim());
        if (title.length) out.push(`**${title.join(' — ')}**`);
        const nested = blocksToMarkdown(b.text_blocks, depth + 1);
        if (nested) out.push(nested);
        break;
      }
      case 'table': {
        const rows = Array.isArray(b.table) ? b.table : [];
        for (const row of rows.slice(0, 50)) {
          if (Array.isArray(row)) out.push(`| ${row.map((c) => String(c ?? '')).join(' | ')} |`);
        }
        break;
      }
      default:
        if (snippet) out.push(snippet);
    }
  }
  return out.join('\n\n').trim();
}

function listToMarkdown(list, depth) {
  if (!Array.isArray(list) || depth > MAX_DEPTH) return '';
  return blocksToMarkdown([{ type: 'list', list }], depth);
}
