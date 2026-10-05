import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { proofCards } from './action-center.js';
import { CITATION_LIMITS } from './citation-opportunities.js';
import { buildDigest } from './digest.js';
import { proofSentence } from './outcomes.js';
import { publicProof, shareSentence } from './proof-share.js';
import {
  evaluateRules,
  pageSubject,
  RULES,
  scoreCandidates,
  stableKeyOf,
} from './recommendations.js';

const prompts = [
  { id: '1', text: 'Best CRM for dentists?', priority: 3 },
  { id: '2', text: 'Dental CRM pricing?', priority: 1 },
];
const grid = [
  { promptId: '1', text: prompts[0].text, priority: 3, engines: [engine(10, 0)] },
  { promptId: '2', text: prompts[1].text, priority: 1, engines: [engine(10, 4)] },
];
function engine(nOk, brandK) {
  return { engineCode: 'chatgpt', status: 'complete', nOk, brandK, rivals: [] };
}
const base = { brandName: 'Acme', prompts, enginesCount: 1, grid, answersTotal: 20 };

const site = (over = {}) => ({
  domain: 'g2.com',
  type: 'review',
  typeLabel: 'Review site or directory',
  format: 'list',
  formatLabel: 'List or roundup',
  timesCited: 6,
  answersCiting: 5,
  answersWithoutBrand: 4,
  promptIds: ['1'],
  questions: [{ promptId: '1', text: prompts[0].text, answersWithoutBrand: 4 }],
  pages: [{ url: 'https://g2.com/x', title: 'Best CRM', timesCited: 6, format: 'list' }],
  path: 'guidance',
  contentFormat: null,
  ...over,
});
const citations = (over = {}) => ({
  opportunities: [site()],
  uncitedPages: [],
  ownCitations: 14,
  ownPagesCited: 1,
  ownPagesJudged: true,
  ...over,
});
const run = (c, extra = {}) => evaluateRules({ ...base, citations: c, ...extra });
const gaps = (out) => out.candidates.filter((c) => c.ruleCode === 'citation.gap');

describe('citation.gap', () => {
  test('is judged on citation share and scoped to the questions the site was cited for', () => {
    const [g] = gaps(run(citations()));
    assert.equal(g.metric, 'citation_share');
    assert.equal(g.title, 'Get listed or mentioned on g2.com');
    assert.equal(g.fixPath, 'guidance');
    assert.equal(g.category, 'offsite_presence');
    assert.deepEqual(g.promptIds, ['1']);
    assert.equal(g.reach.share, 0.2);
    assert.equal(g.evidence.type, 'citation_gap');
    assert.equal(g.evidence.siteType, 'Review site or directory');
    assert.equal(g.stableKey, stableKeyOf('citation.gap', 'g2.com'));
  });

  test('a competitor’s page in a format we write is a page to publish, in Content Studio', () => {
    const [g] = gaps(
      run(
        citations({
          opportunities: [
            site({
              domain: 'rival.io',
              type: 'competitor',
              typeLabel: 'Competitor',
              format: 'comparison',
              formatLabel: 'Comparison',
              path: 'content',
              contentFormat: 'comparison',
            }),
          ],
        }),
      ),
    );
    assert.equal(g.fixPath, 'content');
    assert.equal(g.category, 'content_new');
    assert.equal(g.title, 'Publish a comparison to compete with rival.io');
    assert.equal(g.evidence.contentFormat, 'comparison');
  });

  test('a site cited in fewer than the minimum answers without the brand is not raised', () => {
    const thin = site({ answersWithoutBrand: CITATION_LIMITS.minAnswers - 1 });
    assert.equal(gaps(run(citations({ opportunities: [thin] }))).length, 0);
  });

  test('replaces visibility.cited_source: with citations given, the old rule is silent', () => {
    const oldGap = [
      { domain: 'reddit.com', timesCited: 6, answersCiting: 5, answersWithoutBrand: 4 },
    ];
    const withNew = run(citations(), { citationGaps: oldGap });
    assert.equal(
      withNew.candidates.filter((c) => c.ruleCode === 'visibility.cited_source').length,
      0,
    );
    const legacy = evaluateRules({ ...base, citationGaps: oldGap });
    assert.equal(
      legacy.candidates.filter((c) => c.ruleCode === 'visibility.cited_source').length,
      1,
    );
  });

  test('only the best few are shown, the rest are still found so they are never taken for fixed', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      site({ domain: `site${i}.example`, answersWithoutBrand: 10 - i }),
    );
    const out = run(citations({ opportunities: many }));
    assert.equal(gaps(out).length, CITATION_LIMITS.gaps);
    assert.deepEqual(
      gaps(out).map((c) => c.subject),
      ['site0.example', 'site1.example', 'site2.example'],
    );
    assert.equal(out.detectedKeys.filter((k) => k.startsWith('citation.gap:')).length, 6);
  });

  test('nothing is raised, and nothing cleared, when no answer could be read', () => {
    const out = evaluateRules({ ...base, grid: null, citations: citations() });
    assert.equal(gaps(out).length, 0);
    assert.equal(out.evaluated['citation.gap'], false);
    assert.equal(run(citations()).evaluated['citation.gap'], true);
  });
});

