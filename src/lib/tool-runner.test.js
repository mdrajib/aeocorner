import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSafeFetcher, FetchError } from '../crawler/safe-fetch.js';
import { CouldntCheck, createToolRunner, plainReason, TOOL_RUN_LIMITS } from './tool-runner.js';

const page = (over = {}) => ({
  url: 'https://acme.test/robots.txt',
  status: 200,
  headers: {},
  body: Buffer.from('User-agent: *\nAllow: /\n'),
  bodySkipped: false,
  contentType: 'text/plain',
  redirects: [],
  connections: [{ host: 'acme.test', address: '203.0.113.9', port: 443 }],
  ...over,
});

/** A fetcher that records what it was asked and answers with `answer(url, options)`. */
function fakeFetcher(answer = async () => page()) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options });
      return answer(url, options);
    },
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('a run', () => {
  test('hands back what the tool returned, and how many fetches it made', async () => {
    const fetcher = fakeFetcher();
    const runner = createToolRunner({ fetcher });
    const out = await runner.run(async (ctx) => {
      const res = await ctx.get('https://acme.test/robots.txt');
      return { status: res.status };
    });
    assert.deepEqual(out, { status: 'ok', result: { status: 200 }, fetches: 1 });
    assert.equal(runner.inFlight(), 0);
  });

  test('the sixth fetch is refused as data, and the tool decides what to say', async () => {
    const fetcher = fakeFetcher();
    const runner = createToolRunner({ fetcher });
    const out = await runner.run(async (ctx) => {
      const seen = [];
      for (let i = 0; i < 7; i += 1) seen.push(await ctx.get(`https://acme.test/${i}`));
      return seen.map((r) => (r.ok ? 'ok' : r.error.code));
    });
    assert.deepEqual(out.result, [
      ...Array(TOOL_RUN_LIMITS.maxFetches).fill('ok'),
      'tool_fetch_cap',
      'tool_fetch_cap',
    ]);
    assert.equal(fetcher.calls.length, TOOL_RUN_LIMITS.maxFetches, 'nothing reached the network');
  });

  test('redirects count: a few fetches that each follow a long chain run out of connections', async () => {
    const hops = Array.from({ length: 8 }, (_, i) => ({
      host: `h${i}.test`,
      address: '1.1.1.1',
      port: 443,
    }));
    const fetcher = fakeFetcher(async () => page({ connections: hops }));
    const runner = createToolRunner({ fetcher });
    const out = await runner.run(async (ctx) => {
      const codes = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await ctx.get(`https://acme.test/${i}`);
        codes.push(r.ok ? 'ok' : r.error.code);
      }
      return codes;
    });
    assert.deepEqual(out.result, ['ok', 'ok', 'tool_fetch_cap', 'tool_fetch_cap']);
  });

  test('a request never gets longer than the time left, and none starts after the deadline', async () => {
    const fetcher = fakeFetcher();
    const runner = createToolRunner({ fetcher, limits: { deadlineMs: 400 } });
    const out = await runner.run(async (ctx) => {
      await ctx.get('https://acme.test/a', { timeoutMs: 15_000 });
      await wait(450);
      const late = await ctx.get('https://acme.test/b');
      return late.ok ? 'ok' : late.error.code;
    });
    assert.ok(fetcher.calls[0].options.timeoutMs <= 400, 'clamped to the deadline');
    // The tool outlasted the deadline, so the run gave up on it, and the late fetch never started.
    assert.equal(out.status, 'couldnt_check');
    assert.equal(out.reason, plainReason(new FetchError('tool_deadline', '')));
    await wait(100);
    assert.equal(fetcher.calls.length, 1);
  });

  test('a tool that never finishes is given up on at the deadline and frees its place', async () => {
    const runner = createToolRunner({ fetcher: fakeFetcher(), limits: { deadlineMs: 80 } });
    const started = Date.now();
    const out = await runner.run(() => new Promise(() => {}));
    assert.equal(out.status, 'couldnt_check');
    assert.ok(Date.now() - started < 1000);
    assert.equal(runner.inFlight(), 0);
  });

  test('the robots gate goes through the same counted fetcher', async () => {
    const fetcher = fakeFetcher();
    const runner = createToolRunner({ fetcher });
    const out = await runner.run(async (ctx) => {
      const verdict = await ctx.robots.allow('https://acme.test/some/page');
      return { verdict, requests: ctx.requests() };
    });
    assert.deepEqual(out.result, { verdict: { allowed: true }, requests: 1 });
    assert.equal(fetcher.calls[0].url, 'https://acme.test/robots.txt');
  });
});

