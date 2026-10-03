import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { authHarness, orgPathOf } from './auth-helpers.js';

/** The Brand Kit, Prompt Manager and setup screens of a project (Milestone 3: 3.12 to 3.14). */
const added = [];
const jobs = {
  added,
  async add(name, data, options) {
    added.push({ name, data, options });
  },
};
const h = authHarness({ jobs });
after(() => h.close());

let n = 0;
const site = () => `screens-${Date.now().toString(36)}-${n++}.example.test`;

/** An organization with an owner, an editor and a viewer, and one project. */
async function withProject({ city = '' } = {}) {
  const owner = await h.signedIn();
  const orgId = orgPathOf(await owner.post('/app/new-org', { name: 'Screens Co' }).expect(303));
  const found = await h.db.organizations.findForUser({ publicId: orgId, userId: owner.user.id });
  const members = {};
  for (const role of ['editor', 'viewer']) {
    const m = await h.signedIn();
    await h.db.forOrg(found.org.id).memberships.add({ userId: m.user.id, role });
    members[role] = m;
  }
  const scoped = h.db.forOrg(found.org.id);
  const created = await owner
    .post(`/app/o/${orgId}/projects`, {
      website: site(),
      name: 'Screens Dental',
      country: 'US',
      language: 'en',
      city,
    })
    .expect(303);
  const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
  const project = await scoped.projects.getByPublicId(pid);
  return {
    owner,
    members,
    orgId,
    scoped,
    project,
    base: `/app/o/${orgId}/projects/${pid}`,
    orgBase: `/app/o/${orgId}`,
  };
}

const kitFields = (over = {}) => ({
  section: 'identity',
  expectedVersion: '',
  brandName: 'Screens Dental',
  aliases: 'Screens\nScreens DDS',
  definition: 'A family dental practice in Austin.',
  category: 'family dental practice',
  geography: 'Austin, Texas',
  ...over,
});