describe('citation.own_page_uncited', () => {
  const page = { url: 'https://acme.com/services/implants' };
  const own = (c) => run(c).candidates.filter((x) => x.ruleCode === 'citation.own_page_uncited');

  test('names the page, says the site was cited, and is a content refresh judged on citation share', () => {
    const [r] = own(citations({ uncitedPages: [page] }));
    assert.equal(r.fixPath, 'content');
    assert.equal(r.category, 'content_refresh');
    assert.equal(r.metric, 'citation_share');
    assert.deepEqual(r.affectedUrls, [page.url]);
    assert.equal(r.evidence.ownCitations, 14);
    assert.equal(r.subject, pageSubject(page.url));
    assert.ok(r.stableKey.length < 191);
  });

  test('a long address still makes a short, stable key', () => {
    const long = `https://acme.com/${'a-very-long-segment/'.repeat(30)}end`;
    assert.ok(stableKeyOf('citation.own_page_uncited', pageSubject(long)).length < 191);
    assert.equal(pageSubject(long), pageSubject(long));
    assert.notEqual(pageSubject(long), pageSubject(`${long}x`));
  });

  test('is judged only when the scan and the citations were enough to judge', () => {
    assert.equal(
      run(citations({ ownPagesJudged: true })).evaluated['citation.own_page_uncited'],
      true,
    );
    assert.equal(
      run(citations({ ownPagesJudged: false })).evaluated['citation.own_page_uncited'],
      false,
    );
    assert.equal(run(null).evaluated['citation.own_page_uncited'], false);
  });

  test('no more than the limit are raised', () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({ url: `https://acme.com/p${i}` }));
    assert.equal(own(citations({ uncitedPages: pages })).length, CITATION_LIMITS.uncitedPages);
  });
});

describe('scoring', () => {
  test('both rules have ICE priors and are scored like any other', () => {
    for (const code of ['citation.gap', 'citation.own_page_uncited']) {
      assert.ok(RULES[code].prior > 0 && RULES[code].prior <= 1);
      assert.equal(RULES[code].metric, 'citation_share');
    }
    const found = run(citations({ uncitedPages: [{ url: 'https://acme.com/about' }] }));
    const scored = scoreCandidates(found.candidates, { prompts, enginesCount: 1 });
    assert.ok(scored.every((c) => c.ice > 0));
    assert.deepEqual(
      scored.map((c) => c.ice),
      [...scored.map((c) => c.ice)].sort((a, b) => b - a),
    );
  });
});

describe('the words of a citation result', () => {
  const outcome = (verdict, horizon = 'week_2') => ({
    metric: 'citation_share',
    horizon,
    verdict,
    promptsCount: 2,
    kBefore: 8,
    nBefore: 40,
    kAfter: 18,
    nAfter: 36,
    rateBefore: 0.2,
    rateAfter: 0.5,
    deltaPp: 30,
    p: 0.006,
    engineScope: 'all',
    computedAt: new Date('2026-10-18T10:00:00Z'),
  });
  const context = {
    title: 'Get listed on g2.com',
    startedAt: '2026-10-03T09:00:00Z',
    questions: 2,
    brandName: 'Acme',
  };

  test('a win says the site’s share of cited sources went up, not that the brand was named', () => {
    const text = proofSentence(outcome('proven_win'), context);
    assert.match(
      text,
      /on the 2 questions it targets, Acme’s own site went from 8 of 40 cited sources to 18 of 36/,
    );
    assert.match(text, /bigger than normal variation/);
    assert.doesNotMatch(text, /was named/);
  });

  test('a mention-rate result is worded exactly as before', () => {
    const text = proofSentence({ ...outcome('proven_win'), metric: 'mention_rate' }, context);
    assert.match(
      text,
      /Acme was named on the 2 questions it targets from 8 of 40 to 18 of 36 answers/,
    );
    assert.equal(proofSentence({ ...outcome('proven_win'), metric: undefined }, context), text);
  });

  test('no change and a decline are said plainly for citations too', () => {
    assert.match(
      proofSentence(outcome('no_change', 'week_4'), context),
      /Four weeks on.*8 of 40|18 of 36.*it was 8 of 40/,
    );
    assert.match(
      proofSentence(outcome('declined'), context),
      /drop is bigger than normal variation/,
    );
  });

  test('the proof card shows cited sources, not answers', () => {
    const [card] = proofCards(
      {
        recommendation: { title: 'T', measuringStartedAt: '2026-10-03T09:00:00Z' },
        outcomes: [outcome('proven_win')],
      },
      { brandName: 'Acme' },
    );
    assert.equal(card.rows[0].text, '8 of 40 cited sources were Acme’s own site (20%)');
    assert.equal(card.rows[1].text, '18 of 36 cited sources were Acme’s own site (50%)');
  });

  test('the public page says the same, and only a proven win over all engines can be shared', () => {
    const p = publicProof(outcome('proven_win'), { ...context, domain: 'acme.com' });
    assert.match(
      p.sentence,
      /^Since Acme marked “Get listed on g2\.com” done on October 3, 2026, on the 2 questions it targets, Acme’s own site went from 8 of 40 cited sources to 18 of 36\./,
    );
    assert.equal(shareSentence(outcome('proven_win'), context), p.sentence);
    assert.equal(publicProof(outcome('no_change'), context), null);
  });

  test('the weekly email says it too', () => {
    const wins = [
      {
        title: 'Get listed',
        metric: 'citation_share',
        kBefore: 8,
        nBefore: 40,
        kAfter: 18,
        nAfter: 36,
      },
    ];
    const mention = [{ ...wins[0], metric: 'mention_rate' }];
    const text = (w) =>
      buildDigest({
        project: { name: 'P', domain: 'p.example' },
        tiles: {},
        hasData: false,
        wins: w,
      }).proofs[0];
    assert.match(text(wins) ?? '', /own site was 8 of 40 cited sources before, and 18 of 36 since/);
    assert.match(text(mention) ?? '', /named in 8 of 40 answers before/);
  });
});
