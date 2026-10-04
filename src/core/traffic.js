/**
 * AI traffic from Google Analytics 4 and Search Console (Milestone 8, tasks 8.10–8.12; MVP F10). Pure: the request bodies
 * to send, how to read what comes back, and the numbers a screen shows. No network, no database.
 *
 * Checked against Google's documentation on 2026-10-04: the Data API's `sessionSource`, `landingPage` and `date`
 * dimensions and its `runReport` body (`dateRanges`, `dimensions`, `metrics`, `dimensionFilter`, `limit`, `offset`);
 * Search Console's `searchAnalytics/query` (`startDate`, `endDate`, `dimensions`, `rowLimit` up to 25,000, `startRow`; rows
 * carry `keys`, `clicks`, `impressions`, `ctr` and `position`; dates are Pacific time). The metric names `sessions`,
 * `engagedSessions`, `keyEvents` and `totalRevenue` are the Data API's current ones (key events replaced conversions in
 * 2024); the first live sync is their check.
 */

// --- Which visits came from an AI answer -------------------------------------------------------------------------

/**
 * Referrer hosts of AI assistants, by the channel they are counted under. A visit's source (`sessionSource` in GA4) is
 * matched against the host and its subdomains. The list is short on purpose and changes by editing it here: a visit is
 * never counted as AI unless it matches.
 */
