import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  evidenceRows,
  historyLines,
  listItem,
  paragraphsOf,
  proofCards,
  statusBadge,
  statusPanel,
  stepsOf,
} from './action-center.js';

const projectBase = '/app/o/org/projects/p1';
const readiness = {
  id: 7n,
  ruleCode: 'readiness.A1',
  title: 'Let AI search crawlers read your site',
  category: 'crawler_access',
  fixPath: 'auto_fix',
  effort: 1,
  status: 'open',
  statusChangedAt: '2026-10-03T10:00:00Z',
  whyMd:
    'Our latest scan of x.com looked at “Answer crawlers” (check A1) and it earned 3 of 8 points. What the scan saw: robots.txt blocks a crawler.\n\nIf AI crawlers cannot read your site, engines have nothing of yours to quote.',
  stepsMd: '1. Edit robots.txt.\n2. Press “Mark as done”.',
  questions: 3,
  signalClearedAt: null,
  evidence: {
    type: 'readiness',
    scannedAt: '2026-10-01T10:00:00.000Z',
    check: {
      code: 'A1',
      title: 'Answer crawlers',
      status: 'partial',
      points: 3,
      possible: 8,
      summary: 'robots.txt blocks a crawler',
    },
  },
};

describe('badges and list rows', () => {
  test('each status has a badge, and a fix that ended for lack of data is "not enough data", not "no change"', () => {
    assert.deepEqual(statusBadge('open'), { text: 'To do', tone: 'neutral' });
    assert.deepEqual(statusBadge('proven_win'), { text: 'Proven win', tone: 'success' });
    assert.deepEqual(statusBadge('no_change'), { text: 'No change yet', tone: 'neutral' });
    assert.deepEqual(statusBadge('no_change', { verdict: 'insufficient_data' }), {
      text: 'Not enough data',
      tone: 'unknown',
    });
    assert.equal(statusBadge('declined').tone, 'danger');
    assert.equal(statusBadge('unverified').tone, 'warning');
  });

  test('a list row has a link, the first sentence of the why, and how much it affects', () => {
    const row = listItem(readiness, { projectBase });
    assert.equal(row.href, `${projectBase}/actions/7`);
    assert.equal(row.fixPath, 'Quick fix');
    assert.equal(row.effort, 'Low');
    assert.equal(row.reach, 'Affects all your questions');
    assert.match(row.teaser, /^Our latest scan of x\.com looked at/);
    assert.equal(row.looksFixed, false);
  });

  test('a question-level recommendation says how many questions, and one is "1 question"', () => {
    const lost = { ...readiness, ruleCode: 'visibility.lost_prompt' };
    assert.equal(listItem({ ...lost, questions: 1 }, { projectBase }).reach, 'Affects 1 question');
    assert.equal(listItem({ ...lost, questions: 4 }, { projectBase }).reach, 'Affects 4 questions');
  });

  test('a signal that stopped showing, on something not yet done, "looks fixed"; it is for a person to confirm', () => {
    assert.equal(
      listItem({ ...readiness, signalClearedAt: new Date() }, { projectBase }).looksFixed,
      true,
    );
    const measuring = { ...readiness, status: 'measuring', signalClearedAt: new Date() };
    assert.equal(listItem(measuring, { projectBase }).looksFixed, false);
  });
});

