import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBrandKit } from './brand-kit.js';
import { checklistFor, checklists, CHECKLIST_PLATFORMS, clipWords } from './entity-guidance.js';

const kit = (identity = {}, entity = {}) =>
  parseBrandKit({
    identity: {
      brandName: 'Data Dental',
      legalName: 'Data Dental LLC',
      definition:
        'A family dental practice in Austin that offers cleanings, braces and same-day crowns.',
      category: 'family dental practice',
      ...identity,
    },
    entity: { foundingYear: '2014', headquarters: 'Austin, Texas', ...entity },
  }).kit;
const domain = 'www.datadental.test';

describe('clipWords', () => {
  test('keeps short text, and cuts long text at a word within the limit', () => {
    assert.equal(clipWords('Short text', 120), 'Short text');
    const long = 'word '.repeat(60);
    const cut = clipWords(long, 50);
    assert.ok(cut.length <= 50 && cut.endsWith('…') && !/\s…$/.test(cut));
  });
});

describe('checklistFor', () => {
  test('every platform has steps and fields filled only from the Brand Kit', () => {
    for (const p of CHECKLIST_PLATFORMS) {
      const c = checklistFor(p, kit(), { domain });
      assert.ok(c.steps.length >= 3, p);
      assert.ok(c.fields.length >= 3, p);
      const values = c.fields.map((f) => f.value).join('\n');
      assert.match(values, /Data Dental/);
      assert.ok(!/undefined|null/.test(values), p);
      assert.equal(c.missing.length, 0, p);
    }
  });

  test('the website is the project’s domain without www', () => {
    const c = checklistFor('linkedin', kit(), { domain });
    assert.equal(c.fields.find((f) => f.label === 'Website').value, 'https://datadental.test/');
  });

  test('what the customer has not typed is listed as missing, with where to add it, never invented', () => {
    const c = checklistFor(
      'google_business',
      kit({ definition: '', category: '' }, { foundingYear: '', headquarters: '' }),
      { domain },
    );
    assert.deepEqual(
      c.missing.map((m) => m.what).sort(),
      [
        'a category',
        'a one-line description',
        'the year you were founded',
        'where you are based',
      ].sort(),
    );
    assert.ok(!c.fields.some((f) => /description|Opening|Category|Where/.test(f.label)));
  });

  test('platform limits hold: a 120-character tagline, a 750-character Google description', () => {
    const long = kit({ definition: `${'We fix teeth. '.repeat(28)}`.slice(0, 400) });
    const li = checklistFor('linkedin', long, { domain });
    assert.ok(li.fields.find((f) => f.label === 'Tagline').value.length <= 120);
    const g = checklistFor('google_business', long, { domain });
    assert.ok(g.fields.find((f) => f.label === 'Business description').value.length <= 750);
  });

  test('Wikidata says plainly when not to create an item, and nothing is ever posted for the customer', () => {
    const w = checklistFor('wikidata', kit(), { domain });
    assert.match(w.intro, /never write to Wikidata/);
    assert.ok(w.steps.some((s) => /do not create one/.test(s)));
  });

  test('an unknown platform is a programming error', () => {
    assert.throws(() => checklistFor('myspace', kit(), { domain }), RangeError);
  });
});

describe('checklists', () => {
  test('marks the platforms the customer already listed', () => {
    const k = kit(
      {},
      {
        profiles: [{ platform: 'linkedin', url: 'https://www.linkedin.com/company/dd' }],
        wikidataId: 'Q5',
      },
    );
    const listed = Object.fromEntries(checklists(k, { domain }).map((c) => [c.platform, c.listed]));
    assert.deepEqual(listed, {
      google_business: false,
      linkedin: true,
      crunchbase: false,
      wikidata: true,
      directory: false,
    });
  });
});
