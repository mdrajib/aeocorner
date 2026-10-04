import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { checkFacts } from './entity-accuracy.js';
import { evaluateRules, profileSubject, RULES, scoreCandidates } from './recommendations.js';
import { factsFor, findUnsupported, templateNarrative } from './narrative.js';

const prompts = [
  { id: '1', text: 'What is Data Dental?', priority: 3 },
  { id: '2', text: 'Best family dentist in Austin?', priority: 2 },
];
const base = { brandName: 'Data Dental', prompts, enginesCount: 4 };

const kit = {
  entity: { foundingYear: '2014', headquarters: 'Austin, Texas', profiles: [], wikidataId: '' },
  offerings: { items: [] },
};
const claim = (value, engineCode = 'chatgpt', id = 1) => ({
  id,
  engineCode,
  attribute: 'company_fact',
  value,
});

const entityOf = ({
  checks = [],
  claims = [],
  answersRead = 6,
  profilesListed = 0,
  wikidataId = '',
} = {}) => ({
  checks,
  accuracy: checkFacts({ kit, claims, answersRead }),
  wikidataId,
  profilesListed,
});

const profile = (url, status, finding, platform = 'linkedin', details = {}) => ({
  kind: 'profile',
  subject: url,
  platform,
  status,
  finding,
  details,
  checkedAt: new Date('2026-10-04T00:00:00Z'),
});
const wikidata = (status, finding, details = {}) => ({
  kind: 'wikidata',
  subject: 'wikidata',
  platform: null,
  status,
  finding,
  details,
  checkedAt: new Date('2026-10-04T00:00:00Z'),
});

const keys = (result) => result.candidates.map((c) => c.stableKey).sort();

describe('entity.wrong_fact', () => {
  test('is raised when engines state a fact the Brand Kit contradicts, at least twice', () => {
    const claims = [
      claim('Founded in 2011', 'chatgpt', 1),
      claim('established in 2011', 'gemini', 2),
      claim('founded in 2014', 'perplexity', 3),
    ];
    const r = evaluateRules({ ...base, entity: entityOf({ claims }) });
    assert.deepEqual(keys(r), ['entity.wrong_fact:founded']);
    const [c] = r.candidates;
    assert.equal(c.category, 'entity');
    assert.equal(c.fixPath, 'guidance');
    assert.equal(c.evidence.type, 'entity_fact');
    assert.deepEqual([c.evidence.wrong, c.evidence.right, c.evidence.answersRead], [2, 1, 6]);
    assert.ok(c.evidence.examples.length > 0);
    assert.equal(r.evaluated['entity.wrong_fact'], true);
  });

  test('one stray wrong answer is not worth a task', () => {
    const r = evaluateRules({ ...base, entity: entityOf({ claims: [claim('Founded in 2011')] }) });
    assert.deepEqual(keys(r), []);
  });

  test('nothing is raised, or cleared, when no brand answer was read', () => {
    const r = evaluateRules({ ...base, entity: entityOf({ claims: [], answersRead: 0 }) });
    assert.deepEqual(keys(r), []);
    assert.equal(r.evaluated['entity.wrong_fact'], false);
  });

  test('the same condition gives the same key every time', () => {
    const claims = [claim('Founded in 2011', 'a', 1), claim('Founded in 2012', 'b', 2)];
    const a = evaluateRules({ ...base, entity: entityOf({ claims }) });
    const b = evaluateRules({ ...base, entity: entityOf({ claims: [...claims].reverse() }) });
    assert.deepEqual(keys(a), keys(b));
    assert.deepEqual(a.detectedKeys, b.detectedKeys);
  });
});

describe('entity.profile', () => {
  const url = 'https://www.linkedin.com/company/data-dental';

  test('a profile we could read that does not name the business is an issue', () => {
    const r = evaluateRules({
      ...base,
      entity: entityOf({
        checks: [
          profile(url, 'failed', 'brand_not_named', 'linkedin', {
            namesBrand: false,
            linksBack: false,
          }),
        ],
        profilesListed: 1,
      }),
    });
    assert.deepEqual(keys(r), [
      `entity.profile:linkedin-${profileSubject('linkedin', url).slice(-8)}`,
    ]);
    assert.equal(r.candidates[0].evidence.type, 'entity_profile');
    assert.equal(r.candidates[0].evidence.finding, 'brand_not_named');
    assert.deepEqual(r.candidates[0].affectedUrls, [url]);
  });

  test('a profile that is gone is an issue; one that passed is not', () => {
    const r = evaluateRules({
      ...base,
      entity: entityOf({
        checks: [
          profile(url, 'failed', 'not_found'),
          profile(
            'https://www.crunchbase.com/organization/dd',
            'passed',
            'names_brand',
            'crunchbase',
          ),
        ],
        profilesListed: 2,
      }),
    });
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].evidence.finding, 'not_found');
  });

  test('"couldn\'t check" opens nothing and keeps an open issue from being cleared', () => {
    const r = evaluateRules({
      ...base,
      entity: entityOf({ checks: [profile(url, 'error', 'blocked')], profilesListed: 1 }),
    });
    assert.deepEqual(keys(r), []);
    assert.ok(r.detectedKeys.includes(`entity.profile:${profileSubject('linkedin', url)}`));
  });

  test('with no check made yet, profiles were not evaluated; with none listed, they were', () => {
    assert.equal(
      evaluateRules({ ...base, entity: entityOf({ profilesListed: 2 }) }).evaluated[
        'entity.profile'
      ],
      false,
    );
    assert.equal(
      evaluateRules({ ...base, entity: entityOf({ profilesListed: 0 }) }).evaluated[
        'entity.profile'
      ],
      true,
    );
  });

  test('the key stays within the recommendation key column even for a very long address', () => {
    const long = `https://example.org/${'a'.repeat(400)}`;
    const subject = profileSubject('other', long);
    assert.ok(`entity.profile:${subject}`.length < 191);
  });
});

