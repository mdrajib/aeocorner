import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { normalizedAnswerSchema, PENDING, ProviderError } from '../../src/engines/contract.js';
import { createAdapters } from '../../src/engines/index.js';

/**
 * Contract tests for the engine adapters (BUILD_PLAN Phase 5): each adapter talks real HTTP to a server on this
 * machine that replays the providers' recorded responses (tests/fixtures/engines, see its README for where they
 * came from). They check what we SEND (endpoint, credentials, fields) as much as what we read back, and how every
 * kind of failure is classified. No test calls a real provider.
 */

const fixture = (path) =>
  readFileSync(new URL(`../fixtures/engines/${path}`, import.meta.url), 'utf8');

let server;
let origin;
let requests = [];
/** `${method} ${path}` -> { status, body } or a function (req) -> { status, body } | 'hang' */
let routes = {};

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const record = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
      };
      requests.push(record);
      const route = routes[`${req.method} ${url.pathname}`];
      const answer = typeof route === 'function' ? route(record) : route;
      if (answer === 'hang') return; // never answer: the adapter's time limit has to end it
      if (!answer) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  routes = {};
});

const adapters = () =>
  createAdapters(
    {
      dataforseo: { login: 'dfs-login', password: 'dfs-secret' },
      perplexity: { apiKey: 'pplx-secret' },
      serpapi: { apiKey: 'serp-secret', costPerSearchMicros: 10_000 },
    },
    { baseUrls: { dataforseo: origin, perplexity: origin, serpapi: origin } },
  );

const task = (overrides = {}) => ({
  ref: '101',
  engine: 'chatgpt',
  text: 'What is the best dental practice management software for a small clinic?',
  searchQuery: 'best dental practice management software',
  country: 'US',
  language: 'en',
  city: '',
  mode: 'standard',
  ...overrides,
});

const providerError =
  (status, { retryable, counts } = {}) =>
  (err) => {
    assert.ok(err instanceof ProviderError, `expected a ProviderError, got ${err}`);
    assert.equal(err.status, status);
    if (retryable !== undefined) assert.equal(err.retryable, retryable, 'retryable');
    if (counts !== undefined)
      assert.equal(err.countsAgainstProvider, counts, 'countsAgainstProvider');
    for (const secret of ['dfs-secret', 'pplx-secret', 'serp-secret']) {
      assert.ok(!err.message.includes(secret), 'an error never carries a credential');
    }
    return true;
  };

const DFS = '/v3/ai_optimization/chat_gpt/llm_scraper';

