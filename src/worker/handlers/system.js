import { setTimeout as sleep } from 'node:timers/promises';
import { nextBreakerState } from '../../core/breaker.js';
import { slotsToCheck } from '../../core/slots.js';
import { fromMicros, utcDayStart } from '../../core/spend.js';
import { trackingRunJobId } from '../../lib/job-ids.js';
import { BUCKET_MS, bucketStartOf } from '../../lib/provider-health.js';
import { ledgerKey } from '../provider-call.js';

/**
 * Handlers for the `system` queue: the hourly scheduler tick, the two guards, and the test job that exercises the
 * whole path. A handler is `(ctx, data, job) => result`; the worker has already validated `data`.
 */

/** Hourly. Finds projects whose weekly slot is due and starts their run, once per project per week. */
async function schedulerTick(ctx, data) {
  const at = data.at ? new Date(data.at) : ctx.now();
  const slots = slotsToCheck(at);
  let due = 0;
  let started = 0;
  for (const slot of slots) {
    const projects = await ctx.db.system.scheduling.dueProjects({
      hour: slot.hour,
      enforced: Boolean(ctx.billing?.enforced),
      now: at,
    });
    due += projects.length;
    // `tracking.start` is handled by src/worker/handlers/tracking.js. A worker without a handler for it (a test
    // that replaces the handlers) would only create jobs that can never succeed, so nothing is enqueued and the
    // tick says so in its result.
    if (!ctx.isHandled('tracking.start')) continue;
    for (const p of projects) {
      await ctx.jobs.add(
        'tracking.start',
        { orgId: String(p.orgId), projectId: String(p.projectId), weekKey: slot.weekKey },
        // Same project + same week = same ID, so a tick that fires twice (or a catch-up tick that looks back
        // over an hour already handled) can't start a second run.
        { jobId: trackingRunJobId(p.projectId, slot.weekKey) },
      );
      started += 1;
    }
  }
  if (due > 0 && started === 0) {
    ctx.logger.info({ due }, 'Projects are due but no tracking handler is registered yet');
  }
  return { slots: slots.length, due, started };
}

/** Every 15 minutes. The safety net behind the per-call check: pause what is over its cap, resume what isn't. */
async function guardSpend(ctx, data) {
  let orgIds;
  if (data.orgId) {
    orgIds = [BigInt(data.orgId)];
  } else {
    const since = utcDayStart(ctx.now());
    const [spenders, paused] = await Promise.all([
      ctx.db.system.spendMonitor.spentByOrgSince(since),
      ctx.db.system.spendMonitor.pausedOrgIds(),
    ]);
    orgIds = [...new Set([...spenders.map((s) => s.orgId), ...paused])];
  }
  const changes = { paused: 0, resumed: 0, failed: 0 };
  for (const orgId of orgIds) {
    try {
      const result = await ctx.spendGuard.check(orgId);
      if (result.changed && result.action === 'pause') changes.paused += 1;
      if (result.changed && result.action === 'resume') changes.resumed += 1;
    } catch (err) {
      // One organization's problem must not stop the others from being checked.
      changes.failed += 1;
      ctx.logger.error({ orgId: String(orgId), err: err.message }, 'Spend check failed');
    }
  }
  return { checked: orgIds.length, ...changes };
}

/** Every 5 minutes. Trips or resets circuit breakers from the last 15 minutes and copies health to MySQL. */
async function guardProviderHealth(ctx) {
  const nowMs = ctx.now().getTime();
  const known = await ctx.db.system.providerHealth.knownProviders();
  const summary = { pairs: 0, opened: 0, closed: 0, halfOpened: 0 };

  for (const { provider, engine } of await ctx.health.pairs()) {
    summary.pairs += 1;
    const [current, window] = await Promise.all([
      ctx.health.state(provider, engine),
      ctx.health.window(provider, engine, nowMs),
    ]);
    const next = nextBreakerState({
      state: current.state,
      openedAt: current.openedAt,
      now: nowMs,
      window,
      probes: current.probes,
    });

    if (next.changed) {
      await ctx.health.setState(provider, engine, next);
      ctx.logger.warn(
        { provider, engine, from: current.state, to: next.state, why: next.reason },
        'Breaker changed',
      );
      if (next.state === 'open') {
        summary.opened += 1;
        await ctx.alerts.alert({
          key: `breaker.open:${provider}:${engine}`,
          severity: 'critical',
          title: `Circuit breaker tripped for ${provider}${engine ? ` (${engine})` : ''}`,
          details: {
            provider,
            engine,
            why: next.reason,
            requests: window.requests,
            failures: window.failures,
          },
        });
      } else if (next.state === 'closed') {
        summary.closed += 1;
        await ctx.alerts.alert({
          key: `breaker.closed:${provider}:${engine}`,
          severity: 'warning',
          title: `Circuit breaker closed again for ${provider}${engine ? ` (${engine})` : ''}`,
          details: { provider, engine },
        });
      } else {
        summary.halfOpened += 1;
      }
    }

    if (!known.has(provider)) continue; // a test double or an unconfigured provider has no history row
    for (const start of [bucketStartOf(nowMs), bucketStartOf(nowMs) - BUCKET_MS]) {
      const bucket = await ctx.health.bucket(provider, engine, start);
      if (bucket.requests === 0) continue;
      await ctx.db.system.providerHealth.upsertBucket({
        providerCode: provider,
        engineCode: engine,
        bucketStart: new Date(start),
        requests: bucket.requests,
        successes: bucket.successes,
        failures: bucket.failures,
        timeouts: bucket.timeouts,
        p50Ms: bucket.p50Ms,
        p95Ms: bucket.p95Ms,
        costUsd: fromMicros(bucket.costMicros),
        breakerState: next.state,
      });
    }
  }
  return summary;
}

/** A job that goes through the whole path and does nothing else. */
async function noop(ctx, data, job) {
  const { value } = await ctx.callProvider(
    job,
    {
      orgId: data.orgId,
      projectId: data.projectId,
      provider: data.provider,
      engine: data.engine,
      scope: 'system',
      idempotencyKey: ledgerKey('system', job),
    },
    async () => {
      if (data.holdMs) await sleep(data.holdMs);
      if (job.attemptsMade < data.failTimes) throw new Error('forced failure');
      return {
        value: { ok: true },
        usage: {
          meter: 'other',
          unit: 'request',
          costUsd: data.costUsd,
        },
      };
    },
  );
  if (data.failAfterLedger && job.attemptsMade === 0) {
    throw new Error('forced failure after the ledger row was written');
  }
  return value;
}

export const systemHandlers = {
  'scheduler.tick': schedulerTick,
  'guard.spend': guardSpend,
  'guard.provider_health': guardProviderHealth,
  'system.noop': noop,
};
