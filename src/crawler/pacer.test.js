import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHostPacer } from './pacer.js';

/** A clock that only moves when the pacer sleeps, so the tests are exact and instant. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => void (t += ms), advance: (ms) => void (t += ms) };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

describe('host pacer', () => {
  test('requests to one host start at least 500 ms apart', async () => {
    const clock = fakeClock();
    const pacer = createHostPacer({ now: clock.now, sleep: clock.sleep });
    const starts = [];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        pacer.run('example.com', async () => void starts.push(clock.now())),
      ),
    );
    assert.equal(starts.length, 5);
    for (let i = 1; i < starts.length; i += 1) {
      assert.ok(starts[i] - starts[i - 1] >= 500, `gap ${i}: ${starts[i] - starts[i - 1]} ms`);
    }
  });

  test('never more than two requests to one host at the same time', async () => {
    const clock = fakeClock();
    const pacer = createHostPacer({ now: clock.now, sleep: clock.sleep });
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, deferred);
    const runs = gates.map((gate) =>
      pacer.run('example.com', async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      }),
    );
    // Let everything that can start, start; then release the requests one at a time.
    await new Promise((r) => setImmediate(r));
    assert.equal(active, 2, 'two are running and the rest wait');
    for (const gate of gates) {
      gate.resolve();
      await new Promise((r) => setImmediate(r));
    }
    await Promise.all(runs);
    assert.equal(peak, 2);
  });

  test('different hosts do not wait for each other', async () => {
    const clock = fakeClock();
    const pacer = createHostPacer({ now: clock.now, sleep: clock.sleep });
    const starts = {};
    await Promise.all(
      ['a.example', 'b.example', 'c.example'].map((host) =>
        pacer.run(host, async () => void (starts[host] = clock.now())),
      ),
    );
    assert.equal(new Set(Object.values(starts)).size, 1, 'all three started at the same moment');
  });

  test('host names are not case sensitive', async () => {
    const clock = fakeClock();
    const pacer = createHostPacer({ now: clock.now, sleep: clock.sleep });
    const starts = [];
    await pacer.run('Example.COM', async () => void starts.push(clock.now()));
    await pacer.run('example.com', async () => void starts.push(clock.now()));
    assert.ok(starts[1] - starts[0] >= 500);
  });

  test('a failing request frees its slot and does not stall the queue', async () => {
    const clock = fakeClock();
    const pacer = createHostPacer({ maxConcurrent: 1, now: clock.now, sleep: clock.sleep });
    await assert.rejects(
      pacer.run('example.com', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await pacer.run('example.com', async () => 'next one ran'), 'next one ran');
  });

  test('the limits can be changed, and the default is the one the spec names', async () => {
    const clock = fakeClock();
    const pacer = createHostPacer({ minGapMs: 100, now: clock.now, sleep: clock.sleep });
    const starts = [];
    await pacer.run('x.example', async () => void starts.push(clock.now()));
    await pacer.run('x.example', async () => void starts.push(clock.now()));
    assert.equal(starts[1] - starts[0], 100);
  });

  test('hosts that have gone quiet are forgotten, so a long-running worker does not grow forever', async () => {
    const clock = fakeClock();
    const pacer = createHostPacer({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 500; i += 1) await pacer.run(`h${i}.example`, async () => {});
    clock.advance(120_000);
    await pacer.run('one-more.example', async () => {});
    assert.ok(pacer.size() < 10, `still tracking ${pacer.size()} hosts`);
  });
});
