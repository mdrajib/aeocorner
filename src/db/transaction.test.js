import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isDeadlock, transaction } from './transaction.js';

const deadlock = () =>
  Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), {
    code: 'P2034',
  });

/** A pretend Prisma whose transactions fail with the given errors, in order, before succeeding. */
function fakePrisma(...failures) {
  const calls = { started: 0, callbacks: [] };
  return {
    calls,
    async $transaction(fn) {
      calls.started += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      const tx = { id: calls.started };
      calls.callbacks.push(tx);
      return fn(tx);
    },
  };
}

describe('transaction()', () => {
  test('a transaction that works runs once and returns its result', async () => {
    const prisma = fakePrisma();
    assert.equal(await transaction(prisma, async (tx) => `done ${tx.id}`), 'done 1');
    assert.equal(prisma.calls.started, 1);
  });

  test('a deadlock is retried, with a fresh transaction each time', async () => {
    const prisma = fakePrisma(deadlock(), deadlock());
    const result = await transaction(prisma, async (tx) => tx.id, { baseDelayMs: 1 });
    assert.equal(result, 3, 'the third attempt, on its own transaction object');
    assert.equal(prisma.calls.started, 3);
  });

  test('it gives up after the attempts are used, with the database’s own error', async () => {
    const prisma = fakePrisma(deadlock(), deadlock(), deadlock(), deadlock(), deadlock());
    await assert.rejects(
      transaction(prisma, async () => 'x', { attempts: 3, baseDelayMs: 1 }),
      (e) => e.code === 'P2034',
    );
    assert.equal(prisma.calls.started, 3);
  });

  test('any other error is thrown at once: a duplicate key or a bug is not a deadlock', async () => {
    const duplicate = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const prisma = fakePrisma(duplicate);
    await assert.rejects(
      transaction(prisma, async () => 'x'),
      (e) => e === duplicate,
    );
    assert.equal(prisma.calls.started, 1);

    const broken = fakePrisma();
    await assert.rejects(
      transaction(broken, async () => {
        throw new TypeError('a bug in the callback');
      }),
      TypeError,
    );
    assert.equal(broken.calls.started, 1, 'an error raised by our own code is not retried');
  });

  test('recognises a deadlock by Prisma’s code or by the database’s wording', () => {
    assert.equal(isDeadlock(deadlock()), true);
    assert.equal(
      isDeadlock({
        meta: {
          driverAdapterError: { cause: { message: 'Deadlock found when trying to get lock' } },
        },
      }),
      true,
    );
    // What a raw query reports for the same event (copied from a real MySQL 8 deadlock):
    const raw = {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: '1213',
            originalMessage: 'Deadlock found when trying to get lock; try restarting transaction',
            kind: 'TransactionWriteConflict',
          },
        },
      },
    };
    assert.equal(isDeadlock(raw), true);
    assert.equal(
      isDeadlock({
        code: 'P2010',
        meta: {
          driverAdapterError: { cause: { originalCode: '1064', originalMessage: 'syntax error' } },
        },
      }),
      false,
    );
    assert.equal(isDeadlock(new Error('connection reset')), false);
    assert.equal(isDeadlock(null), false);
  });
});
