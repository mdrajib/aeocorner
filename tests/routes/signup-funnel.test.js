import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { createFunnel } from '../../src/lib/funnel.js';
import { authHarness, orgPathOf } from './auth-helpers.js';

// The last step of the public funnel (Milestone 9, task 9.09): a new account made its first organization.
const calls = [];
let response = { ok: true };
const funnel = createFunnel({
  posthog: { host: 'https://posthog.test', apiKey: 'phc_test' },
  fetchImpl: async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (response instanceof Error) throw response;
    return response;
  },
});
const h = authHarness({ funnel });
after(() => h.close());

const events = () => calls.filter((c) => c.event === 'signup_completed');

describe('signup_completed', () => {
  test('fires once, for a first organization, and carries nothing that identifies the person', async () => {
    const u = await h.signedIn({ name: 'Maya Private', email: 'maya.private@acme-corp.test' });
    const before = events().length;
    const created = await u.post('/app/new-org', { name: 'Private Dental Co' }).expect(303);
    assert.ok(orgPathOf(created));
    assert.equal(events().length, before + 1);
    const event = events().at(-1);
    assert.deepEqual(
      Object.fromEntries(Object.entries(event.properties).filter(([k]) => !k.startsWith('$'))),
      { from_audit: false },
    );
    assert.equal(event.properties.$process_person_profile, false);
    assert.doesNotMatch(JSON.stringify(event), /Maya|Private|acme-corp|\/app\/o\//);

    // A second organization by the same person is not a sign-up.
    await u.post('/app/new-org', { name: 'Second Co' }).expect(303);
    assert.equal(events().length, before + 1);
  });

  test('a PostHog outage does not stop the organization from being made', async () => {
    response = new Error('connect ECONNREFUSED');
    try {
      const u = await h.signedIn();
      const created = await u.post('/app/new-org', { name: 'Resilient Co' }).expect(303);
      assert.ok(orgPathOf(created));
    } finally {
      response = { ok: true };
    }
  });

  test('a form that is refused (no CSRF token, or a bad name) is not a sign-up', async () => {
    const u = await h.signedIn();
    const before = events().length;
    await u.post('/app/new-org', { name: 'No Token' }, { csrf: null }).expect(403);
    await u.post('/app/new-org', { name: 'x' }).expect(422);
    assert.equal(events().length, before);
  });
});
