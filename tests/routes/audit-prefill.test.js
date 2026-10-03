import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { auditFixtures } from '../helpers/audit-fixtures.js';
import { authHarness, orgPathOf } from './auth-helpers.js';

/** Signing up from a report ("Track this every week") and the project it prefills (Milestone 3: 3.11). */
const added = [];
const jobs = {
  async add(name, data, options) {
    added.push({ name, data, options });
  },
};
const h = authHarness({ jobs });
after(() => h.close());
const { seedAudit } = auditFixtures({ db: h.db, fx: h.fx });

/** A finished audit with the Brand Kit and competitors the pipeline would have found. */
async function auditOfSite({ liteName = 'Widget Works Ltd', status = 'complete' } = {}) {
  const audit = await seedAudit('running');
  await h.db.audits.saveSetup(audit.id, {
    brandKitLite: {
      brand_name: liteName,
      aliases: ['WidgetWorks'],
      category: 'industrial widget supplier',
      definition: 'Makes widgets for factories.',
      offerings: ['Steel widgets', 'Brass widgets'],
      audience: 'factory buyers',
      geography: 'Ohio',
      competitors: [],
    },
    prompts: [],
    suggestedCompetitors: [
      { name: 'Bright Widgets', domain: 'brightwidgets.example' },
      { name: 'Lone Star Widgets', domain: null },
    ],
  });
  await h.db.audits.finish(audit.id, {
    status,
    readinessScore: 54,
    visibilityScore: 15,
    aeoScore: 38,
    subScores: {},
    topFixes: [],
  });
  return h.db.audits.get(audit.id);
}

const claim = (audit) => `aeo_audit=${audit.public_id}`;

async function signedUpOwner() {
  const owner = await h.signedIn();
  return owner;
}

