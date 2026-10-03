import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createFunnel, FUNNEL_EVENTS, scoreBand } from './funnel.js';

const posthog = { host: 'https://posthog.test', apiKey: 'phc_test' };

function recorder(response = { ok: true }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return typeof response === 'function' ? response() : response;
  };
  return { calls, fetchImpl };
}

describe('funnel events', () => {
  test('an event is anonymous: a fresh id each time and no person profile', async () => {
    const r = recorder();
    const funnel = createFunnel({ posthog, fetchImpl: r.fetchImpl });
    await funnel.capture('audit_form_submitted', { has_competitor: true });
    await funnel.capture('audit_form_submitted', { has_competitor: false });
    assert.equal(r.calls[0].url, 'https://posthog.test/capture/');
    assert.equal(r.calls[0].body.api_key, 'phc_test');
    assert.equal(r.calls[0].body.properties.$process_person_profile, false);
    assert.notEqual(r.calls[0].body.distinct_id, r.calls[1].body.distinct_id);
  });

  test('only allowed properties can be sent: an email, domain or audit id throws', async () => {
    const funnel = createFunnel({ posthog, fetchImpl: recorder().fetchImpl });
    for (const key of ['email', 'domain', 'audit_id', 'ip', 'url']) {
      await assert.rejects(funnel.capture('audit_report_viewed', { [key]: 'x' }), /not allowed/);
    }
  });

  test('a value outside what a property may hold is dropped, not sent', async () => {
    const r = recorder();
    const funnel = createFunnel({ posthog, fetchImpl: r.fetchImpl });
    await funnel.capture('audit_report_viewed', {
      status: 'someone@example.com',
      score_band: 'high',
      cached: 'yes',
    });
    assert.deepEqual(
      Object.keys(r.calls[0].body.properties).filter((k) => !k.startsWith('$')),
      ['score_band'],
    );
  });

  test('an unknown event is a programming error', async () => {
    const funnel = createFunnel({ posthog, fetchImpl: recorder().fetchImpl });
    await assert.rejects(funnel.capture('page_view'), /Unknown funnel event/);
  });

  test('without PostHog it sends nothing and still checks its arguments', async () => {
    const r = recorder();
    const funnel = createFunnel({ posthog: null, fetchImpl: r.fetchImpl });
    assert.equal(await funnel.capture('audit_code_verified', {}), false);
    assert.equal(r.calls.length, 0);
    await assert.rejects(funnel.capture('audit_code_verified', { email: 'x' }), /not allowed/);
  });

  test('a PostHog outage or a refusal never breaks the request: it resolves false', async () => {
    const down = createFunnel({
      posthog,
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    assert.equal(await down.capture('audit_track_clicked', {}), false);
    const refused = createFunnel({ posthog, fetchImpl: recorder({ ok: false }).fetchImpl });
    assert.equal(await refused.capture('audit_track_clicked', {}), false);
  });

  test('every event the routes fire is on the list', () => {
    assert.deepEqual(FUNNEL_EVENTS, [
      'audit_form_submitted',
      'audit_email_submitted',
      'audit_code_verified',
      'audit_report_viewed',
      'audit_track_clicked',
    ]);
  });

  test('a score becomes a band, and a missing one is "none", never "low"', () => {
    assert.equal(scoreBand(null), 'none');
    assert.equal(scoreBand(undefined), 'none');
    assert.equal(scoreBand(0), 'low');
    assert.equal(scoreBand(33), 'low');
    assert.equal(scoreBand(34), 'mid');
    assert.equal(scoreBand(66), 'mid');
    assert.equal(scoreBand(67), 'high');
  });
});
