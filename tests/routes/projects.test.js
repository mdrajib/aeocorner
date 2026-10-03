import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { authHarness, orgPathOf } from './auth-helpers.js';

/** Projects and competitors in the signed-in area (Milestone 3). */
const added = [];
const jobs = {
  added,
  async add(name, data, options) {
    added.push({ name, data, options });
  },
};
const checks = [];
let verdict = {
  verified: false,
  method: null,
  reasons: { dns: 'No record yet.', file: 'No file.' },
};
const domainVerifier = {
  async verify(args) {
    checks.push(args);
    return verdict;
  },
};
const h = authHarness({ jobs, domainVerifier });
after(() => h.close());

let n = 0;
const site = () => `route-${Date.now().toString(36)}-${n++}.example.test`;
const form = (extra = {}) => ({
  website: site(),
  name: 'Route Dental',
  country: 'US',
  language: 'en',
  ...extra,
});

async function team() {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Project Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const members = {};
  for (const role of ['admin', 'editor', 'viewer']) {
    const m = await h.signedIn();
    await h.db.forOrg(found.org.id).memberships.add({ userId: m.user.id, role });
    members[role] = m;
  }
  return { owner, members, orgId, org: found.org, scoped: h.db.forOrg(found.org.id) };
}

const projectIdOf = (res) => res.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];

describe('creating a project', () => {
  test('an owner creates one, lands on its page, and its first scan is queued', async () => {
    const { owner, orgId } = await team();
    const form1 = await owner.get(`/app/o/${orgId}/projects/new`).expect(200);
    assert.match(form1.text, /Create a project/);
    assert.match(form1.text, /name="_csrf"/);

    const before = added.length;
    const res = await owner.post(`/app/o/${orgId}/projects`, form()).expect(303);
    assert.match(res.headers.location, /\/setup\/brand\?notice=project-created$/);
    const setup = await owner.get(res.headers.location).expect(200);
    assert.match(setup.text, /Confirm your brand/);
    assert.match(setup.text, /Your project is ready/);
    const page = await owner.get(res.headers.location.replace(/\/setup\/brand.*/, '')).expect(200);
    assert.match(page.text, /Route Dental/);
    assert.match(page.text, /ChatGPT/);
    assert.match(page.text, /Continue setup/);

    // The first scan and the first reading of the website are both queued, carrying IDs and nothing else.
    const queued = added.slice(before);
    assert.deepEqual(queued.map((j) => j.name).sort(), ['brandkit.extract', 'crawl.readiness']);
    const scan = queued.find((j) => j.name === 'crawl.readiness');
    assert.deepEqual(Object.keys(scan.data).sort(), ['orgId', 'projectId', 'scanId']);
    const reading = queued.find((j) => j.name === 'brandkit.extract');
    assert.deepEqual(Object.keys(reading.data).sort(), ['baseVersion', 'orgId', 'projectId']);
    assert.equal(reading.data.baseVersion, 0);
  });

  test('the organization overview lists the project', async () => {
    const { owner, orgId } = await team();
    const empty = await owner.get(`/app/o/${orgId}`).expect(200);
    assert.match(empty.text, /No projects yet/);
    await owner.post(`/app/o/${orgId}/projects`, form({ name: 'Listed Co' })).expect(303);
    const list = await owner.get(`/app/o/${orgId}`).expect(200);
    assert.match(list.text, /Listed Co/);
    assert.match(list.text, /Setting up/);
  });

  test('a queue that is down does not lose the project', async () => {
    const down = authHarness({
      jobs: {
        async add() {
          throw new Error('redis is down');
        },
      },
    });
    try {
      const owner = await down.signedIn();
      const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Down Co' }).expect(303));
      const res = await owner.post(`/app/o/${orgId}/projects`, form()).expect(303);
      await owner.get(res.headers.location).expect(200);
    } finally {
      await down.close();
    }
  });

  test('mistakes are explained on the form with status 422 and nothing is created', async () => {
    const { owner, orgId, scoped } = await team();
    const res = await owner
      .post(`/app/o/${orgId}/projects`, {
        website: 'not a site',
        name: 'A',
        country: 'ZZ',
        language: '',
      })
      .expect(422);
    assert.match(res.text, /Enter your website/);
    assert.match(res.text, /Use between 2 and 128 characters/);
    assert.match(res.text, /Choose a country/);
    assert.equal((await scoped.projects.list()).length, 0);
  });

  test('the same website twice in one organization is explained, not a crash', async () => {
    const { owner, orgId } = await team();
    const body = form();
    await owner.post(`/app/o/${orgId}/projects`, body).expect(303);
    const again = await owner.post(`/app/o/${orgId}/projects`, body).expect(422);
    assert.match(again.text, /already has a project for that website/);
  });

  test('www. and the scheme are dropped from the stored domain', async () => {
    const { owner, orgId, scoped } = await team();
    const domain = site();
    await owner
      .post(`/app/o/${orgId}/projects`, form({ website: `https://www.${domain}/about` }))
      .expect(303);
    assert.equal((await scoped.projects.list())[0].domain, domain);
  });

  test('a brand name with HTML in it is shown as text', async () => {
    const { owner, orgId } = await team();
    const res = await owner
      .post(`/app/o/${orgId}/projects`, form({ name: '<img src=x onerror=alert(1)> Co' }))
      .expect(303);
    const page = await owner.get(res.headers.location).expect(200);
    assert.doesNotMatch(page.text, /<img src=x/);
    assert.match(page.text, /&lt;img src=x/);
  });

  test('viewers cannot create; admins and editors can; a form without the token is refused', async () => {
    const { members, orgId, owner } = await team();
    await members.viewer.get(`/app/o/${orgId}/projects/new`).expect(403);
    await members.viewer.post(`/app/o/${orgId}/projects`, form()).expect(403);
    await members.editor.post(`/app/o/${orgId}/projects`, form()).expect(303);
    await members.admin.post(`/app/o/${orgId}/projects`, form()).expect(303);
    await owner.post(`/app/o/${orgId}/projects`, form(), { csrf: null }).expect(403);
    const noButton = await members.viewer.get(`/app/o/${orgId}`).expect(200);
    assert.doesNotMatch(noButton.text, /New project/);
  });
});