describe('DataForSEO LLM Scraper (ChatGPT, Gemini)', () => {
  test('standard queue: task_post with Basic auth and our fields, then task_get until ready', async () => {
    const chatgpt = adapters().get('dataforseo', 'chatgpt');
    routes[`POST ${DFS}/task_post`] = { body: fixture('dataforseo/chatgpt-task-post.json') };
    const handle = await chatgpt.submit(task());

    const [post] = requests;
    assert.equal(
      post.headers.authorization,
      `Basic ${Buffer.from('dfs-login:dfs-secret').toString('base64')}`,
    );
    assert.deepEqual(post.body, [
      {
        keyword: task().text,
        location_code: 2840,
        language_code: 'en',
        priority: 1,
        tag: '101',
      },
    ]);
    assert.deepEqual(handle, {
      providerRef: '10031512-1535-0636-0000-7f0c2a4e1b11',
      raw: null,
      costMicros: 1_200,
    });

    const getPath = `${DFS}/task_get/advanced/10031512-1535-0636-0000-7f0c2a4e1b11`;
    routes[`GET ${getPath}`] = { body: fixture('dataforseo/chatgpt-task-get-queued.json') };
    assert.equal(await chatgpt.poll(handle), PENDING);

    routes[`GET ${getPath}`] = { body: fixture('dataforseo/chatgpt-task-get-ready.json') };
    const raw = await chatgpt.poll(handle);
    const answer = chatgpt.normalize(raw, task());
    normalizedAnswerSchema.parse(answer);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.sources.length, 3);
    assert.equal(requests.filter((r) => r.method === 'GET').length, 2);
  });

  test('priority mode asks for priority 2; a language with a region is sent as the bare language', async () => {
    const chatgpt = adapters().get('dataforseo', 'chatgpt');
    routes[`POST ${DFS}/task_post`] = { body: fixture('dataforseo/chatgpt-task-post.json') };
    await chatgpt.submit(task({ mode: 'priority', language: 'en-GB', country: 'GB' }));
    assert.equal(requests[0].body[0].priority, 2);
    assert.equal(requests[0].body[0].language_code, 'en');
    assert.equal(requests[0].body[0].location_code, 2826);
  });

  test('live (Gemini): one request, the answer in the handle, the live price', async () => {
    const gemini = adapters().get('dataforseo', 'gemini');
    routes['POST /v3/ai_optimization/gemini/llm_scraper/live/advanced'] = {
      body: fixture('dataforseo/gemini-live-ready.json'),
    };
    const handle = await gemini.submit(task({ engine: 'gemini', mode: 'live' }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body[0].priority, undefined, 'live has no queue priority');
    assert.equal(handle.costMicros, 4_000);
    assert.equal(await gemini.poll(handle), handle.raw, 'polling a live answer asks nothing');
    assert.equal(requests.length, 1);
    assert.equal(gemini.normalize(handle.raw, task()).modelVersion, 'gemini-3.5-flash');
  });

  test('no results is an answer ("no_answer"), not an error', async () => {
    const gemini = adapters().get('dataforseo', 'gemini');
    routes['GET /v3/ai_optimization/gemini/llm_scraper/task_get/advanced/t1'] = {
      body: fixture('dataforseo/gemini-task-get-no-results.json'),
    };
    const raw = await gemini.poll({ providerRef: 't1', raw: null });
    assert.equal(gemini.normalize(raw, task()).status, 'no_answer');
  });

  test('a refused login is ours to fix: not retried, not held against DataForSEO', async () => {
    const chatgpt = adapters().get('dataforseo', 'chatgpt');
    routes[`POST ${DFS}/task_post`] = { status: 401, body: fixture('dataforseo/auth-failed.json') };
    await assert.rejects(
      chatgpt.submit(task()),
      providerError('auth', { retryable: false, counts: false }),
    );
    // The same failure written inside an HTTP 200, as DataForSEO also does.
    routes[`POST ${DFS}/task_post`] = { body: fixture('dataforseo/auth-failed.json') };
    await assert.rejects(
      chatgpt.submit(task()),
      providerError('auth', { retryable: false, counts: false }),
    );
  });

  test('task-level failures: rate limit and server trouble are retried; no money is not', async () => {
    const chatgpt = adapters().get('dataforseo', 'chatgpt');
    const withTaskStatus = (code) => {
      const body = JSON.parse(fixture('dataforseo/chatgpt-task-post.json'));
      body.tasks[0].status_code = code;
      body.tasks[0].status_message = 'from the fixture';
      return { body: JSON.stringify(body) };
    };
    routes[`POST ${DFS}/task_post`] = withTaskStatus(40202);
    await assert.rejects(
      chatgpt.submit(task()),
      providerError('rate_limited', { retryable: true }),
    );
    routes[`POST ${DFS}/task_post`] = withTaskStatus(50000);
    await assert.rejects(chatgpt.submit(task()), providerError('dfs_50000', { retryable: true }));
    routes[`POST ${DFS}/task_post`] = withTaskStatus(40210);
    await assert.rejects(
      chatgpt.submit(task()),
      providerError('no_credit', { retryable: false, counts: false }),
    );
    routes[`POST ${DFS}/task_post`] = withTaskStatus(40501);
    await assert.rejects(
      chatgpt.submit(task()),
      providerError('dfs_40501', { retryable: false, counts: false }),
    );
    routes[`POST ${DFS}/task_post`] = { status: 500, body: '{}' };
    await assert.rejects(chatgpt.submit(task()), providerError('http_500', { retryable: true }));
    routes[`POST ${DFS}/task_post`] = { body: 'not json' };
    await assert.rejects(chatgpt.submit(task()), providerError('bad_response'));
  });

  test('a country we have no location code for is refused before anything is sent', async () => {
    const chatgpt = adapters().get('dataforseo', 'chatgpt');
    await assert.rejects(
      chatgpt.submit(task({ country: 'KP' })),
      providerError('unsupported_location', { retryable: false, counts: false }),
    );
    assert.equal(requests.length, 0);
  });
});

