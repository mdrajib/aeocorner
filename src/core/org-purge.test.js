import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { KEPT_AFTER_PURGE, purgeOrder } from './org-purge.js';

describe('purgeOrder', () => {
  test('children come before the tables they reference', () => {
    const order = purgeOrder(
      ['projects', 'runs', 'answer_snapshots', 'recommendations'],
      [
        { child: 'runs', parent: 'projects' },
        { child: 'recommendations', parent: 'projects' },
        { child: 'answer_snapshots', parent: 'runs' },
      ],
    );
    assert.ok(order.indexOf('answer_snapshots') < order.indexOf('runs'));
    assert.ok(order.indexOf('runs') < order.indexOf('projects'));
    assert.ok(order.indexOf('recommendations') < order.indexOf('projects'));
    assert.equal(order.length, 4);
  });

  test('a self reference and a table outside the list change nothing', () => {
    const order = purgeOrder(
      ['prompts', 'projects'],
      [
        { child: 'prompts', parent: 'prompts' },
        { child: 'prompts', parent: 'projects' },
        { child: 'prompts', parent: 'users' },
      ],
    );
    assert.deepEqual(order, ['prompts', 'projects']);
  });

  test('is stable, and a cycle is appended rather than lost', () => {
    const edges = [
      { child: 'a', parent: 'b' },
      { child: 'b', parent: 'a' },
    ];
    assert.deepEqual(purgeOrder(['c', 'b', 'a'], edges), ['c', 'a', 'b']);
    assert.deepEqual(purgeOrder(['c', 'a', 'b'], edges), ['c', 'a', 'b']);
  });

  test('the tables kept after a purge each have a reason', () => {
    for (const [table, why] of Object.entries(KEPT_AFTER_PURGE)) {
      assert.ok(why.length > 10, table);
    }
  });
});
