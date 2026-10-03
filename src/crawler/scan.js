import { PROBE_USER_AGENTS } from '../core/ai-crawlers.js';
import { storeRaw } from '../integrations/spaces.js';
import { detectBotBlock } from './bot-block.js';
import { decodeBody } from './decode.js';
import { extractPage } from './html.js';
import { runReadinessChecks } from './readiness/index.js';
import { evaluateRobots, parseRobots, ROBOTS_MAX_BYTES } from './robots.js';
import { MAX_KEY_PAGES, MAX_RENDERED_PAGES, pickRenderPages, selectPages } from './select-pages.js';
import { CRAWLER_USER_AGENT, FetchError } from './safe-fetch.js';
import { inflateIfGzipped, parseSitemap, SITEMAP_LIMITS } from './sitemap.js';

/**
 * One scan of one website: everything Phase 4 builds, in order (MVP F1 steps 1-4). Given a domain it
 *   1. reads robots.txt and obeys it,
 *   2. finds the sitemaps,
 *   3. fetches the home page and chooses up to 20 key pages,
 *   4. fetches each (storing the raw HTML),
 *   5. renders 5 of them in a headless browser (storing that too),
 *   6. sends look-alike AI-crawler requests to see whether a firewall turns them away,
 *   7. runs the 24 readiness checks.
 *
 * Every request goes through the safe fetcher, so no step can reach a private address. The function takes its
 * collaborators as arguments and does no persistence of its own: the worker saves what it returns.
 *
 * A thing we could not look at is recorded as such. It never turns into "the site lacks this".
 */

