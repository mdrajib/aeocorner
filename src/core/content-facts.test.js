import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandFacts, buildRegistry, usableFacts, factTexts, sourceList } from './content-facts.js';

const kit = {
  identity: {
    brandName: 'Data Dental',
    definition: 'a family dental practice',
    category: 'dental practice',
    geography: 'Austin, Texas',
    legalName: 'Data Dental PLLC',
  },
  offerings: {
    items: [{ name: 'Porcelain crowns', description: 'Same-day crowns', price: '$900-$1,500' }],
    differentiators: ['Open on Saturdays'],
    audiences: [],
  },
  facts: [{ label: 'Founded', value: '2009' }],
};

test('Brand Kit facts become sentences in a fixed order', () => {
  assert.deepEqual(brandFacts(kit), [
    'Data Dental is a family dental practice',
    'Data Dental is a dental practice serving Austin, Texas.',
    'The legal name of Data Dental is Data Dental PLLC.',
    'Porcelain crowns. Same-day crowns. Price: $900-$1,500',
    'Open on Saturdays',
    'Founded: 2009',
  ]);
  assert.deepEqual(brandFacts({}), []);
  assert.deepEqual(brandFacts({ identity: { brandName: 'X' } }), []);
});

test('the registry numbers Brand Kit facts b1.. then research r1.., and only verified facts are usable', () => {
  const registry = buildRegistry({
    kit,
    research: [
      {
        claim: 'Crowns last 15 years on average.',
        url: 'https://www.ada.org/crowns',
        quote: 'last about 15 years',
        verified: true,
      },
      { claim: 'Half of adults have a crown.', url: 'https://x.com/p', verified: false },
    ],
  });
  assert.equal(registry[0].id, 'b1');
  assert.equal(registry[5].id, 'b6');
  assert.deepEqual(
    registry.slice(6).map((f) => [f.id, f.verified]),
    [
      ['r1', true],
      ['r2', false],
    ],
  );
  assert.equal(usableFacts(registry).length, 7);
  assert.ok(factTexts(registry).includes('last about 15 years'));
  assert.ok(!factTexts(registry).some((t) => /Half of adults/.test(t)));
  assert.deepEqual(sourceList(registry), [
    { url: 'https://www.ada.org/crowns', quote: 'last about 15 years' },
  ]);
});

test('an unverified flag must be exactly true; anything else is not usable', () => {
  const registry = buildRegistry({
    kit: {},
    research: [
      { claim: 'c', url: 'https://a.com', verified: 'yes' },
      { claim: 'd', url: 'https://a.com' },
    ],
  });
  assert.equal(usableFacts(registry).length, 0);
});

test('the entity facts the customer typed are facts a draft may state, and come last', () => {
  const kit = {
    identity: { brandName: 'Data Dental', definition: 'a family dental practice' },
    entity: { foundingYear: '2014', headquarters: 'Austin, Texas' },
  };
  const texts = buildRegistry({ kit }).map((f) => f.text);
  assert.deepEqual(texts.slice(-2), [
    'Data Dental was founded in 2014.',
    'Data Dental is based in Austin, Texas.',
  ]);
  const none = buildRegistry({ kit: { identity: { brandName: 'Data Dental' }, entity: {} } });
  assert.ok(!none.some((f) => /founded|based in/.test(f.text)), 'nothing is made up');
});