describe('a project made from an audit', () => {
  test('signing up from a report goes to a prefilled project form and the project starts with what the audit found', async () => {
    const audit = await auditOfSite();
    const owner = await signedUpOwner();

    // A new visitor has no organization yet: creating one continues to the project, not to an empty overview.
    const org = await owner
      .post('/app/new-org', { name: 'Widget Works' })
      .set('Cookie', claim(audit))
      .expect(303);
    const orgBase = org.headers.location.replace(/\/projects\/new$/, '');
    assert.match(org.headers.location, /^\/app\/o\/[0-9A-Z]{26}\/projects\/new$/);

    const form = await owner.get(org.headers.location).set('Cookie', claim(audit)).expect(200);
    assert.match(form.text, /Pre-filled from your free audit/);
    assert.ok(form.text.includes(`value="${audit.domain}"`), 'the audited website');
    assert.match(form.text, /value="Widget Works Ltd"/);

    const before = added.length;
    const res = await owner
      .post(`${orgBase}/projects`, {
        website: audit.domain,
        name: 'Widget Works',
        country: 'US',
        language: 'en',
      })
      .set('Cookie', claim(audit))
      .expect(303);
    assert.match(res.headers.location, /\/setup\/brand\?notice=project-created$/);
    const cleared = res.headers['set-cookie']?.find((c) => c.startsWith('aeo_audit='));
    assert.match(cleared ?? '', /aeo_audit=;/, 'the claim is used up');

    const found = await h.db.organizations.findForUser({
      publicId: orgPathOf(org),
      userId: owner.user.id,
    });
    const scoped = h.db.forOrg(found.org.id);
    const [project] = await scoped.projects.list();
    assert.equal(project.source_audit_id, audit.id);
    assert.equal((await h.db.audits.get(audit.id)).org_id, found.org.id, 'the audit is claimed');
    assert.equal((await h.db.audits.get(audit.id)).project_id, project.id);

    const kit = await scoped.brandKits.current(project.id);
    assert.equal(kit.version, 1);
    assert.equal(kit.source, 'audit');
    assert.equal(kit.data.identity.brandName, 'Widget Works', 'the name the customer confirmed');
    assert.ok(
      kit.data.identity.aliases.includes('Widget Works Ltd'),
      'the audit’s wording is kept as an alias',
    );
    assert.deepEqual(kit.data.identity.domains, [audit.domain]);
    assert.deepEqual(
      kit.data.offerings.items.map((i) => i.name),
      ['Steel widgets', 'Brass widgets'],
    );

    const competitors = await scoped.entities.list(project.id, { kind: 'competitor' });
    assert.deepEqual(competitors.map((c) => [c.name, c.status, c.source]).sort(), [
      ['Bright Widgets', 'suggested', 'audit'],
      ['Lone Star Widgets', 'suggested', 'audit'],
    ]);

    // The full reading builds on the audit's kit (version 1), so a person's edits are never overwritten.
    const reading = added.slice(before).find((j) => j.name === 'brandkit.extract');
    assert.equal(reading.data.baseVersion, 1);

    const brand = await owner
      .get(`${orgBase}/projects/${project.public_id}/setup/brand`)
      .expect(200);
    assert.match(brand.text, /industrial widget supplier/);
    assert.match(brand.text, /Steel widgets/);
  });

  test('a person who already has an organization goes straight to a prefilled new project', async () => {
    const audit = await auditOfSite();
    const owner = await signedUpOwner();
    const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Existing Co' }).expect(303));
    const res = await owner.get('/app/new-org').set('Cookie', claim(audit)).expect(302);
    assert.equal(res.headers.location, `/app/o/${orgId}/projects/new`);
    // Without the claim the same page is the ordinary form.
    await owner.get('/app/new-org').expect(200);
  });

  test('a different website than the audited one is a different project: nothing is taken from the audit', async () => {
    const audit = await auditOfSite();
    const owner = await signedUpOwner();
    const orgId = orgPathOf(
      await owner.post('/app/new-org', { name: 'Other Site Co' }).expect(303),
    );
    await owner
      .post(`/app/o/${orgId}/projects`, {
        website: `elsewhere-${Date.now().toString(36)}.example.test`,
        name: 'Elsewhere',
        country: 'US',
        language: 'en',
      })
      .set('Cookie', claim(audit))
      .expect(303);
    const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
    const scoped = h.db.forOrg(found.org.id);
    const [project] = await scoped.projects.list();
    assert.equal(project.source_audit_id, null);
    assert.equal(await scoped.brandKits.current(project.id), null);
    assert.equal((await h.db.audits.get(audit.id)).org_id, null, 'the audit is still unclaimed');
  });

  test('an audit that belongs to another organization, is unfinished, or is a made-up ID offers nothing', async () => {
    const owner = await signedUpOwner();
    const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Not Yours Co' }).expect(303));
    const other = await h.signedIn();
    const otherOrg = await h.db.organizations.createWithOwner({
      user: other.user,
      name: 'Owner Of It',
    });

    const taken = await auditOfSite();
    await h.fx.claimAudit(taken.id, otherOrg.org.id);
    const unfinished = await seedAudit('running');

    for (const cookie of [
      claim(taken),
      claim(unfinished),
      'aeo_audit=01ARZ3NDEKTSV4RRFFQ69G5FAV',
      'aeo_audit=not-an-id',
    ]) {
      const page = await owner
        .get(`/app/o/${orgId}/projects/new`)
        .set('Cookie', cookie)
        .expect(200);
      assert.doesNotMatch(page.text, /Pre-filled from your free audit/, cookie);
    }
    const res = await owner
      .post(`/app/o/${orgId}/projects`, {
        website: taken.domain,
        name: 'Taken Audit',
        country: 'US',
        language: 'en',
      })
      .set('Cookie', claim(taken))
      .expect(303);
    const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
    const [project] = await h.db.forOrg(found.org.id).projects.list();
    assert.equal(project.source_audit_id, null, res.headers.location);
    assert.equal((await h.db.audits.get(taken.id)).org_id, otherOrg.org.id, 'still theirs');
  });

  test('an audit with no kit still creates the project, just without a prefilled kit', async () => {
    const audit = await seedAudit('running');
    await h.db.audits.finish(audit.id, {
      status: 'partial',
      readinessScore: null,
      visibilityScore: null,
      aeoScore: null,
      subScores: {},
      topFixes: [],
    });
    const owner = await signedUpOwner();
    const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'No Kit Co' }).expect(303));
    const done = await h.db.audits.get(audit.id);
    await owner
      .post(`/app/o/${orgId}/projects`, {
        website: done.domain,
        name: 'No Kit',
        country: 'US',
        language: 'en',
      })
      .set('Cookie', claim(done))
      .expect(303);
    const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
    const scoped = h.db.forOrg(found.org.id);
    const [project] = await scoped.projects.list();
    assert.equal(project.source_audit_id, done.id);
    assert.equal(await scoped.brandKits.current(project.id), null);
  });
});
