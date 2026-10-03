import { evaluateAuditBudget, fromMicros, toMicros, utcDayStart } from '../core/spend.js';

/**
 * The free audit's daily budget in action (MVP §17 R9): every visitor's audits together may spend `capUsd` in a UTC
 * day. When it is spent, new audits wait for the next UTC midnight; ones already running finish.
 *
 * `admit()` is asked before an audit starts (by the web route, to tell the visitor "busy today", and by the
 * `audit.run` job, which defers). The decision is `evaluateAuditBudget` in src/core/spend.js; this reads the ledger
 * and raises one alert a day when the budget closes.
 */
export function createAuditBudget({ db, alerts, logger, capUsd, now = () => new Date() }) {
  const capMicros = toMicros(capUsd);
  const dayKey = (date) => date.toISOString().slice(0, 10);

  return {
    capMicros,

    async admit() {
      const at = now();
      const spentMicros = await db.audits.ledger.spentSinceMicros(utcDayStart(at));
      const verdict = evaluateAuditBudget({ spentMicros, capMicros, now: at });
      if (!verdict.open) {
        await alerts.alert({
          key: `audit_budget:${dayKey(at)}`,
          severity: 'critical',
          title: 'The free audit’s daily budget is spent: new audits wait until tomorrow',
          details: {
            spentUsd: fromMicros(spentMicros),
            capUsd: fromMicros(capMicros),
            resumesAt: verdict.until.toISOString(),
          },
        });
        logger.warn('Free audits paused: daily audit budget reached');
      }
      return { ...verdict, spentMicros, capMicros };
    },
  };
}