describe('words', () => {
  test('paragraphs and steps are split without markup', () => {
    assert.equal(paragraphsOf(readiness.whyMd).length, 2);
    assert.deepEqual(stepsOf(readiness.stepsMd), ['Edit robots.txt.', 'Press “Mark as done”.']);
    assert.deepEqual(paragraphsOf(null), []);
  });

  test('readiness evidence: the check, its points, what the scan saw and when', () => {
    const rows = evidenceRows(readiness, { projectBase, domain: 'x.com', brandName: 'X' });
    assert.deepEqual(
      rows.map((r) => r.label),
      ['What we checked', 'Result', 'What the scan saw', 'Scanned'],
    );
    assert.equal(rows[1].text, '3 of 8 points');
    assert.equal(rows[3].text, 'x.com on October 1, 2026');
  });

  test('a lost question links to its answers; a cited site links to the sources', () => {
    const lost = evidenceRows(
      {
        evidence: {
          type: 'lost_prompt',
          promptId: '12',
          question: 'Best dentist?',
          answersRead: 20,
          engines: ['chatgpt', 'gemini'],
          competitors: [{ name: 'Rival', k: 1 }],
        },
      },
      { projectBase, domain: 'x.com', brandName: 'X' },
    );
    assert.equal(lost[0].href, `${projectBase}/answers/12`);
    assert.equal(lost[1].text, '20 answers from ChatGPT, Gemini');
    assert.equal(lost.find((r) => r.label === 'Named instead').text, 'Rival (1 time)');
    const site = evidenceRows(
      {
        evidence: {
          type: 'cited_source',
          domain: 'reddit.com',
          siteType: 'Forum',
          timesCited: 4,
          answersCiting: 3,
          answersWithoutBrand: 2,
        },
      },
      { projectBase, domain: 'x.com', brandName: 'X' },
    );
    assert.equal(site[0].text, 'reddit.com (forum)');
    assert.equal(site[0].href, `${projectBase}/citations`);
    assert.equal(site[1].text, '4 times, in 3 answers');
  });
});

describe('the status panel', () => {
  const detail = (rec, extra = {}) => ({
    recommendation: { ...readiness, ...rec },
    prompts: [],
    events: [],
    verifications: [],
    outcomes: [],
    ...extra,
  });

  test('while checking, it says what is happening and how the three checks are going', () => {
    const p = statusPanel(
      detail(
        { status: 'done', baseline: { n: 50, k: 9 } },
        {
          verifications: [
            { attempt: 1, status: 'failed', details: { couldntCheck: false } },
            { attempt: 2, status: 'pending' },
            { attempt: 3, status: 'pending' },
          ],
        },
      ),
    );
    assert.equal(p.title, 'We are checking your site');
    assert.deepEqual(p.attempts, [
      { label: 'Check 1 of 3', text: 'problem still there' },
      { label: 'Check 2 of 3', text: 'waiting' },
      { label: 'Check 3 of 3', text: 'waiting' },
    ]);
    assert.deepEqual(p.facts, [{ label: 'Before the fix', text: '9 of 50 answers named you' }]);
  });

  test('"could not check" is never described as a failing fix', () => {
    const p = statusPanel(
      detail(
        {
          status: 'unverified',
          verification: { reason: 'couldnt_check' },
          baseline: { n: 10, k: 1 },
        },
        {
          verifications: [1, 2, 3].map((attempt) => ({
            attempt,
            status: 'failed',
            details: { couldntCheck: true },
          })),
        },
      ),
    );
    assert.match(p.text, /could not reach your site/);
    assert.ok(p.attempts.every((a) => a.text === 'could not check'));
    assert.doesNotMatch(p.text, /still there/);
  });

  test('an unverified fix whose re-checks failed says the problem is still there, and offers to measure anyway', () => {
    const p = statusPanel(
      detail({
        status: 'unverified',
        verification: { reason: 'still_failing' },
        baseline: { n: 10, k: 1 },
      }),
    );
    assert.match(p.text, /problem is still there/);
    assert.match(p.text, /start measuring anyway/);
  });

  test('while measuring: the two check dates, and what "before" was', () => {
    const p = statusPanel(
      detail({
        status: 'measuring',
        measuringStartedAt: '2026-10-03T12:00:00Z',
        baseline: { n: 80, k: 40 },
        verification: { reason: 'passed' },
      }),
    );
    assert.deepEqual(p.facts, [
      { label: 'Before the fix', text: '40 of 80 answers named you' },
      { label: 'Check at 2 weeks', text: 'October 17, 2026' },
      { label: 'Check at 4 weeks', text: 'October 31, 2026' },
    ]);
    assert.match(p.text, /Your site has the fix/);
    assert.match(p.text, /2–6 weeks/);
  });

  test('a fix we cannot check by machine says so', () => {
    const p = statusPanel(
      detail({
        status: 'measuring',
        measuringStartedAt: '2026-10-03T12:00:00Z',
        baseline: { n: 20, k: 0 },
        verification: { reason: 'not_verifiable' },
      }),
    );
    assert.match(p.text, /cannot check this kind of fix automatically/);
  });

  test('no baseline answers: it says there is nothing to compare with', () => {
    const p = statusPanel(
      detail({
        status: 'measuring',
        measuringStartedAt: '2026-10-03T12:00:00Z',
        baseline: { n: 0, k: 0 },
      }),
    );
    assert.match(p.facts[0].text, /nothing to compare with/);
  });

  test('dismissed: the reason and the note', () => {
    const p = statusPanel(
      detail({ status: 'dismissed', dismissReason: 'wont_do', dismissNote: 'Not now' }),
    );
    assert.match(p.text, /We won’t do this\. “Not now”/);
  });
});

