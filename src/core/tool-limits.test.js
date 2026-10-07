import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  counterSpecs,
  createToolLimiterModel,
  TOOL_LIMITS,
  untilWindowEnds,
  windowSlot,
} from './tool-limits.js';

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0); // a minute, hour and day boundary is not needed: 12:00:00 is on all three
const ask = (model, over = {}) =>
  model.admit({ kind: 'fetch', ip: '203.0.113.1', domain: 'acme.test', nowMs: T0, ...over });

describe('the windows', () => {
  test('a window ends at the next multiple of its length', () => {
    assert.equal(untilWindowEnds('minute', T0), 60_000);
    assert.equal(untilWindowEnds('minute', T0 + 59_999), 1);
    assert.equal(untilWindowEnds('hour', T0), 3_600_000);
    assert.equal(untilWindowEnds('day', T0), 12 * 3_600_000);
    assert.notEqual(windowSlot('minute', T0), windowSlot('minute', T0 + 60_000));
  });

  test('a fetch tool is counted three ways, a generator one way, and an unknown kind is a bug', () => {
    const fetchSpecs = counterSpecs('fetch', { ip: 'i', domain: 'd' }, T0);
    assert.deepEqual(
      fetchSpecs.map((s) => [s.name, s.limit]),
      [
        ['ip_minute', TOOL_LIMITS.fetch.perIpPerMinute],
        ['ip_day', TOOL_LIMITS.fetch.perIpPerDay],
        ['domain_hour', TOOL_LIMITS.fetch.perDomainPerHour],
      ],
    );
    assert.deepEqual(
      counterSpecs('generate', { ip: 'i' }, T0).map((s) => s.name),
      ['ip_minute'],
    );
    assert.throws(() => counterSpecs('other', { ip: 'i' }, T0), /Unknown tool kind/);
  });

  test('a counter outlives its window, so a clock a little off never frees it early', () => {
    for (const s of counterSpecs('fetch', { ip: 'i', domain: 'd' }, T0)) {
      assert.ok(s.ttlMs > untilWindowEnds(s.window, T0));
    }
  });
});

describe('the rule', () => {
  test('six fetches a minute: the seventh is refused and says when to come back', () => {
    const m = createToolLimiterModel();
    for (let i = 0; i < 6; i += 1) assert.equal(ask(m, { domain: `d${i}.test` }).allowed, true);
    const refused = ask(m, { domain: 'd7.test' });
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, 'ip_minute');
    assert.equal(refused.retryAfterMs, 60_000);
    assert.equal(ask(m, { nowMs: T0 + 60_000, domain: 'd8.test' }).allowed, true);
  });

  test('twenty a domain an hour, whoever asks', () => {
    const m = createToolLimiterModel();
    for (let i = 0; i < 20; i += 1) {
      const nowMs = T0 + Math.floor(i / 5) * 60_000; // four minutes, five requests each: under the minute limit
      assert.equal(ask(m, { ip: `198.51.100.${i}`, nowMs }).allowed, true);
    }
    const refused = ask(m, { ip: '198.51.100.99', nowMs: T0 + 5 * 60_000 });
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, 'domain_hour');
  });

  test('a refusal spends nothing: the other counters do not move', () => {
    const m = createToolLimiterModel();
    for (let i = 0; i < 20; i += 1)
      ask(m, { ip: `198.51.100.${i}`, nowMs: T0 + Math.floor(i / 5) * 60_000 });
    // This IP is new. The domain is full, so it is refused, and its own minute and day counters stay at zero.
    for (let i = 0; i < 3; i += 1)
      assert.equal(ask(m, { ip: '192.0.2.9', nowMs: T0 + 5 * 60_000 }).reason, 'domain_hour');
    for (let i = 0; i < 6; i += 1)
      assert.equal(
        ask(m, { ip: '192.0.2.9', domain: `other${i}.test`, nowMs: T0 + 5 * 60_000 }).allowed,
        true,
      );
  });

  test('five refusals in a day block the IP, which is then refused before anything is counted', () => {
    const m = createToolLimiterModel();
    for (let i = 0; i < 6; i += 1) ask(m, { domain: `d${i}.test` });
    for (let i = 0; i < TOOL_LIMITS.strikesToBlock; i += 1) assert.equal(ask(m).allowed, false);
    assert.equal(m.blocked.has('203.0.113.1'), true);
    const next = ask(m, { nowMs: T0 + 2 * 60_000 });
    assert.deepEqual(next, { allowed: false, reason: 'blocked' });
  });

  test('generators are limited a minute and never earn a strike', () => {
    const m = createToolLimiterModel();
    const gen = (over = {}) => m.admit({ kind: 'generate', ip: '203.0.113.5', nowMs: T0, ...over });
    for (let i = 0; i < 20; i += 1) assert.equal(gen().allowed, true);
    for (let i = 0; i < 50; i += 1) assert.equal(gen().allowed, false);
    assert.equal(m.blocked.size, 0);
    assert.equal(gen({ nowMs: T0 + 60_000 }).allowed, true);
  });
});
