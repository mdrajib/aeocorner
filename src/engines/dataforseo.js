import { checkedAnswer, PENDING, ProviderError } from './contract.js';
import { clip, dedupeSources, requestJson } from './http.js';
import { baseLanguage, DATAFORSEO_LOCATION_CODES } from './locations.js';
import { llmScraperMicros, reportedMicros } from './pricing.js';

/**
 * DataForSEO LLM Scraper: real ChatGPT and Gemini answers as a logged-out visitor sees them, sources included
 * (MVP §6.2, method `ui_capture`). Docs checked 2026-10-03:
 * https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/task_post/
 *
 * Two ways to ask:
 *   standard / priority   POST task_post, then GET task_get/advanced/<id> until it is ready (45 / 5 minutes at
 *                         most). Cheapest; what weekly tracking uses.
 *   live                  POST live/advanced and wait for the answer (up to 90 seconds). The free audit uses it.
 *
 * DataForSEO answers almost everything with HTTP 200 and puts the real outcome in `status_code`, once for the
 * whole request and once per task. It charges when the task is created; the price comes back in `cost`.
 */

const SE = { chatgpt: 'chat_gpt', gemini: 'gemini' };

// https://docs.dataforseo.com/v3/appendix/errors/
const READY = 20000;
const CREATED = 20100;
const QUEUED = new Set([40601, 40602]); // "task handed", "task in queue"
const NO_RESULTS = 40102;

function statusError(label, code, message) {
  const text = `${label}: DataForSEO ${code}${message ? ` (${String(message).slice(0, 120)})` : ''}`;
  if (code === 40100 || code === 40101) {
    return new ProviderError(text, {
      status: 'auth',
      retryable: false,
      countsAgainstProvider: false,
    });
  }
  if (code === 40210 || code === 40200) {
    return new ProviderError(text, {
      status: 'no_credit',
      retryable: false,
      countsAgainstProvider: false,
    });
  }
  if (code === 40202) return new ProviderError(text, { status: 'rate_limited' });
  if (code >= 40500 && code < 40600) {
    // 405xx: the request itself is wrong. Ours to fix; asking again won't help.
    return new ProviderError(text, {
      status: `dfs_${code}`,
      retryable: false,
      countsAgainstProvider: false,
    });
  }
  if (code === 40400 || code === 40401) {
    // The task ID is unknown or has expired (results are kept 30 days).
    return new ProviderError(text, { status: 'task_gone', retryable: false });
  }
  return new ProviderError(text, { status: `dfs_${code}` });
}

/** The one task in a response, after checking the response as a whole. */
function onlyTask(label, body) {
  if (body?.status_code !== READY)
    throw statusError(label, body?.status_code, body?.status_message);
  const task = body.tasks?.[0];
  if (!task || typeof task.status_code !== 'number') {
    throw new ProviderError(`${label}: no task in the response`, { status: 'bad_response' });
  }
  return task;
}