const PAGE_BODY_TYPES = [/html/i, /xml/i, /^text\//i];
const TEXT_BODY_TYPES = [/^text\//i, /xml/i, /json/i, /octet-stream/i, /^$/];
const SITEMAP_BODY_TYPES = [/xml/i, /^text\//i, /gzip/i, /octet-stream/i, /^$/];
const DEFAULT_SITEMAPS = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'];
const PAGE_CONCURRENCY = 2;
// Headers worth keeping with a page: what the readiness checks and later diagnosis read.
const KEPT_HEADERS = [
  'content-type',
  'last-modified',
  'x-robots-tag',
  'server',
  'x-powered-by',
  'link',
];

export const SCAN_LIMITS = Object.freeze({
  maxKeyPages: MAX_KEY_PAGES,
  maxRenderedPages: MAX_RENDERED_PAGES,
  /** Stop starting new steps after this long; whatever finished is reported as a partial scan. */
  maxDurationMs: 4 * 60_000,
  maxSitemapUrls: 10_000,
  /**
   * Choosing 20 pages needs a sample of the site's URLs, not all of them. Large sites have sitemaps of many
   * megabytes; reading them all took 44 of 80 seconds on one real site. Stop once there are this many URLs, or
   * after this long.
   */
  sitemapEnoughUrls: 2_000,
  sitemapBudgetMs: 20_000,
});

/** Run `fn` over `items` with at most `size` in flight at once, keeping the results in order. */
async function mapPool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

const startUrl = (input) => (/^https?:\/\//i.test(input) ? input : `https://${input}`);
const pathAndQuery = (url) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};
const pickHeaders = (headers) =>
  Object.fromEntries(
    KEPT_HEADERS.filter((h) => headers[h] !== undefined).map((h) => [h, String(headers[h])]),
  );

/**
 * @param {object} deps
 * @param {{ fetch: Function }} deps.fetcher   the safe fetcher
 * @param {{ render: Function } | null} [deps.renderer]   the headless browser; null skips the render step
 * @param {object} deps.store   object storage (raw pages)
 */
export async function runSiteScan(
  input,
  {
    fetcher,
    renderer = null,
    store,
    now = () => new Date(),
    log = () => {},
    limits = {},
    respectRobots = true,
  } = {},
) {
  const policy = { ...SCAN_LIMITS, ...limits };
  const startedAt = now();
  const deadline = startedAt.getTime() + policy.maxDurationMs;
  const outOfTime = () => now().getTime() >= deadline; // the same clock that set the deadline
  const notes = [];
  const connections = [];
  const overridden = new Set(); // robots.txt answers we went ahead despite (respectRobots: false)
  // Where the time goes: each phase logs how long the one before it took.
  let phaseName = null;
  let phaseStart = Date.now();
  const phase = (next) => {
    if (phaseName) log('phase', { phase: phaseName, ms: Date.now() - phaseStart });
    phaseName = next;
    phaseStart = Date.now();
  };

  /** A fetch that reports failure as data. Every connection is recorded to show what the scan touched. */
  async function get(url, options = {}) {
    try {
      const res = await fetcher.fetch(url, options);
      connections.push(...res.connections);
      return { ok: true, ...res };
    } catch (err) {
      if (!(err instanceof FetchError)) throw err;
      log('fetch_failed', { url, code: err.code });
      return {
        ok: false,
        error: { code: err.code, message: err.message, guard: err.code.startsWith('blocked_') },
      };
    }
  }

  const save = (kind, res, body = res.body) =>
    storeRaw(store, {
      kind,
      body,
      contentType: res.contentType || undefined,
      url: res.url,
      status: res.status,
      fetchedAt: now(),
    });

  phase('robots');
  // --- 1. robots.txt, from the address the visitor typed ----------------------------------------------------
  const first = new URL(startUrl(input));
  const robotsByOrigin = new Map();

  async function robotsFor(origin) {
    if (robotsByOrigin.has(origin)) return robotsByOrigin.get(origin);
    const res = await get(`${origin}/robots.txt`, {
      maxBytes: ROBOTS_MAX_BYTES,
      bodyTypes: TEXT_BODY_TYPES,
    });
    const info = {
      origin,
      status: 'unreachable',
      httpStatus: res.ok ? res.status : null,
      parsed: null,
      key: null,
      error: res.ok ? null : res.error.code,
    };
    if (res.ok && detectBotBlock(res).blocked) {
      // A firewall answered instead of the site. We can't tell what robots.txt says; that is not "no rules".
      info.error = 'blocked_by_firewall';
      info.blocked = true;
    } else if (res.ok) {
      const text = decodeBody(res.body, res.contentType).text;
      if (res.status >= 200 && res.status < 300) {
        const looksLikeHtml = /html/i.test(res.contentType) || /^\s*</.test(text);
        if (looksLikeHtml || res.bodySkipped) {
          info.status = 'missing'; // a web page served where robots.txt should be: no rules
        } else {
          info.status = 'ok';
          info.parsed = parseRobots(text);
          info.key = (await save('robots', res)).key;
        }
      } else if (res.status === 429 || res.status >= 500) {
        info.status = 'unreachable'; // RFC 9309: assume the worst
      } else {
        info.status = 'missing'; // 404 and the like: nothing is off limits
      }
    }
    robotsByOrigin.set(origin, info);
    return info;
  }

  /**
   * May OUR crawler fetch this URL? A robots.txt we can't reach means no (RFC 9309).
   *
   * With `respectRobots: false` the answer is always yes. That is for a signed-in customer scanning their own
   * project (ADR-0005, decided 2026-10-02): it is their site and their request, and without it a robots.txt that
   * shuts out all bots would leave them unable to see what is wrong. The scan says so in its notes, and still
   * reports what robots.txt says (check A1). Pacing, size limits and the SSRF guard are unchanged.
   */
  async function mayFetch(url) {
    const verdict = await robotsVerdict(url);
    if (verdict.allowed || respectRobots) return verdict;
    overridden.add(verdict.reason);
    return { allowed: true };
  }

  async function robotsVerdict(url) {
    const robots = await robotsFor(new URL(url).origin);
    // A firewall that turns us away at robots.txt will turn us away at the pages too, and each page then records
    // the block. A server that is simply down is different: the standard says stay away.
    if (robots.status === 'unreachable' && robots.blocked) return { allowed: true };
    if (robots.status === 'unreachable') return { allowed: false, reason: 'robots_unreachable' };
    if (robots.status === 'missing') return { allowed: true };
    const verdict = evaluateRobots(robots.parsed, 'AEOCornerBot', pathAndQuery(url));
    return verdict.allowed
      ? { allowed: true }
      : { allowed: false, reason: 'disallowed_by_robots', rule: verdict.rule };
  }

  let robots = await robotsFor(first.origin);

  phase('home');
  // --- 2. the home page --------------------------------------------------------------------------------------
  const homeGate = await mayFetch(`${first.origin}/`);
  let home = null;
  let homeProblem = null;
  if (!homeGate.allowed) {
    homeProblem = homeGate.reason;
    notes.push(
      homeGate.reason === 'robots_unreachable'
        ? `robots.txt could not be fetched (${robots.error ?? `HTTP ${robots.httpStatus}`}), so the crawler stayed away, as the standard requires.`
        : `robots.txt asks our crawler (AEOCornerBot) to stay away (${homeGate.rule}). The pages were not read.`,
    );
  } else {
    home = await get(`${first.origin}/`, { bodyTypes: PAGE_BODY_TYPES });
    if (!home.ok) homeProblem = home.error.code;
    // The site may have sent us to another address (acme.com -> www.acme.com). That origin has its own robots.txt.
    else if (new URL(home.url).origin !== first.origin) {
      robots = await robotsFor(new URL(home.url).origin);
      const gate = await mayFetch(home.url);
      if (!gate.allowed) {
        homeProblem = gate.reason;
        notes.push(
          `robots.txt at ${new URL(home.url).origin} asks our crawler to stay away. The pages were not read.`,
        );
      }
    }
  }
  const origin = home?.ok ? new URL(home.url).origin : first.origin;
  const homeUrl = home?.ok ? home.url : `${first.origin}/`;
  robots = robotsByOrigin.get(origin) ?? robots;

  phase('sitemaps');
  // --- 3. sitemaps -------------------------------------------------------------------------------------------
  const sitemaps = {
    found: [],
    referenced: robots.parsed?.sitemaps ?? [],
    lastmods: [],
    urls: [],
    blocked: false,
  };
  const sitemapsStarted = Date.now();
  const sitemapsEnough = () =>
    sitemaps.urls.length >= policy.sitemapEnoughUrls ||
    Date.now() - sitemapsStarted > policy.sitemapBudgetMs;
  async function readSitemap(url, depth = 0) {
    if (sitemaps.urls.length >= policy.maxSitemapUrls) return false;
    const res = await get(url, { maxBytes: 5 * 1024 * 1024, bodyTypes: SITEMAP_BODY_TYPES });
    // A firewall's answer means we could not look, which the sitemap check must not report as "no sitemap".
    if (res.ok && detectBotBlock(res).blocked) sitemaps.blocked = true;
    if (!res.ok || res.status < 200 || res.status >= 300) return false;
    let text;
    try {
      text = inflateIfGzipped(res.body, 5 * 1024 * 1024);
    } catch {
      return false; // a compressed bomb or a damaged file
    }
    const parsed = parseSitemap(text, { maxUrls: policy.maxSitemapUrls - sitemaps.urls.length });
    if (parsed.kind === 'unknown' || (parsed.urls.length === 0 && parsed.sitemaps.length === 0))
      return false;
    // The top-level file is kept as fetched (decompressed); a finding about it can point at the stored copy.
    const stored = depth === 0 ? await save('sitemap', res, Buffer.from(text)) : null;
    sitemaps.found.push({
      url: res.url,
      kind: parsed.kind,
      urlCount: parsed.urls.length,
      children: parsed.sitemaps.length,
      key: stored?.key ?? null,
    });
    for (const u of parsed.urls) {
      sitemaps.urls.push(u);
      if (u.lastmod) sitemaps.lastmods.push(u.lastmod);
    }
    if (parsed.kind === 'index' && depth === 0) {
      for (const child of parsed.sitemaps.slice(0, SITEMAP_LIMITS.maxChildSitemaps)) {
        if (outOfTime() || sitemapsEnough()) break;
        await readSitemap(child.loc, 1);
      }
    }
    return true;
  }

  if (!homeProblem) {
    const candidates = robots.parsed?.sitemaps.length
      ? robots.parsed.sitemaps.slice(0, 3)
      : DEFAULT_SITEMAPS.map((p) => `${origin}${p}`);
    for (const candidate of candidates) {
      if (outOfTime() || sitemapsEnough()) break;
      const ok = await readSitemap(candidate);
      // Default addresses are guesses: stop at the first that is real. Declared ones are all read.
      if (ok && !robots.parsed?.sitemaps.length) break;
    }
  }

  phase('selection');
  // --- 4. the home page's facts, and the choice of key pages ------------------------------------------------
  const pages = [];
  let homeFacts = null;
  if (home?.ok && !homeProblem) {
    const block = detectBotBlock(home);
    if (!block.blocked && home.status >= 200 && home.status < 300 && !home.bodySkipped) {
      homeFacts = extractPage(decodeBody(home.body, home.contentType).text, home.url, {
        headers: home.headers,
      });
    }
  }

  const selected = homeFacts
    ? selectPages({
        home: home.url,
        links: homeFacts.links,
        sitemapUrls: sitemaps.urls,
        limit: policy.maxKeyPages,
      })
    : [{ url: homeUrl, pageType: 'home', sources: ['home'], score: 1000 }];

  phase('pages');
  // --- 5. fetch every key page (the home page is already in hand) ------------------------------------------
  async function readPage(plan) {
    const record = {
      url: plan.url,
      finalUrl: null,
      pageType: plan.pageType,
      isKey: true,
      sources: plan.sources,
      status: null,
      redirectCount: 0,
      contentType: null,
      headers: {},
      facts: null,
      rendered: null,
      rawKey: null,
      rawBytes: null,
      sha256: null,
      fetchMs: null,
      error: null,
      blocked: null,
    };
    let res;
    if (plan.pageType === 'home' && home) {
      res = home;
      if (homeProblem) {
        record.error = homeProblem;
        return record;
      }
    } else {
      const gate = await mayFetch(plan.url);
      if (!gate.allowed) {
        record.error = gate.reason;
        return record;
      }
      res = await get(plan.url, { bodyTypes: PAGE_BODY_TYPES });
    }
    if (!res.ok) {
      record.error = res.error.code;
      return record;
    }
    Object.assign(record, {
      finalUrl: res.url,
      status: res.status,
      redirectCount: res.redirects.length,
      contentType: res.contentType || null,
      headers: pickHeaders(res.headers),
      fetchMs: res.ms,
    });
    // A firewall's answer is not the site: a challenge page served with 200, or a 403 for a crawler. Judging it
    // as the site would report schema and content "missing" that the site may well have.
    const block = detectBotBlock(res);
    if (block.blocked) {
      record.error = 'blocked_by_firewall';
      record.blocked = { vendor: block.vendor, reason: block.reason };
      return record;
    }
    if (res.status < 200 || res.status >= 300) return record;
    if (res.bodySkipped) {
      record.error = 'not_html';
      return record;
    }
    const html = decodeBody(res.body, res.contentType).text;
    const raw = await save('html', res);
    Object.assign(record, { rawKey: raw.key, rawBytes: raw.bytes, sha256: raw.sha256 });
    record.facts =
      plan.pageType === 'home' && homeFacts
        ? homeFacts
        : extractPage(html, res.url, { headers: res.headers });
    if (record.facts.skipped) record.error = record.facts.skipped;
    return record;
  }

  const planned = selected.length;
  if (!homeProblem) {
    const [homeRecord, ...rest] = selected;
    pages.push(await readPage(homeRecord));
    pages.push(
      ...(await mapPool(rest, PAGE_CONCURRENCY, async (plan) => {
        if (outOfTime()) return { ...(await skipped(plan)), error: 'scan_time_limit' };
        return readPage(plan);
      })),
    );
  } else {
    pages.push(await readPage(selected[0]));
  }
  async function skipped(plan) {
    return {
      url: plan.url,
      finalUrl: null,
      pageType: plan.pageType,
      isKey: true,
      sources: plan.sources,
      status: null,
      redirectCount: 0,
      headers: {},
      facts: null,
      rendered: null,
    };
  }

  phase('render');
  // --- 6. render a few in a headless browser ----------------------------------------------------------------
  const readable = pages.filter(
    (p) => p.facts && !p.facts.skipped && p.status >= 200 && p.status < 300,
  );
  if (renderer && readable.length) {
    const toRender = new Set(pickRenderPages(readable, policy.maxRenderedPages));
    for (const record of readable) {
      if (!toRender.has(record.url)) continue;
      if (outOfTime()) {
        record.rendered = { ok: false, error: 'scan_time_limit' };
        continue;
      }
      const result = await renderer.render(record.finalUrl ?? record.url);
      if (!result.ok) {
        record.rendered = { ok: false, error: result.error, detail: result.detail ?? null };
        log('render_failed', { url: record.url, error: result.error });
        continue;
      }
      const stored = await storeRaw(store, {
        kind: 'rendered',
        body: Buffer.from(result.html),
        contentType: 'text/html; charset=utf-8',
        url: result.finalUrl,
        status: result.status,
        fetchedAt: now(),
      });
      record.rendered = {
        ok: true,
        facts: extractPage(result.html, result.finalUrl),
        key: stored.key,
        ms: result.ms,
        blockedRequests: result.blocked.length,
      };
    }
    if (renderer.isUnavailable?.())
      notes.push('The headless browser is not available, so rendered pages could not be compared.');
  } else if (!renderer) {
    notes.push('No headless browser was provided, so rendered pages could not be compared.');
  }

  phase('probes');
  // --- 7. llms.txt and the look-alike AI crawler requests ---------------------------------------------------
  let llmsTxt = { status: 'error', httpStatus: null };
  let botProbes = null;
  if (!homeProblem) {
    const llms = await get(`${origin}/llms.txt`, {
      maxBytes: 1024 * 1024,
      bodyTypes: TEXT_BODY_TYPES,
    });
    if (llms.ok) {
      const text = decodeBody(llms.body, llms.contentType).text.trim();
      const isFile =
        llms.status >= 200 &&
        llms.status < 300 &&
        text.length >= 10 &&
        !/html/i.test(llms.contentType) &&
        !text.startsWith('<');
      if (isFile) {
        llmsTxt = {
          status: 'present',
          httpStatus: llms.status,
          key: (await save('llms', llms)).key,
        };
      } else if (llms.status >= 500 || detectBotBlock(llms).blocked) {
        // A server failure, or a firewall in the way: we could not look, which is not the same as "not there".
        llmsTxt = { status: 'error', httpStatus: llms.status };
      } else {
        llmsTxt = { status: 'missing', httpStatus: llms.status };
      }
    }

    if (!outOfTime()) {
      const control = home?.ok
        ? { agent: 'AEOCornerBot', status: home.status, ...blockVerdict(home) }
        : { agent: 'AEOCornerBot', status: null, blocked: null, vendor: null, reason: homeProblem };
      const bots = [];
      for (const { agent, userAgent } of PROBE_USER_AGENTS) {
        const res = await get(`${origin}/`, {
          userAgent,
          bodyTypes: PAGE_BODY_TYPES,
          maxBytes: 512 * 1024,
        });
        bots.push(
          res.ok
            ? { agent, status: res.status, ...blockVerdict(res) }
            : { agent, status: null, blocked: null, vendor: null, reason: res.error.code },
        );
      }
      botProbes = { control, bots };
    }
  }

  phase('checks');
  // --- 8. the checks ----------------------------------------------------------------------------------------
  phase('done');
  if (overridden.size) {
    notes.push(
      overridden.has('robots_unreachable') && overridden.size === 1
        ? 'robots.txt could not be fetched. The scan went ahead because the project owner asked for it.'
        : 'robots.txt asks our crawler (AEOCornerBot) to stay away. The scan went ahead because the project owner asked for it; fix robots.txt if AI crawlers should be shut out too.',
    );
  }
  const report = runReadinessChecks({
    site: { origin, domain: new URL(homeUrl).hostname.replace(/^www\./, ''), homeUrl },
    robots: {
      status: robots.status,
      httpStatus: robots.httpStatus,
      parsed: robots.parsed,
      key: robots.key,
    },
    sitemaps: {
      found: sitemaps.found,
      referenced: sitemaps.referenced,
      lastmods: sitemaps.lastmods.slice(0, 5000),
      blocked: sitemaps.blocked,
    },
    botProbes,
    llmsTxt,
    pages,
    now: now(),
  });

  const readableNow = pages.filter(
    (p) => p.facts && !p.facts.skipped && p.status >= 200 && p.status < 300,
  );
  const failedPages = pages.filter((p) => p.error);
  const status =
    readableNow.length === 0
      ? 'failed'
      : report.score === null || failedPages.length > 0 || notes.length > 0
        ? 'partial'
        : 'complete';

  return {
    status,
    rubricVersion: report.rubricVersion,
    readinessScore: report.score,
    categoryScores: report.categories,
    coverage: report.coverage,
    counts: report.counts,
    checks: report.checks,
    site: {
      origin,
      domain: new URL(homeUrl).hostname.replace(/^www\./, ''),
      homeUrl,
      platform: homeFacts?.platform ?? null,
      problem: homeProblem,
    },
    robots: { status: robots.status, httpStatus: robots.httpStatus, key: robots.key },
    sitemaps: {
      found: sitemaps.found,
      referenced: sitemaps.referenced,
      urlCount: sitemaps.urls.length,
    },
    llmsTxt,
    botProbes,
    pages: pages.map(({ facts, rendered, ...p }) => ({
      ...p,
      title: facts?.title ?? null,
      jsonLdTypes: facts?.jsonLd?.types ?? [],
      rawTextChars: facts && !facts.skipped ? facts.visibleTextChars : null,
      renderedTextChars: rendered?.ok ? rendered.facts.visibleTextChars : null,
      renderedKey: rendered?.ok ? rendered.key : null,
      renderError: rendered && !rendered.ok ? rendered.error : null,
    })),
    // What the lite Brand Kit reads (src/llm/brand-kit.js): the first readable pages, home page first, each cut to a
    // few thousand characters. Page text is a stranger's: it is only ever fenced and sent to the model, never acted on.
    brandPages: readableNow.slice(0, 6).map((p) => ({
      url: p.finalUrl ?? p.url,
      title: p.facts.title,
      text: [
        p.facts.metaDescription,
        ...p.facts.headings.slice(0, 12).map((h) => h.text),
        p.facts.text.slice(0, 2500),
      ]
        .filter(Boolean)
        .join('\n'),
    })),
    robotsOverridden: overridden.size > 0,
    pagesPlanned: planned,
    pagesFetched: pages.filter((p) => p.status !== null).length,
    notes,
    connections,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
  };
}

function blockVerdict(res) {
  const verdict = detectBotBlock({ status: res.status, headers: res.headers, body: res.body });
  return { blocked: verdict.blocked, vendor: verdict.vendor, reason: verdict.reason };
}

export { CRAWLER_USER_AGENT };