describe('too many at once', () => {
  test('the fifth run at the same moment is told it is busy, and a finished run frees a place', async () => {
    const runner = createToolRunner({ fetcher: fakeFetcher() });
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = () => runner.run(async () => (await gate, 'done'));
    const running = Array.from({ length: TOOL_RUN_LIMITS.inFlight }, slow);
    await wait(10);
    assert.deepEqual(await runner.run(async () => 'x'), { status: 'busy' });
    release();
    assert.ok((await Promise.all(running)).every((r) => r.status === 'ok'));
    assert.equal((await runner.run(async () => 'x')).status, 'ok');
  });
});

describe('what a visitor is told', () => {
  test('an error from our own code is never shown: its text goes to the log only', async () => {
    const logged = [];
    const runner = createToolRunner({
      fetcher: fakeFetcher(),
      log: (event, data) => logged.push([event, data]),
    });
    const out = await runner.run(async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:6379 for /srv/secret/path');
    });
    assert.equal(out.status, 'couldnt_check');
    assert.doesNotMatch(out.reason, /10\.0\.0\.5|secret|ECONNREFUSED/);
    assert.match(JSON.stringify(logged), /10\.0\.0\.5/, 'it is in the log, for us');
  });

  test('a refusal by the guard does not say which address or why', async () => {
    const reason = plainReason(
      new FetchError('blocked_address', 'evil.test points at 127.0.0.1 (loopback)', {
        address: '127.0.0.1',
      }),
    );
    assert.match(reason, /public websites/);
    assert.doesNotMatch(reason, /127|loopback|evil/);
  });

  test('a tool that knows why can say so in its own words', async () => {
    const runner = createToolRunner({ fetcher: fakeFetcher() });
    const out = await runner.run(async () => {
      throw new CouldntCheck('The site answered with a sign-in page.');
    });
    assert.deepEqual(out, {
      status: 'couldnt_check',
      reason: 'The site answered with a sign-in page.',
      fetches: 0,
    });
  });

  test('every code the fetcher can throw has words of its own or the general ones, never the code', () => {
    for (const code of [
      'timeout',
      'dns_failed',
      'connect_failed',
      'tls_failed',
      'network_error',
      'too_large',
      'too_many_redirects',
      'unsupported_encoding',
      'bad_url',
      'something_new',
    ]) {
      const reason = plainReason(new FetchError(code, 'detail that must not appear'));
      assert.doesNotMatch(reason, /detail|_/);
      assert.ok(reason.endsWith('.'));
    }
  });
});

describe('with the real safe fetcher', () => {
  const runner = () => createToolRunner({ fetcher: createSafeFetcher() });
  for (const address of [
    'http://127.0.0.1/robots.txt',
    'http://[::1]/robots.txt',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/robots.txt',
    'http://10.0.0.1:6379/',
    'http://user:pass@example.com/',
    'file:///etc/passwd',
  ]) {
    test(`${address} is refused, and the answer names nothing`, async () => {
      const out = await runner().run(async (ctx) => {
        const res = await ctx.get(address);
        if (res.ok) return { opened: true };
        throw new FetchError(res.error.code, res.error.message);
      });
      assert.equal(out.status, 'couldnt_check');
      assert.doesNotMatch(out.reason, /127|169|10\.0|localhost|passwd|pass/);
    });
  }
});

describe('planning with the fetches left', () => {
  test('fetchesLeft counts down as the tool fetches, and stops at zero', async () => {
    const runner = createToolRunner({ fetcher: fakeFetcher() });
    const out = await runner.run(async (ctx) => {
      const seen = [ctx.fetchesLeft()];
      await ctx.get('https://acme.test/a');
      seen.push(ctx.fetchesLeft());
      for (let i = 0; i < 10; i += 1) await ctx.get(`https://acme.test/${i}`);
      seen.push(ctx.fetchesLeft());
      return seen;
    });
    assert.deepEqual(out.result, [TOOL_RUN_LIMITS.maxFetches, TOOL_RUN_LIMITS.maxFetches - 1, 0]);
  });
});
