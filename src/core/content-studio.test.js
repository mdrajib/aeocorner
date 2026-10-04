import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardColumns,
  itemCard,
  qcView,
  researchView,
  publishPanel,
  liveDraftHtml,
  exportHtml,
  exportMarkdown,
  wordsLabel,
} from './content-studio.js';
import { STATUSES } from './content-lifecycle.js';

const item = (over = {}) => ({
  publicId: '01ABC',
  title: 'Crowns',
  status: 'ready',
  format: 'faq',
  kind: 'new',
  qcScore: 88,
  qc: { blocking: [] },
  ...over,
});

test('every status lands in a board column; cards say status, format, kind, score and whether something blocks', () => {
  const columns = boardColumns(
    STATUSES.filter((s) => s !== 'archived').map((status) => item({ status, publicId: status })),
    { projectBase: '/p' },
  );
  assert.deepEqual(
    columns.map((c) => [c.key, c.cards.map((x) => x.status)]),
    [
      ['working', ['researching', 'briefing', 'drafting', 'qc']],
      ['review', ['ready', 'approved', 'publishing', 'failed']],
      ['published', ['published']],
    ],
  );
  const card = itemCard(item({ qc: { blocking: ['overlap'] }, kind: 'refresh' }), {
    projectBase: '/p',
  });
  assert.deepEqual(
    [card.href, card.badge, card.format, card.kind, card.score, card.blocked],
    ['/p/content/01ABC', { text: 'Ready to review', tone: 'warning' }, 'FAQ', 'Refresh', 88, true],
  );
  assert.ok(boardColumns([], { projectBase: '/p' }).every((c) => c.empty && c.cards.length === 0));
});

test('the check panel: tone by score and blocking, a stale check says so, each check explained', () => {
  const qc = {
    score: 88,
    ready: true,
    blocking: [],
    checks: [
      {
        code: 'answer_first',
        label: 'x',
        weight: 25,
        points: 25,
        status: 'pass',
        blocking: false,
        findings: [],
      },
      {
        code: 'overlap',
        weight: 10,
        points: 0,
        status: 'fail',
        blocking: true,
        findings: ['too similar'],
      },
    ],
  };
  const view = qcView(qc);
  assert.deepEqual([view.score, view.ready, view.tone, view.stale], [88, true, 'success', false]);
  assert.equal(view.checks[0].label, 'Answer first');
  assert.match(view.checks[0].help, /60 words/);
  assert.deepEqual(
    [
      view.checks[1].tone,
      view.checks[1].statusText,
      view.checks[1].blocking,
      view.checks[1].findings,
    ],
    ['danger', 'Needs work', true, ['too similar']],
  );
  assert.equal(qcView({ ...qc, blocking: ['overlap'] }).tone, 'danger');
  assert.match(qcView({ ...qc, blocking: ['overlap'] }).headline, /has to be fixed/);
  assert.equal(qcView({ ...qc, score: 70 }).tone, 'warning');
  assert.equal(qcView({ ...qc, score: 40 }).tone, 'danger');
  assert.deepEqual(
    [
      qcView(qc, { revisionIsCurrent: false }).ready,
      qcView(qc, { revisionIsCurrent: false }).stale,
    ],
    [false, true],
  );
  assert.equal(qcView(null), null);
});

test('research: verified and unverified facts are told apart, and the evidence is summarised', () => {
  const view = researchView({
    warning: 'None checked',
    searches: 3,
    facts: [
      { claim: 'A', url: 'https://a.com', quote: 'q', verified: true },
      { claim: 'B', url: 'https://b.com', verified: false },
    ],
    pack: {
      question: 'How much?',
      engines: [
        { engineCode: 'chatgpt', readable: 3, named: [{ name: 'Rival', count: 2 }] },
        { engineCode: 'gemini', readable: 0, named: [] },
      ],
      sources: [
        {
          url: 'https://s.com',
          title: null,
          domain: 's.com',
          timesCited: 4,
          isOwn: false,
          format: 'best_of',
        },
      ],
      format: { basis: '4 of 4 citations are best-of list pages' },
    },
  });
  assert.deepEqual(
    view.facts.map((f) => f.label),
    ['Checked against the page', 'Not checked: not used in the draft'],
  );
  assert.deepEqual(view.engines, [
    { code: 'chatgpt', readable: 3, named: 'Rival (2)' },
    { code: 'gemini', readable: 0, named: 'nobody' },
  ]);
  assert.deepEqual(view.sources[0], {
    url: 'https://s.com',
    title: 's.com',
    cited: 4,
    own: false,
    format: 'Best-of list',
  });
  assert.equal(researchView(null), null);
  assert.deepEqual(researchView({}).facts, []);
});

