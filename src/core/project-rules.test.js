import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkProjectFields, normalizeEntityName, weeklySlotHour } from './project-rules.js';

describe('weeklySlotHour', () => {
  test('is stable and inside the week', () => {
    for (let i = 0; i < 200; i++) {
      const id = `01J${i}ABCDEFGHJKMNPQRSTVWXYZ`;
      const hour = weeklySlotHour(id);
      assert.equal(hour, weeklySlotHour(id));
      assert.ok(Number.isInteger(hour) && hour >= 0 && hour < 168);
    }
  });

  test('spreads projects across the week', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(weeklySlotHour(`project-${i}`));
    assert.ok(seen.size > 150);
  });
});

describe('checkProjectFields', () => {
  const good = { name: '  Acme   Dental ', country: 'us', language: 'EN' };

  test('tidies a good project', () => {
    const r = checkProjectFields(good);
    assert.deepEqual(r, {
      ok: true,
      value: { name: 'Acme Dental', country: 'US', language: 'en' },
    });
  });

  test('says what is wrong, field by field', () => {
    const r = checkProjectFields({ name: 'A', country: 'USA', language: '' });
    assert.equal(r.ok, false);
    assert.deepEqual(Object.keys(r.errors).sort(), ['country', 'language', 'name']);
  });

  test('a partial edit checks only what it changes', () => {
    assert.deepEqual(checkProjectFields({ city: ' Austin ' }, { partial: true }), {
      ok: true,
      value: { city: 'Austin' },
    });
    assert.equal(checkProjectFields({ cadence: 'hourly' }, { partial: true }).ok, false);
    assert.equal(checkProjectFields({ timezone: 'Mars/Base' }, { partial: true }).ok, false);
    assert.equal(checkProjectFields({ timezone: 'Europe/Berlin' }, { partial: true }).ok, true);
  });

  test('rejects non-string input without throwing', () => {
    assert.equal(checkProjectFields({ name: { $ne: 1 }, country: 7, language: null }).ok, false);
  });
});

describe('normalizeEntityName', () => {
  test('ignores case, accents, punctuation and spacing', () => {
    assert.equal(normalizeEntityName('  Café  Rosé, Inc. '), 'cafe rose inc');
    assert.equal(normalizeEntityName('ACME-Inc'), normalizeEntityName('acme inc'));
  });
});

describe('the country and language lists', () => {
  test('every listed country is one the engine adapters can ask from', async () => {
    const { COUNTRIES } = await import('./project-rules.js');
    const { DATAFORSEO_LOCATION_CODES } = await import('../engines/locations.js');
    assert.deepEqual(Object.keys(COUNTRIES).sort(), Object.keys(DATAFORSEO_LOCATION_CODES).sort());
  });

  test('a country the adapters cannot ask from is refused', () => {
    assert.equal(checkProjectFields({ name: 'Acme', country: 'ZZ', language: 'en' }).ok, false);
  });
});
