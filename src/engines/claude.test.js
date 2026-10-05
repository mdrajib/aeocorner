import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { assertAdapter, normalizedAnswerSchema, ProviderError } from './contract.js';
import { createClaudeAdapter } from './claude.js';
import { createAdapters } from './index.js';
import { claudeMicros, PRICES } from './pricing.js';

/**
 * The Claude engine adapter without a network: a stand-in client answers with the documented Messages API shapes
 * (tests/fixtures/engines/claude). The same adapter over real HTTP is in tests/adapters/engines.test.js.
 */

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../tests/fixtures/engines/claude/${name}.json`, import.meta.url),
      'utf8',
    ),
  );

const task = {
  ref: '101',
  engine: 'claude',
  text: 'What is the best dental practice management software for a small clinic?',
  searchQuery: null,
  country: 'US',
  language: 'en',
  city: '',
  mode: 'standard',
};

/** A client that answers each call with the next fixture and remembers what it was asked. */
function standIn(...replies) {
  const calls = [];
  return {
    calls,
    extract: async (params) => {
      calls.push(structuredClone(params));
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (reply instanceof Error) throw reply;
      return structuredClone(reply);
    },
  };
}

const adapterFor = (client, options = {}) => createClaudeAdapter({ client, ...options });

describe('Claude engine adapter', () => {
  test('meets the contract, and is built only when there are credentials', () => {
    assertAdapter(adapterFor(standIn()));
    assert.throws(() => createClaudeAdapter({}), /API key/);
    const registry = createAdapters({ claude: { apiKey: 'k' } });
    assert.deepEqual(
      registry.list().map((a) => `${a.provider}/${a.engine}`),
      ['anthropic/claude'],
    );
    assert.equal(createAdapters({ claude: null }).list().length, 0);
  });

  test('asks one question with web search on, in the prompt’s language and place, at low effort', async () => {
    const client = standIn(fixture('messages-ok'));
    await adapterFor(client).submit({ ...task, language: 'de-AT', city: 'Wien' });
    const [asked] = client.calls;
    assert.equal(asked.model, 'claude-sonnet-5-5');
    assert.deepEqual(asked.messages, [{ role: 'user', content: task.text }]);
    assert.match(asked.system, /"de"/);
    assert.deepEqual(asked.output_config, { effort: 'low' });
    assert.deepEqual(asked.tools, [
      {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: 3,
        user_location: { type: 'approximate', country: 'US', city: 'Wien' },
      },
    ]);
    assert.ok(asked.max_tokens >= 1024);
    assert.equal(asked.temperature, undefined, 'no sampling settings: newer models reject them');
    assert.equal(asked.thinking, undefined, 'thinking is left to the model');
  });

  test('a normal answer: text in order, cited pages as sources, cost counted from usage and searches', async () => {
    const adapter = adapterFor(standIn(fixture('messages-ok')));
    const handle = await adapter.submit(task);
    assert.equal(handle.providerRef, 'msg_01ClaudeEngineFixtureOk');
    assert.equal(handle.model, 'claude-sonnet-5-5');
    assert.equal(handle.tokensIn, 5120);
    assert.equal(handle.tokensOut, 640);
    // 5,120 × $2/M + 640 × $10/M + one search at $0.01.
    assert.equal(handle.costMicros, 10_240 + 6_400 + 10_000);
    assert.equal(await adapter.poll(handle), handle.raw);

    const answer = adapter.normalize(handle.raw, task);
    normalizedAnswerSchema.parse(answer);
    assert.equal(answer.status, 'ok');
    assert.equal(answer.engine, 'claude');
    assert.equal(answer.provider, 'anthropic');
    assert.equal(answer.method, 'api_grounded');
    assert.equal(answer.modelVersion, 'claude-sonnet-5-5');
    assert.match(
      answer.text,
      /^I'll look up current options\.For a small clinic, cloud-based tools such as DentOS/,
    );
    assert.match(answer.text, /Pricing starts around \$200 a month\.$/);
    // The pages the answer cites, in the order it first cites them, numbered 1..n and de-duplicated; the third page
    // the search returned was never cited and is not a source.
    assert.deepEqual(
      answer.sources.map((s) => [s.position, s.domain]),
      [
        [1, 'example-reviews.com'],
        [2, 'dentalpractice.example.org'],
      ],
    );
    assert.match(answer.sources[0].snippet, /easiest cloud option/);
  });

  test('the stored raw response keeps addresses and titles but not Anthropic’s opaque tokens', async () => {
    const handle = await adapterFor(standIn(fixture('messages-ok'))).submit(task);
    const text = JSON.stringify(handle.raw);
    assert.ok(!text.includes('encrypted_content'));
    assert.ok(!text.includes('encrypted_index'));
    assert.ok(text.includes('https://vendor.example.net/pricing'));
  });

  test('an answer that searched but cites nothing lists the pages the search returned', async () => {
    const adapter = adapterFor(standIn(fixture('messages-no-citations')));
    const answer = adapter.normalize((await adapter.submit(task)).raw, task);
    assert.deepEqual(
      answer.sources.map((s) => s.domain),
      ['a.example.com', 'b.example.com'],
    );
  });

  test('a search that failed is not a source; the answer still counts', async () => {
    const adapter = adapterFor(standIn(fixture('messages-search-error')));
    const answer = adapter.normalize((await adapter.submit(task)).raw, task);
    assert.equal(answer.status, 'ok');
    assert.deepEqual(answer.sources, []);
  });

  test('"no answer" is only something Claude said: a refusal. Everything unreadable is an error', async () => {
    const refusal = adapterFor(standIn(fixture('messages-refusal')));
    const refused = refusal.normalize((await refusal.submit(task)).raw, task);
    assert.equal(refused.status, 'no_answer');
    assert.equal(refused.text, '');
    assert.deepEqual(refused.sources, []);

    const empty = adapterFor(standIn(fixture('messages-empty')));
    const emptyRaw = (await empty.submit(task)).raw;
    assert.throws(
      () => empty.normalize(emptyRaw, task),
      (e) => e.status === 'bad_response',
    );

    const cut = adapterFor(standIn(fixture('messages-max-tokens')));
    const cutRaw = (await cut.submit(task)).raw;
    assert.throws(
      () => cut.normalize(cutRaw, task),
      (e) => e instanceof ProviderError && e.status === 'run_max_tokens' && e.retryable === false,
    );
  });

  test('a changed shape throws, loudly, and never becomes an empty answer', () => {
    const adapter = adapterFor(standIn());
    for (const raw of [
      null,
      'text',
      {},
      { content: 'text', stop_reason: 'end_turn' },
      { content: {} },
    ]) {
      assert.throws(
        () => adapter.normalize(raw, task),
        (e) => e instanceof ProviderError && e.status === 'bad_response',
        JSON.stringify(raw),
      );
    }
    // A stop we have never seen is not an answer either.
    assert.throws(
      () =>
        adapter.normalize(
          { content: [{ type: 'text', text: 'hi' }], stop_reason: 'something_new' },
          task,
        ),
      (e) => e.status === 'run_something_new',
    );
  });

  test('a paused turn is continued, usage of every turn is added up, and a loop that never ends is an error', async () => {
    const client = standIn(fixture('messages-pause-turn'), fixture('messages-ok'));
    const adapter = adapterFor(client);
    const handle = await adapter.submit(task);
    assert.equal(client.calls.length, 2);
    // The second request hands back what the first turn had produced, as the assistant.
    assert.equal(client.calls[1].messages.at(-1).role, 'assistant');
    assert.equal(client.calls[1].messages.at(-1).content[0].type, 'server_tool_use');
    assert.equal(handle.tokensIn, 1000 + 5120);
    assert.equal(handle.tokensOut, 50 + 640);
    assert.equal(handle.raw.usage.web_searches, 2);
    assert.equal(
      handle.costMicros,
      claudeMicros({ inputTokens: 6120, outputTokens: 690, searches: 2 }),
    );
    assert.equal(adapter.normalize(handle.raw, task).status, 'ok');

    const stuck = adapterFor(standIn(fixture('messages-pause-turn')));
    await assert.rejects(
      () => stuck.submit(task),
      (e) => e instanceof ProviderError && e.status === 'run_pause_turn',
    );
  });

  test('errors from the client pass through as they are', async () => {
    const boom = new ProviderError('anthropic messages.create: HTTP 529 (overloaded_error)', {
      status: 'overloaded',
    });
    await assert.rejects(
      () => adapterFor(standIn(boom)).submit(task),
      (e) => e === boom,
    );
  });

  test('cost estimate: a typical run is about three cents, and an unknown model has no price', () => {
    const adapter = adapterFor(standIn());
    assert.equal(adapter.estimateCostMicros(task), claudeMicros(PRICES.claude.typical));
    assert.equal(adapter.estimateCostUsd(task), adapter.estimateCostMicros(task) / 1e6);
    assert.ok(adapter.estimateCostUsd(task) > 0.02 && adapter.estimateCostUsd(task) < 0.05);
    assert.throws(
      () => claudeMicros({ inputTokens: 1, outputTokens: 1, searches: 0, model: 'x' }),
      RangeError,
    );
    // The Opus 5.5 setting costs about twice as much per token.
    const opus = createClaudeAdapter({ client: standIn(), model: 'claude-opus-5-5' });
    assert.ok(opus.estimateCostMicros(task) > adapter.estimateCostMicros(task));
  });
});
