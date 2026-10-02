import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { acquireLease, activeLeases, releaseLease } from './concurrency.js';

const LIMIT = { cap: 3, ttlMs: 60_000 };

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('per-organization concurrency cap', () => {
  test('lets `cap` jobs run and turns the next one away', () => {
    let leases = new Map();
    for (const id of ['a', 'b', 'c']) {
      const r = acquireLease(leases, 0, LIMIT, id);
      assert.equal(r.acquired, true, id);
      leases = r.leases;
    }
    assert.equal(acquireLease(leases, 0, LIMIT, 'd').acquired, false);
  });

  test('releasing frees a slot', () => {
    let leases = new Map();
    for (const id of ['a', 'b', 'c']) leases = acquireLease(leases, 0, LIMIT, id).leases;
    leases = releaseLease(leases, 'b');
    assert.equal(acquireLease(leases, 0, LIMIT, 'd').acquired, true);
  });

  test('a worker that dies without releasing loses its slot when the lease expires', () => {
    let leases = new Map();
    for (const id of ['a', 'b', 'c']) leases = acquireLease(leases, 0, LIMIT, id).leases;
    assert.equal(acquireLease(leases, 59_999, LIMIT, 'd').acquired, false);
    assert.equal(acquireLease(leases, 60_000, LIMIT, 'd').acquired, true);
  });

  test('a retried job asking again for its own lease renews it instead of taking a second slot', () => {
    let leases = new Map();
    for (const id of ['a', 'b', 'c']) leases = acquireLease(leases, 0, LIMIT, id).leases;
    const again = acquireLease(leases, 1_000, LIMIT, 'a');
    assert.equal(again.acquired, true);
    assert.equal(activeLeases(again.leases, 1_000), 3);
  });

  test('does not change the map it is given', () => {
    const leases = new Map([['a', 100]]);
    acquireLease(leases, 0, LIMIT, 'b');
    releaseLease(leases, 'a');
    assert.deepEqual([...leases], [['a', 100]]);
  });

  test('two organizations do not share a cap', () => {
    let orgA = new Map();
    let orgB = new Map();
    for (const id of ['a1', 'a2', 'a3']) orgA = acquireLease(orgA, 0, LIMIT, id).leases;
    assert.equal(acquireLease(orgA, 0, LIMIT, 'a4').acquired, false);
    assert.equal(acquireLease(orgB, 0, LIMIT, 'b1').acquired, true);
  });

  test('simulated load: the number of running jobs never goes above the cap', () => {
    const random = seeded(11);
    const running = [];
    let leases = new Map();
    let now = 0;
    let started = 0;
    let turnedAway = 0;
    for (let i = 0; i < 20_000; i += 1) {
      now += Math.floor(random() * 3_000);
      if (running.length && random() < 0.45) {
        const [id] = running.splice(Math.floor(random() * running.length), 1);
        leases = releaseLease(leases, id);
      }
      const id = `job-${i}`;
      const r = acquireLease(leases, now, LIMIT, id);
      leases = r.leases;
      if (r.acquired) {
        running.push(id);
        started += 1;
      } else {
        turnedAway += 1;
      }
      assert.ok(activeLeases(leases, now) <= LIMIT.cap, `over the cap at step ${i}`);
    }
    assert.ok(started > 1000 && turnedAway > 1000, 'the run should have been both busy and idle');
  });

  test('refuses a cap below one', () => {
    assert.throws(() => acquireLease(new Map(), 0, { cap: 0, ttlMs: 1 }, 'a'), RangeError);
  });
});
