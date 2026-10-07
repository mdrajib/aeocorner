import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ENGINES } from '../engines/contract.js';
import { AUDIT_ENGINES } from '../worker/handlers/audit.js';
import { AUDIT_ENGINE_ORDER } from './audit-progress.js';
import { DEFAULT_ENGINE_LABELS } from './narrative.js';
import {
  ENGINE_LABELS,
  ENGINE_ORDER,
  engineAccess,
  engineChoices,
  featureForEngine,
  graceAfterPlanChange,
} from './engines.js';

describe('engine names and order', () => {
  test('every engine the adapters can answer for has a name, in the same order', () => {
    assert.deepEqual([...ENGINE_ORDER], [...ENGINES]);
    for (const code of ENGINES) assert.ok(ENGINE_LABELS[code], code);
    assert.equal(DEFAULT_ENGINE_LABELS.claude, 'Claude');
  });

  test('the free audit stays on four engines: Claude is not in it (Milestone 16, task 16.08)', () => {
    assert.deepEqual([...AUDIT_ENGINE_ORDER], ['chatgpt', 'perplexity', 'gemini', 'google_aio']);
    assert.ok(!AUDIT_ENGINE_ORDER.includes('claude'));
    assert.deepEqual(
      [...AUDIT_ENGINES],
      [...AUDIT_ENGINE_ORDER],
      'the job asks the engines the page shows',
    );
  });

  test('only Claude needs a plan feature', () => {
    assert.equal(featureForEngine('claude'), 'claude_engine');
    for (const code of ['chatgpt', 'perplexity', 'gemini', 'google_aio'])
      assert.equal(featureForEngine(code), null);
  });
});

describe('engineChoices()', () => {
  const catalog = ENGINE_ORDER.map((code) => ({ code, name: ENGINE_LABELS[code] }));

  test('a project that predates an engine shows it as "not tracked", not as off, and the others are unchanged', () => {
    const rows = ['chatgpt', 'perplexity', 'gemini', 'google_aio'].map((engine_code) => ({
      engine_code,
      enabled: true,
    }));
    const choices = engineChoices(catalog, rows);
    assert.equal(choices.length, 5);
    assert.deepEqual(
      choices.filter((c) => c.enabled).map((c) => c.engine_code),
      ['chatgpt', 'perplexity', 'gemini', 'google_aio'],
    );
    const claude = choices.find((c) => c.engine_code === 'claude');
    assert.deepEqual(
      { enabled: claude.enabled, notTracked: claude.notTracked },
      { enabled: false, notTracked: true },
    );
    assert.ok(choices.filter((c) => c.engine_code !== 'claude').every((c) => !c.notTracked));
  });

  test('a row that was switched off is off, not "not tracked"', () => {
    const [first] = engineChoices(catalog, [{ engine_code: 'chatgpt', enabled: false }]);
    assert.deepEqual(
      { enabled: first.enabled, notTracked: first.notTracked },
      { enabled: false, notTracked: false },
    );
  });

  test('the plan decides whether an engine may be switched on', () => {
    const choices = engineChoices(catalog, [], (code) => code !== 'claude');
    assert.equal(choices.find((c) => c.engine_code === 'claude').allowed, false);
    assert.ok(choices.filter((c) => c.engine_code !== 'claude').every((c) => c.allowed));
  });
});

describe('a plan gated engine after a plan change (option C)', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const end = new Date('2026-10-28T00:00:00Z');

  test('losing the feature starts a grace that ends with the paid period', () => {
    assert.equal(graceAfterPlanChange({ before: true, after: false, periodEnd: end, now }), end);
  });

  test('gaining the feature clears a grace that is running', () => {
    assert.equal(
      graceAfterPlanChange({ before: false, after: true, periodEnd: end, existing: end, now }),
      null,
    );
  });

  test('a period that already ended starts no grace', () => {
    const past = new Date('2026-10-01T00:00:00Z');
    assert.equal(graceAfterPlanChange({ before: true, after: false, periodEnd: past, now }), null);
    assert.equal(graceAfterPlanChange({ before: true, after: false, periodEnd: null, now }), null);
  });

  test('a change that never involved the feature leaves a running grace alone and does not extend it', () => {
    assert.equal(
      graceAfterPlanChange({
        before: false,
        after: false,
        periodEnd: new Date('2026-11-28'),
        existing: end,
        now,
      }),
      end,
    );
    assert.equal(graceAfterPlanChange({ before: false, after: false, periodEnd: end, now }), null);
  });

  test('access is plan, grace or none', () => {
    const growth = { features: { claude_engine: false } };
    const agency = { features: { claude_engine: true } };
    const base = { code: 'claude', hasPlan: true, now };
    assert.equal(engineAccess({ ...base, plan: agency }), 'plan');
    assert.equal(engineAccess({ ...base, plan: growth, graceUntil: end }), 'grace');
    assert.equal(
      engineAccess({ ...base, plan: growth, graceUntil: new Date('2026-10-09') }),
      'none',
    );
    assert.equal(engineAccess({ ...base, plan: growth }), 'none');
    assert.equal(
      engineAccess({ ...base, hasPlan: false, plan: null }),
      'plan',
      'no plan yet: not held back',
    );
    assert.equal(
      engineAccess({ ...base, code: 'chatgpt', plan: growth }),
      'plan',
      'an engine in every plan',
    );
  });
});