describe('one project’s page', () => {
  test('a malformed or unknown project ID is a plain 404', async () => {
    const { owner, orgId } = await team();
    await owner.get(`/app/o/${orgId}/projects/nope`).expect(404);
    await owner.get(`/app/o/${orgId}/projects/${'0'.repeat(26)}`).expect(404);
  });

  test('another organization’s project is a plain 404, never a 403', async () => {
    const mine = await team();
    const theirs = await team();
    const res = await theirs.owner.post(`/app/o/${theirs.orgId}/projects`, form()).expect(303);
    const pid = projectIdOf(res);
    await theirs.owner.get(`/app/o/${theirs.orgId}/projects/${pid}`).expect(200);
    await mine.owner.get(`/app/o/${mine.orgId}/projects/${pid}`).expect(404);
    await mine.owner.get(`/app/o/${theirs.orgId}/projects/${pid}`).expect(404);
  });

  test('a client seat sees only its selected projects', async () => {
    const { owner, orgId, scoped, members } = await team();
    const one = projectIdOf(
      await owner.post(`/app/o/${orgId}/projects`, form({ name: 'Visible Co' })).expect(303),
    );
    const two = projectIdOf(
      await owner.post(`/app/o/${orgId}/projects`, form({ name: 'Hidden Co' })).expect(303),
    );
    const visible = await scoped.projects.getByPublicId(one);
    const membership = await scoped.memberships.getByUser(members.viewer.user.id);
    await scoped.memberships.setProjectAccess({
      membershipId: membership.id,
      access: 'selected',
      projectIds: [visible.id],
    });
    await members.viewer.get(`/app/o/${orgId}/projects/${one}`).expect(200);
    await members.viewer.get(`/app/o/${orgId}/projects/${two}`).expect(404);
    const list = await members.viewer.get(`/app/o/${orgId}`).expect(200);
    assert.match(list.text, /Visible Co/);
    assert.doesNotMatch(list.text, /Hidden Co/);
  });
});