describe('Perplexity Agent API', () => {
  test('POST /v1/agent: bearer key, the sonar model, web search from the prompt’s country; the reported cost', async () => {
    const perplexity = adapters().get('perplexity_api', 'perplexity');
    routes['POST /v1/agent'] = { body: fixture('perplexity/agent-ok.json') };
    const handle = await perplexity.submit(task({ engine: 'perplexity', city: 'Austin' }));

    const [req] = requests;
    assert.equal(req.headers.authorization, 'Bearer pplx-secret');
    assert.equal(req.body.model, 'perplexity/sonar');
    assert.equal(req.body.input, task().text);
    assert.deepEqual(req.body.tools, [
      {
        type: 'web_search',
        search_context_size: 'low',
        user_location: { country: 'US', city: 'Austin' },
      },
    ]);
    assert.equal(handle.costMicros, 3_776, 'usage.cost.total_cost, as reported');
    assert.deepEqual(
      [handle.tokensIn, handle.tokensOut, handle.model],
      [1180, 96, 'perplexity/sonar'],
    );
    assert.equal(await perplexity.poll(handle), handle.raw);
    const answer = perplexity.normalize(handle.raw, task());
    assert.equal(answer.status, 'ok');
    assert.equal(answer.sources.length, 4);
  });

  test('without a reported cost, the cost is counted from tokens and searches at published prices', async () => {
    const perplexity = adapters().get('perplexity_api', 'perplexity');
    const body = JSON.parse(fixture('perplexity/agent-ok.json'));
    delete body.usage.cost;
    routes['POST /v1/agent'] = { body: JSON.stringify(body) };
    const handle = await perplexity.submit(task());
    assert.equal(handle.costMicros, 1_180 + 96 + 2_500);
  });

  test('an answer cut short is a failure to retry, never a short answer', async () => {
    const perplexity = adapters().get('perplexity_api', 'perplexity');
    routes['POST /v1/agent'] = { body: fixture('perplexity/agent-incomplete.json') };
    await assert.rejects(
      perplexity.submit(task()),
      providerError('run_incomplete', { retryable: true }),
    );
  });

  test('HTTP failures are classified like every provider’s', async () => {
    const perplexity = adapters().get('perplexity_api', 'perplexity');
    routes['POST /v1/agent'] = { status: 429, body: '{"error":"slow down"}' };
    await assert.rejects(
      perplexity.submit(task()),
      providerError('rate_limited', { retryable: true }),
    );
    routes['POST /v1/agent'] = { status: 401, body: '{"error":"bad key pplx-secret"}' };
    await assert.rejects(
      perplexity.submit(task()),
      providerError('auth', { retryable: false, counts: false }),
    );
    routes['POST /v1/agent'] = { status: 502, body: '' };
    await assert.rejects(perplexity.submit(task()), providerError('http_502', { retryable: true }));
  });
});

