import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AI_CHANNELS,
  aiSourcePattern,
  brandTerms,
  channelOfSource,
  ga4Reports,
  gscRequests,
  isBrandedQuery,
  parseGa4Response,
  parseGscResponse,
  trafficView,
} from './traffic.js';

describe('which visits are AI traffic', () => {
  test('known assistants map to their channel, with or without www, a scheme or a subdomain', () => {
    const cases = {
      'chatgpt.com': 'chatgpt',
      'chat.openai.com': 'chatgpt',
      'https://www.perplexity.ai/search?q=x': 'perplexity',
      'gemini.google.com': 'gemini',
      'copilot.microsoft.com': 'copilot',
      'claude.ai': 'claude',
      'app.you.com': 'other_ai',
      'CHATGPT.COM': 'chatgpt',
    };
    for (const [source, channel] of Object.entries(cases))
      assert.equal(channelOfSource(source), channel, source);
  });

  test('anything else is not AI traffic, including look-alike hosts and plain Google', () => {
    for (const source of [
      'google',
      'google.com',
      'bing',
      'newsletter',
      'evilchatgpt.com',
      'chatgpt.com.evil.test',
      'notclaude.ai',
      '',
      null,
      undefined,
      '(direct)',
    ]) {
      assert.equal(channelOfSource(source), null, String(source));
    }
  });

  test('the GA4 filter pattern matches exactly the hosts in the table', () => {
    const re = new RegExp(`^${aiSourcePattern()}$`, 'i');
    for (const hosts of Object.values(AI_CHANNELS).map((c) => c.hosts)) {
      for (const h of hosts) {
        assert.ok(re.test(h), h);
        assert.ok(re.test(`www.${h}`), `www.${h}`);
      }
    }
    for (const bad of [
      'google.com',
      'evilchatgpt.com',
      'chatgpt.com.evil.test',
      'xchat.openai.com.au',
    ]) {
      assert.ok(!re.test(bad), bad);
    }
  });
});

describe('the GA4 requests', () => {
  const reports = ga4Reports({ startDate: '2026-09-01', endDate: '2026-09-30' });

  test('the AI report is by day, source and landing page, filtered to AI sources', () => {
    assert.deepEqual(
      reports.ai.dimensions.map((d) => d.name),
      ['date', 'sessionSource', 'landingPage'],
    );
    assert.deepEqual(
      reports.ai.metrics.map((m) => m.name),
      ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue'],
    );
    assert.equal(reports.ai.dimensionFilter.filter.fieldName, 'sessionSource');
    assert.equal(reports.ai.dimensionFilter.filter.stringFilter.matchType, 'FULL_REGEXP');
    assert.deepEqual(reports.ai.dateRanges, [{ startDate: '2026-09-01', endDate: '2026-09-30' }]);
  });

  test('the totals and organic reports are by day only', () => {
    assert.deepEqual(reports.all.dimensions, [{ name: 'date' }]);
    assert.equal(reports.all.dimensionFilter, undefined);
    assert.equal(reports.organic.dimensionFilter.filter.stringFilter.value, 'Organic Search');
  });
});

/** A GA4 response in the shape the Data API returns. */
const ga4 = (rows, { dims = ['date', 'sessionSource', 'landingPage'], currency = 'USD' } = {}) => ({
  dimensionHeaders: dims.map((name) => ({ name })),
  metricHeaders: ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue'].map((name) => ({
    name,
    type: 'TYPE_INTEGER',
  })),
  rows: rows.map(([d, m]) => ({
    dimensionValues: d.map((value) => ({ value })),
    metricValues: m.map((value) => ({ value: String(value) })),
  })),
  rowCount: rows.length,
  metadata: { currencyCode: currency },
});

