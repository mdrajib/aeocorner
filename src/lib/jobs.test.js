import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createJobClient, STALLED_REASON } from './jobs.js';

/** A queue that remembers jobs by ID, like BullMQ: adding an ID that exists returns the existing job. */
function fakeQueue(existing = {}) {
  const jobs = new Map(Object.entries(existing));
  const removed = [];
  return {
    jobs,
    removed,
    async getJob(id) {
      return jobs.get(id);
    },
    async add(name, data, opts) {
      if (opts.jobId && jobs.has(opts.jobId)) return jobs.get(opts.jobId);
      const job = { id: opts.jobId, name, failedReason: undefined, isFailed: async () => false };
      if (opts.jobId) jobs.set(opts.jobId, job);
      return job;
    },
  };
}

const failedJob = (id, failedReason, queue) => ({
  id,
  failedReason,
  isFailed: async () => true,
  remove: async () => {
    queue.removed.push(id);
    queue.jobs.delete(id);
  },
});

const payload = { orgId: '1', snapshotId: '7' };

describe('job client: a job ID that already exists', () => {
  test('stays a no-op for a job that is waiting or finished', async () => {
    const queue = fakeQueue();
    const jobs = createJobClient({ extract: queue });
    const first = await jobs.add('extract.answer', payload, { jobId: 'extract-answer-7' });
    const second = await jobs.add('extract.answer', payload, { jobId: 'extract-answer-7' });
    assert.equal(second, first);
    assert.deepEqual(queue.removed, []);
  });

  test('is replaced when the earlier job failed because its worker died', async () => {
    const queue = fakeQueue();
    queue.jobs.set('extract-answer-7', failedJob('extract-answer-7', STALLED_REASON, queue));
    const jobs = createJobClient({ extract: queue });
    const added = await jobs.add('extract.answer', payload, { jobId: 'extract-answer-7' });
    assert.deepEqual(queue.removed, ['extract-answer-7']);
    assert.equal(added.name, 'extract.answer', 'a new job was queued under the same ID');
  });

  test('is kept when the earlier job failed with its own error (no paid retry loop)', async () => {
    const queue = fakeQueue();
    queue.jobs.set('extract-answer-7', failedJob('extract-answer-7', 'provider exploded', queue));
    const jobs = createJobClient({ extract: queue });
    const added = await jobs.add('extract.answer', payload, { jobId: 'extract-answer-7' });
    assert.deepEqual(queue.removed, []);
    assert.equal(added.failedReason, 'provider exploded');
  });
});