describe('proof cards', () => {
  const rec = {
    title: 'Fix robots.txt',
    measuringStartedAt: '2026-10-03T12:00:00Z',
    doneAt: '2026-10-03T11:00:00Z',
  };
  const outcome = (over) => ({
    horizon: 'week_2',
    verdict: 'proven_win',
    promptsCount: 3,
    kBefore: 10,
    nBefore: 120,
    kAfter: 40,
    nAfter: 118,
    rateBefore: 0.0833,
    rateAfter: 0.339,
    deltaPp: 25.6,
    p: 0.00001,
    computedAt: '2026-10-17T12:00:00Z',
    ...over,
  });

  test('a win says so, with the counts before and after, the change and how sure we are', () => {
    const [card] = proofCards(
      { recommendation: rec, outcomes: [outcome()] },
      { brandName: 'Data Dental' },
    );
    assert.equal(card.label, 'Proven win');
    assert.equal(card.tone, 'success');
    assert.match(card.sentence, /from 10 of 120 to 40 of 118 answers/);
    assert.deepEqual(
      card.rows.map((r) => r.text),
      [
        '10 of 120 answers named Data Dental (8.3%)',
        '40 of 118 answers named Data Dental (33.9%)',
        '+25.6 percentage points',
      ],
    );
    assert.match(card.sure, /at least 5 points/);
    assert.match(card.sure, /Here p < 0\.001\./);
  });

  test('"within normal variation" is not coloured, and "not enough data" is its own thing', () => {
    const [quiet] = proofCards(
      { recommendation: rec, outcomes: [outcome({ verdict: 'no_change', deltaPp: 1.2, p: 0.4 })] },
      { brandName: 'X' },
    );
    assert.deepEqual([quiet.label, quiet.tone], ['Within normal variation', 'neutral']);
    const thin = outcome({
      verdict: 'insufficient_data',
      nBefore: 5,
      nAfter: 8,
      rateBefore: 0.2,
      rateAfter: 0.5,
      deltaPp: null,
      p: null,
    });
    const [card] = proofCards({ recommendation: rec, outcomes: [thin] }, { brandName: 'X' });
    assert.deepEqual([card.label, card.tone], ['Not enough data', 'unknown']);
    assert.match(card.sure, /at least 20 readable answers/);
    assert.equal(card.rows.length, 2);
  });

  test('a decline is the only other coloured result', () => {
    const [bad] = proofCards(
      { recommendation: rec, outcomes: [outcome({ verdict: 'declined', deltaPp: -20 })] },
      { brandName: 'X' },
    );
    assert.deepEqual([bad.label, bad.tone], ['Declined', 'danger']);
    assert.equal(bad.rows[2].text, '-20 percentage points');
  });
});

describe('history', () => {
  test('who did what, with the system and the customer told apart', () => {
    const lines = historyLines([
      {
        fromStatus: null,
        toStatus: 'open',
        actorType: 'system',
        note: 'Raised from evidence',
        createdAt: '2026-10-03T10:00:00Z',
      },
      {
        fromStatus: 'open',
        toStatus: 'done',
        actorType: 'user',
        note: null,
        createdAt: '2026-10-03T11:00:00Z',
      },
    ]);
    assert.deepEqual(lines, [
      { when: 'October 3, 2026', who: 'AEO Corner', what: 'Raised', note: 'Raised from evidence' },
      { when: 'October 3, 2026', who: 'You', what: 'To do → Checking', note: '' },
    ]);
  });
});
