import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { GOOGLE_SCOPES, GoogleError, createGoogle } from '../../src/integrations/google.js';
import {
  addDaysText,
  fetchGa4,
  fetchSearchConsole,
  syncRange,
} from '../../src/integrations/google-sync.js';
import { brandTerms } from '../../src/core/traffic.js';
import { startGoogleStub } from '../helpers/google-stub.js';

/** The Google client, the OAuth steps and the sync reads, against a Google stand-in with fixtures built from the API docs. */

const stub = await startGoogleStub();
const google = createGoogle({
  clientId: stub.clientId,
  clientSecret: stub.clientSecret,
  urls: stub.urls,
});
after(() => stub.close());

const grant = async (opts) => {
  const { code, refreshToken } = stub.issueCode(opts);
  const tokens = await google.exchangeCode({
    code,
    redirectUri: 'https://aeocorner.test/app/google/callback',
  });
  return { ...tokens, refreshToken };
};

describe('the sign-in', () => {
  test('the address asks for the two read-only scopes, offline access and a consent screen, and passes our state through', () => {
    const url = new URL(
      google.authUrl({
        redirectUri: 'https://aeocorner.test/app/google/callback',
        state: 'abc.def',
      }),
    );
    assert.equal(url.origin + url.pathname, stub.urls.auth);
    const q = Object.fromEntries(url.searchParams);
    assert.equal(q.client_id, stub.clientId);
    assert.equal(q.response_type, 'code');
    assert.equal(q.access_type, 'offline');
    assert.equal(q.prompt, 'consent');
    assert.equal(q.state, 'abc.def');
    assert.equal(q.redirect_uri, 'https://aeocorner.test/app/google/callback');
    assert.deepEqual(q.scope.split(' '), GOOGLE_SCOPES);
    assert.ok(
      GOOGLE_SCOPES.every((s) => s.endsWith('.readonly')),
      'read-only, nothing wider',
    );
  });

  test('a code becomes an access token and a refresh token, with the scopes that were allowed', async () => {
    const tokens = await grant();
    assert.match(tokens.accessToken, /^at-/);
    assert.equal(tokens.refreshToken.startsWith('rt-'), true);
    assert.deepEqual(tokens.scopes, GOOGLE_SCOPES);
    assert.deepEqual(tokens.missingScopes, []);
  });

  test('a code works once, and a wrong code is refused', async () => {
    const { code } = stub.issueCode();
    await google.exchangeCode({ code, redirectUri: 'x' });
    await assert.rejects(
      google.exchangeCode({ code, redirectUri: 'x' }),
      (e) => e instanceof GoogleError && e.code === 'revoked',
    );
    await assert.rejects(google.exchangeCode({ code: 'nope', redirectUri: 'x' }), GoogleError);
  });

  test('a grant that leaves out a scope says which is missing; one with no refresh token is refused', async () => {
    const partial = await grant({ scopes: [GOOGLE_SCOPES[1]] });
    assert.deepEqual(partial.missingScopes, [GOOGLE_SCOPES[0]]);
    const { code } = stub.issueCode({ refreshToken: null });
    await assert.rejects(
      google.exchangeCode({ code, redirectUri: 'x' }),
      (e) => e.code === 'no_refresh_token',
    );
  });

  test('a refresh token gives a new access token until the person withdraws access', async () => {
    const { refreshToken } = await grant();
    const fresh = await google.refresh(refreshToken);
    assert.match(fresh.accessToken, /^at-/);
    stub.revokeGrant(refreshToken);
    await assert.rejects(
      google.refresh(refreshToken),
      (e) => e.code === 'revoked' && !/rt-/.test(e.message),
    );
  });

  test('revoking tells Google, and never throws when Google cannot be reached', async () => {
    const { refreshToken } = await grant();
    assert.equal(await google.revoke(refreshToken), true);
    assert.ok(stub.state.revoked.includes(refreshToken));
    const dead = createGoogle({
      clientId: 'a',
      clientSecret: 'b',
      urls: { revoke: 'http://127.0.0.1:1/revoke' },
      timeoutMs: 300,
    });
    assert.equal(await dead.revoke('x'), false);
  });

  test('a wrong client secret is refused', async () => {
    const wrong = createGoogle({ clientId: stub.clientId, clientSecret: 'wrong', urls: stub.urls });
    await assert.rejects(wrong.refresh('rt'), GoogleError);
    assert.throws(() => createGoogle({ clientId: '', clientSecret: '' }), TypeError);
  });
});

