import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBody } from './content-html.js';
import {
  scoreDraft,
  gradeLevel,
  targetGrade,
  syllables,
  overlapWith,
  QC_CHECKS,
  READY_SCORE,
} from './content-qc.js';

const clean = (html) => sanitizeBody(html).html;
const check = (report, code) => report.checks.find((c) => c.code === code);

const FACTS = [
  'Data Dental has served Austin since 2009.',
  'A porcelain crown at Data Dental costs between $900 and $1,500.',
  'Same-day crowns take about two hours.',
];
const SOURCES = [
  {
    url: 'https://www.ada.org/resources/crowns',
    quote: 'A crown covers a damaged tooth and restores its shape and strength.',
  },
];

const GOOD = clean(`
<p>A crown is a cap that covers a damaged tooth. Most people in Austin pay between $900 and $1,500 for a porcelain crown at Data Dental.</p>
<h2>How much does a dental crown cost in Austin?</h2>
<p>A porcelain crown at Data Dental costs between $900 and $1,500. The price depends on the tooth, the material and whether you need other work first.</p>
<p>We give you a written quote before we start. Insurance often pays part of the cost, so ask your plan what it covers.</p>
<h2>How long does a crown take?</h2>
<p>Same-day crowns take about two hours. A crown made in a lab takes two visits, about two weeks apart.</p>
<p>On the first visit we shape the tooth and take a mould. You wear a temporary crown until the real one is ready. On the second visit we check the fit and bond the crown in place.</p>
<h2>Does getting a crown hurt?</h2>
<p>No. We numb the area first, so you feel pressure but not pain. Your gum may feel sore for a day or two afterwards.</p>
<p>Most people go back to work the same day. If the bite feels high or the pain lasts more than a week, call us and we will adjust it.</p>
<h2>How do I care for a crown?</h2>
<p>Brush twice a day and floss once a day, just as you do for your other teeth. Avoid chewing ice or hard sweets, because they can chip porcelain.</p>
<ul><li>Use a soft brush.</li><li>Floss around the crown every day.</li><li>See us twice a year for a check.</li></ul>
<p>A crown can last fifteen years or more with good care. The American Dental Association explains the steps in its <a href="https://www.ada.org/resources/crowns">guide to crowns</a>.</p>
<h2>Which crown material is best?</h2>
<p>Porcelain looks the most like a natural tooth and is the usual choice for front teeth. Metal crowns are strong and suit back teeth that take heavy chewing.</p>
<p>Ask us to show you samples. We will tell you which one we would pick for your own tooth, and why. If cost is the main worry, we can talk through the options that fit your budget.</p>
`);

const GOOD_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'How long does a crown take?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Same-day crowns take about two hours. A crown made in a lab takes two visits, about two weeks apart.',
      },
    },
    {
      '@type': 'Question',
      name: 'Does getting a crown hurt?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'No. We numb the area first, so you feel pressure but not pain. Your gum may feel sore for a day or two afterwards.',
      },
    },
  ],
};

const input = (over = {}) => ({
  bodyHtml: GOOD,
  jsonld: GOOD_JSONLD,
  voice: { avoid: ['cheap', 'guarantee'], readingLevel: 'Grade 8' },
  facts: FACTS,
  sources: SOURCES,
  existingPages: [
    {
      url: 'https://example.com/about',
      text: 'We are a family dental practice that has served the Austin area for many years with gentle care.',
    },
  ],
  ...over,
});

test('the checks and their weights add up to 100', () => {
  assert.equal(
    QC_CHECKS.reduce((n, c) => n + c.weight, 0),
    100,
  );
});

test('a good draft scores ready with nothing blocking', () => {
  const r = scoreDraft(input());
  assert.deepEqual(
    r.checks.map((c) => [c.code, c.status]),
    r.checks.map((c) => [c.code, c.status]),
  );
  assert.ok(
    r.score >= READY_SCORE,
    `${r.score}: ${JSON.stringify(r.checks.map((c) => [c.code, c.points, c.findings]))}`,
  );
  assert.equal(r.ready, true);
  assert.deepEqual(r.blocking, []);
  assert.equal(check(r, 'answer_first').status, 'pass');
  assert.equal(check(r, 'schema_valid').status, 'pass');
});

test('the same draft always gets the same score', () => {
  assert.deepEqual(scoreDraft(input()), scoreDraft(input()));
});

test('a long first paragraph under a question loses answer-first points and says which heading', () => {
  const long = clean(
    `<h2>How much does a crown cost?</h2><p>${'The price of a crown depends on many things that we will go through one at a time. '.repeat(8)}</p><h2>Is it safe?</h2><p>Yes.</p>`,
  );
  const r = scoreDraft(input({ bodyHtml: long, jsonld: null }));
  const c = check(r, 'answer_first');
  assert.equal(c.points, 12.5);
  assert.match(c.findings[0], /How much does a crown cost\?.*words/);
});

