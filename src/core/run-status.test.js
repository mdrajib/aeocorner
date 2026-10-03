import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  describeRun,
  isRunning,
  RUNNING_STATUSES,
  runNowLabel,
  STALE_RUN_MS,
} from './run-status.js';

const run = (over) => ({
  status: 'complete',
  trigger_type: 'schedule',
  tasks_planned: 8,
  tasks_ok: 8,
  tasks_no_answer: 0,
  tasks_failed: 0,
  finished_at: new Date('2026-10-04T06:00:00Z'),
  ...over,
});

describe('describeRun', () => {
  test('no run yet says what will happen, with no number', () => {
    const d = describeRun(null);
    assert.equal(d.state, 'none');
    assert.equal(d.running, false);
    assert.doesNotMatch(d.text, /\d/);
  });

  test('every in-flight status is "running", and the first check says so', () => {
    for (const status of RUNNING_STATUSES) {
      const d = describeRun(run({ status, finished_at: null }));
      assert.equal(d.state, 'running');
      assert.equal(d.running, true);
      assert.equal(d.finishedAt, null);
    }
    assert.equal(
      describeRun(run({ status: 'collecting', trigger_type: 'onboarding' })).title,
      'Your first check is running',
    );
    assert.equal(describeRun(run({ status: 'collecting' })).title, 'A check is running');
  });

  test('a complete run says all answers were read', () => {
    const d = describeRun(run());
    assert.deepEqual([d.state, d.tone], ['complete', 'success']);
    assert.equal(d.text, 'All 8 answers were read.');
    assert.equal(d.finishedAt.toISOString(), '2026-10-04T06:00:00.000Z');
  });

  test('a partial run says how many were left out, and that they are not "not mentioned"', () => {
    const d = describeRun(run({ status: 'partial', tasks_failed: 3 }));
    assert.deepEqual([d.state, d.tone], ['partial', 'warning']);
    assert.match(d.text, /3 of 8 answers couldn’t be checked/);
    assert.match(d.text, /not counted as “not mentioned”/);
  });

  test('a failed run shows no figure and promises none', () => {
    const d = describeRun(run({ status: 'failed', tasks_ok: 0, tasks_failed: 8 }));
    assert.deepEqual([d.state, d.tone], ['failed', 'danger']);
    assert.match(d.text, /no number is guessed/);
  });

  test('singular and plural', () => {
    assert.equal(describeRun(run({ tasks_planned: 1 })).text, 'The one answer was read.');
    assert.match(
      describeRun(run({ status: 'partial', tasks_planned: 1, tasks_failed: 1 })).text,
      /1 of 1 answer couldn/,
    );
  });
});

describe('a run that lost its job', () => {
  const queued = new Date('2026-10-04T00:00:00Z');
  const running = run({ status: 'collecting', finished_at: null, queued_at: queued });
  test('is running for as long as a run can plausibly take', () => {
    const now = new Date(queued.getTime() + STALE_RUN_MS);
    assert.equal(isRunning(running, now), true);
    assert.equal(describeRun(running, now).state, 'running');
  });
  test('is stalled after that, and no longer blocks another check', () => {
    const now = new Date(queued.getTime() + STALE_RUN_MS + 1000);
    assert.equal(isRunning(running, now), false);
    const d = describeRun(running, now);
    assert.deepEqual([d.state, d.tone, d.running], ['stalled', 'warning', false]);
    assert.match(d.text, /start another check/);
  });
  test('a finished run, or none, is never running', () => {
    assert.equal(isRunning(run({ queued_at: queued })), false);
    assert.equal(isRunning(null), false);
  });
});

describe('runNowLabel', () => {
  test('counts what is left, never below zero', () => {
    assert.equal(runNowLabel({ used: 1, limit: 4 }), '3 extra checks left this month');
    assert.equal(runNowLabel({ used: 3, limit: 4 }), '1 extra check left this month');
    assert.equal(runNowLabel({ used: 9, limit: 4 }), '0 extra checks left this month');
  });
});