describe('SerpApi (Google AI Overviews)', () => {
  test('one Google search for the keyword form, from the prompt’s country and language', async () => {
    const aio = adapters().get('serpapi', 'google_aio');
    routes['GET /search.json'] = { body: fixture('serpapi/google-aio-inline.json') };
    const handle = await aio.submit(task({ engine: 'google_aio' }));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].query, {
      engine: 'google',
      q: 'best dental practice management software',
      gl: 'us',
      hl: 'en',
      api_key: 'serp-secret',
    });
    assert.deepEqual([handle.costMicros, handle.quantity], [10_000, 1]);
    assert.equal(aio.normalize(handle.raw, task()).status, 'ok');
  });

  test('an overview behind a page token is fetched at once with a second request, counted as a second search', async () => {
    const aio = adapters().get('serpapi', 'google_aio');
    routes['GET /search.json'] = (req) =>
      req.query.engine === 'google_ai_overview'
        ? { body: fixture('serpapi/google-ai-overview-followup.json') }
        : { body: fixture('serpapi/google-aio-page-token.json') };
    const handle = await aio.submit(task({ searchQuery: null }));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].query.q, task().text, 'without a keyword form, the question itself');
    assert.deepEqual(requests[1].query, {
      engine: 'google_ai_overview',
      page_token: 'KIVu-nictZPdkqI4FMcv-fixture-token',
      api_key: 'serp-secret',
    });
    assert.deepEqual([handle.costMicros, handle.quantity], [20_000, 2]);
    const answer = aio.normalize(handle.raw, task());
    assert.equal(answer.status, 'ok');
    assert.match(answer.text, /Curve Dental or Open Dental/);
  });

  test('a page token whose follow-up Google left empty is "no_answer"; any other empty follow-up is an error', async () => {
    const aio = adapters().get('serpapi', 'google_aio');
    routes['GET /search.json'] = (req) =>
      req.query.engine === 'google_ai_overview'
        ? { body: fixture('serpapi/google-ai-overview-followup-empty.json') }
        : { body: fixture('serpapi/google-aio-page-token.json') };
    const handle = await aio.submit(task());
    assert.deepEqual(
      [handle.costMicros, handle.quantity],
      [20_000, 2],
      'both searches are charged',
    );
    const answer = aio.normalize(handle.raw, task());
    assert.equal(answer.status, 'no_answer');
    assert.equal(answer.text, '');

    // Either of SerpApi's two statements is enough; with neither, an empty follow-up is a changed shape.
    const without = (...keys) => {
      const followUp = JSON.parse(fixture('serpapi/google-ai-overview-followup-empty.json'));
      for (const key of keys) delete followUp[key];
      return { ...handle.raw, followUp };
    };
    assert.equal(aio.normalize(without('error'), task()).status, 'no_answer');
    assert.equal(aio.normalize(without('search_information'), task()).status, 'no_answer');
    assert.throws(
      () => aio.normalize(without('error', 'search_information'), task()),
      providerError('bad_response'),
    );
  });

  test('no overview, or no results at all, is "no_answer" (the trigger rate), after one search', async () => {
    const aio = adapters().get('serpapi', 'google_aio');
    for (const file of ['serpapi/google-no-aio.json', 'serpapi/google-no-results.json']) {
      requests = [];
      routes['GET /search.json'] = { body: fixture(file) };
      const handle = await aio.submit(task());
      assert.equal(requests.length, 1, file);
      assert.equal(aio.normalize(handle.raw, task()).status, 'no_answer', file);
    }
  });

  test('"can’t generate an overview right now" is retried later; it is not "Google showed none"', async () => {
    const aio = adapters().get('serpapi', 'google_aio');
    routes['GET /search.json'] = { body: fixture('serpapi/google-aio-error.json') };
    await assert.rejects(aio.submit(task()), providerError('aio_unavailable', { retryable: true }));
  });

  test('errors never carry the API key, which travels in the URL', async () => {
    const aio = adapters().get('serpapi', 'google_aio');
    routes['GET /search.json'] = { status: 401, body: '{"error":"Invalid API key."}' };
    await assert.rejects(aio.submit(task()), providerError('auth', { retryable: false }));
    routes['GET /search.json'] = { body: '{"error":"Your account has run out of searches."}' };
    await assert.rejects(aio.submit(task()), providerError('serp_error'));
  });
});