describe('the Brand Kit screen', () => {
  test('starts empty with the project’s own name, and saving makes version 1', async () => {
    const { owner, base, scoped, project } = await withProject();
    const page = await owner.get(`${base}/brand`).expect(200);
    assert.match(page.text, /Not saved yet/);
    assert.match(page.text, /value="Screens Dental"/);
    assert.match(page.text, /name="_csrf"/);
    for (const tab of ['Identity', 'Offerings', 'Facts', 'Voice', 'Competitors']) {
      assert.match(page.text, new RegExp(`>${tab}<`));
    }

    const saved = await owner.post(`${base}/brand`, kitFields()).expect(303);
    assert.match(saved.headers.location, /\/brand\?tab=identity&notice=brand-saved$/);
    const kit = await scoped.brandKits.current(project.id);
    assert.equal(kit.version, 1);
    assert.equal(kit.source, 'edited');
    assert.deepEqual(kit.data.identity.aliases, ['Screens', 'Screens DDS']);

    const after = await owner.get(saved.headers.location).expect(200);
    assert.match(after.text, /Version 1/);
    assert.match(after.text, /Brand Kit saved/);
    assert.match(after.text, /Screens DDS/);
  });

  test('a form that started from an older version is refused, and nothing is overwritten', async () => {
    const { owner, base, scoped, project } = await withProject();
    await owner.post(`${base}/brand`, kitFields({ brandName: 'First' })).expect(303);
    // A second person's form was opened before the first save: it still says "no version yet".
    const stale = await owner
      .post(`${base}/brand`, kitFields({ brandName: 'Second', expectedVersion: '' }))
      .expect(409);
    assert.match(stale.text, /Someone saved a newer version first/);
    const kit = await scoped.brandKits.current(project.id);
    assert.equal(kit.version, 1);
    assert.equal(kit.data.identity.brandName, 'First');

    // Starting from the version they can see, the same edit goes through as version 2.
    await owner
      .post(`${base}/brand`, kitFields({ brandName: 'Second', expectedVersion: '1' }))
      .expect(303);
    assert.equal((await scoped.brandKits.current(project.id)).version, 2);
  });

  test('offerings, facts and voice save from repeated rows; empty rows are dropped', async () => {
    const { owner, base, scoped, project } = await withProject();
    await owner
      .post(`${base}/brand`, {
        section: 'offerings',
        expectedVersion: '',
        offering_name: ['Check-ups', 'Braces', ''],
        offering_price: ['$99', '', ''],
        offering_url: ['', '', ''],
        offering_description: ['Twice-yearly exams.', '', ''],
        audiences: 'families\nstudents',
        differentiators: 'Open on Saturdays',
      })
      .expect(303);
    await owner
      .post(`${base}/brand`, {
        section: 'facts',
        expectedVersion: '1',
        fact_label: ['Founded', '', ''],
        fact_value: ['2009', '', ''],
      })
      .expect(303);
    await owner
      .post(`${base}/brand`, {
        section: 'voice',
        expectedVersion: '2',
        tone: 'friendly\nplain',
        readingLevel: 'plain',
        use: 'smile',
        avoid: '',
        persona_name: ['Dr Ada Lovelace', ''],
        persona_bio: ['Founder.', ''],
        persona_credentials: ['DDS', ''],
      })
      .expect(303);
    const kit = await scoped.brandKits.current(project.id);
    assert.equal(kit.version, 3);
    assert.deepEqual(
      kit.data.offerings.items.map((i) => [i.name, i.price]),
      [
        ['Check-ups', '$99'],
        ['Braces', ''],
      ],
    );
    assert.deepEqual(kit.data.offerings.audiences, ['families', 'students']);
    assert.deepEqual(kit.data.facts, [{ label: 'Founded', value: '2009' }]);
    assert.deepEqual(kit.data.voice.tone, ['friendly', 'plain']);
    assert.equal(kit.data.voice.personas[0].name, 'Dr Ada Lovelace');
  });

  test('a half-filled row is explained, with status 422, and nothing is saved', async () => {
    const { owner, base, scoped, project } = await withProject();
    const res = await owner
      .post(`${base}/brand`, {
        section: 'offerings',
        expectedVersion: '',
        offering_name: ['', 'Braces'],
        offering_price: ['$500', ''],
        offering_url: ['', ''],
        offering_description: ['', ''],
      })
      .expect(422);
    assert.match(res.text, /Offering 1/);
    assert.equal(await scoped.brandKits.current(project.id), null);

    const noName = await owner.post(`${base}/brand`, kitFields({ brandName: '  ' })).expect(422);
    assert.match(noName.text, /can’t be empty|needs a name/);
  });

  test('every version is listed with what it changed, and an old one can be restored as a new version', async () => {
    const { owner, base, scoped, project } = await withProject();
    await owner.post(`${base}/brand`, kitFields({ brandName: 'Original Name' })).expect(303);
    await owner
      .post(`${base}/brand`, kitFields({ brandName: 'Renamed Name', expectedVersion: '1' }))
      .expect(303);
    const page = await owner.get(`${base}/brand`).expect(200);
    assert.match(page.text, /Version 2/);
    assert.match(page.text, /Changed: Identity/);
    assert.match(page.text, /action="[^"]*\/brand\/restore"/);

    await owner.post(`${base}/brand/restore`, { version: '1' }).expect(303);
    const kit = await scoped.brandKits.current(project.id);
    assert.equal(kit.version, 3, 'restoring is a new version, not a rewrite of history');
    assert.equal(kit.data.identity.brandName, 'Original Name');
    assert.equal((await scoped.brandKits.history(project.id)).length, 3);
    await owner.post(`${base}/brand/restore`, { version: '99' }).expect(404);
  });

  test('"read my website again" queues one job per kit version and time slot, carrying IDs only', async () => {
    const { owner, base, project } = await withProject();
    const before = added.length;
    const res = await owner.post(`${base}/brand/reread`).expect(303);
    assert.match(res.headers.location, /notice=reading-site/);
    await owner.post(`${base}/brand/reread`).expect(303);
    const queued = added.slice(before);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].options.jobId, queued[1].options.jobId, 'a double click is one job');
    assert.deepEqual(queued[0].data, {
      orgId: queued[0].data.orgId,
      projectId: String(project.id),
      baseVersion: 0,
    });
  });

  test('a queue that is down says so and loses nothing', async () => {
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
      const created = await owner
        .post(`/app/o/${orgId}/projects`, {
          website: site(),
          name: 'Down Dental',
          country: 'US',
          language: 'en',
        })
        .expect(303);
      const pid = created.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
      const res = await owner.post(`/app/o/${orgId}/projects/${pid}/brand/reread`).expect(303);
      assert.match(res.headers.location, /notice=queue-down/);
    } finally {
      await down.close();
    }
  });

  test('viewers can read but not change anything; the page shows them no save button', async () => {
    const { members, base } = await withProject();
    const page = await members.viewer.get(`${base}/brand`).expect(200);
    assert.match(page.text, /You can view the Brand Kit/);
    assert.doesNotMatch(page.text, /Read my website again/);
    await members.viewer.post(`${base}/brand`, kitFields()).expect(403);
    await members.viewer.post(`${base}/brand/restore`, { version: '1' }).expect(403);
    await members.viewer.post(`${base}/brand/reread`).expect(403);
  });

  test('another organization’s project has no Brand Kit page for you', async () => {
    const mine = await withProject();
    const theirs = await withProject();
    await mine.owner.get(`${theirs.base}/brand`).expect(404);
    await mine.owner.post(`${theirs.base}/brand`, kitFields()).expect(404);
  });
});

