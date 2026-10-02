import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { authHarness, orgPathOf } from './auth-helpers.js';

// Analytics (PostHog) is for the public marketing pages only. The signed-in area, the invitation page and the
// staff console carry private data or a secret token in their URLs, and PostHog records page URLs.
const h = authHarness({ env: { POSTHOG_API_KEY: 'phc_test' } });
after(() => h.close());

const hasAnalytics = (html) => /posthog-config|\/js\/analytics\.js/.test(html);

describe('analytics stays off pages with private URLs', () => {
  test('the public pages do load it when configured (so this test can fail)', async () => {
    for (const path of ['/', '/methodology', '/terms', '/privacy']) {
      assert.ok(hasAnalytics((await h.agent.get(path).expect(200)).text), path);
    }
  });

  test('the free-audit form pages keep it', async () => {
    const res = await h.agent.post('/audit').type('form').send({ url: 'example.com' }).expect(200);
    assert.ok(hasAnalytics(res.text));
  });

  test('signed-in pages never load it', async () => {
    const u = await h.signedIn();
    assert.ok(!hasAnalytics((await u.get('/app/new-org').expect(200)).text), '/app/new-org');
    const orgId = orgPathOf(await u.post('/app/new-org', { name: 'Private Co' }).expect(303));
    for (const path of [`/app/o/${orgId}`, `/app/o/${orgId}/settings`]) {
      assert.ok(!hasAnalytics((await u.get(path).expect(200)).text), path);
    }
  });

  test('the no-access page never loads it', async () => {
    const owner = await h.signedIn();
    const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Gate Co' }).expect(303));
    const org = (await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id }))
      .org;
    const viewer = await h.signedIn();
    await h.db.forOrg(org.id).memberships.add({ userId: viewer.user.id, role: 'viewer' });
    const res = await viewer.get(`/app/o/${orgId}/settings`).expect(403);
    assert.ok(!hasAnalytics(res.text));
  });

  test('invitation pages never load it, in any state (their URL is a secret)', async () => {
    const unknown = await h.agent.get(`/invite/${'x'.repeat(43)}`).expect(404);
    assert.ok(!hasAnalytics(unknown.text));
  });

  test('error and 404 pages do not load it', async () => {
    assert.ok(!hasAnalytics((await h.agent.get('/no-such-page').expect(404)).text));
  });

  test('the sign-in-unavailable page does not load it', async () => {
    const { createUnconfiguredProvider } = await import('../../src/web/auth/provider.js');
    const request = (await import('supertest')).default;
    const { createApp } = await import('../../src/web/app.js');
    const { silentLogger } = await import('./helpers.js');
    const app = request(
      createApp({
        config: h.config,
        logger: silentLogger,
        db: h.db,
        provider: createUnconfiguredProvider(),
      }),
    );
    assert.ok(!hasAnalytics((await app.get('/sign-in').expect(503)).text));
  });
});
