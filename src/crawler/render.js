import { CRAWLER_USER_AGENT, isGuardError } from './safe-fetch.js';

/**
 * Render a page the way a browser would, JavaScript included, to compare with the raw HTML (MVP F1 step 3,
 * readiness check B1): the pages most AI crawlers see is the raw HTML, and what is only added by scripts is
 * invisible to them.
 *
 * THE SECURITY RULE: Chromium never opens a network connection of its own. A page we render is a stranger's
 * code, and a headless browser is the classic way to reach a private address (a script that calls
 * http://169.254.169.254/, a redirect, an <img> or <iframe>, a WebSocket). So every request the page makes is
 * intercepted and answered by OUR safe fetcher, which resolves DNS once, refuses private addresses and connects
 * to the address it checked (ADR-0005). Chromium is also started with name resolution switched off, so even a
 * request that somehow escaped interception has nowhere to go.
 *
 * What we let through, and what we don't:
 *   - Pages, scripts and data requests (document, script, xhr, fetch): fetched by us, GET only.
 *   - Images, stylesheets, fonts, media, WebSockets, service workers, downloads: refused. We read text, and
 *     skipping them keeps a render to a second or two.
 *   - At most `maxRequests` per page and `maxBytes` of responses, so a page that loops forever is cut off.
 */

const ALLOWED_TYPES = new Set(['document', 'script', 'xhr', 'fetch']);
const FORWARD_HEADERS = ['accept', 'accept-language', 'referer'];
// Headers that describe how the bytes were sent on the wire; we hand Chromium the decoded body instead.
const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
  'strict-transport-security',
]);

export const RENDER_LIMITS = Object.freeze({
  timeoutMs: 25_000,
  maxRequests: 120,
  maxBytes: 20 * 1024 * 1024,
  perRequestTimeoutMs: 10_000,
  maxConcurrent: 1,
});

/**
 * How Chromium is started. The first flag is the second wall: every hostname fails to resolve inside the
 * browser. Real requests are answered by us before DNS is needed, so nothing legitimate is affected, and a
 * request that somehow got past interception has nowhere to go. The rest keep it from phoning home.
 */
export const BROWSER_ARGS = Object.freeze([
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--no-first-run',
]);

async function launchChromium() {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, args: BROWSER_ARGS });
}

/**
 * @param {object} options
 * @param {{ fetch: Function }} options.fetcher   the safe fetcher; the only way a page reaches the network
 * @param {() => Promise<object>} [options.launch]   starts the browser (tests may substitute)
 */