describe('what a login can see', () => {
  test('lists GA4 properties by their number and Search Console sites, without ones the login only half-owns', async () => {
    const { accessToken } = await grant();
    assert.deepEqual(await google.ga4Properties(accessToken), [
      { id: '123456789', name: 'Acme Dental - GA4', account: 'Acme Dental' },
      { id: '987654321', name: 'Acme Blog', account: 'Acme Dental' },
    ]);
    const sites = await google.searchConsoleSites(accessToken);
    assert.deepEqual(
      sites.map((s) => s.siteUrl),
      ['https://acme.example.test/', 'sc-domain:acme.example.test'],
    );
  });

  test('a property ID that is not digits never reaches the address', () => {
    assert.throws(() => google.runReport('t', '1/../../x', {}), TypeError);
  });

  test('errors say what to do and never carry the token or Google’s words', async () => {
    const { accessToken } = await grant();
    stub.state.allowedProperties = ['123456789'];
    await assert.rejects(
      google.runReport(accessToken, '555', { dimensions: [], dateRanges: [] }),
      (e) => e.code === 'forbidden' && e.status === 403,
    );
    stub.state.allowedProperties = null;
    stub.failNext(503, 'UNAVAILABLE');
    await assert.rejects(
      google.ga4Properties(accessToken),
      (e) => e.code === 'http' && !e.message.includes(accessToken),
    );
    stub.failNext(429, 'RESOURCE_EXHAUSTED');
    await assert.rejects(google.ga4Properties(accessToken), (e) => e.code === 'quota');
    await assert.rejects(google.ga4Properties('not-a-token'), (e) => e.code === 'revoked');
    const dead = createGoogle({
      clientId: 'a',
      clientSecret: 'b',
      urls: { analyticsAdmin: 'http://127.0.0.1:1' },
      timeoutMs: 300,
    });
    await assert.rejects(dead.ga4Properties('x'), (e) => e.code === 'unreachable');
  });
});

describe('reading a day range', () => {
  test('GA4: all three reports, parsed, with AI sources added together and non-AI sources dropped', async () => {
    const { accessToken } = await grant();
    const rows = await fetchGa4({
      google,
      accessToken,
      propertyId: '123456789',
      startDate: '2026-08-01',
      endDate: '2026-10-01',
    });
    const ai = rows.filter((r) => !['all', 'organic_search'].includes(r.channel));
    assert.deepEqual([...new Set(ai.map((r) => r.channel))].sort(), ['chatgpt', 'perplexity']);
    const day = ai.find((r) => r.metricDate === '2026-08-10' && r.channel === 'chatgpt');
    assert.deepEqual([day.landingPage, day.sessions, day.engagedSessions], ['/pricing', 12, 7]);
    assert.equal(rows.filter((r) => r.channel === 'all').length, 8);
    assert.equal(rows.filter((r) => r.channel === 'organic_search').length, 8);
    assert.ok(!rows.some((r) => r.landingPage === '/ignored'));
    const sent = stub.calls
      .filter((c) => c.path.endsWith(':runReport'))
      .slice(-3)
      .map((c) => c.body);
    assert.deepEqual(
      sent.map((b) => b.dateRanges[0]),
      Array(3).fill({ startDate: '2026-08-01', endDate: '2026-10-01' }),
    );
  });

  test('GA4: a report with more rows than one page is read page by page', async () => {
    const { accessToken } = await grant();
    stub.state.rowCountOverride = { ai: 150_000 };
    const before = stub.calls.filter((c) => c.path.endsWith(':runReport')).length;
    await fetchGa4({
      google,
      accessToken,
      propertyId: '123456789',
      startDate: '2026-08-01',
      endDate: '2026-10-01',
    });
    const calls = stub.calls.filter((c) => c.path.endsWith(':runReport')).slice(before);
    assert.equal(calls.length, 4, 'two pages of the AI report, one each of the others');
    assert.deepEqual(
      calls.filter((c) => c.body.dimensions.length === 3).map((c) => c.body.offset),
      [0, 100000],
    );
    stub.state.rowCountOverride = null;
  });

  test('Search Console: branded queries and pages only', async () => {
    const { accessToken } = await grant();
    const terms = brandTerms({ names: ['Acme Dental'], domain: 'acme.example.test' });
    const rows = await fetchSearchConsole({
      google,
      accessToken,
      siteUrl: 'https://acme.example.test/',
      startDate: '2026-08-01',
      endDate: '2026-10-01',
      terms,
    });
    const queries = rows.filter((r) => r.dimension === 'query');
    assert.equal(queries.length, 16, 'two branded queries a week, and "dentist near me" left out');
    assert.ok(queries.every((q) => q.isBranded === true));
    assert.ok(!queries.some((q) => q.value === 'dentist near me'));
    assert.equal(rows.filter((r) => r.dimension === 'page').length, 8);
  });

  test('a site the login cannot read is "forbidden", not an empty list', async () => {
    const { accessToken } = await grant();
    await assert.rejects(
      fetchSearchConsole({
        google,
        accessToken,
        siteUrl: 'https://other.example.test/',
        startDate: '2026-08-01',
        endDate: '2026-10-01',
        terms: [],
      }),
      (e) => e.code === 'forbidden',
    );
  });
});

describe('which days a sync reads', () => {
  const now = new Date('2026-10-05T09:00:00Z');

  test('the first sync looks back 90 days and stops at yesterday (Search Console two days earlier)', () => {
    const r = syncRange({}, now);
    assert.deepEqual(r.ga4, { startDate: '2026-07-07', endDate: '2026-10-04' });
    assert.deepEqual(r.gsc, { startDate: '2026-07-07', endDate: '2026-10-03' });
  });

  test('later syncs start three days before the last day read, so late data settles', () => {
    const r = syncRange({ synced_from: '2026-07-07', synced_to: '2026-10-01' }, now);
    assert.equal(r.ga4.startDate, '2026-09-28');
    assert.equal(r.ga4.endDate, '2026-10-04');
  });

  test('a long-idle connection is not read further back than 90 days', () => {
    const r = syncRange({ synced_to: '2026-01-01' }, now);
    assert.equal(r.ga4.startDate, addDaysText('2026-10-05', -90));
  });
});
