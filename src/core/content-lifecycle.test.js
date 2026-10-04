import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES,
  canMove,
  movesFrom,
  pipelineSteps,
  approvalBlockers,
  retryStage,
  STATUS_LABELS,
  STATUS_TONES,
  EDITABLE,
  RUNNING,
  BOARD_COLUMNS,
} from './content-lifecycle.js';

test('only a person can approve or publish; only the system can finish publishing', () => {
  assert.equal(canMove('ready', 'approved', 'user'), true);
  assert.equal(canMove('ready', 'approved', 'system'), false);
  assert.equal(canMove('approved', 'publishing', 'user'), true);
  assert.equal(canMove('approved', 'publishing', 'system'), false);
  assert.equal(canMove('publishing', 'published', 'system'), true);
  assert.equal(canMove('publishing', 'published', 'user'), false);
  assert.equal(
    canMove('publishing', 'approved', 'system'),
    true,
    'saved as a WordPress draft: approved, not live',
  );
  assert.equal(canMove('publishing', 'approved', 'user'), false);
});

test('no path reaches published, publishing or approved without passing through a person', () => {
  const reach = (start, actors) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const s = queue.shift();
      for (const actor of actors)
        for (const to of movesFrom(s, actor))
          if (!seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
    }
    return seen;
  };
  const bySystem = reach('researching', ['system']);
  for (const s of ['approved', 'publishing', 'published']) assert.equal(bySystem.has(s), false, s);
  assert.equal(bySystem.has('ready'), true);
});

test('the pipeline moves forward one stage at a time and can fail at any stage', () => {
  for (const [a, b] of [
    ['researching', 'briefing'],
    ['briefing', 'drafting'],
    ['drafting', 'qc'],
    ['qc', 'ready'],
  ]) {
    assert.equal(canMove(a, b, 'system'), true, `${a} → ${b}`);
    assert.equal(canMove(a, 'failed', 'system'), true);
  }
  assert.equal(canMove('researching', 'drafting', 'system'), false);
  assert.equal(canMove('briefing', 'ready', 'system'), false);
  assert.equal(canMove('ready', 'researching', 'user'), false);
});

test('editing after approval is a move a person makes, and archiving is final', () => {
  assert.equal(canMove('approved', 'ready', 'user'), true);
  assert.equal(canMove('approved', 'qc', 'user'), true);
  assert.deepEqual(movesFrom('archived', 'user'), []);
  assert.deepEqual(movesFrom('archived', 'system'), []);
  assert.equal(canMove('published', 'drafting', 'user'), true);
  assert.equal(canMove('failed', 'researching', 'user'), true);
  assert.equal(canMove('failed', 'approved', 'user'), true);
  assert.equal(canMove('failed', 'approved', 'system'), false);
  assert.equal(
    canMove('publishing', 'archived', 'user'),
    false,
    'a publish in flight is not put away',
  );
});

test('every status has a label, a tone and an entry in the table', () => {
  for (const s of STATUSES) {
    assert.ok(STATUS_LABELS[s], s);
    assert.ok(STATUS_TONES[s], s);
    assert.ok(Array.isArray(movesFrom(s, 'user')), s);
  }
  assert.deepEqual(EDITABLE, ['ready', 'approved']);
  assert.ok(RUNNING.includes('publishing'));
  const columned = BOARD_COLUMNS.flatMap((c) => c.statuses);
  for (const s of STATUSES.filter((x) => x !== 'archived'))
    assert.ok(columned.includes(s), `${s} is on the board`);
});

test('the step list shows done, active and waiting stages, and points at the stage that failed', () => {
  const states = (status, opts) => pipelineSteps(status, opts).map((s) => s.state);
  assert.deepEqual(states('researching'), ['active', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(states('drafting'), ['done', 'done', 'active', 'todo', 'todo']);
  assert.deepEqual(states('ready'), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(states('published'), ['done', 'done', 'done', 'done', 'done']);
  assert.deepEqual(states('failed', { failedAt: 'drafting' }), [
    'done',
    'done',
    'failed',
    'todo',
    'todo',
  ]);
  assert.deepEqual(states('failed'), ['todo', 'todo', 'todo', 'todo', 'todo']);
});

test('approval is blocked by a missing check, an old check, blocking problems and missing structured data', () => {
  const ok = {
    qc: { blocking: [], checks: [] },
    qcRevisionId: 7,
    currentRevisionId: 7,
    hasJsonld: true,
  };
  assert.deepEqual(approvalBlockers(ok), []);
  assert.deepEqual(approvalBlockers({ ...ok, currentRevisionId: null }), [
    'There is no draft to approve yet.',
  ]);
  assert.match(approvalBlockers({ ...ok, qc: null })[0], /has not run/);
  assert.match(
    approvalBlockers({ ...ok, currentRevisionId: 8 })[0],
    /changed after the last quality check/,
  );
  const blocked = approvalBlockers({
    ...ok,
    qc: { blocking: ['unsupported_claims', 'overlap', 'schema_valid', 'other'] },
  });
  assert.equal(blocked.length, 4);
  assert.match(blocked[0], /needs source/);
  assert.match(blocked[3], /"other"/);
  assert.match(approvalBlockers({ ...ok, hasJsonld: false })[0], /no structured data/);
});

test('a retry starts again from research unless the draft itself failed', () => {
  assert.equal(retryStage('researching'), 'researching');
  assert.equal(retryStage('briefing'), 'researching');
  assert.equal(retryStage('drafting'), 'drafting');
  assert.equal(retryStage('qc'), 'drafting');
  assert.equal(retryStage(null), 'researching');
  assert.equal(retryStage('publishing'), 'approved');
});
