import { performance } from 'node:perf_hooks';
import { orgConcurrency, providerLimits } from '../core/limits.js';
import { toMicros } from '../core/spend.js';
import { Deferral } from './deferral.js';

/**
 * Every call to an external provider goes through here (MVP §7.8, §7.6). In order:
 *
 *   1. spend pause    the organization hit its daily cap  -> wait until it resets
 *   2. breaker        the provider is tripped for this engine -> wait for the cooldown
 *   3. org slot       the organization is already running its maximum of this kind -> wait a moment
 *   4. rate limit     the provider's token bucket is empty -> wait until a token exists
 *   5. the call, timed, with its outcome recorded for the circuit breaker
 *   6. the ledger     one `usage_ledger` row, keyed so a retry can't write it twice
 *   7. spend check    that row may have taken the organization over its cap -> pause now, not in 15 minutes
 *
 * A free audit has no organization, so it passes `auditId` instead of `orgId`. Everything above still applies except
 * the two things that belong to an organization: step 1 (an audit is held back by the audit budget, checked once when
 * the audit starts, because a visitor's audit is never cut off halfway) and step 7, and the ledger row is the audit's
 * own (`db.audits.ledger`). Its concurrency slots are per audit.
 *
 * Waiting (1-4) throws a `Deferral`, which the worker turns into a delayed job that does not use up an attempt.
 * The caller's function must return `{ value, usage }` where `usage` describes what the call cost; a call that
 * returns no usage is a bug (every paid call is written to the ledger), so it throws. A call the provider does not
 * charge for says `usage: { free: true }` and skips steps 6 and 7 (polling a queued DataForSEO task).
 */
export function createProviderCaller({
  db,
  limiter,
  concurrency,
  health,
  spendGuard,
  logger,
  now = () => new Date(),
  random = Math.random,
}) {
  const jitter = (ms) => Math.round(ms * (1 + random() * 0.5));

  return async function callProvider(job, params, fn) {
    const { provider, engine = '', scope, idempotencyKey, cost = 1 } = params;
    // Job payloads carry IDs as strings (JSON has no BigInt); the database layer wants BigInt.
    const auditId = params.auditId == null ? null : BigInt(params.auditId);
    if ((auditId === null) === (params.orgId == null)) {
      throw new TypeError(
        'A provider call belongs to an organization or to an audit, not both or neither',
      );
    }
    const orgId = auditId === null ? BigInt(params.orgId) : null;
    // What the concurrency slots are counted per: the organization, or this one audit.
    const owner = auditId === null ? orgId : `audit-${auditId}`;
    const projectId = params.projectId == null ? undefined : BigInt(params.projectId);
    const jobKey = String(job.id);

    if (orgId !== null) {
      const pausedUntil = await spendGuard.pausedUntil(orgId);
      if (pausedUntil) {
        throw new Deferral(pausedUntil.getTime() - now().getTime(), 'spend cap reached');
      }
    }

    const verdict = await health.admit(provider, engine);
    if (verdict === 'deny') throw new Deferral(jitter(60_000), `breaker open for ${provider}`);

    const slot = orgConcurrency(scope);
    if (!(await concurrency.acquire(scope, owner, slot, jobKey))) {
      throw new Deferral(jitter(2_000), 'organization is at its concurrency limit');
    }

    try {
      const bucket = await limiter.take(provider, providerLimits(provider), cost);
      if (!bucket.allowed) {
        throw new Deferral(jitter(bucket.retryAfterMs), `${provider} rate limit`);
      }

      const started = performance.now();
      let outcome;
      try {
        outcome = await fn();
      } catch (err) {
        // An error that is our own fault (bad input) must not count against the provider's health.
        if (err?.countsAgainstProvider !== false) {
          await health.record(provider, engine, {
            outcome:
              err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT' ? 'timeout' : 'failure',
            ms: performance.now() - started,
            probe: verdict === 'probe',
          });
        }
        throw err;
      }
      const ms = performance.now() - started;

      if (!outcome?.usage) {
        throw new TypeError(
          `The call to ${provider} returned no usage: every external call is ledgered`,
        );
      }
      const { usage } = outcome;
      await health.record(provider, engine, {
        outcome: 'success',
        ms,
        costMicros: usage.free ? 0 : toMicros(usage.costUsd),
        probe: verdict === 'probe',
      });
      // A call the provider does not charge for (asking whether a queued task is ready) still counts against its
      // rate limit and its health, but it is not a cost, so it writes no ledger row. It has to say so explicitly.
      if (usage.free === true) return { value: outcome.value, ledger: null };

      const entry = { providerCode: provider, idempotencyKey, ...usage };
      const ledger =
        auditId === null
          ? await db.forOrg(orgId).usage.record({ projectId, ...entry })
          : await db.audits.ledger.record(auditId, entry);
      if (!ledger.recorded) {
        logger.info({ idempotencyKey }, 'Ledger row already written: a retry is not counted twice');
      }

      if (orgId !== null) await spendGuard.check(orgId);
      return { value: outcome.value, ledger };
    } finally {
      await concurrency.release(scope, owner, jobKey);
    }
  };
}

/** The ledger key for one step of one job: stable across retries, unique across jobs. */
export function ledgerKey(queueName, job, step = 'call') {
  return `${queueName}.${job.id}.${step}`.slice(0, 128);
}
