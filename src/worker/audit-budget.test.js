import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { toMicros } from '../core/spend.js';
import { createAuditBudget } from './audit-budget.js';

const fake = (spentUsd) => {
  const alerts = [];
  const asked = [];
  const budget = createAuditBudget({
    db: {
      audits: {
        ledger: {
          async spentSinceMicros(since) {
            asked.push(since.toISOString());
            return toMicros(spentUsd);
          },
        },
      },
    },
    alerts: { alert: async (a) => alerts.push(a) },
    logger: { warn() {} },
    capUsd: 60,
    now: () => new Date('2026-10-03T13:00:00Z'),
  });
  return { budget, alerts, asked };
};

describe('the audit budget guard', () => {
  test('lets an audit start under the budget, measuring from UTC midnight, and raises no alert', async () => {
    const { budget, alerts, asked } = fake('12.5');
    const verdict = await budget.admit();
    assert.equal(verdict.open, true);
    assert.deepEqual(asked, ['2026-10-03T00:00:00.000Z']);
    assert.equal(alerts.length, 0);
  });

  test('stops new audits at the budget and alerts once under a key for the day', async () => {
    const { budget, alerts } = fake('60.01');
    const verdict = await budget.admit();
    assert.equal(verdict.open, false);
    assert.equal(verdict.until.toISOString(), '2026-10-04T00:00:00.000Z');
    assert.equal(alerts[0].key, 'audit_budget:2026-10-03');
    assert.equal(alerts[0].severity, 'critical');
    assert.equal(alerts[0].details.capUsd, '60.000000');
  });
});
