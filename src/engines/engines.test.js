import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { assertAdapter, normalizedAnswerSchema, ProviderError } from './contract.js';
import { createDataForSeoAdapter } from './dataforseo.js';
import { dedupeSources, domainOf, httpError } from './http.js';
import { adapterRegistry, createAdapters } from './index.js';
import { createPerplexityAdapter } from './perplexity.js';
import { llmScraperMicros, perplexityMicros, PRICES, reportedMicros } from './pricing.js';
import { blocksToMarkdown, createSerpApiAdapter } from './serpapi.js';

/**
 * The adapters without a network: normalize() over the recorded fixtures, cost estimates against the published
 * prices, and the small helpers. The same adapters over real HTTP are in tests/adapters/engines.test.js.
 */

const fixture = (path) =>
  JSON.parse(
    readFileSync(new URL(`../../tests/fixtures/engines/${path}`, import.meta.url), 'utf8'),
  );

const task = {
  ref: '101',
  engine: 'chatgpt',
  text: 'What is the best dental practice management software for a small clinic?',
  searchQuery: 'best dental practice management software',
  country: 'US',
  language: 'en',
  city: '',
  mode: 'standard',
};

const chatgpt = createDataForSeoAdapter({ engine: 'chatgpt', login: 'l', password: 'p' });
const gemini = createDataForSeoAdapter({ engine: 'gemini', login: 'l', password: 'p' });
const perplexity = createPerplexityAdapter({ apiKey: 'k' });
const serpapi = createSerpApiAdapter({ apiKey: 'k' });