describe('suggested competitors', () => {
  async function withSuggestion() {
    const t = await withProject();
    const entity = await t.scoped.entities.addCompetitor(t.project.id, {
      name: 'Suggested Smiles',
      primaryDomain: 'suggested.example.test',
      source: 'brand_kit',
      status: 'suggested',
    });
    return { ...t, entity };
  }

  test('are shown apart from tracked competitors until confirmed, then tracked', async () => {
    const { owner, base, entity, scoped, project } = await withSuggestion();
    const page = await owner.get(`${base}/brand?tab=competitors`).expect(200);
    assert.match(page.text, /Suggested for you/);
    assert.match(page.text, /Suggested Smiles/);

    const res = await owner
      .post(`${base}/competitors/${entity.id}/track`, { next: 'brand' })
      .expect(303);
    assert.match(res.headers.location, /\/brand\?tab=competitors&notice=competitor-tracked$/);
    const [row] = (await scoped.entities.list(project.id, { kind: 'competitor' })).filter(
      (e) => e.id === entity.id,
    );
    assert.equal(row.status, 'active');
  });

  test('can be dismissed, and a form can only go back to a screen of ours', async () => {
    const { owner, base, entity, scoped, project } = await withSuggestion();
    const res = await owner
      .post(`${base}/competitors/${entity.id}/remove`, { next: 'https://evil.example/' })
      .expect(303);
    assert.ok(res.headers.location.startsWith(base), res.headers.location);
    assert.doesNotMatch(res.headers.location, /evil/);
    const [row] = (await scoped.entities.list(project.id, { kind: 'competitor' })).filter(
      (e) => e.id === entity.id,
    );
    assert.equal(row.status, 'ignored');
  });

  test('only a suggestion of this project can be confirmed, and only by someone who may edit', async () => {
    const mine = await withSuggestion();
    const other = await withSuggestion();
    await mine.owner.post(`${mine.base}/competitors/${other.entity.id}/track`).expect(404);
    await mine.members.viewer.post(`${mine.base}/competitors/${mine.entity.id}/track`).expect(403);
    // An already tracked competitor is not "a suggestion".
    await mine.owner.post(`${mine.base}/competitors/${mine.entity.id}/track`).expect(303);
    await mine.owner.post(`${mine.base}/competitors/${mine.entity.id}/track`).expect(404);
  });
});

const questions = (count, prefix = 'What is the best option for case') =>
  Array.from({ length: count }, (_, i) => ({
    text: `${prefix} number ${i} when comparing providers in town?`,
    intent: 'discovery',
  }));