function isoOrNull(text) {
  // DataForSEO writes "2026-10-03 09:12:44 +00:00".
  if (typeof text !== 'string') return null;
  const d = new Date(text.replace(' ', 'T').replace(' ', ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {object} opts
 * @param {'chatgpt'|'gemini'} opts.engine
 * @param {string} opts.login       DATAFORSEO_LOGIN
 * @param {string} opts.password    DATAFORSEO_PASSWORD
 * @param {boolean} [opts.forceWebSearch]  ChatGPT only: make it search even when it wouldn't. Off by default,
 *                                  because we measure what a real visitor gets.
 */
export function createDataForSeoAdapter({
  engine,
  login,
  password,
  baseUrl = 'https://api.dataforseo.com',
  fetchImpl,
  forceWebSearch = false,
  timeoutMs = { live: 120_000, other: 30_000 },
}) {
  const se = SE[engine];
  if (!se) throw new TypeError(`DataForSEO's LLM Scraper does not cover ${engine}`);
  if (!login || !password) throw new TypeError('DataForSEO needs a login and a password');

  const auth = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
  const root = `${baseUrl.replace(/\/+$/, '')}/v3/ai_optimization/${se}/llm_scraper`;
  const label = `dataforseo/${engine}`;
  const call = (path, { method = 'GET', body, timeout = timeoutMs.other } = {}) =>
    requestJson(`${root}${path}`, {
      method,
      body,
      headers: { authorization: auth },
      timeoutMs: timeout,
      fetchImpl,
      label,
    });

  function requestFor(task) {
    const locationCode = DATAFORSEO_LOCATION_CODES[task.country];
    if (!locationCode) {
      throw new ProviderError(`${label}: country ${task.country} is not set up for DataForSEO`, {
        status: 'unsupported_location',
        retryable: false,
        countsAgainstProvider: false,
      });
    }
    return {
      keyword: task.text,
      location_code: locationCode,
      language_code: baseLanguage(task.language),
      ...(engine === 'chatgpt' && forceWebSearch ? { force_web_search: true } : {}),
    };
  }

  return {
    engine,
    provider: 'dataforseo',
    method: 'ui_capture',

    estimateCostUsd: (task) => llmScraperMicros(task.mode ?? 'standard') / 1e6,
    estimateCostMicros: (task) => llmScraperMicros(task.mode ?? 'standard'),

    async submit(task) {
      const request = requestFor(task);
      if (task.mode === 'live') {
        const body = await call('/live/advanced', {
          method: 'POST',
          body: [request],
          timeout: timeoutMs.live,
        });
        const t = onlyTask(label, body);
        if (t.status_code !== READY && t.status_code !== NO_RESULTS) {
          throw statusError(label, t.status_code, t.status_message);
        }
        return {
          providerRef: t.id ?? null,
          raw: t,
          costMicros: reportedMicros(t.cost) ?? llmScraperMicros('live'),
        };
      }

      const body = await call('/task_post', {
        method: 'POST',
        body: [{ ...request, priority: task.mode === 'priority' ? 2 : 1, tag: task.ref }],
      });
      const t = onlyTask(label, body);
      if (t.status_code !== CREATED) throw statusError(label, t.status_code, t.status_message);
      if (typeof t.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(t.id)) {
        throw new ProviderError(`${label}: the task has no usable ID`, { status: 'bad_response' });
      }
      return {
        providerRef: t.id,
        raw: null,
        costMicros: reportedMicros(t.cost) ?? llmScraperMicros(task.mode ?? 'standard'),
      };
    },

    /** The raw task once it is ready, or PENDING. Asking costs nothing. */
    async poll(handle) {
      if (handle.raw) return handle.raw;
      const body = await call(`/task_get/advanced/${encodeURIComponent(handle.providerRef)}`);
      const t = onlyTask(label, body);
      if (QUEUED.has(t.status_code)) return PENDING;
      if (t.status_code === READY || t.status_code === NO_RESULTS) return t;
      throw statusError(label, t.status_code, t.status_message);
    },

    normalize(raw, task) {
      // "No answer" must be something the provider SAID (40102, or an empty answer), never what we conclude from
      // a response we couldn't read: a changed shape would otherwise be counted as "not mentioned anywhere".
      if (raw?.status_code !== READY && raw?.status_code !== NO_RESULTS) {
        throw new ProviderError(`${label}: not a finished task`, { status: 'bad_response' });
      }
      const result = raw.status_code === READY ? raw.result?.[0] : null;
      if (raw.status_code === READY && typeof result?.markdown !== 'string') {
        throw new ProviderError(`${label}: the answer has no text field`, {
          status: 'bad_response',
        });
      }
      const text = result ? result.markdown.trim() : '';
      const base = {
        engine,
        provider: 'dataforseo',
        method: 'ui_capture',
        locale: { country: task.country, language: task.language },
        providerRef: clip(raw?.id, 128),
        modelVersion: clip(result?.model, 64),
        answeredAt: isoOrNull(result?.datetime),
      };
      if (!text) return checkedAnswer({ ...base, status: 'no_answer', text: '', sources: [] });

      // Sources are listed for the whole answer and again on the text blocks that cite them; the answer-level
      // list comes first and keeps its order.
      const fromItems = (result.items ?? []).flatMap((item) => item?.sources ?? []);
      return checkedAnswer({
        ...base,
        status: 'ok',
        text,
        sources: dedupeSources([...(result.sources ?? []), ...fromItems]),
      });
    },
  };
}
