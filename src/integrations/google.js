/**
 * Google for AI traffic (Milestone 8, tasks 8.09–8.11): the OAuth steps, and the three read-only calls a connection needs.
 * Checked against Google's documentation on 2026-10-04: authorization at `accounts.google.com/o/oauth2/v2/auth` with
 * `access_type=offline` (and `prompt=consent`, so a refresh token is always issued); code and refresh exchanges at
 * `oauth2.googleapis.com/token`; revocation at `oauth2.googleapis.com/revoke`; Search Console's
 * `webmasters/v3/sites` and `searchAnalytics/query`; the Data API's `analyticsdata.googleapis.com/v1beta/properties/<id>:runReport`
 * and the Admin API's `analyticsadmin.googleapis.com/v1beta/accountSummaries` to list the properties a login can see.
 *
 * Least privilege: two read-only scopes and nothing else (no email, no profile). Google reviews the app for them
 * (MILESTONES task 0.18, weeks of lead time); until it does, only the app's listed test users can connect.
 *
 * No SDK, for the same reason as Stripe: a few calls, and a client we can hand a fake `fetch` and fake addresses.
 */

export const GOOGLE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
]);

const DEFAULT_URLS = Object.freeze({
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  analyticsAdmin: 'https://analyticsadmin.googleapis.com/v1beta',
  analyticsData: 'https://analyticsdata.googleapis.com/v1beta',
  searchConsole: 'https://www.googleapis.com/webmasters/v3',
});

const TIMEOUT_MS = 30_000;

/**
 * `code` says what to do about it: `revoked` (the person withdrew access or the grant expired: reconnect), `forbidden`
 * (no access to that property or site), `quota` (try again later), `unreachable`, `bad_response`, or `http`.
 * The message never contains a token or Google's response body.
 */
export class GoogleError extends Error {
  constructor(message, { code = 'http', status = null } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;
    this.status = status;
  }
}

export function createGoogle({
  clientId,
  clientSecret,
  urls = DEFAULT_URLS,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  if (!clientId || !clientSecret) throw new TypeError('Google needs a client ID and secret');
  const u = { ...DEFAULT_URLS, ...urls };

  async function request(url, { method = 'GET', headers = {}, body, form } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GoogleError('Google could not be reached.', { code: 'unreachable' });
    }
    let json = null;
    try {
      json = await response.json();
    } catch {
      /* handled below */
    }
    if (!response.ok) {
      const reason = json?.error?.status ?? json?.error ?? '';
      if (response.status === 400 && json?.error === 'invalid_grant') {
        throw new GoogleError('Google access was withdrawn or has expired.', {
          code: 'revoked',
          status: 400,
        });
      }
      if (response.status === 401) {
        throw new GoogleError('Google no longer accepts this login.', {
          code: 'revoked',
          status: 401,
        });
      }
      if (response.status === 403 && /QUOTA|RATE|LIMIT/i.test(JSON.stringify(json?.error ?? ''))) {
        throw new GoogleError('Google is limiting requests for now.', {
          code: 'quota',
          status: 403,
        });
      }
      if (response.status === 403 || response.status === 404) {
        throw new GoogleError('This login has no access to that property or site.', {
          code: 'forbidden',
          status: response.status,
        });
      }
      if (response.status === 429)
        throw new GoogleError('Google is limiting requests for now.', {
          code: 'quota',
          status: 429,
        });
      throw new GoogleError(
        `Google answered ${response.status}${reason ? ` (${String(reason).slice(0, 60)})` : ''}.`,
        {
          code: 'http',
          status: response.status,
        },
      );
    }
    if (json === null || typeof json !== 'object') {
      throw new GoogleError('Google answered something unreadable.', {
        code: 'bad_response',
        status: response.status,
      });
    }
    return json;
  }

  const bearer = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });

  return {
    /** The address to send the person to. `state` comes back unchanged. */
    authUrl({ redirectUri, state }) {
      const url = new URL(u.auth);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      }).toString();
      return url.toString();
    },

    /** Trade the one-time code for tokens. A grant without a refresh token (or without both scopes) is refused. */
    async exchangeCode({ code, redirectUri }) {
      const t = await request(u.token, {
        method: 'POST',
        form: {
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        },
      });
      const scopes = String(t.scope ?? '')
        .split(' ')
        .filter(Boolean);
      if (!t.access_token)
        throw new GoogleError('Google gave no access token.', { code: 'bad_response' });
      if (!t.refresh_token)
        throw new GoogleError('Google gave no long-lived access.', { code: 'no_refresh_token' });
      const missing = GOOGLE_SCOPES.filter((s) => !scopes.includes(s));
      return {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresIn: Number(t.expires_in) || 3600,
        scopes,
        missingScopes: missing,
      };
    },

    /** A fresh short-lived access token from the stored refresh token. */
    async refresh(refreshToken) {
      const t = await request(u.token, {
        method: 'POST',
        form: {
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
        },
      });
      if (!t.access_token)
        throw new GoogleError('Google gave no access token.', { code: 'bad_response' });
      return { accessToken: t.access_token, expiresIn: Number(t.expires_in) || 3600 };
    },

    /** Tell Google to forget the grant. Best effort: a failure does not stop us erasing our copy. */
    async revoke(token) {
      try {
        await fetchImpl(u.revoke, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return true;
      } catch {
        return false;
      }
    },

    /** The GA4 properties this login can see: `[{ id: '123456', name, account }]`. */
    async ga4Properties(accessToken) {
      const out = [];
      let pageToken = '';
      for (let page = 0; page < 10; page += 1) {
        const q = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
        const r = await request(`${u.analyticsAdmin}/accountSummaries?${q}`, {
          headers: bearer(accessToken),
        });
        for (const account of r.accountSummaries ?? []) {
          for (const p of account.propertySummaries ?? []) {
            const id = /^properties\/(\d+)$/.exec(p.property ?? '')?.[1];
            if (id)
              out.push({
                id,
                name: String(p.displayName ?? id).slice(0, 120),
                account: String(account.displayName ?? '').slice(0, 120),
              });
          }
        }
        pageToken = r.nextPageToken ?? '';
        if (!pageToken) break;
      }
      return out;
    },

    /** The Search Console sites this login can read: `[{ siteUrl, level }]`. */
    async searchConsoleSites(accessToken) {
      const r = await request(`${u.searchConsole}/sites`, { headers: bearer(accessToken) });
      return (r.siteEntry ?? [])
        .filter((s) => typeof s.siteUrl === 'string' && s.permissionLevel !== 'siteUnverifiedUser')
        .map((s) => ({ siteUrl: s.siteUrl, level: s.permissionLevel ?? null }));
    },

    /** One page of a GA4 report. `propertyId` is digits only (checked here: it goes into the address). */
    runReport(accessToken, propertyId, body) {
      if (!/^\d{1,20}$/.test(String(propertyId)))
        throw new TypeError('A GA4 property ID is digits');
      return request(`${u.analyticsData}/properties/${propertyId}:runReport`, {
        method: 'POST',
        headers: bearer(accessToken),
        body,
      });
    },

    /** One page of a Search Console query. */
    queryResults(accessToken, siteUrl, body) {
      return request(
        `${u.searchConsole}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: bearer(accessToken),
          body,
        },
      );
    },
  };
}