describe('normalize(): one shape whoever provided the answer', () => {
  const answers = {
    chatgpt: chatgpt.normalize(fixture('dataforseo/chatgpt-task-get-ready.json').tasks[0], task),
    gemini: gemini.normalize(fixture('dataforseo/gemini-live-ready.json').tasks[0], task),
    perplexity: perplexity.normalize(fixture('perplexity/agent-ok.json'), task),
    google_aio: serpapi.normalize({ search: fixture('serpapi/google-aio-inline.json') }, task),
  };

  test('every provider’s answer passes the same schema, with the same keys', () => {
    const keys = Object.keys(normalizedAnswerSchema.shape).sort();
    for (const [engine, answer] of Object.entries(answers)) {
      normalizedAnswerSchema.parse(answer);
      assert.deepEqual(Object.keys(answer).sort(), keys, engine);
      assert.equal(answer.engine, engine);
      assert.equal(answer.status, 'ok', engine);
      assert.ok(answer.text.length > 50, `${engine} has the answer text`);
      assert.ok(answer.sources.length >= 2, `${engine} has sources`);
      assert.deepEqual(
        answer.sources.map((s) => s.position),
        answer.sources.map((_s, i) => i + 1),
        `${engine}: sources are numbered 1..n`,
      );
      assert.deepEqual(answer.locale, { country: 'US', language: 'en' });
    }
  });

  test('ChatGPT (DataForSEO): Markdown text, the model, answer sources first then block sources, no repeats', () => {
    const a = answers.chatgpt;
    assert.match(a.text, /^For a small dental clinic/);
    assert.match(a.text, /\*\*Curve Dental\*\*/);
    assert.equal(a.modelVersion, 'gpt-5-3');
    assert.equal(a.answeredAt, '2026-10-03T09:12:44.000Z');
    assert.equal(a.providerRef, '10031512-1535-0636-0000-7f0c2a4e1b11');
    assert.deepEqual(
      a.sources.map((s) => s.url),
      [
        'https://www.capterra.com/dental-software/',
        'https://www.curvedental.com/',
        'https://www.opendental.com/',
      ],
    );
    assert.equal(a.sources[0].domain, 'capterra.com');
    assert.equal(a.sources[1].snippet, null);
  });

  test('Gemini (DataForSEO live): the same adapter code, the gemini source type', () => {
    assert.equal(answers.gemini.modelVersion, 'gemini-3.5-flash');
    assert.equal(answers.gemini.method, 'ui_capture');
    assert.equal(answers.gemini.sources[0].domain, 'planetdds.com');
  });

  test('Perplexity: text from the message, search results then cited pages they missed, the model it named', () => {
    const a = answers.perplexity;
    assert.equal(a.method, 'api_grounded');
    assert.equal(a.modelVersion, 'perplexity/sonar');
    assert.match(a.text, /\*\*Curve Dental\*\* and \*\*Open Dental\*\*/);
    assert.deepEqual(
      a.sources.map((s) => s.domain),
      ['capterra.com', 'opendental.com', 'reddit.com', 'curvedental.com'],
    );
    assert.equal(a.answeredAt, new Date(1791019204 * 1000).toISOString());
  });

  test('AI Overviews: text blocks as Markdown, references in their index order', () => {
    const a = answers.google_aio;
    assert.equal(a.method, 'serp');
    assert.equal(a.modelVersion, null);
    assert.match(a.text, /- \*\*Dentrix Ascend:\*\* Cloud-based/);
    assert.match(a.text, /### What to look for/);
    assert.match(a.text, /\*\*Key features\*\*\n\nScheduling, charting/);
    assert.match(a.text, /Best for:/, 'a nested list is kept');
    assert.deepEqual(
      a.sources.map((s) => s.url),
      [
        'https://www.capterra.com/dental-software/',
        'https://www.dentrixascend.com/',
        'https://www.opendental.com/',
      ],
    );
    assert.equal(a.answeredAt, '2026-10-03T09:30:11.000Z');
  });

  test('AI Overviews fetched with a page token: the follow-up overview is the answer', () => {
    const a = serpapi.normalize(
      {
        search: fixture('serpapi/google-aio-page-token.json'),
        followUp: fixture('serpapi/google-ai-overview-followup.json'),
      },
      task,
    );
    assert.equal(a.status, 'ok');
    assert.match(a.text, /Curve Dental or Open Dental/);
    assert.equal(a.sources.length, 2);
    assert.equal(
      a.providerRef,
      '66fe1b0000000000000000aa',
      'the search, not the follow-up, is the reference',
    );
  });

  test('no answer is "no_answer", never a failure and never an empty "ok"', () => {
    const emptyMessage = {
      id: 'x',
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ' ' }] },
      ],
    };
    const cases = [
      chatgpt.normalize(fixture('dataforseo/gemini-task-get-no-results.json').tasks[0], task),
      serpapi.normalize({ search: fixture('serpapi/google-no-aio.json') }, task),
      serpapi.normalize({ search: fixture('serpapi/google-no-results.json') }, task),
      perplexity.normalize(emptyMessage, task),
    ];
    for (const a of cases) {
      assert.equal(a.status, 'no_answer');
      assert.equal(a.text, '');
      assert.deepEqual(a.sources, []);
    }
  });

  test('a provider that changes shape fails loudly; it is never read as "no answer"', () => {
    const badResponse = (e) => e instanceof ProviderError && e.status === 'bad_response';

    const renamed = structuredClone(fixture('dataforseo/chatgpt-task-get-ready.json').tasks[0]);
    renamed.result[0].text = renamed.result[0].markdown;
    delete renamed.result[0].markdown;
    assert.throws(() => chatgpt.normalize(renamed, task), badResponse);
    assert.throws(() => chatgpt.normalize({ status_code: 40602 }, task), badResponse);

    const reshaped = structuredClone(fixture('perplexity/agent-ok.json'));
    reshaped.output = reshaped.output.map((i) =>
      i.type === 'message' ? { ...i, type: 'reply' } : i,
    );
    assert.throws(() => perplexity.normalize(reshaped, task), badResponse);
    assert.throws(
      () => perplexity.normalize({ status: 'completed', output: [] }, task),
      badResponse,
    );

    const aio = structuredClone(fixture('serpapi/google-aio-inline.json'));
    aio.ai_overview.blocks = aio.ai_overview.text_blocks;
    delete aio.ai_overview.text_blocks;
    assert.throws(() => serpapi.normalize({ search: aio }, task), badResponse);
    assert.throws(() => serpapi.normalize({ html: '<p>' }, task), badResponse);

    // An over-long field is clipped, not fatal; the schema is the last check on what leaves the adapter.
    const long = structuredClone(fixture('dataforseo/chatgpt-task-get-ready.json').tasks[0]);
    long.result[0].model = 'x'.repeat(200);
    assert.equal(chatgpt.normalize(long, task).modelVersion.length, 64);
  });
});