describe('entity.wikidata', () => {
  test('no item, an ambiguous name and a wrong item number each raise one issue with its own words', () => {
    for (const [finding, title] of [
      ['not_in_wikidata', /Get Data Dental a Wikidata item/],
      ['ambiguous', /which Wikidata item is Data Dental/],
      ['mismatch', /Wikidata item number/],
    ]) {
      const r = evaluateRules({
        ...base,
        entity: entityOf({ checks: [wikidata('failed', finding, { candidates: 2 })] }),
      });
      assert.deepEqual(keys(r), ['entity.wikidata:item'], finding);
      assert.match(r.candidates[0].title, title);
    }
  });

  test('found, confirmed, or a lookup that failed: nothing is raised, and a failed lookup is not "fixed"', () => {
    for (const status of ['passed']) {
      const r = evaluateRules({
        ...base,
        entity: entityOf({ checks: [wikidata(status, 'found')] }),
      });
      assert.deepEqual(keys(r), []);
      assert.equal(r.evaluated['entity.wikidata'], true);
    }
    const down = evaluateRules({
      ...base,
      entity: entityOf({ checks: [wikidata('error', 'lookup_failed')] }),
    });
    assert.deepEqual(keys(down), []);
    assert.equal(down.evaluated['entity.wikidata'], false);
    assert.ok(down.detectedKeys.includes('entity.wikidata:item'));
  });
});

describe('scoring and words', () => {
  const claims = [claim('Founded in 2011', 'a', 1), claim('Founded in 2012', 'b', 2)];
  const found = evaluateRules({ ...base, entity: entityOf({ claims }) });
  const context = { brandName: 'Data Dental', domain: 'datadental.test' };

  test('every entity rule is in the table with a prior and an effort', () => {
    for (const code of ['entity.wrong_fact', 'entity.profile', 'entity.wikidata']) {
      assert.ok(RULES[code].prior > 0 && RULES[code].effort >= 1, code);
    }
  });

  test('a wrong fact is scored on how often the answers said it', () => {
    const [scored] = scoreCandidates(found.candidates, { prompts, enginesCount: 4 });
    assert.ok(scored.impact > 0 && scored.ice > 0);
  });

  test('the template narrative uses only the evidence, and passes the narrative check', () => {
    const [c] = found.candidates;
    const facts = factsFor(c.evidence, context);
    assert.ok(
      facts.some((f) => f.text.includes('2014')),
      'what the customer told us',
    );
    assert.ok(
      facts.some((f) => f.text.includes('Founded in 2011')),
      'what the engine said',
    );
    const n = templateNarrative(
      { ruleCode: c.ruleCode, category: c.category, evidence: c.evidence },
      context,
    );
    assert.equal(
      findUnsupported({ why: n.why, steps: n.steps }, facts, n.steps, context).length,
      0,
    );
  });

  test('every Wikidata finding has a narrative the check accepts', () => {
    for (const finding of ['not_in_wikidata', 'ambiguous', 'mismatch']) {
      const evidence = {
        type: 'entity_wikidata',
        finding,
        candidates: 2,
        givenId: 'Q42',
        item: { id: 'Q42', label: 'Another Company' },
      };
      const n = templateNarrative(
        { ruleCode: 'entity.wikidata', category: 'entity', evidence },
        context,
      );
      const facts = factsFor(evidence, context);
      assert.equal(
        findUnsupported({ why: n.why, steps: n.steps }, facts, n.steps, context).length,
        0,
        finding,
      );
    }
  });

  test('a profile and a Wikidata narrative say only what was found', () => {
    const r = evaluateRules({
      ...base,
      entity: entityOf({
        checks: [
          profile('https://www.linkedin.com/company/dd', 'failed', 'not_found'),
          wikidata('failed', 'not_in_wikidata'),
        ],
        profilesListed: 1,
      }),
    });
    for (const c of r.candidates) {
      const facts = factsFor(c.evidence, context);
      assert.ok(facts.length > 0, c.stableKey);
      const n = templateNarrative(
        { ruleCode: c.ruleCode, category: c.category, evidence: c.evidence },
        context,
      );
      assert.equal(
        findUnsupported({ why: n.why, steps: n.steps }, facts, n.steps, context).length,
        0,
        c.stableKey,
      );
      assert.ok(n.steps.includes('1.'));
    }
  });
});