/** `engines:try --record` keeps the one task the provider returned; the server sends it inside this envelope. */
const inEnvelope = (path) =>
  JSON.stringify({ status_code: 20000, status_message: 'Ok.', tasks: [JSON.parse(fixture(path))] });

describe('real recorded responses (live calls on 2026-10-03), replayed over HTTP', () => {
  test('Perplexity: the reported cost and the answer come through the whole adapter', async () => {
    const perplexity = adapters().get('perplexity_api', 'perplexity');
    routes['POST /v1/agent'] = { body: fixture('perplexity/agent-recorded-2026-10-03.json') };
    const handle = await perplexity.submit(task({ engine: 'perplexity' }));
    assert.equal(handle.costMicros, 4_410);
    assert.deepEqual([handle.tokensIn, handle.tokensOut], [4269, 337]);
    const answer = perplexity.normalize(await perplexity.poll(handle), task());
    normalizedAnswerSchema.parse(answer);
    assert.equal(answer.sources.length, 15);
  });

  test('DataForSEO ChatGPT: a live answer is one request, the cited sources only', async () => {
    const chatgpt = adapters().get('dataforseo', 'chatgpt');
    routes['POST /v3/ai_optimization/chat_gpt/llm_scraper/live/advanced'] = {
      body: inEnvelope('dataforseo/chatgpt-live-recorded-2026-10-03.json'),
    };
    const handle = await chatgpt.submit(task({ mode: 'live' }));
    assert.deepEqual([requests.length, handle.costMicros], [1, 4_000]);
    const answer = chatgpt.normalize(await chatgpt.poll(handle), task());
    normalizedAnswerSchema.parse(answer);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.modelVersion, 'gpt-5-6');
    // The recording lists 33 pages ChatGPT searched; only the 3 it cited are sources.
    assert.deepEqual(
      answer.sources.map((s) => new URL(s.url).hostname),
      ['www.getpracticehelp.com', 'www.dental-practice-software.com', 'www.capterra.com'],
    );
  });

  test('DataForSEO Gemini: a live answer is one request, with its sources', async () => {
    const gemini = adapters().get('dataforseo', 'gemini');
    routes['POST /v3/ai_optimization/gemini/llm_scraper/live/advanced'] = {
      body: inEnvelope('dataforseo/gemini-live-recorded-2026-10-03.json'),
    };
    const handle = await gemini.submit(task({ engine: 'gemini', mode: 'live' }));
    assert.deepEqual([requests.length, handle.costMicros], [1, 4_000]);
    const answer = gemini.normalize(await gemini.poll(handle), task({ engine: 'gemini' }));
    normalizedAnswerSchema.parse(answer);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.modelVersion, '3.5 Flash-Lite');
    assert.equal(answer.sources.length, 5);
  });

  test('SerpApi: an overview on the results page itself takes one search', async () => {
    const aio = adapters().get('serpapi', 'google_aio');
    routes['GET /search.json'] = { body: fixture('serpapi/google-aio-recorded-2026-10-03.json') };
    const handle = await aio.submit(task({ engine: 'google_aio' }));
    assert.deepEqual([requests.length, handle.quantity, handle.costMicros], [1, 1, 10_000]);
    const answer = aio.normalize(handle.raw, task());
    normalizedAnswerSchema.parse(answer);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.sources.length, 7);
  });
});

test('a provider that never answers is cut off by the time limit and reported as a timeout', async () => {
  const { createPerplexityAdapter } = await import('../../src/engines/perplexity.js');
  const slow = createPerplexityAdapter({ apiKey: 'pplx-secret', baseUrl: origin, timeoutMs: 300 });
  routes['POST /v1/agent'] = 'hang';
  const started = Date.now();
  await assert.rejects(slow.submit(task()), (err) => {
    providerError('timeout', { retryable: true })(err);
    assert.equal(err.name, 'TimeoutError', 'callProvider counts it as a timeout for the breaker');
    return true;
  });
  assert.ok(Date.now() - started < 5_000);
});