test('a heading with a list or nothing under it has no direct answer', () => {
  const r = scoreDraft(
    input({
      bodyHtml: clean('<h2>Is it safe?</h2><ul><li>yes</li></ul><h2>Why us?</h2>'),
      jsonld: null,
    }),
  );
  assert.equal(check(r, 'answer_first').points, 0);
  assert.equal(check(r, 'answer_first').findings.length, 2);
});

test('no question headings at all fails answer-first', () => {
  const r = scoreDraft(
    input({
      bodyHtml: clean(
        '<h2>Our services</h2><p>We do crowns.</p><h2>About us</h2><p>We are nice.</p>',
      ),
      jsonld: null,
    }),
  );
  assert.equal(check(r, 'answer_first').status, 'fail');
  assert.match(check(r, 'answer_first').findings[0], /question/);
});

test('a [needs source] marker blocks approval however good the rest is', () => {
  const r = scoreDraft(
    input({ bodyHtml: GOOD.replace('Brush twice a day', 'Brush twice a day [needs source]') }),
  );
  assert.equal(r.ready, false);
  assert.deepEqual(r.blocking, ['unsupported_claims']);
  assert.match(check(r, 'unsupported_claims').findings[0], /needs source/);
  assert.equal(check(r, 'unsupported_claims').detail.markers, 1);
});

test('a figure with no source in the text, the facts or a link is flagged; with a link or in the facts it is not', () => {
  const bad = clean(
    '<h2>Is it worth it?</h2><p>Studies show that 87% of patients prefer porcelain.</p>',
  );
  const r = scoreDraft(input({ bodyHtml: bad, jsonld: null }));
  assert.equal(check(r, 'unsupported_claims').detail.unsupported, 1);
  assert.ok(check(r, 'unsupported_claims').points < 20);
  const linked = clean(
    '<h2>Is it worth it?</h2><p>Studies show that 87% of patients prefer porcelain, <a href="https://www.ada.org/resources/crowns">says the ADA</a>.</p>',
  );
  assert.equal(
    check(scoreDraft(input({ bodyHtml: linked, jsonld: null })), 'unsupported_claims').detail
      .unsupported,
    0,
  );
  const inFacts = clean('<h2>How much?</h2><p>A crown costs $1,500 at the top end.</p>');
  assert.equal(
    check(scoreDraft(input({ bodyHtml: inFacts, jsonld: null })), 'unsupported_claims').detail
      .unsupported,
    0,
  );
  const wrongFigure = clean('<h2>How much?</h2><p>A crown costs $4,000 at the top end.</p>');
  assert.equal(
    check(scoreDraft(input({ bodyHtml: wrongFigure, jsonld: null })), 'unsupported_claims').detail
      .unsupported,
    1,
  );
});

test('a quotation that is not in the facts or the research is blocking; a real one is not', () => {
  const invented = clean(
    '<h2>What do patients say?</h2><p>One patient said "this was the best dental experience of my entire life and I tell everybody".</p>',
  );
  const r = scoreDraft(input({ bodyHtml: invented, jsonld: null }));
  assert.ok(r.blocking.includes('unsupported_claims'));
  assert.equal(check(r, 'unsupported_claims').detail.invented, 1);
  const real = clean(
    '<h2>What is a crown?</h2><p>The ADA says "A crown covers a damaged tooth and restores its shape and strength."</p>',
  );
  assert.equal(
    check(scoreDraft(input({ bodyHtml: real, jsonld: null })), 'unsupported_claims').detail
      .invented,
    0,
  );
});

test('heading structure: skipped levels, repeats and too few sections cost points', () => {
  const flat = clean(
    `<h2>Is it safe?</h2><p>Yes, it is safe for most people who have healthy gums.</p><h4>Is it safe?</h4><p>Still yes.</p>`,
  );
  const c = check(scoreDraft(input({ bodyHtml: flat, jsonld: null })), 'heading_structure');
  assert.ok(c.points < 8, JSON.stringify(c));
  assert.ok(c.findings.some((f) => /skips a heading level/.test(f)));
  assert.ok(c.findings.some((f) => /Two headings read/.test(f)));
  assert.ok(c.findings.some((f) => /at least 3/.test(f)));
});

