import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ENGINES } from '../engines/contract.js';
import { AUDIT_ENGINES } from '../worker/handlers/audit.js';
import { AUDIT_ENGINE_ORDER } from './audit-progress.js';
import { DEFAULT_ENGINE_LABELS } from './narrative.js';
import { ENGINE_LABELS, ENGINE_ORDER, engineChoices, featureForEngine } from './engines.js';

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
