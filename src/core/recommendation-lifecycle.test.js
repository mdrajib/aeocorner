import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ACTORS,
  allowedNext,
  canTransition,
  decideVerification,
  FINAL_STATUSES,
  LIVE_STATUSES,
  mayRaiseAgain,
  STATUSES,
  timelineFor,
  verificationSchedule,
  verifyMethodFor,
  checkCodeOf,
} from './recommendation-lifecycle.js';

describe('transitions', () => {
  // Every allowed move, as "from > to: who". Anything not here must be refused for everyone.
  const allowed = {
    'open>in_progress': ['user'],
    'open>done': ['user'],
    'open>dismissed': ['user', 'staff'],
    'in_progress>open': ['user'],
    'in_progress>done': ['user'],
    'in_progress>dismissed': ['user', 'staff'],
    'done>verified': ['system'],
    'done>unverified': ['system'],
    'done>in_progress': ['system'],
    'verified>measuring': ['system'],
    'verified>in_progress': ['system'],
    'unverified>in_progress': ['user', 'system'],
    'unverified>measuring': ['user', 'system'],
    'measuring>in_progress': ['system'],
    'measuring>proven_win': ['system'],
    'measuring>no_change': ['system'],
    'measuring>declined': ['system'],
  };

  test('every cell of the table', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        for (const actor of ACTORS) {
          assert.equal(
            canTransition(from, to, actor),
            allowed[`${from}>${to}`]?.includes(actor) ?? false,
            `${actor}: ${from} > ${to}`,
          );
        }
      }
    }
  });

  test('a person can never verify a fix or declare a win', () => {
    for (const to of ['verified', 'proven_win', 'no_change', 'declined']) {
      for (const from of STATUSES) assert.equal(canTransition(from, to, 'user'), false);
    }
  });

  test('final statuses go nowhere, and unknown names are refused', () => {
    for (const status of FINAL_STATUSES) assert.deepEqual(allowedNext(status, 'user'), []);
    assert.equal(canTransition('open', 'nonsense', 'user'), false);
    assert.equal(canTransition('nonsense', 'open', 'user'), false);
    assert.equal(canTransition('open', 'done', 'robot'), false);
  });

  test('live and final statuses split the ten', () => {
    assert.equal(LIVE_STATUSES.length + FINAL_STATUSES.length, STATUSES.length);
    assert.deepEqual(allowedNext('unverified', 'user').sort(), ['in_progress', 'measuring']);
  });
});

describe('the timeline', () => {
  const states = (steps) => steps.map((s) => `${s.key}:${s.state}`);

  test('a fix that went open → in progress → done is checking', () => {
    assert.deepEqual(states(timelineFor('done', { reached: ['open', 'in_progress', 'done'] })), [
      'open:done',
      'in_progress:done',
      'done:current',
      'verified:upcoming',
      'measuring:upcoming',
      'proven_win:upcoming',
    ]);
  });

  test('a step that was skipped is skipped, not claimed', () => {
    const steps = timelineFor('measuring', { reached: ['open', 'done', 'verified', 'measuring'] });
    assert.equal(steps.find((s) => s.key === 'in_progress').state, 'skipped');
    assert.equal(steps.find((s) => s.key === 'measuring').state, 'current');
  });

  test('an unverified fix shows the verified step as not verified', () => {
    const step = timelineFor('unverified', { reached: ['open', 'done'] })[3];
    assert.equal(step.label, 'Not verified');
    assert.equal(step.state, 'current');
  });

  test('the last step takes the name of the real end', () => {
    const last = (status) => timelineFor(status, { reached: ['measuring'] }).at(-1);
    assert.deepEqual(last('proven_win'), { key: 'proven_win', label: 'Proven win', state: 'done' });
    assert.equal(last('no_change').label, 'No change yet');
    assert.equal(last('declined').label, 'Declined');
  });

  test('a dismissed recommendation has no timeline', () => {
    assert.deepEqual(timelineFor('dismissed'), []);
  });
});

describe('raising an issue again', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);

  test('nothing before it: raise it', () => {
    assert.deepEqual(mayRaiseAgain(null, now), { allowed: true, parentId: null });
  });

  test('a declined one is raised again at once, as its follow-up', () => {
    const previous = { id: 7n, status: 'declined', statusChangedAt: daysAgo(0) };
    assert.deepEqual(mayRaiseAgain(previous, now), { allowed: true, parentId: 7n });
  });

  test('a dismissed one stays quiet for 90 days, "already done" for 30', () => {
    const dismissed = (reason, ago) => ({
      id: 1n,
      status: 'dismissed',
      dismissReason: reason,
      statusChangedAt: daysAgo(ago),
    });
    assert.equal(mayRaiseAgain(dismissed('wont_do', 89), now).allowed, false);
    assert.equal(mayRaiseAgain(dismissed('wont_do', 90), now).allowed, true);
    assert.equal(mayRaiseAgain(dismissed('already_done', 29), now).allowed, false);
    assert.equal(mayRaiseAgain(dismissed('already_done', 30), now).allowed, true);
  });

  test('a fix that changed nothing, or won, is not nagged about for four weeks', () => {
    for (const status of ['no_change', 'proven_win']) {
      assert.equal(
        mayRaiseAgain({ id: 1n, status, statusChangedAt: daysAgo(27) }, now).allowed,
        false,
      );
      assert.equal(
        mayRaiseAgain({ id: 1n, status, statusChangedAt: daysAgo(28) }, now).allowed,
        true,
      );
    }
  });
});

describe('the same-day re-check', () => {
  test('only a readiness issue can be checked by machine, and its check is named by its rule', () => {
    assert.equal(verifyMethodFor('readiness.C1'), 'readiness_check');
    assert.equal(checkCodeOf('readiness.C1'), 'C1');
    for (const rule of ['visibility.lost_prompt', 'visibility.cited_source', 'visibility.hedged']) {
      assert.equal(verifyMethodFor(rule), null);
      assert.equal(checkCodeOf(rule), null);
    }
  });

  test('attempts are at once, after an hour and after a day', () => {
    const done = new Date('2026-10-03T09:00:00Z');
    assert.deepEqual(
      verificationSchedule(done).map((d) => d.toISOString()),
      ['2026-10-03T09:00:00.000Z', '2026-10-03T10:00:00.000Z', '2026-10-04T09:00:00.000Z'],
    );
  });

  test('a pass at any attempt verifies', () => {
    assert.deepEqual(
      decideVerification([
        { attempt: 1, status: 'failed' },
        { attempt: 2, status: 'passed' },
      ]),
      {
        verdict: 'verified',
        reason: 'passed',
      },
    );
  });

  test('a fix that cannot be checked is unverified straight away', () => {
    assert.deepEqual(decideVerification([{ attempt: 1, status: 'not_verifiable' }]), {
      verdict: 'unverified',
      reason: 'not_verifiable',
    });
  });

  test('a failure waits for the later attempts, then gives up', () => {
    assert.equal(decideVerification([{ attempt: 1, status: 'failed' }]).verdict, 'continue');
    assert.equal(decideVerification([{ attempt: 1, status: 'pending' }]).verdict, 'continue');
    const all = [1, 2, 3].map((attempt) => ({ attempt, status: 'failed' }));
    assert.deepEqual(decideVerification(all), { verdict: 'unverified', reason: 'still_failing' });
  });

  test('"we could not look" at the end is not "still failing"', () => {
    const all = [1, 2, 3].map((attempt) => ({ attempt, status: 'failed', couldntCheck: true }));
    assert.deepEqual(decideVerification(all), { verdict: 'unverified', reason: 'couldnt_check' });
  });
});