export const AI_CHANNELS = Object.freeze({
  chatgpt: { label: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'] },
  perplexity: { label: 'Perplexity', hosts: ['perplexity.ai'] },
  gemini: { label: 'Gemini', hosts: ['gemini.google.com', 'bard.google.com'] },
  copilot: { label: 'Copilot', hosts: ['copilot.microsoft.com', 'copilot.com'] },
  claude: { label: 'Claude', hosts: ['claude.ai'] },
  other_ai: {
    label: 'Other AI',
    hosts: [
      'you.com',
      'phind.com',
      'poe.com',
      'meta.ai',
      'grok.com',
      'deepseek.com',
      'kagi.com',
      'chat.mistral.ai',
    ],
  },
});

export const AI_CHANNEL_CODES = Object.freeze(Object.keys(AI_CHANNELS));
export const CHANNEL_LABELS = Object.freeze({
  ...Object.fromEntries(Object.entries(AI_CHANNELS).map(([k, v]) => [k, v.label])),
  organic_search: 'Organic search',
  all: 'All visits',
});

const normalizeHost = (source) =>
  String(source ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');

/** The AI channel a visit's source belongs to, or null (a visit from anywhere else is not AI traffic). */
export function channelOfSource(source) {
  const host = normalizeHost(source);
  if (!host) return null;
  for (const [channel, def] of Object.entries(AI_CHANNELS)) {
    if (def.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return channel;
  }
  return null;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regular expression (GA4's FULL_REGEXP must match the whole value) for every host above, with or without `www.`. */
export function aiSourcePattern() {
  const hosts = Object.values(AI_CHANNELS).flatMap((c) => c.hosts);
  return `(?:[a-z0-9-]+\\.)?(?:${hosts.map(escapeRegex).join('|')})`;
}

// --- GA4 ----------------------------------------------------------------------------------------------------------

const GA4_METRICS = ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue'];
export const GA4_PAGE_SIZE = 100_000;

/**
 * The three reports one sync asks for, over `[startDate, endDate]` (YYYY-MM-DD, the property's own time zone):
 *   ai       visits whose source is an AI assistant, by day, source and landing page
 *   all      every visit, by day (so AI can be shown as a share of all visits)
 *   organic  visits from organic search, by day
 */
export function ga4Reports({ startDate, endDate }) {
  const base = {
    dateRanges: [{ startDate, endDate }],
    metrics: GA4_METRICS.map((name) => ({ name })),
    limit: GA4_PAGE_SIZE,
  };
  return {
    ai: {
      ...base,
      dimensions: ['date', 'sessionSource', 'landingPage'].map((name) => ({ name })),
      dimensionFilter: {
        filter: {
          fieldName: 'sessionSource',
          stringFilter: {
            matchType: 'FULL_REGEXP',
            value: aiSourcePattern(),
            caseSensitive: false,
          },
        },
      },
    },
    all: { ...base, dimensions: [{ name: 'date' }] },
    organic: {
      ...base,
      dimensions: [{ name: 'date' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
    },
  };
}

const gaDate = (v) =>
  /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null;
const whole = (v) => Math.max(0, Math.round(Number(v) || 0));

/**
 * Read one report's response into rows `{ metricDate, channel, landingPage, sessions, engagedSessions, keyEvents,
 * revenue, currency }`, one per day, channel and page. Several AI sources can share a channel (`other_ai`), so they are
 * added together. A row we cannot read (no date, no metrics) is skipped; a response with the wrong shape throws.
 *
 * @param {'ai'|'all'|'organic'} kind
 */
export function parseGa4Response(response, kind) {
  if (
    !response ||
    typeof response !== 'object' ||
    (response.rows !== undefined && !Array.isArray(response.rows))
  ) {
    throw new Error('Google Analytics answered in a shape we do not recognise.');
  }
  const names = (response.dimensionHeaders ?? []).map((h) => h.name);
  const metricNames = (response.metricHeaders ?? []).map((h) => h.name);
  if (response.rows?.length && (!names.includes('date') || !metricNames.includes('sessions'))) {
    throw new Error('Google Analytics answered in a shape we do not recognise.');
  }
  const currency = response.metadata?.currencyCode ?? null;
  const merged = new Map();
  for (const row of response.rows ?? []) {
    const dim = Object.fromEntries(names.map((n, i) => [n, row.dimensionValues?.[i]?.value]));
    const met = Object.fromEntries(metricNames.map((n, i) => [n, row.metricValues?.[i]?.value]));
    const metricDate = gaDate(dim.date);
    if (!metricDate) continue;
    let channel;
    if (kind === 'ai') {
      channel = channelOfSource(dim.sessionSource);
      if (!channel) continue; // the filter should prevent it; a source we do not recognise is never counted
    } else {
      channel = kind === 'organic' ? 'organic_search' : 'all';
    }
    const landingPage = kind === 'ai' ? String(dim.landingPage ?? '').slice(0, 2048) : '';
    const key = `${metricDate}|${channel}|${landingPage}`;
    const cur = merged.get(key) ?? {
      metricDate,
      channel,
      landingPage,
      sessions: 0,
      engagedSessions: 0,
      keyEvents: 0,
      revenue: 0,
      currency,
    };
    cur.sessions += whole(met.sessions);
    cur.engagedSessions += whole(met.engagedSessions);
    cur.keyEvents += whole(met.keyEvents);
    cur.revenue += Number(met.totalRevenue) || 0;
    merged.set(key, cur);
  }
  return [...merged.values()].map((r) => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }));
}

// --- Search Console -----------------------------------------------------------------------------------------------

export const GSC_ROW_LIMIT = 5000;
const GSC_MAX_PAGES = 20;
export { GSC_MAX_PAGES };

/** Search Console request bodies: queries by day (to find the branded ones) and pages by day. */
export function gscRequests({ startDate, endDate }) {
  const base = { startDate, endDate, rowLimit: GSC_ROW_LIMIT, dataState: 'final' };
  return {
    query: { ...base, dimensions: ['date', 'query'] },
    page: { ...base, dimensions: ['date', 'page'] },
  };
}

const normalizeWords = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The words that make a search "branded": the brand's name and aliases, and the site's own name (`acme-dental.com` is
 * "acme dental" and "acmedental"). Terms shorter than three characters are dropped: they match too much.
 */
export function brandTerms({ names = [], domain = '' }) {
  const terms = new Set();
  for (const n of names) {
    const w = normalizeWords(n);
    if (w.length >= 3) {
      terms.add(w);
      terms.add(w.replaceAll(' ', ''));
    }
  }
  const label = normalizeWords(
    String(domain)
      .replace(/^www\./, '')
      .split('.')[0],
  );
  if (label.length >= 3) {
    terms.add(label);
    terms.add(label.replaceAll(' ', ''));
  }
  return [...terms];
}

/**
 * Does this search contain one of the brand's terms as whole words? "acme-dental prices" and "acmedental reviews" do;
 * "acmeish" does not (a term inside a longer word is a different word).
 */
export function isBrandedQuery(query, terms) {
  const words = ` ${normalizeWords(query)} `;
  return terms.some((t) => words.includes(` ${t} `));
}

/**
 * Read a Search Console response (`dimensions: ['date', 'query' | 'page']`) into rows `{ metricDate, dimension,
 * value, isBranded, clicks, impressions, avgPosition }`. Queries are kept only when branded (the point is whether
 * people search for the brand by name); pages are kept as they are.
 */
export function parseGscResponse(response, dimension, terms = []) {
  if (
    !response ||
    typeof response !== 'object' ||
    (response.rows !== undefined && !Array.isArray(response.rows))
  ) {
    throw new Error('Search Console answered in a shape we do not recognise.');
  }
  const out = [];
  for (const row of response.rows ?? []) {
    const [date, value] = row.keys ?? [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || typeof value !== 'string' || !value) continue;
    const branded = dimension === 'query' ? isBrandedQuery(value, terms) : null;
    if (dimension === 'query' && !branded) continue;
    out.push({
      metricDate: date,
      dimension,
      value: value.slice(0, 2048),
      isBranded: branded,
      clicks: whole(row.clicks),
      impressions: whole(row.impressions),
      avgPosition: Number.isFinite(row.position) ? Math.round(row.position * 100) / 100 : null,
    });
  }
  return out;
}

// --- What the traffic screen says ---------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOf = (v) => String(v).slice(0, 10);
const mondayOf = (day) => {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY_MS).toISOString().slice(0, 10);
};
const sum = (rows, pick) => rows.reduce((n, r) => n + Number(pick(r)), 0);

/**
 * The traffic screen as data.
 *
 * @param {object[]} input.rows      `traffic_daily` rows as `{ metricDate, channel, landingPage, sessions, engagedSessions, keyEvents, revenue }`
 * @param {object[]} input.search    `search_console_daily` rows as `{ metricDate, dimension, value, clicks, impressions }`
 * @param {{from: string, to: string}|null} input.coverage  the days that have been synced (a week outside it is "couldn't check", never 0)
 * @param {string} input.today       YYYY-MM-DD
 * @param {number} [input.weeks]
 */
export function trafficView({ rows, search = [], coverage, today, weeks = 8 }) {
  if (!coverage) return { state: 'no_data' };
  // The weeks shown are the eight that have finished: the one in progress is not a week yet.
  const lastMonday = new Date(new Date(`${mondayOf(today)}T00:00:00Z`).getTime() - 7 * DAY_MS);
  const starts = Array.from({ length: weeks }, (_, i) =>
    new Date(lastMonday.getTime() - (weeks - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
  );
  const endOf = (start) =>
    new Date(new Date(`${start}T00:00:00Z`).getTime() + 6 * DAY_MS).toISOString().slice(0, 10);
  // A week counts only when every day of it has been synced. The current week is still in progress, so it is left out.
  const complete = starts.filter(
    (s) => s >= coverage.from && endOf(s) <= coverage.to && endOf(s) < today,
  );
  const labels = starts.map((s) => `Week of ${s}`);
  const inWeek = (rs, start) =>
    rs.filter((r) => dayOf(r.metricDate) >= start && dayOf(r.metricDate) <= endOf(start));
  const weekly = (rs, pick) =>
    starts.map((s) => (complete.includes(s) ? sum(inWeek(rs, s), pick) : null));

  const ai = rows.filter((r) => AI_CHANNEL_CODES.includes(r.channel));
  const all = rows.filter((r) => r.channel === 'all');
  const channels = AI_CHANNEL_CODES.map((code) => ({
    code,
    label: AI_CHANNELS[code].label,
    values: weekly(
      ai.filter((r) => r.channel === code),
      (r) => r.sessions,
    ),
  })).filter((c) => c.values.some((v) => v)); // a source that never sent anyone is not a line

  // The last four finished weeks against the four before them: shown, never coloured (no significance test here).
  const last4 = complete.slice(-4);
  const prev4 = complete.slice(-8, -4);
  const total = (rs, weeksList) =>
    sum(
      weeksList.flatMap((s) => inWeek(rs, s)),
      (r) => r.sessions,
    );
  const aiNow = last4.length === 4 ? total(ai, last4) : null;
  const aiBefore = prev4.length === 4 ? total(ai, prev4) : null;
  const allNow = last4.length === 4 ? total(all, last4) : null;
  const change = (now, before) => {
    if (now === null || before === null) return null;
    if (before === 0)
      return now === 0 ? 'No visits from AI in either period' : `Up from none (not tested)`;
    const pct = Math.round(((now - before) / before) * 100);
    return `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}% vs the four weeks before (not tested)`;
  };

  const lastWindow = last4.flatMap((s) => inWeek(ai, s));
  const pages = new Map();
  for (const r of lastWindow) {
    if (!r.landingPage) continue;
    const p = pages.get(r.landingPage) ?? {
      page: r.landingPage,
      sessions: 0,
      engaged: 0,
      keyEvents: 0,
    };
    p.sessions += r.sessions;
    p.engaged += r.engagedSessions;
    p.keyEvents += r.keyEvents;
    pages.set(r.landingPage, p);
  }
  const topPages = [...pages.values()]
    .sort((a, b) => b.sessions - a.sessions || a.page.localeCompare(b.page))
    .slice(0, 10);

  const branded = search.filter((r) => r.dimension === 'query');
  const brandedClicks = weekly(branded, (r) => r.clicks);

  return {
    state: complete.length === 0 ? 'syncing' : 'data',
    labels,
    channels,
    totals: weekly(ai, (r) => r.sessions),
    brandedClicks,
    hasBranded: branded.length > 0,
    tiles: {
      aiSessions: aiNow === null ? null : { value: aiNow, note: change(aiNow, aiBefore) },
      aiShare:
        allNow === null || allNow === 0
          ? null
          : { value: Math.round((aiNow / allNow) * 1000) / 10 },
      engaged: aiNow ? Math.round((sum(lastWindow, (r) => r.engagedSessions) / aiNow) * 100) : null,
      keyEvents: aiNow === null ? null : sum(lastWindow, (r) => r.keyEvents),
    },
    topPages,
    window: last4.length ? { from: last4[0], to: endOf(last4.at(-1)) } : null,
    max: Math.max(10, ...channels.flatMap((c) => c.values.filter((v) => v !== null))),
  };
}
