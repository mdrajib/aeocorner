import { readFileSync } from 'node:fs';
import { GOOGLE_SCOPES } from '../../src/integrations/google.js';
import { startServer } from './http-fixture.js';

/**
 * A Google stand-in for tests (Milestone 8): the OAuth token endpoint and the three read-only APIs the traffic sync uses,
 * on a real socket, answering with the fixtures in tests/fixtures/google (built from Google's documentation: the first
 * live sync is the check against the real thing). Everything it receives is recorded in `calls`.
 */
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/google/${name}.json`, import.meta.url), 'utf8'));

export async function startGoogleStub({
  clientId = 'test-client',
  clientSecret = 'test-secret',
} = {}) {
  const state = {
    calls: [],
    codes: new Map(), // one-time code -> { refreshToken, scopes }
    refreshTokens: new Set(),
    accessTokens: new Map(), // access token -> expires (ms)
    revoked: [],
    reports: {
      ai: fixture('ga4-ai-report'),
      all: fixture('ga4-all-report'),
      organic: fixture('ga4-organic-report'),
    },
    gsc: { query: fixture('gsc-query-report'), page: fixture('gsc-page-report') },
    accountSummaries: fixture('account-summaries'),
    sites: fixture('sites'),
    failNext: null,
    seq: 0,
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const apiError = (res, status, statusText, message) =>
    json(res, status, { error: { code: status, message, status: statusText } });

  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    const isForm = (req.headers['content-type'] ?? '').includes('x-www-form-urlencoded');
    const body = isForm
      ? Object.fromEntries(new URLSearchParams(text))
      : text
        ? JSON.parse(text)
        : null;
    state.calls.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers,
    });

    if (url.pathname === '/token') {
      if (body.client_id !== clientId || body.client_secret !== clientSecret) {
        return json(res, 401, { error: 'invalid_client' });
      }
      if (body.grant_type === 'authorization_code') {
        const grant = state.codes.get(body.code);
        if (!grant) return json(res, 400, { error: 'invalid_grant' });
        state.codes.delete(body.code);
        const access = `at-${(state.seq += 1)}`;
        state.accessTokens.set(access, Date.now() + 3600_000);
        state.refreshTokens.add(grant.refreshToken);
        return json(res, 200, {
          access_token: access,
          expires_in: 3599,
          ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
          scope: grant.scopes.join(' '),
          token_type: 'Bearer',
        });
      }
      if (body.grant_type === 'refresh_token') {
        if (!state.refreshTokens.has(body.refresh_token))
          return json(res, 400, { error: 'invalid_grant' });
        const access = `at-${(state.seq += 1)}`;
        state.accessTokens.set(access, Date.now() + 3600_000);
        return json(res, 200, { access_token: access, expires_in: 3599, token_type: 'Bearer' });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/revoke') {
      state.revoked.push(body.token);
      state.refreshTokens.delete(body.token);
      return json(res, 200, {});
    }

    // Everything below needs a live access token.
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !state.accessTokens.has(token))
      return apiError(res, 401, 'UNAUTHENTICATED', 'Invalid credentials.');
    if (state.failNext) {
      const { status, statusText } = state.failNext;
      state.failNext = null;
      return apiError(res, status, statusText, 'Injected failure.');
    }

    if (url.pathname === '/admin/accountSummaries') return json(res, 200, state.accountSummaries);
    if (url.pathname === '/webmasters/sites') return json(res, 200, state.sites);

    const report = /^\/data\/properties\/(\d+):runReport$/.exec(url.pathname);
    if (report) {
      if (state.allowedProperties && !state.allowedProperties.includes(report[1])) {
        return apiError(res, 403, 'PERMISSION_DENIED', 'No access.');
      }
      const dims = body.dimensions.map((d) => d.name).join(',');
      const filtered = body.dimensionFilter?.filter?.fieldName;
      const kind =
        dims === 'date,sessionSource,landingPage'
          ? 'ai'
          : filtered === 'sessionDefaultChannelGroup'
            ? 'organic'
            : 'all';
      const full = state.reports[kind];
      const offset = Number(body.offset ?? 0);
      return json(res, 200, {
        ...full,
        rows: offset === 0 ? full.rows : [],
        rowCount: state.rowCountOverride?.[kind] ?? full.rowCount,
      });
    }
    const query = /^\/webmasters\/sites\/(.+)\/searchAnalytics\/query$/.exec(url.pathname);
    if (query) {
      const site = decodeURIComponent(query[1]);
      if (!state.sites.siteEntry.some((s) => s.siteUrl === site))
        return apiError(res, 403, 'PERMISSION_DENIED', 'No access.');
      const kind = body.dimensions.includes('query') ? 'query' : 'page';
      return json(res, 200, Number(body.startRow ?? 0) === 0 ? state.gsc[kind] : { rows: [] });
    }
    return apiError(res, 404, 'NOT_FOUND', 'Not found.');
  });

  const origin = `http://127.0.0.1:${server.port}`;
  return {
    state,
    calls: state.calls,
    clientId,
    clientSecret,
    close: server.close,
    urls: {
      auth: `${origin}/auth`,
      token: `${origin}/token`,
      revoke: `${origin}/revoke`,
      analyticsAdmin: `${origin}/admin`,
      analyticsData: `${origin}/data`,
      searchConsole: `${origin}/webmasters`,
    },

    /** A one-time code Google would hand back after the person agreed; `scopes` are what they allowed. */
    issueCode({
      refreshToken = `rt-${(state.seq += 1)}`,
      scopes = [...GOOGLE_SCOPES],
      code = `code-${(state.seq += 1)}`,
    } = {}) {
      state.codes.set(code, { refreshToken, scopes });
      return { code, refreshToken };
    },
    /** The person withdrew access in their Google account. */
    revokeGrant(refreshToken) {
      state.refreshTokens.delete(refreshToken);
    },
    failNext(status = 503, statusText = 'UNAVAILABLE') {
      state.failNext = { status, statusText };
    },
  };
}
