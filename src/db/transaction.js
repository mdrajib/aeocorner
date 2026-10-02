import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Run a transaction, and run it again if MySQL abandons it as a deadlock.
 *
 * InnoDB resolves two transactions that wait on each other by rolling one back and saying "retry your
 * transaction" (Prisma reports it as P2034). It is not an error in our code and it is not rare when several
 * requests create rows in the same tables at once (two people creating organizations at the same moment hit it in
 * the test suite). Handing it to the user as a 500 would be wrong; the documented remedy is to run the whole
 * transaction again, and that is safe because a rolled-back transaction has changed nothing.
 *
 * The callback must only touch the database through `tx` (every repository's does), since it may run more than
 * once.
 *
 * @param {object} prisma
 * @param {(tx: object) => Promise<any>} fn
 * @param {{ attempts?: number, baseDelayMs?: number }} [options]
 */
export async function transaction(prisma, fn, { attempts = 4, baseDelayMs = 25 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(fn);
    } catch (err) {
      if (!isDeadlock(err) || attempt >= attempts) throw err;
      // A short, growing, slightly random wait, so the two that collided do not collide again in step.
      await sleep(baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }
}

/**
 * Did MySQL abandon this transaction as a deadlock? Prisma words it two ways, depending on which statement was
 * waiting: P2034 ("write conflict or a deadlock", from its own create/update calls) and, for a raw query, P2010
 * with the driver's cause: error 1213, kind "TransactionWriteConflict". Both are checked against the real thing
 * in tests/integration/org-concurrency.test.js.
 */
export function isDeadlock(err) {
  const cause = err?.meta?.driverAdapterError?.cause;
  return (
    err?.code === 'P2034' ||
    cause?.kind === 'TransactionWriteConflict' ||
    String(cause?.originalCode) === '1213' ||
    /deadlock|write conflict/i.test(String(cause?.originalMessage ?? cause?.message ?? ''))
  );
}
