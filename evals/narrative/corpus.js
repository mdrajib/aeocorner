import { CHECKS } from '../../src/crawler/readiness/rubric.js';
import { READINESS_GUIDANCE } from '../../src/core/fix-list.js';
import { RULES } from '../../src/core/recommendations.js';

/**
 * The narrative eval's cases (Milestone 6, task 6.04): recommendations of every rule, with evidence shaped like the rules
 * engine's, for the business names that tend to break text checks (digits, dots, apostrophes, accents, ampersands).
 *
 * `CORPUS` is what every narrative must pass: stating nothing its evidence does not. `BAD_NARRATIVES` are narratives
 * that make something up, and the eval fails if any of them is NOT flagged: the check itself is under test too.
 */

const PEOPLE = [
  { brandName: 'Data Dental', domain: 'datadental.com' },
  { brandName: "O'Brien & Sons Plumbing", domain: 'obriensons.co.uk' },
  { brandName: '7-Star Dental', domain: '7stardental.com' },
  { brandName: 'Café Léon', domain: 'cafeleon.fr' },
  { brandName: 'Acme.io', domain: 'acme.io' },
];

const readiness = (code, status, points, summary) => ({
  type: 'readiness',
  scanId: '41',
  scannedAt: '2026-10-01T10:00:00.000Z',
  check: {
    code,
    title: CHECKS[code].title,
    status,
    points,
    possible: CHECKS[code].points,
    summary,
  },
});

const READINESS = Object.keys(READINESS_GUIDANCE).flatMap((code) => {
  const possible = CHECKS[code].points;
  return [
    { evidence: readiness(code, 'fail', 0, ''), tag: 'fail' },
    {
      evidence: readiness(code, 'partial', Math.round(possible / 2), 'Found on 3 of 7 key pages.'),
      tag: 'partial',
    },
  ].map(({ evidence, tag }) => ({ ruleCode: `readiness.${code}`, evidence, tag }));
});

const LOST = [
  {
    tag: 'one rival',
    evidence: {
      type: 'lost_prompt',
      promptId: '12',
      question: 'Who is the best family dentist near me?',
      answersRead: 20,
      brandMentions: 0,
      engines: ['chatgpt', 'perplexity'],
      competitors: [{ name: 'Bright Smiles', k: 11 }],
    },
  },
  {
    tag: 'many rivals, unusual names',
    evidence: {
      type: 'lost_prompt',
      promptId: '13',
      question: 'Which plumber should I call for a burst pipe at night?',
      answersRead: 40,
      brandMentions: 0,
      engines: ['chatgpt', 'perplexity', 'gemini', 'google_aio'],
      competitors: [
        { name: '24/7 Pipe Pros', k: 14 },
        { name: "Dr. Drain's", k: 9 },
        { name: 'Müller & Söhne', k: 4 },
        { name: 'Fix.it', k: 2 },
        { name: 'Solo', k: 1 },
      ],
    },
  },
];

const CITED = [
  {
    tag: 'with a site type',
    evidence: {
      type: 'cited_source',
      domain: 'reddit.com',
      siteType: 'Forum',
      timesCited: 9,
      answersCiting: 6,
      answersWithoutBrand: 5,
    },
  },
  {
    tag: 'without a site type',
    evidence: {
      type: 'cited_source',
      domain: 'yelp.com',
      siteType: null,
      timesCited: 3,
      answersCiting: 3,
      answersWithoutBrand: 2,
    },
  },
];

const SENTIMENT = [
  { tag: 'cool', evidence: { type: 'sentiment', average: -0.5, answers: 10 } },
  { tag: 'cold', evidence: { type: 'sentiment', average: -1.75, answers: 31 } },
];

const withPeople = (ruleCode, cases) =>
  cases.flatMap((c, i) => {
    const who = PEOPLE[i % PEOPLE.length];
    return [
      { name: `${ruleCode} ${c.tag} (${who.brandName})`, ruleCode, evidence: c.evidence, ...who },
    ];
  });

const everyone = (ruleCode, cases) =>
  cases.flatMap((c) =>
    PEOPLE.map((who) => ({
      name: `${ruleCode} ${c.tag} (${who.brandName})`,
      ruleCode,
      evidence: c.evidence,
      ...who,
    })),
  );

export const CORPUS = [
  ...READINESS.map((c, i) => {
    const who = PEOPLE[i % PEOPLE.length];
    return { name: `${c.ruleCode} ${c.tag} (${who.brandName})`, ...c, ...who };
  }),
  ...everyone('visibility.lost_prompt', LOST),
  ...withPeople('visibility.cited_source', CITED),
  ...withPeople('visibility.hedged', SENTIMENT),
].map((c) => ({ ...c, category: RULES[c.ruleCode].category }));

const base = CORPUS.find((c) =>
  c.name.startsWith('visibility.lost_prompt one rival (Data Dental)'),
);
const a1 = CORPUS.find((c) => c.name.startsWith('readiness.A1 fail'));

/** Narratives that say something their evidence does not. Each must be flagged for the reason given. */
export const BAD_NARRATIVES = [
  {
    name: 'a figure the evidence does not have',
    case: base,
    narrative: {
      why: 'Bright Smiles was named in 17 answers, and Data Dental in none.',
      steps: '1. Write a page.',
    },
    expect: [{ kind: 'number', value: '17' }],
  },
  {
    name: 'a percentage worked out from the evidence',
    case: base,
    narrative: {
      why: 'Bright Smiles took 55% of the answers, and Data Dental was not named.',
      steps: '1. Write a page.',
    },
    expect: [{ kind: 'number', value: '55' }],
  },
  {
    name: 'a competitor that is not in the evidence',
    case: base,
    narrative: {
      why: 'ChatGPT recommended Smile Brands instead of Data Dental.',
      steps: '1. Write a page.',
    },
    expect: [{ kind: 'name', value: 'Brands' }],
  },
  {
    name: 'a website that is not in the evidence',
    case: base,
    narrative: {
      why: 'Bright Smiles is praised on healthgrades.com, and Data Dental is not named.',
      steps: '1. Write a page.',
    },
    expect: [{ kind: 'site', value: 'healthgrades.com' }],
  },
  {
    name: 'a quotation that is not in the evidence',
    case: base,
    narrative: {
      why: 'Engines describe Bright Smiles as “the friendliest dentist in town”.',
      steps: '1. Write a page.',
    },
    expect: [{ kind: 'quote', value: 'the friendliest dentist in town' }],
  },
  {
    name: 'a step that invents a figure about the customer',
    case: a1,
    narrative: {
      why: a1.evidence.check.title,
      steps: '1. Allow the crawler on your 12 key pages.',
    },
    expect: [{ kind: 'number', value: '12' }],
  },
  {
    name: 'a prediction with a figure',
    case: base,
    narrative: {
      why: 'Fixing this should lift your mention rate by 30 points within 4 weeks.',
      steps: '1. Write a page.',
    },
    expect: [
      { kind: 'number', value: '30' },
      { kind: 'number', value: '4' },
    ],
  },
];