test('what may be pressed: approval needs a person with the right, a check of this text, and nothing blocking', () => {
  const ready = item({
    status: 'ready',
    currentRevisionId: 7n,
    jsonld: { a: 1 },
    qc: { blocking: [], revisionId: '7' },
  });
  const connected = {
    status: 'connected',
    config: { siteName: 'My Site', pluginConnected: true, canPublish: true },
  };
  let p = publishPanel({ item: ready, integration: connected, canApprove: true, canEdit: true });
  assert.deepEqual(
    [p.canEdit, p.canApprove, p.approveBlockers, p.canPublish, p.wordpress],
    [true, true, [], false, 'Connected to My Site'],
  );
  p = publishPanel({ item: ready, integration: connected, canApprove: false, canEdit: true });
  assert.deepEqual([p.canApprove, p.mayApprove], [false, false]);
  p = publishPanel({
    item: { ...ready, qc: { blocking: ['overlap'], revisionId: '7' } },
    integration: connected,
    canApprove: true,
    canEdit: true,
  });
  assert.equal(p.canApprove, false);
  assert.match(p.approveBlockers[0], /already on one of your pages/);
  p = publishPanel({
    item: { ...ready, qc: { blocking: [], revisionId: '6' } },
    integration: connected,
    canApprove: true,
    canEdit: true,
  });
  assert.match(p.approveBlockers[0], /changed after the last quality check/);
  const approved = item({ status: 'approved', cmsRef: '55', publishedUrl: 'https://x.test/?p=55' });
  p = publishPanel({ item: approved, integration: connected, canApprove: true, canEdit: true });
  assert.deepEqual(
    [p.canPublish, p.canUnapprove, p.draftUrl, p.needsConnection],
    [true, true, 'https://x.test/?p=55', false],
  );
  p = publishPanel({ item: approved, integration: null, canApprove: true, canEdit: true });
  assert.deepEqual(
    [p.canPublish, p.needsConnection, p.wordpress],
    [false, true, 'WordPress is not connected'],
  );
  p = publishPanel({
    item: approved,
    integration: { status: 'broken', config: {} },
    canApprove: true,
    canEdit: true,
  });
  assert.match(p.wordpress, /needs attention/);
  p = publishPanel({
    item: approved,
    integration: { status: 'connected', config: { pluginConnected: false, canPublish: false } },
    canApprove: true,
    canEdit: true,
  });
  assert.deepEqual([p.pluginMissing, p.cannotPublishLive], [true, true]);
  p = publishPanel({
    item: item({ status: 'published', publishedUrl: 'https://x.test/a/' }),
    integration: connected,
    canApprove: true,
    canEdit: true,
  });
  assert.deepEqual([p.publishedUrl, p.canEdit, p.canPublish], ['https://x.test/a/', false, false]);
});

test('the live draft is always sanitized', () => {
  assert.equal(
    liveDraftHtml('<h2>Hi</h2><p onclick="x">Text<script>alert(1)</script></p>'),
    '<h2>Hi</h2>\n<p>Text</p>',
  );
  assert.equal(liveDraftHtml(null), '');
  assert.ok(liveDraftHtml('<p>'.repeat(100_000)).length < 200_000);
});

test('HTML export carries the structured data as an escaped script block', () => {
  const html = exportHtml({
    title: 'A -- B',
    bodyHtml: '<p>Hi</p>',
    jsonld: { '@context': 'https://schema.org', '@type': 'Article', headline: 'Crowns <b>&</b>' },
  });
  assert.match(html, /^<!-- A — B -->\n<p>Hi<\/p>\n<script type="application\/ld\+json">/);
  assert.ok(!html.slice(html.indexOf('<script')).slice(40).includes('<b>'));
  assert.equal(
    exportHtml({ title: 't', bodyHtml: '<p>x</p>', jsonld: null }),
    '<!-- t -->\n<p>x</p>\n\n',
  );
  assert.throws(() => exportHtml({ title: 't', bodyHtml: '', jsonld: { '@type': 'Nope' } }));
});

test('Markdown export: headings, inline marks, links, lists, quotes and tables', () => {
  const md = exportMarkdown(
    '<h2>How much?</h2><p>It is <strong>$900</strong> or <em>so</em>, see <a href="https://a.com/x(1)">the guide</a> and *stars* [x].</p><ul><li>One</li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol><blockquote>Wise words</blockquote><h3>Table</h3><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr><tr><td>solo</td></tr></table>',
  );
  assert.equal(
    md,
    [
      '## How much?',
      'It is **$900** or *so*, see [the guide](https://a.com/x(1%29) and \\*stars\\* \\[x\\].',
      '- One\n- Two',
      '1. First\n2. Second',
      '> Wise words',
      '### Table',
      '| A | B |\n| --- | --- |\n| 1 | 2\\|3 |\n| solo |  |',
      '',
    ]
      .join('\n\n')
      .replace(/\n\n$/, '\n'),
  );
  assert.equal(exportMarkdown(''), '\n');
});

test('words label', () => {
  assert.equal(wordsLabel(1234), '1,234 words');
});