describe('competitors', () => {
  async function withProject() {
    const t = await team();
    const pid = projectIdOf(await t.owner.post(`/app/o/${t.orgId}/projects`, form()).expect(303));
    return { ...t, pid, base: `/app/o/${t.orgId}/projects/${pid}` };
  }

  test('an editor adds a competitor, it shows on the page, and removing it takes it off', async () => {
    const { members, owner, base, scoped, pid } = await withProject();
    const res = await members.editor
      .post(`${base}/competitors`, {
        name: 'Rival Smiles',
        website: 'https://www.rival.example.test/',
      })
      .expect(303);
    assert.match(res.headers.location, /competitor-added/);
    const page = await owner.get(base).expect(200);
    assert.match(page.text, /Rival Smiles/);
    assert.match(page.text, /rival\.example\.test/);

    const project = await scoped.projects.getByPublicId(pid);
    const rival = (await scoped.entities.list(project.id, { kind: 'competitor' }))[0];
    await owner.post(`${base}/competitors/${rival.id}/remove`).expect(303);
    assert.doesNotMatch((await owner.get(base).expect(200)).text, /Rival Smiles/);
  });

  test('viewers cannot add or remove; the page shows them no form', async () => {
    const { members, base } = await withProject();
    await members.viewer.post(`${base}/competitors`, { name: 'Nope Co' }).expect(403);
    const page = await members.viewer.get(base).expect(200);
    assert.doesNotMatch(page.text, /Add competitor/);
  });

  test('a duplicate, a bad website, and the eleventh competitor are each explained', async () => {
    const { owner, base } = await withProject();
    await owner.post(`${base}/competitors`, { name: 'Same Co' }).expect(303);
    const dup = await owner.post(`${base}/competitors`, { name: 'SAME co' }).expect(303);
    assert.match(dup.headers.location, /competitor-exists/);
    const bad = await owner
      .post(`${base}/competitors`, { name: 'Bad Site', website: 'not a site' })
      .expect(303);
    assert.match(bad.headers.location, /competitor-invalid/);
    for (let i = 0; i < 9; i += 1) {
      await owner.post(`${base}/competitors`, { name: `Rival Number ${i}` }).expect(303);
    }
    const full = await owner.post(`${base}/competitors`, { name: 'One Too Many' }).expect(303);
    assert.match(full.headers.location, /competitors-full/);
  });

  test('a competitor of another project cannot be removed through this one', async () => {
    const { owner, orgId, base, scoped } = await withProject();
    const otherPid = projectIdOf(await owner.post(`/app/o/${orgId}/projects`, form()).expect(303));
    const other = await scoped.projects.getByPublicId(otherPid);
    const rival = await scoped.entities.addCompetitor(other.id, { name: 'Other Rival' });
    await owner.post(`${base}/competitors/${rival.id}/remove`).expect(404);
    await owner.post(`${base}/competitors/nope/remove`).expect(404);
    const still = await scoped.entities.list(other.id, { kind: 'competitor' });
    assert.equal(still[0].status, 'active');
  });
});

describe('proving the site is theirs', () => {
  async function withProject() {
    const t = await team();
    const pid = projectIdOf(await t.owner.post(`/app/o/${t.orgId}/projects`, form()).expect(303));
    return { ...t, pid, base: `/app/o/${t.orgId}/projects/${pid}` };
  }

  test('the page shows the DNS record and the file, with this project’s own token', async () => {
    const { owner, base, scoped, pid } = await withProject();
    const page = await owner.get(base).expect(200);
    const { token } = await scoped.projects.verification(
      (await scoped.projects.getByPublicId(pid)).id,
    );
    assert.match(page.text, /_aeocorner\./);
    assert.match(page.text, new RegExp(`aeocorner-verification=${token}`));
    assert.match(page.text, /aeocorner-verification\.txt/);
  });

  test('a failed check says why and changes nothing', async () => {
    const { owner, base, scoped, pid } = await withProject();
    verdict = {
      verified: false,
      method: null,
      reasons: { dns: 'No record yet.', file: 'No file.' },
    };
    const res = await owner.post(`${base}/verify`, { method: 'any' }).expect(200);
    assert.match(res.text, /couldn’t verify it yet/);
    assert.match(res.text, /No record yet\./);
    const v = await scoped.projects.verification((await scoped.projects.getByPublicId(pid)).id);
    assert.equal(v.verifiedAt, null);
    assert.equal(checks.at(-1).token, v.token);
  });

  test('a successful check verifies the project; checking again is harmless', async () => {
    const { owner, base, scoped, pid } = await withProject();
    verdict = { verified: true, method: 'dns', reasons: {} };
    const res = await owner.post(`${base}/verify`, { method: 'dns' }).expect(303);
    assert.match(res.headers.location, /notice=verified/);
    const v = await scoped.projects.verification((await scoped.projects.getByPublicId(pid)).id);
    assert.equal(v.method, 'dns');
    assert.match((await owner.get(base).expect(200)).text, /Verified/);
    const before = checks.length;
    await owner.post(`${base}/verify`, {}).expect(303);
    assert.equal(checks.length, before, 'no new lookup for a site already verified');
  });

  test('checks are spaced out, viewers cannot check, and a bad token is refused', async () => {
    const { owner, members, base } = await withProject();
    verdict = { verified: false, method: null, reasons: {} };
    await owner.post(`${base}/verify`, {}).expect(200);
    await owner.post(`${base}/verify`, {}).expect(429);
    await members.viewer.post(`${base}/verify`, {}).expect(403);
    await owner.post(`${base}/verify`, {}, { csrf: null }).expect(403);
  });

  test('another organization cannot verify this project', async () => {
    const { base } = await withProject();
    const other = await team();
    await other.owner
      .post(base.replace(/^\/app\/o\/[0-9A-Z]{26}/, `/app/o/${other.orgId}`) + '/verify', {})
      .expect(404);
  });
});