describe('the Prompt Manager screen', () => {
  test('is empty at first and says what to do', async () => {
    const { owner, base } = await withProject();
    const page = await owner.get(`${base}/questions`).expect(200);
    assert.match(page.text, /No questions yet/);
    assert.match(page.text, /Write my questions/);
    assert.match(page.text, /Add a question/);
    assert.match(page.text, /0 of 50/);
  });

  test('adds a question, refuses a duplicate, and warns about a near duplicate', async () => {
    const { owner, base, scoped, project } = await withProject();
    const add = (text, extra = {}) =>
      owner.post(`${base}/questions`, {
        text,
        intent: 'discovery',
        priority: '2',
        topic: 'Finding',
        ...extra,
      });

    const first = await add('What is the best family dentist in Austin?').expect(303);
    assert.match(first.headers.location, /notice=question-added$/);
    const dup = await add('what is the BEST family dentist in austin').expect(422);
    assert.match(dup.text, /already track this question/);
    const near = await add('What is the best family dentist in Austin TX?').expect(303);
    assert.match(near.headers.location, /question-added-similar/);
    const bad = await add('Hi').expect(422);
    assert.match(bad.text, /full question/);
    assert.equal((await scoped.prompts.list(project.id)).length, 2);

    const page = await owner.get(`${base}/questions`).expect(200);
    assert.match(page.text, /Looks like a duplicate of/);
    assert.match(page.text, /Finding/);
  });

  test('flags a question that names the brand when it should not', async () => {
    const { owner, base } = await withProject();
    await owner
      .post(`${base}/questions`, {
        text: 'Is Screens Dental the best family dentist in Austin?',
        intent: 'discovery',
        priority: '2',
      })
      .expect(303);
    const page = await owner.get(`${base}/questions`).expect(200);
    assert.match(page.text, /names your brand/);
  });

  test('shows what the set is missing against the intent rules', async () => {
    const { owner, base } = await withProject();
    const page = await owner.get(`${base}/questions`).expect(200);
    assert.match(page.text, /To get a reliable picture/);
    assert.match(page.text, /Add 25 more/);
  });

  test('filters by words, kind and status', async () => {
    const { owner, base, scoped, project } = await withProject();
    await scoped.prompts.add(project.id, {
      text: 'Which dentist takes walk-ins on Saturdays?',
      intent: 'discovery',
    });
    const { prompt } = await scoped.prompts.add(project.id, {
      text: 'Screens Dental versus Bright Smiles for braces?',
      intent: 'comparison',
    });
    await scoped.prompts.setStatus(prompt.id, 'paused');

    const byWord = await owner.get(`${base}/questions?q=walk-ins`).expect(200);
    assert.match(byWord.text, /walk-ins/);
    assert.doesNotMatch(byWord.text, /Bright Smiles for braces/);
    const byKind = await owner.get(`${base}/questions?intent=comparison`).expect(200);
    assert.match(byKind.text, /Bright Smiles for braces/);
    assert.doesNotMatch(byKind.text, /walk-ins/);
    const paused = await owner.get(`${base}/questions?status=paused`).expect(200);
    assert.match(paused.text, /Bright Smiles for braces/);
    const none = await owner.get(`${base}/questions?q=zzzzzz`).expect(200);
    assert.match(none.text, /No question matches those filters/);
  });

  test('rewording archives the old question and keeps it as history; the edit page is pre-filled', async () => {
    const { owner, base, scoped, project } = await withProject();
    const { prompt } = await scoped.prompts.add(project.id, {
      text: 'Which dentist takes walk-ins on Saturdays?',
      intent: 'discovery',
    });
    const form = await owner.get(`${base}/questions/${prompt.id}/edit`).expect(200);
    assert.match(form.text, /Which dentist takes walk-ins on Saturdays\?/);
    assert.match(form.text, /starts a fresh line on your charts/);

    const res = await owner
      .post(`${base}/questions/${prompt.id}`, {
        text: 'Which dentist in Austin takes walk-ins on a Saturday?',
        intent: 'discovery',
        priority: '1',
        topic: 'Hours',
      })
      .expect(303);
    assert.match(res.headers.location, /notice=question-saved$/);
    const live = await scoped.prompts.list(project.id);
    assert.equal(live.length, 1);
    assert.equal(live[0].replaces_prompt_id, prompt.id);
    const archived = await scoped.prompts.list(project.id, { status: 'archived' });
    assert.deepEqual(
      archived.map((p) => p.id),
      [prompt.id],
    );

    const bad = await owner
      .post(`${base}/questions/${live[0].id}`, { text: 'x', intent: 'discovery', priority: '2' })
      .expect(422);
    assert.match(bad.text, /full question/);
    await owner.get(`${base}/questions/${prompt.id}/edit`).expect(200);
  });

  test('a question can be paused, turned on, archived and restored; a full plan refuses turning one on', async () => {
    const { owner, base, scoped, project } = await withProject();
    const { prompt } = await scoped.prompts.add(project.id, {
      text: 'Which dentist takes walk-ins on Saturdays?',
      intent: 'discovery',
    });
    const move = (status) => owner.post(`${base}/questions/${prompt.id}/status`, { status });
    await move('paused').expect(303);
    assert.equal((await scoped.prompts.list(project.id, { status: 'paused' })).length, 1);
    await move('active').expect(303);
    await move('archived').expect(303);
    assert.equal((await scoped.prompts.list(project.id, { status: 'archived' })).length, 1);
    await move('active').expect(303);
    assert.equal((await scoped.prompts.list(project.id, { status: 'active' })).length, 1);
    const bad = await move('nonsense').expect(303);
    assert.match(bad.headers.location, /question-invalid/);

    // Fill the plan (50), then pause one and try to turn a paused question on while full.
    await scoped.prompts.importMany(project.id, questions(49), { limit: 50 });
    const blocked = await scoped.prompts.add(
      project.id,
      { text: 'Where can I book a late dentist visit?', intent: 'discovery' },
      { limit: 51 },
    );
    await scoped.prompts.setStatus(blocked.prompt.id, 'paused');
    const full = await owner
      .post(`${base}/questions/${blocked.prompt.id}/status`, { status: 'active' })
      .expect(303);
    assert.match(full.headers.location, /question-limit/);
    const refused = await owner
      .post(`${base}/questions`, {
        text: 'Which practice is best for kids in Austin?',
        intent: 'discovery',
        priority: '2',
      })
      .expect(422);
    assert.match(refused.text, /all in use/);
  });

  test('an import answers every line: added, already tracked, and not understood', async () => {
    const { owner, base, scoped, project } = await withProject();
    await scoped.prompts.add(project.id, {
      text: 'Which dentist takes walk-ins on Saturdays?',
      intent: 'discovery',
    });
    const csv = [
      'question,intent,topic,priority',
      'Where can a nervous child get a gentle checkup in Austin?,discovery,Kids,1',
      'Which dentist takes walk-ins on Saturdays?,discovery,Hours,2',
      'How do I choose between braces and aligners?,haggling,Costs,2',
      ',discovery,,',
      'What does a dental crown usually cost in Texas?,Solving a problem,Costs,3',
    ].join('\n');
    const res = await owner.post(`${base}/questions/import`, { csv }).expect(200);
    assert.match(res.text, /2 of 5 questions imported/);
    assert.match(res.text, /Already tracked/);
    assert.match(res.text, /haggling/);
    assert.match(res.text, /There is no question on this line/);
    assert.equal((await scoped.prompts.list(project.id)).length, 3);

    const nothing = await owner.post(`${base}/questions/import`, { csv: '   ' }).expect(422);
    assert.match(nothing.text, /Paste your questions first/);
  });

  test('"write my questions" queues one job with IDs only, once per slot, and not when the plan is full', async () => {
    const { owner, base, scoped, project } = await withProject();
    const before = added.length;
    const res = await owner.post(`${base}/questions/generate`).expect(303);
    assert.match(res.headers.location, /questions\?since=\d+&n=0&notice=questions-queued$/);
    await owner.post(`${base}/questions/generate`).expect(303);
    const queued = added.slice(before);
    assert.equal(queued.length, 2);
    assert.equal(queued[0].name, 'questions.generate');
    assert.equal(queued[0].options.jobId, queued[1].options.jobId);
    assert.deepEqual(Object.keys(queued[0].data).sort(), ['count', 'orgId', 'projectId']);

    // While we wait the page says so and refreshes itself.
    const waiting = await owner.get(res.headers.location).expect(200);
    assert.match(waiting.text, /We’re writing your questions/);
    assert.match(waiting.text, /<meta http-equiv="refresh" content="8">/);

    await scoped.prompts.importMany(project.id, questions(50), { limit: 50 });
    const full = await owner.post(`${base}/questions/generate`).expect(303);
    assert.match(full.headers.location, /question-limit/);
    assert.equal(added.length, before + 2);
  });

  test('a question of another project cannot be reached through this one', async () => {
    const mine = await withProject();
    const theirs = await withProject();
    const { prompt } = await theirs.scoped.prompts.add(theirs.project.id, {
      text: 'Which dentist takes walk-ins on Saturdays?',
      intent: 'discovery',
    });
    await mine.owner.get(`${mine.base}/questions/${prompt.id}/edit`).expect(404);
    await mine.owner
      .post(`${mine.base}/questions/${prompt.id}`, {
        text: 'Planted wording about dentists',
        intent: 'discovery',
      })
      .expect(404);
    await mine.owner
      .post(`${mine.base}/questions/${prompt.id}/status`, { status: 'archived' })
      .expect(404);
    await mine.owner.get(`${theirs.base}/questions`).expect(404);
    assert.equal((await theirs.scoped.prompts.list(theirs.project.id)).length, 1);
    assert.equal((await theirs.scoped.prompts.list(theirs.project.id))[0].status, 'active');
  });

  test('viewers can read the list but see no forms and cannot change anything', async () => {
    const { members, base, scoped, project } = await withProject();
    const { prompt } = await scoped.prompts.add(project.id, {
      text: 'Which dentist takes walk-ins on Saturdays?',
      intent: 'discovery',
    });
    const page = await members.viewer.get(`${base}/questions`).expect(200);
    assert.match(page.text, /walk-ins/);
    assert.doesNotMatch(page.text, /Add a question/);
    assert.doesNotMatch(page.text, /Import from a spreadsheet/);
    await members.viewer
      .post(`${base}/questions`, { text: 'Which practice is best for kids?', intent: 'discovery' })
      .expect(403);
    await members.viewer
      .post(`${base}/questions/${prompt.id}/status`, { status: 'archived' })
      .expect(403);
    await members.viewer
      .post(`${base}/questions/import`, { csv: 'a question about dentists' })
      .expect(403);
    await members.viewer.post(`${base}/questions/generate`).expect(403);
  });

  test('a question with HTML in it is shown as text', async () => {
    const { owner, base, scoped, project } = await withProject();
    await scoped.prompts.add(project.id, {
      text: '<img src=x onerror=alert(1)> which dentist is best in town?',
      intent: 'discovery',
    });
    const page = await owner.get(`${base}/questions`).expect(200);
    assert.doesNotMatch(page.text, /<img src=x/);
    assert.match(page.text, /&lt;img src=x/);
  });
});