describe('reading a GA4 response', () => {
  test('rows become days, channels and pages; sources of one channel are added together', () => {
    const rows = parseGa4Response(
      ga4([
        [
          ['20260901', 'chatgpt.com', '/pricing'],
          [10, 7, 2, 120.5],
        ],
        [
          ['20260901', 'chat.openai.com', '/pricing'],
          [5, 3, 0, 0],
        ],
        [
          ['20260901', 'perplexity.ai', '/'],
          [4, 4, 1, 0],
        ],
        [
          ['20260902', 'you.com', '/'],
          [1, 0, 0, 0],
        ],
        [
          ['20260902', 'phind.com', '/'],
          [2, 1, 0, 0],
        ],
      ]),
      'ai',
    );
    const find = (date, channel, page) =>
      rows.find((r) => r.metricDate === date && r.channel === channel && r.landingPage === page);
    assert.equal(find('2026-09-01', 'chatgpt', '/pricing').sessions, 15);
    assert.equal(find('2026-09-01', 'chatgpt', '/pricing').engagedSessions, 10);
    assert.equal(find('2026-09-01', 'chatgpt', '/pricing').revenue, 120.5);
    assert.equal(find('2026-09-01', 'chatgpt', '/pricing').currency, 'USD');
    assert.equal(find('2026-09-02', 'other_ai', '/').sessions, 3);
    assert.equal(rows.length, 3);
  });

  test('a source that is not an AI assistant is never counted, even if the filter let it through', () => {
    const rows = parseGa4Response(
      ga4([
        [
          ['20260901', 'google', '/'],
          [99, 50, 0, 0],
        ],
      ]),
      'ai',
    );
    assert.deepEqual(rows, []);
  });

  test('the totals and organic reports have no page and their own channel', () => {
    const all = parseGa4Response(
      ga4([[['20260901'], [200, 150, 5, 0]]], { dims: ['date'] }),
      'all',
    );
    assert.deepEqual([all[0].channel, all[0].landingPage, all[0].sessions], ['all', '', 200]);
    const organic = parseGa4Response(
      ga4([[['20260901'], [80, 60, 1, 0]]], { dims: ['date'] }),
      'organic',
    );
    assert.equal(organic[0].channel, 'organic_search');
  });

  test('a day with no visits has no row (it is not invented), and an empty report is an empty list', () => {
    assert.deepEqual(parseGa4Response({ dimensionHeaders: [], metricHeaders: [] }, 'ai'), []);
  });

  test('a response that changed shape throws instead of being read as zero', () => {
    assert.throws(() => parseGa4Response(null, 'ai'), /shape/);
    assert.throws(() => parseGa4Response({ rows: 'x' }, 'ai'), /shape/);
    const noDate = ga4([[['x'], [1, 1, 1, 1]]], { dims: ['sessionSource'] });
    assert.throws(() => parseGa4Response(noDate, 'ai'), /shape/);
  });

  test('a row with a bad date or non-numeric metrics is skipped or counted as zero, never NaN', () => {
    const rows = parseGa4Response(
      ga4([
        [
          ['not-a-date', 'chatgpt.com', '/'],
          [1, 1, 1, 1],
        ],
        [
          ['20260903', 'chatgpt.com', '/x'],
          ['abc', -4, null, 'zz'],
        ],
      ]),
      'ai',
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].sessions, rows[0].engagedSessions, rows[0].keyEvents, rows[0].revenue],
      [0, 0, 0, 0],
    );
  });
});

describe('Search Console', () => {
  const terms = brandTerms({ names: ['Acme Dental', 'Acme'], domain: 'www.acme-dental.com' });

  test('the brand’s terms come from its names and its site', () => {
    assert.ok(terms.includes('acme dental'));
    assert.ok(terms.includes('acmedental'));
    assert.ok(terms.includes('acme'));
    assert.deepEqual(
      brandTerms({ names: ['Ab'], domain: 'x.com' }),
      [],
      'too short to mean anything',
    );
  });

  test('a search is branded when it names the brand as words or run together', () => {
    for (const q of [
      'acme dental austin',
      'Acme Dental',
      'acmedental reviews',
      'is acme good',
      'ACME-dental prices',
    ]) {
      assert.equal(isBrandedQuery(q, terms), true, q);
    }
    for (const q of ['dentist in austin', 'acmeish', 'best dental clinic', '']) {
      assert.equal(isBrandedQuery(q, terms), false, q);
    }
  });

  test('requests ask for queries and pages by day, final data', () => {
    const r = gscRequests({ startDate: '2026-09-01', endDate: '2026-09-30' });
    assert.deepEqual(r.query.dimensions, ['date', 'query']);
    assert.deepEqual(r.page.dimensions, ['date', 'page']);
    assert.equal(r.query.dataState, 'final');
    assert.ok(r.query.rowLimit <= 25000);
  });

  test('queries are kept only when branded; pages are kept as they are', () => {
    const response = {
      rows: [
        {
          keys: ['2026-09-01', 'acme dental austin'],
          clicks: 12,
          impressions: 90,
          ctr: 0.13,
          position: 1.4,
        },
        {
          keys: ['2026-09-01', 'cheap dentist'],
          clicks: 50,
          impressions: 900,
          ctr: 0.05,
          position: 8,
        },
      ],
    };
    const q = parseGscResponse(response, 'query', terms);
    assert.equal(q.length, 1);
    assert.deepEqual(
      [q[0].value, q[0].isBranded, q[0].clicks, q[0].impressions, q[0].avgPosition],
      ['acme dental austin', true, 12, 90, 1.4],
    );
    const pages = parseGscResponse(
      {
        rows: [
          {
            keys: ['2026-09-01', 'https://acme-dental.com/pricing'],
            clicks: 3,
            impressions: 40,
            position: 5.123,
          },
        ],
      },
      'page',
    );
    assert.deepEqual([pages[0].isBranded, pages[0].avgPosition], [null, 5.12]);
  });

  test('a changed shape throws; an empty answer is an empty list; a malformed row is skipped', () => {
    assert.throws(() => parseGscResponse('x', 'page'), /shape/);
    assert.deepEqual(parseGscResponse({}, 'page'), []);
    assert.deepEqual(
      parseGscResponse({ rows: [{ keys: ['nope', 'x'], clicks: 1 }, { keys: [] }] }, 'page'),
      [],
    );
  });
});