describe('estimateCostUsd(): the published prices (checked 2026-10-03)', () => {
  test('DataForSEO LLM Scraper: $0.0012 standard, $0.0024 priority, $0.004 live, for ChatGPT and Gemini alike', () => {
    for (const adapter of [chatgpt, gemini]) {
      assert.equal(adapter.estimateCostUsd({ ...task, mode: 'standard' }), 0.0012);
      assert.equal(adapter.estimateCostUsd({ ...task, mode: 'priority' }), 0.0024);
      assert.equal(adapter.estimateCostUsd({ ...task, mode: 'live' }), 0.004);
    }
    assert.equal(llmScraperMicros('standard'), 1_200);
    assert.throws(() => llmScraperMicros('express'), RangeError);
  });

  test('DataForSEO: the estimate equals the cost the provider reported in the fixtures exactly', () => {
    const posted = fixture('dataforseo/chatgpt-task-post.json').tasks[0];
    assert.equal(reportedMicros(posted.cost), chatgpt.estimateCostMicros({ mode: 'standard' }));
    const live = fixture('dataforseo/gemini-live-ready.json').tasks[0];
    assert.equal(reportedMicros(live.cost), gemini.estimateCostMicros({ mode: 'live' }));
  });

  test('Perplexity: $1 per million tokens in and out plus $0.0025 a search; a typical answer is about $0.004', () => {
    assert.equal(perplexity.estimateCostUsd(task), 0.004);
    // Built up from the price list, not restated: 1,180 in + 96 out + one search.
    assert.equal(perplexityMicros({ inputTokens: 1180, outputTokens: 96, searches: 1 }), 3_776);
  });

  test('Perplexity: the estimate is within the documented ±50% of what the provider reported', () => {
    // Token counts vary with the question and the sources, so the estimate is a guide; the ledger records the
    // provider's own figure. ±50% is the tolerance written in ADR-0006.
    const reported = reportedMicros(fixture('perplexity/agent-ok.json').usage.cost.total_cost);
    const estimate = perplexity.estimateCostMicros(task);
    assert.ok(Math.abs(estimate - reported) / reported <= 0.5, `${estimate} vs ${reported}`);
    // And the reported figure is consistent with the published prices for the tokens it reports.
    assert.equal(reported, perplexityMicros({ inputTokens: 1180, outputTokens: 96, searches: 1 }));
  });

  test('SerpApi: the configured plan’s price per search (default: Production, $150 / 15,000 = $0.010)', () => {
    assert.equal(serpapi.estimateCostUsd(task), 0.01);
    assert.equal(PRICES.serpapi.defaultPerSearch, Math.round((150 / 15_000) * 1e6));
    const developer = createSerpApiAdapter({ apiKey: 'k', costPerSearchMicros: 15_000 });
    assert.equal(developer.estimateCostUsd(task), 0.015);
  });

  test('reported costs: floats become whole micro-dollars; nonsense is ignored', () => {
    assert.equal(reportedMicros(0.0012000000000000001), 1_200);
    assert.equal(reportedMicros(0.003776), 3_776);
    for (const bad of [undefined, null, -1, NaN, Infinity, '0.1']) {
      assert.equal(reportedMicros(bad), null, String(bad));
    }
  });
});