describe('the setup steps', () => {
  test('walk brand → competitors → questions → connect → start, pre-filled from the Brand Kit', async () => {
    const { owner, base, scoped, project } = await withProject();
    await scoped.brandKits.save(project.id, {
      kit: {
        identity: {
          brandName: 'Screens Dental',
          category: 'family dental practice',
          definition: 'A dental practice.',
        },
        offerings: { items: [{ name: 'Check-ups', price: '$99' }] },
      },
      source: 'extracted',
      expectedVersion: null,
    });
    const brand = await owner.get(`${base}/setup/brand`).expect(200);
    assert.match(brand.text, /Confirm your brand/);
    assert.match(brand.text, /family dental practice/);
    assert.match(brand.text, /Check-ups/);
    assert.match(brand.text, /aria-current="step"/);

    const res = await owner
      .post(`${base}/setup/brand`, {
        expectedVersion: '1',
        brandName: 'Screens Dental',
        aliases: 'Screens',
        definition: 'A family dental practice in Austin.',
        category: 'family dental practice',
        geography: 'Austin',
        products: 'Check-ups\nBraces',
      })
      .expect(303);
    assert.equal(res.headers.location, `${base}/setup/competitors`);
    const kit = await scoped.brandKits.current(project.id);
    assert.equal(kit.version, 2);
    assert.deepEqual(
      kit.data.offerings.items.map((i) => [i.name, i.price]),
      [
        ['Check-ups', '$99'],
        ['Braces', ''],
      ],
      'a product that was already there keeps its details',
    );

    const competitors = await owner.get(res.headers.location).expect(200);
    assert.match(competitors.text, /Your competitors/);
    assert.match(competitors.text, /name="next" value="setup"/);

    const before = added.length;
    const go = await owner.post(`${base}/setup/competitors`).expect(303);
    assert.match(go.headers.location, /\/setup\/questions\?since=\d+&n=0$/);
    assert.equal(
      added
        .slice(before)
        .map((j) => j.name)
        .join(),
      'questions.generate',
    );
    const waiting = await owner.get(go.headers.location).expect(200);
    assert.match(waiting.text, /Writing your questions/);

    await scoped.prompts.importMany(project.id, questions(30), { limit: 50 });
    const done = await owner.get(`${base}/setup/questions`).expect(200);
    assert.match(done.text, /A few of them/);
    assert.match(done.text, /and 22 more/);
    for (const step of ['connect', 'start']) {
      const page = await owner.get(`${base}/setup/${step}`).expect(200);
      assert.match(page.text, /aria-current="step"/);
    }
    const start = await owner.get(`${base}/setup/start`).expect(200);
    assert.match(start.text, /Version 2 saved/);
    assert.match(start.text, /30 in use/);
    await owner.get(`${base}/setup/nonsense`).expect(404);
    const index = await owner.get(`${base}/setup`).expect(302);
    assert.equal(index.headers.location, `${base}/setup/brand`);
  });

  test('a stale or invalid brand step is explained and nothing is saved over a newer version', async () => {
    const { owner, base, scoped, project } = await withProject();
    await owner.post(`${base}/brand`, kitFields({ brandName: 'Saved First' })).expect(303);
    const stale = await owner
      .post(`${base}/setup/brand`, {
        expectedVersion: '',
        brandName: 'Too Late',
        products: '',
      })
      .expect(409);
    assert.match(stale.text, /Someone saved a newer version first/);
    assert.equal(
      (await scoped.brandKits.current(project.id)).data.identity.brandName,
      'Saved First',
    );

    const empty = await owner
      .post(`${base}/setup/brand`, { expectedVersion: '1', brandName: ' ', products: '' })
      .expect(422);
    assert.match(empty.text, /This step wasn’t saved/);
  });

  test('the project page keeps pointing at setup until the kit and questions are done', async () => {
    const { owner, base, scoped, project } = await withProject();
    assert.match((await owner.get(base).expect(200)).text, /Setup isn’t finished/);
    await scoped.brandKits.save(project.id, {
      kit: { identity: { brandName: 'Screens Dental' } },
      source: 'edited',
      expectedVersion: null,
    });
    assert.match((await owner.get(base).expect(200)).text, /Setup isn’t finished/);
  });

  test('a viewer can follow the steps but not change them', async () => {
    const { members, base } = await withProject();
    const page = await members.viewer.get(`${base}/setup/brand`).expect(200);
    assert.doesNotMatch(page.text, /Looks right/);
    await members.viewer.post(`${base}/setup/brand`, { brandName: 'x', products: '' }).expect(403);
    await members.viewer.post(`${base}/setup/competitors`).expect(403);
  });
});