describe('the traffic screen’s numbers', () => {
  const day = (metricDate, channel, sessions, landingPage = '', extra = {}) => ({
    metricDate,
    channel,
    landingPage,
    sessions,
    engagedSessions: Math.floor(sessions / 2),
    keyEvents: 0,
    revenue: 0,
    ...extra,
  });
  // Eight Mondays ending 2026-09-28, with a visit on each, and the days between synced.
  const mondays = [
    '2026-08-10',
    '2026-08-17',
    '2026-08-24',
    '2026-08-31',
    '2026-09-07',
    '2026-09-14',
    '2026-09-21',
    '2026-09-28',
  ];
  const rows = mondays.flatMap((m, i) => [
    day(m, 'chatgpt', 10 + i, '/pricing'),
    day(m, 'perplexity', 5, '/'),
    day(m, 'all', 200),
  ]);
  const coverage = { from: '2026-08-10', to: '2026-10-04' };

  test('weekly lines per source, the last four weeks against the four before, and the share of all visits', () => {
    const v = trafficView({ rows, coverage, today: '2026-10-05' });
    assert.equal(v.state, 'data');
    assert.equal(v.labels.length, 8);
    assert.deepEqual(
      v.channels.map((c) => c.code),
      ['chatgpt', 'perplexity'],
    );
    assert.deepEqual(v.channels[0].values, [10, 11, 12, 13, 14, 15, 16, 17]);
    assert.equal(v.tiles.aiSessions.value, 14 + 15 + 16 + 17 + 20);
    assert.match(v.tiles.aiSessions.note, /vs the four weeks before \(not tested\)/);
    assert.equal(v.tiles.aiShare.value, Math.round(((62 + 20) / 800) * 1000) / 10);
    assert.deepEqual(v.topPages[0], { page: '/pricing', sessions: 62, engaged: 30, keyEvents: 0 });
    assert.deepEqual(v.window, { from: '2026-09-07', to: '2026-10-04' });
  });

  test('a week not yet synced is "couldn’t check" (null), never 0; a source that sent nobody is not a line', () => {
    const v = trafficView({
      rows,
      coverage: { from: '2026-08-31', to: '2026-10-04' },
      today: '2026-10-05',
    });
    assert.deepEqual(v.channels[0].values.slice(0, 3), [null, null, null]);
    assert.equal(v.channels[0].values[3], 13);
    assert.equal(
      v.tiles.aiSessions.note,
      null,
      'with no earlier four weeks there is nothing to compare',
    );
    assert.ok(!v.channels.some((c) => c.code === 'claude'));
  });

  test('the week in progress is not shown: the last label is the last finished week', () => {
    const v = trafficView({
      rows,
      coverage: { from: '2026-08-10', to: '2026-09-30' },
      today: '2026-09-30',
    });
    assert.equal(v.labels.at(-1), 'Week of 2026-09-21');
    assert.equal(v.channels[0].values.at(-1), 16);
  });

  test('no connection or nothing synced yet says so instead of drawing zeros', () => {
    assert.equal(trafficView({ rows: [], coverage: null, today: '2026-10-05' }).state, 'no_data');
    assert.equal(
      trafficView({
        rows: [],
        coverage: { from: '2026-10-01', to: '2026-10-04' },
        today: '2026-10-05',
      }).state,
      'syncing',
    );
  });

  test('branded search clicks are weekly and only shown when there are any', () => {
    const search = [
      { metricDate: '2026-09-28', dimension: 'query', value: 'acme', clicks: 9, impressions: 20 },
    ];
    const v = trafficView({ rows, search, coverage, today: '2026-10-05' });
    assert.equal(v.hasBranded, true);
    assert.equal(v.brandedClicks.at(-1), 9);
    assert.equal(trafficView({ rows, coverage, today: '2026-10-05' }).hasBranded, false);
  });

  test('visits from AI that rose from none are said so, without a percentage of nothing', () => {
    const only = mondays.slice(4).map((m) => day(m, 'chatgpt', 3, '/'));
    const v = trafficView({
      rows: [...only, ...mondays.map((m) => day(m, 'all', 100))],
      coverage,
      today: '2026-10-05',
    });
    assert.equal(v.tiles.aiSessions.note, 'Up from none (not tested)');
  });
});