export function createRenderer({
  fetcher,
  launch = launchChromium,
  userAgent = CRAWLER_USER_AGENT,
  limits = {},
}) {
  const policy = { ...RENDER_LIMITS, ...limits };
  let browserPromise = null;
  let unavailable = null;
  let running = 0;
  const waiting = [];

  async function browser() {
    if (unavailable) throw unavailable;
    browserPromise ??= launch().catch((err) => {
      unavailable = Object.assign(
        new Error(`The browser could not start: ${err.message.split('\n')[0]}`),
        {
          code: 'browser_unavailable',
        },
      );
      throw unavailable;
    });
    return browserPromise;
  }

  /** A turn, so Chromium (memory hungry) never renders more pages at once than `maxConcurrent`. */
  async function takeTurn() {
    if (running >= policy.maxConcurrent) await new Promise((resolve) => waiting.push(resolve));
    running += 1;
  }
  function giveTurn() {
    running -= 1;
    waiting.shift()?.();
  }

  async function renderOnce(url, { timeoutMs }) {
    const started = Date.now();
    const blocked = [];
    let requests = 0;
    let fetched = 0;
    let bytes = 0;
    let redirectTo = null;
    let page = null;

    let context;
    try {
      context = await (
        await browser()
      ).newContext({
        userAgent,
        viewport: { width: 1280, height: 800 },
        javaScriptEnabled: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
        locale: 'en-US',
      });
    } catch (err) {
      return {
        ok: false,
        error: err.code ?? 'browser_error',
        detail: err.message,
        blocked,
        requests,
      };
    }

    try {
      // WebSockets bypass request interception, so refuse them outright: the handler never connects onward.
      await context.routeWebSocket(/.*/, (ws) => {
        blocked.push({ url: ws.url(), code: 'websocket' });
        ws.close();
      });

      await context.route('**/*', async (route) => {
        const request = route.request();
        const target = request.url();
        requests += 1;
        if (requests > policy.maxRequests) {
          blocked.push({ url: target, code: 'too_many_requests' });
          return route.abort('blockedbyclient');
        }
        if (!ALLOWED_TYPES.has(request.resourceType()) || request.method() !== 'GET') {
          // Not recorded as "blocked": skipping images and the like is the normal case, not an attack.
          return route.abort('blockedbyclient');
        }
        try {
          const headers = Object.fromEntries(
            FORWARD_HEADERS.map((h) => [h, request.headers()[h]]).filter(([, v]) => v),
          );
          // Chromium follows a redirect we hand it WITHOUT asking again, which would skip our check of the next
          // hop. So the fetcher follows redirects itself (checking every hop), except for the page being
          // loaded: a redirect there ends this render and the caller renders the new address, so the page
          // knows its real URL and relative links resolve correctly.
          const mainPage = Boolean(
            page && request.isNavigationRequest() && request.frame() === page.mainFrame(),
          );
          const response = await fetcher.fetch(target, {
            followRedirects: !mainPage,
            headers,
            maxBytes: Math.max(1, policy.maxBytes - bytes),
            timeoutMs: policy.perRequestTimeoutMs,
            userAgent,
          });
          bytes += response.body.length;
          fetched += 1;
          const location = response.headers.location;
          if (mainPage && response.status >= 300 && response.status < 400 && location) {
            redirectTo = new URL(location, target).href;
            return route.abort('blockedbyclient');
          }
          return route.fulfill({
            status: response.status,
            headers: Object.fromEntries(
              Object.entries(response.headers)
                .filter(([name]) => !DROP_RESPONSE_HEADERS.has(name))
                .map(([name, value]) => [name, [value].flat().join(', ')]),
            ),
            body: response.body,
          });
        } catch (err) {
          blocked.push({ url: target, code: err.code ?? 'error', guard: isGuardError(err) });
          return route.abort('blockedbyclient');
        }
      });

      page = await context.newPage();
      const deadline = new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Object.assign(new Error('render timed out'), { code: 'timeout' })),
          timeoutMs,
        );
        timer.unref?.();
      });
      const work = (async () => {
        const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
        // Scripts that fetch their content keep going after "load"; give them a moment, but not forever.
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        const contentType = (await response?.headerValue('content-type')) ?? '';
        if (response && !/html|xml/i.test(contentType)) {
          return { ok: false, error: 'not_html', status: response.status(), contentType };
        }
        return {
          ok: true,
          status: response?.status() ?? null,
          finalUrl: page.url(),
          html: await page.content(),
        };
      })();
      work.catch(() => {}); // if the deadline wins, the late result is dropped quietly
      const result = await Promise.race([work, deadline]);
      return { ...result, ms: Date.now() - started, requests, fetched, bytes, blocked };
    } catch (err) {
      if (redirectTo) {
        return {
          ok: false,
          error: 'redirected',
          redirectTo,
          ms: Date.now() - started,
          requests,
          fetched,
          bytes,
          blocked,
        };
      }
      const code =
        err.code === 'timeout' || /timeout/i.test(err.message) ? 'timeout' : 'render_failed';
      return {
        ok: false,
        error: code,
        detail: err.message.split('\n')[0],
        ms: Date.now() - started,
        requests,
        fetched,
        bytes,
        blocked,
      };
    } finally {
      // Closing the context stops anything the page is still doing, even a script stuck in a loop.
      await context.close().catch(() => {});
    }
  }

  return {
    /**
     * Render one URL. Never throws: a page that can't be rendered is a result with `ok: false` and an `error`
     * code (timeout, not_html, browser_unavailable, render_failed), because "couldn't render" is a normal
     * thing for the readiness checks to hear about.
     */
    async render(url, { timeoutMs = policy.timeoutMs, maxRedirects = 5 } = {}) {
      await takeTurn();
      try {
        const redirects = [];
        let current = url;
        for (;;) {
          const result = await renderOnce(current, { timeoutMs });
          if (result.error !== 'redirected') return { ...result, redirects };
          if (redirects.length >= maxRedirects) {
            return {
              ok: false,
              error: 'too_many_redirects',
              ms: result.ms,
              requests: result.requests,
              blocked: result.blocked,
              redirects,
            };
          }
          redirects.push({ from: current, to: result.redirectTo });
          current = result.redirectTo;
        }
      } finally {
        giveTurn();
      }
    },

    /** True once the browser failed to start; further renders fail at once instead of retrying. */
    isUnavailable: () => Boolean(unavailable),

    async close() {
      const pending = browserPromise;
      browserPromise = null;
      if (pending) await (await pending.catch(() => null))?.close().catch(() => {});
    },
  };
}