describe('client seats', () => {
  async function withSeat() {
    const t = await withProject();
    // A second project, so "only the projects I choose" has something to leave out.
    const second = await t.owner
      .post(`${t.orgBase}/projects`, {
        website: site(),
        name: 'Second Project',
        country: 'US',
        language: 'en',
      })
      .expect(303);
    const secondPid = second.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
    const seat = t.members.viewer;
    const membership = await t.scoped.memberships.getByUser(seat.user.id);
    return {
      ...t,
      seat,
      membership,
      secondPid,
      accessUrl: `${t.orgBase}/members/${membership.id}/access`,
    };
  }

  test('the team page shows who sees what, and links to change it for anyone who can be limited', async () => {
    const { owner, orgBase, membership } = await withSeat();
    const page = await owner.get(`${orgBase}/settings`).expect(200);
    assert.match(page.text, />Can see</);
    assert.match(page.text, /Every project/);
    assert.ok(page.text.includes(`/members/${membership.id}/access`));
    assert.equal(
      (page.text.match(/\/members\/\d+\/access/g) ?? []).length,
      2,
      'the editor and the viewer, not the owner',
    );
  });

  test('limiting a member to one project: they see that project and get a plain 404 for the other', async () => {
    const { owner, seat, scoped, membership, accessUrl, orgBase, base, secondPid, project } =
      await withSeat();
    const form = await owner.get(accessUrl).expect(200);
    assert.match(form.text, /Only the projects I choose/);
    assert.match(form.text, /Screens Dental/);
    assert.match(form.text, /Second Project/);

    const res = await owner
      .post(accessUrl, { access: 'selected', project: [project.public_id] })
      .expect(303);
    assert.match(res.headers.location, /\/settings\?notice=access-saved$/);
    const [row] = (await scoped.memberships.list()).filter((m) => m.id === membership.id);
    assert.equal(row.project_access, 'selected');
    assert.deepEqual(row.projectIds, [project.id]);

    const overview = await seat.get(orgBase).expect(200);
    assert.match(overview.text, /Screens Dental/);
    assert.doesNotMatch(overview.text, /Second Project/);
    await seat.get(base).expect(200);
    await seat.get(`${orgBase}/projects/${secondPid}`).expect(404);
    await seat.get(`${orgBase}/projects/${secondPid}/brand`).expect(404);
    await seat.get(`${orgBase}/projects/${secondPid}/questions`).expect(404);

    // And back to everything.
    await owner.post(accessUrl, { access: 'all' }).expect(303);
    await seat.get(`${orgBase}/projects/${secondPid}`).expect(200);
  });

  test('a choice that makes no sense is explained and changes nothing', async () => {
    const { owner, scoped, membership, accessUrl, base } = await withSeat();
    const none = await owner.post(accessUrl, { access: 'selected' }).expect(422);
    assert.match(none.text, /Choose at least one project/);
    const foreign = await withProject();
    const planted = await owner
      .post(accessUrl, { access: 'selected', project: [foreign.project.public_id] })
      .expect(422);
    assert.match(planted.text, /Choose at least one project/);
    const [row] = (await scoped.memberships.list()).filter((m) => m.id === membership.id);
    assert.equal(row.project_access, 'all');
    assert.ok(base);
  });

  test('owners and admins always see every project, and the page says so', async () => {
    const { owner, orgBase, scoped, project } = await withSeat();
    const adminUser = await h.signedIn();
    const admin = await scoped.memberships.add({ userId: adminUser.user.id, role: 'admin' });
    const url = `${orgBase}/members/${admin.id}/access`;
    const page = await owner.get(url).expect(200);
    assert.match(page.text, /Sees every project/);
    const refused = await owner
      .post(url, { access: 'selected', project: [project.public_id] })
      .expect(422);
    assert.match(refused.text, /always see every project/);
  });

  test('only people who manage the team can change access; another organization’s member is a 404', async () => {
    const mine = await withSeat();
    const theirs = await withSeat();
    await mine.members.editor.get(mine.accessUrl).expect(403);
    await mine.members.editor.post(mine.accessUrl, { access: 'all' }).expect(403);
    await mine.owner.get(theirs.accessUrl).expect(404);
    await mine.owner.post(theirs.accessUrl, { access: 'all' }).expect(404);
    await mine.owner.get(`${mine.orgBase}/members/abc/access`).expect(404);
  });

  test('an invitation can limit the new member to chosen projects, and refuses a limit that makes no sense', async () => {
    const { owner, scoped, orgBase, project } = await withSeat();
    const email = `client-${Date.now().toString(36)}@acme-corp.test`;
    const page = await owner.get(`${orgBase}/settings`).expect(200);
    assert.match(page.text, /Projects they can see/);

    await owner
      .post(`${orgBase}/invitations`, {
        email,
        role: 'viewer',
        access: 'selected',
        project: [project.public_id],
      })
      .expect(303);
    const [invitation] = (await scoped.invitations.listPending()).filter((i) => i.email === email);
    assert.equal(invitation.project_access, 'selected');
    assert.deepEqual(invitation.project_ids, [String(project.id)]);

    const none = await owner
      .post(`${orgBase}/invitations`, { email: `x-${email}`, role: 'viewer', access: 'selected' })
      .expect(422);
    assert.match(none.text, /Choose at least one project/);
    const admin = await owner
      .post(`${orgBase}/invitations`, {
        email: `y-${email}`,
        role: 'admin',
        access: 'selected',
        project: [project.public_id],
      })
      .expect(422);
    assert.match(admin.text, /always see every project/);
    assert.equal(
      (await scoped.invitations.listPending()).filter((i) => i.email.endsWith(email)).length,
      1,
    );
  });
});