describe('helpers', () => {
  test('domainOf(): host without www, lower-case; nothing for non-web URLs', () => {
    assert.equal(domainOf('https://WWW.Example.com/a?b'), 'example.com');
    assert.equal(domainOf('http://sub.example.co.uk'), 'sub.example.co.uk');
    assert.equal(domainOf('javascript:alert(1)'), null);
    assert.equal(domainOf('not a url'), null);
  });

  test('dedupeSources(): first occurrence wins, renumbered, empty and oversized URLs dropped', () => {
    const out = dedupeSources([
      { url: 'https://a.test/' },
      { url: '' },
      { url: 'https://b.test/', title: '  B  ', domain: 'WWW.B.TEST' },
      { url: 'https://a.test/', title: 'again' },
      { url: `https://c.test/${'x'.repeat(2100)}` },
      null,
    ]);
    assert.deepEqual(
      out.map((s) => [s.url, s.position, s.domain, s.title]),
      [
        ['https://a.test/', 1, 'a.test', null],
        ['https://b.test/', 2, 'b.test', 'B'],
      ],
    );
  });

  test('httpError(): whose fault it is decides retrying and the breaker', () => {
    const cases = [
      [401, 'auth', false, false],
      [403, 'auth', false, false],
      [402, 'no_credit', false, false],
      [400, 'http_400', false, false],
      [404, 'http_404', false, false],
      [429, 'rate_limited', true, true],
      [408, 'http_408', true, true],
      [500, 'http_500', true, true],
      [503, 'http_503', true, true],
    ];
    for (const [code, status, retryable, counts] of cases) {
      const err = httpError('x', code);
      assert.ok(err instanceof ProviderError);
      assert.deepEqual(
        [err.status, err.retryable, err.countsAgainstProvider],
        [status, retryable, counts],
        String(code),
      );
    }
  });

  test('blocksToMarkdown(): unknown blocks keep their snippet; nesting stops at a fixed depth', () => {
    assert.equal(
      blocksToMarkdown([{ type: 'video', snippet: 'Watch this' }, 'junk', null]),
      'Watch this',
    );
    let deep = { type: 'paragraph', snippet: 'bottom' };
    for (let i = 0; i < 50; i += 1)
      deep = { type: 'expandable', title: `level ${i}`, text_blocks: [deep] };
    const md = blocksToMarkdown([deep]);
    assert.ok(!md.includes('bottom'), 'not followed past the limit');
    assert.match(md, /level 49/);
  });

  test('assertAdapter() and the registry: every adapter meets the contract; keys are provider/engine', () => {
    const registry = createAdapters({
      dataforseo: { login: 'l', password: 'p' },
      perplexity: { apiKey: 'k' },
      serpapi: { apiKey: 'k' },
    });
    assert.deepEqual(
      registry
        .list()
        .map((a) => `${a.provider}/${a.engine}`)
        .sort(),
      [
        'dataforseo/chatgpt',
        'dataforseo/gemini',
        'perplexity_api/perplexity',
        'serpapi/google_aio',
      ],
    );
    assert.equal(registry.get('serpapi', 'chatgpt'), null);
    assert.equal(createAdapters({}).list().length, 0, 'no credentials, no adapters');
    assert.throws(() => adapterRegistry([{ ...perplexity, poll: undefined }]), /poll/);
    assert.throws(() => assertAdapter({ ...perplexity, engine: 'bing' }), /Unknown engine/);
  });

  test('adapters refuse to start without credentials', () => {
    assert.throws(() => createDataForSeoAdapter({ engine: 'chatgpt' }), /login/);
    assert.throws(() =>
      createDataForSeoAdapter({ engine: 'perplexity', login: 'l', password: 'p' }),
    );
    assert.throws(() => createPerplexityAdapter({}), /API key/);
    assert.throws(() => createSerpApiAdapter({}), /API key/);
  });
});