test('reading level: grade is computed, the Brand Kit target is read, hard text loses points', () => {
  assert.equal(syllables('crown'), 1);
  assert.equal(syllables('dentistry'), 3);
  assert.equal(syllables('the'), 1);
  assert.equal(targetGrade('Grade 8'), 8);
  assert.equal(targetGrade('10th grade'), 10);
  assert.equal(targetGrade('plain English'), 8);
  assert.equal(targetGrade('written for experts'), 13);
  assert.equal(targetGrade(''), 9);
  assert.equal(gradeLevel('Too short.'), null);
  const hard = clean(
    `<h2>What is osseointegration?</h2><p>${'Osseointegration constitutes the biomechanical establishment of direct structural and functional connection between ordered, living bone and the surface of a load-carrying endosseous implant, notwithstanding considerable physiological variability. '.repeat(4)}</p>`,
  );
  const r = scoreDraft(input({ bodyHtml: hard, jsonld: null }));
  assert.ok(check(r, 'reading_level').detail.grade > 16);
  assert.equal(check(r, 'reading_level').points, 0);
  assert.ok(gradeLevel(GOOD.replace(/<[^>]+>/g, ' ')) < 9);
});

test('words to avoid: the Brand Kit list costs more than the stock filler, and whole words only', () => {
  const dirty = GOOD.replace(
    'A crown is a cap',
    'Our cheap crowns are a game-changer, and we delve into the tapestry of care. A crown is a cap',
  );
  const r = scoreDraft(input({ bodyHtml: dirty }));
  const c = check(r, 'banned_words');
  assert.deepEqual(c.detail.avoid, ['cheap']);
  assert.deepEqual(c.detail.filler.sort(), ['delve', 'game-changer', 'tapestry']);
  assert.ok(c.points < 5);
  const whole = scoreDraft(
    input({
      bodyHtml: GOOD.replace(
        'A crown is a cap',
        'Our cheaply priced extras need no guarantees. A crown is a cap',
      ),
    }),
  );
  assert.deepEqual(check(whole, 'banned_words').detail.avoid, []);
});

test('overlap: a near copy of an existing page is blocking, a partial one costs points', () => {
  const page =
    'A porcelain crown at Data Dental costs between $900 and $1,500. The price depends on the tooth, the material and whether you need other work first. We give you a written quote before we start.';
  assert.ok(overlapWith(GOOD, [{ url: 'u', text: page }]).share > 0.05);
  const copy = scoreDraft(
    input({
      bodyHtml: clean(`<h2>How much is a crown?</h2><p>${page}</p>`),
      existingPages: [{ url: 'https://example.com/crowns', text: page }],
    }),
  );
  assert.ok(copy.blocking.includes('overlap'));
  assert.match(check(copy, 'overlap').findings[0], /already on https:\/\/example\.com\/crowns/);
  assert.equal(check(scoreDraft(input()), 'overlap').status, 'pass');
  assert.deepEqual(overlapWith('', [{ url: 'u', text: 'x y z a b c' }]), { share: 0, url: null });
  assert.deepEqual(overlapWith('one two three four five six', []), { share: 0, url: null });
});

test('structured data: missing, invalid, and out of step with the page', () => {
  assert.equal(check(scoreDraft(input({ jsonld: null })), 'schema_valid').points, 0);
  const invalid = scoreDraft(
    input({ jsonld: { '@context': 'https://schema.org', '@type': 'FAQPage' } }),
  );
  assert.ok(invalid.blocking.includes('schema_valid'));
  const stray = {
    ...GOOD_JSONLD,
    mainEntity: [
      ...GOOD_JSONLD.mainEntity,
      {
        '@type': 'Question',
        name: 'Is it free?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes, completely free.' },
      },
    ],
  };
  const r = scoreDraft(input({ jsonld: stray }));
  assert.ok(r.blocking.includes('schema_valid'));
  assert.match(check(r, 'schema_valid').findings[0], /Is it free\?/);
  const drift = {
    ...GOOD_JSONLD,
    mainEntity: [
      {
        ...GOOD_JSONLD.mainEntity[0],
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'It takes a month and costs nothing at all, ever, for anyone.',
        },
      },
    ],
  };
  const d = scoreDraft(input({ jsonld: drift }));
  assert.ok(check(d, 'schema_valid').points < 10);
  assert.match(check(d, 'schema_valid').findings[0], /not what the page says/);
});

test('a bad draft scores low on several checks and is not ready', () => {
  const bad = clean(
    '<h2>Welcome</h2><p>We delve into the cheap, game-changer world of crowns. Studies show 92% of people love us. [needs source]</p><h2>Welcome</h2>',
  );
  const r = scoreDraft(input({ bodyHtml: bad, jsonld: null }));
  assert.ok(r.score < 40, String(r.score));
  assert.equal(r.ready, false);
  assert.ok(r.blocking.includes('unsupported_claims'));
  for (const code of ['answer_first', 'heading_structure', 'schema_valid'])
    assert.notEqual(check(r, code).status, 'pass', code);
});

test('an empty draft does not crash and scores near zero', () => {
  const r = scoreDraft({ bodyHtml: '', jsonld: null });
  assert.equal(r.score, 0);
  assert.equal(r.ready, false);
  assert.equal(r.checks.length, 7);
});