describe('the engines of a project', () => {
  test('an editor switches engines on and off, at least one stays on, and viewers only see them', async () => {
    const { owner, members, base, scoped, project } = await withProject();
    const page = await owner.get(base).expect(200);
    assert.match(page.text, /Save engines/);
    assert.match(page.text, /name="engine" value="chatgpt"/);

    const saved = await owner
      .post(`${base}/engines`, { engine: ['chatgpt', 'google_aio'] })
      .expect(303);
    assert.match(saved.headers.location, /notice=engines-saved$/);
    const on = (await scoped.projectEngines.list(project.id)).filter((e) => e.enabled);
    assert.deepEqual(on.map((e) => e.engine_code).sort(), ['chatgpt', 'google_aio']);

    const none = await owner.post(`${base}/engines`, {}).expect(303);
    assert.match(none.headers.location, /engines-none/);
    const bad = await owner.post(`${base}/engines`, { engine: ['nonsense'] }).expect(303);
    assert.match(bad.headers.location, /engines-invalid/);
    assert.equal((await scoped.projectEngines.list(project.id)).filter((e) => e.enabled).length, 2);

    const view = await members.viewer.get(base).expect(200);
    assert.doesNotMatch(view.text, /Save engines/);
    await members.viewer.post(`${base}/engines`, { engine: ['chatgpt'] }).expect(403);
  });

  test('another organization’s project cannot have its engines changed', async () => {
    const mine = await withProject();
    const theirs = await withProject();
    await mine.owner.post(`${theirs.base}/engines`, { engine: ['chatgpt'] }).expect(404);
  });
});
