import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/** The Prompt Manager repository (Milestone 3, task 3.08). */
const db = connectTestDb();
const fx = fixtures(db);

let A;
let n = 0;
const refuses = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof DomainError && e.code === code);

async function newProject(extra = {}) {
  return A.scoped.projects.create({
    name: 'Prompt Dental',
    domain: `prompts-${Date.now().toString(36)}-${n++}.example.test`,
    country: 'US',
    language: 'en',
    ...extra,
  });
}
const q = (text, extra = {}) => ({ text, intent: 'discovery', ...extra });

before(async () => {
  A = await fx.org();
});

after(async () => {
  await fx.cleanup();
  await db.close();
});

describe('adding a question', () => {
  test('stores it in the project’s locale with its topic, and lists it', async () => {
    const p = await newProject({ city: 'Austin' });
    const { prompt, restored, similar } = await A.scoped.prompts.add(
      p.id,
      q('What is the best family dentist in Austin?', {
        clusterName: ' Finding a dentist ',
        searchQuery: 'best family dentist austin',
        priority: 1,
      }),
      { actorUserId: A.owner.id },
    );
    assert.equal(restored, false);
    assert.deepEqual(similar, []);
    assert.equal(prompt.country, 'US');
    assert.equal(prompt.city, 'Austin');
    assert.equal(prompt.source, 'manual');
    assert.equal(prompt.text_hash.length, 32);

    const list = await A.scoped.prompts.list(p.id);
    assert.deepEqual(
      list.map((x) => [x.text, x.clusterName, x.priority]),
      [['What is the best family dentist in Austin?', 'Finding a dentist', 1]],
    );
    assert.equal((await A.scoped.prompts.clusters(p.id)).length, 1);
  });

  test('the same question written differently is a duplicate; a near one is flagged, not refused', async () => {
    const p = await newProject();
    await A.scoped.prompts.add(p.id, q('Best family dentist in Austin?'));
    await refuses(A.scoped.prompts.add(p.id, q('  best FAMILY dentist in austin ')), 'DUPLICATE');
    const { similar } = await A.scoped.prompts.add(p.id, q('best family dentist austin tx'));
    assert.equal(similar.length, 1);
    assert.equal(similar[0].text, 'Best family dentist in Austin?');
    assert.equal((await A.scoped.prompts.list(p.id)).length, 2);
  });

  test('bad input is explained: blank, too short, unknown intent, bad priority', async () => {
    const p = await newProject();
    await assert.rejects(
      A.scoped.prompts.add(p.id, q('')),
      (e) => e.code === 'INVALID_QUESTION' && /Write the question/.test(e.message),
    );
    await refuses(A.scoped.prompts.add(p.id, q('dentist')), 'INVALID_QUESTION');
    await refuses(
      A.scoped.prompts.add(p.id, q('a fine question here', { intent: 'x' })),
      'INVALID_INTENT',
    );
    await refuses(
      A.scoped.prompts.add(p.id, q('a fine question here', { priority: 9 })),
      'INVALID_PRIORITY',
    );
    assert.equal((await A.scoped.prompts.list(p.id)).length, 0);
  });

  test('the plan’s limit on active questions is enforced at save, and says so', async () => {
    const p = await newProject();
    await A.scoped.prompts.add(p.id, q('First question about dentists'), { limit: 2 });
    await A.scoped.prompts.add(p.id, q('Second question about dentists'), { limit: 2 });
    await refuses(
      A.scoped.prompts.add(p.id, q('Third question about dentists'), { limit: 2 }),
      'PLAN_LIMIT',
    );
    assert.equal((await A.scoped.prompts.list(p.id)).length, 2);
  });

  test('an archived question that is asked again is brought back, not duplicated', async () => {
    const p = await newProject();
    const { prompt } = await A.scoped.prompts.add(p.id, q('Is flossing really needed daily?'));
    await A.scoped.prompts.setStatus(prompt.id, 'archived');
    assert.equal((await A.scoped.prompts.list(p.id)).length, 0);
    const again = await A.scoped.prompts.add(p.id, q('is flossing really needed daily'));
    assert.equal(again.restored, true);
    assert.equal(again.prompt.id, prompt.id);
    assert.equal(again.prompt.status, 'active');
  });
});

describe('editing', () => {
  test('new wording archives the old question and links its replacement', async () => {
    const p = await newProject();
    const { prompt: old } = await A.scoped.prompts.add(
      p.id,
      q('Best dentist near the park?', { priority: 1 }),
    );
    const now = await A.scoped.prompts.edit(
      old.id,
      { text: 'Best dentist near Zilker Park?' },
      { actorUserId: A.owner.id },
    );
    assert.notEqual(now.id, old.id);
    assert.equal(now.replaces_prompt_id, old.id);
    assert.equal(now.priority, 1);
    assert.equal(now.status, 'active');
    const archived = await A.scoped.prompts.list(p.id, { status: 'archived' });
    assert.deepEqual(
      archived.map((x) => x.id),
      [old.id],
    );
    assert.deepEqual(
      (await A.scoped.prompts.list(p.id)).map((x) => x.id),
      [now.id],
    );
    await refuses(A.scoped.prompts.edit(old.id, { priority: 3 }), 'ARCHIVED');
  });

  test('anything but the wording changes in place and keeps the same row', async () => {
    const p = await newProject();
    const { prompt } = await A.scoped.prompts.add(p.id, q('How do I stop my gums bleeding?'));
    const same = await A.scoped.prompts.edit(prompt.id, {
      priority: 3,
      intent: 'problem_solution',
      clusterName: 'Gum health',
    });
    assert.equal(same.id, prompt.id);
    assert.equal(same.priority, 3);
    assert.equal(same.intent, 'problem_solution');
    assert.equal((await A.scoped.prompts.list(p.id))[0].clusterName, 'Gum health');
    // Capitalisation alone is not new wording either.
    const still = await A.scoped.prompts.edit(prompt.id, {
      text: 'how do i stop my gums bleeding',
    });
    assert.equal(still.id, prompt.id);
  });

  test('rewording into a question that already exists is refused and changes nothing', async () => {
    const p = await newProject();
    await A.scoped.prompts.add(p.id, q('Which toothpaste is best for sensitive teeth?'));
    const { prompt } = await A.scoped.prompts.add(p.id, q('What toothpaste helps sensitivity?'));
    await refuses(
      A.scoped.prompts.edit(prompt.id, { text: 'which toothpaste is best for sensitive teeth' }),
      'DUPLICATE',
    );
    assert.equal((await A.scoped.prompts.list(p.id)).length, 2);
  });
});

describe('turning questions on and off', () => {
  test('pause, resume and archive; resuming counts against the limit', async () => {
    const p = await newProject();
    const { prompt: one } = await A.scoped.prompts.add(p.id, q('Question number one here'), {
      limit: 1,
    });
    const paused = await A.scoped.prompts.setStatus(one.id, 'paused');
    assert.equal(paused.paused_reason, 'user');
    const { prompt: two } = await A.scoped.prompts.add(p.id, q('Question number two here'), {
      limit: 1,
    });
    await refuses(A.scoped.prompts.setStatus(one.id, 'active', { limit: 1 }), 'PLAN_LIMIT');
    await A.scoped.prompts.setStatus(two.id, 'archived');
    const resumed = await A.scoped.prompts.setStatus(one.id, 'active', { limit: 1 });
    assert.equal(resumed.paused_reason, null);
    await refuses(A.scoped.prompts.setStatus(one.id, 'deleted'), 'INVALID_STATUS');
  });

  test('the list can be filtered by status, intent and words', async () => {
    const p = await newProject();
    await A.scoped.prompts.add(p.id, q('Best implants clinic around here'));
    const { prompt } = await A.scoped.prompts.add(p.id, {
      text: 'How much do braces cost for adults',
      intent: 'transactional',
    });
    await A.scoped.prompts.setStatus(prompt.id, 'paused');
    assert.equal((await A.scoped.prompts.list(p.id, { status: 'paused' })).length, 1);
    assert.equal((await A.scoped.prompts.list(p.id, { intent: 'discovery' })).length, 1);
    assert.equal((await A.scoped.prompts.list(p.id, { q: 'braces' })).length, 1);
    assert.equal((await A.scoped.prompts.list(p.id, { q: 'nothing like this' })).length, 0);
  });
});

describe('importing', () => {
  test('every row gets an answer, in order, and the good ones are saved', async () => {
    const p = await newProject();
    await A.scoped.prompts.add(p.id, q('Already tracked question here'));
    const results = await A.scoped.prompts.importMany(
      p.id,
      [
        q('A brand new question about braces'),
        q('already tracked question here'),
        q(''),
        q('One more new question about crowns', { intent: 'nonsense' }),
        q('A brand new question about braces!'),
        q('Final good question about whitening', { clusterName: 'Cosmetic' }),
      ],
      { actorUserId: A.owner.id },
    );
    assert.deepEqual(
      results.map((r) => [r.row, r.result]),
      [
        [1, 'added'],
        [2, 'duplicate'],
        [3, 'invalid'],
        [4, 'invalid'],
        [5, 'duplicate'],
        [6, 'added'],
      ],
    );
    assert.match(results[2].error, /Write the question/);
    assert.equal((await A.scoped.prompts.list(p.id)).length, 3);
    assert.equal(
      (await A.scoped.prompts.list(p.id)).find((x) => x.clusterName).clusterName,
      'Cosmetic',
    );
    assert.ok(results.filter((r) => r.prompt).every((r) => r.prompt.source === 'imported'));
  });

  test('rows over the plan limit say so instead of vanishing', async () => {
    const p = await newProject();
    const results = await A.scoped.prompts.importMany(
      p.id,
      [
        q('First imported question here'),
        q('Second imported question here'),
        q('Third imported question here'),
      ],
      { limit: 2 },
    );
    assert.deepEqual(
      results.map((r) => r.result),
      ['added', 'added', 'over_limit'],
    );
    assert.equal((await A.scoped.prompts.list(p.id)).length, 2);
  });

  test('a file of more than 500 rows is refused whole', async () => {
    const p = await newProject();
    const rows = Array.from({ length: 501 }, (_, i) => q(`Question number ${i} about dentists`));
    await refuses(A.scoped.prompts.importMany(p.id, rows), 'TOO_MANY_ROWS');
    await refuses(A.scoped.prompts.importMany(p.id, 'nope'), 'TOO_MANY_ROWS');
  });

  test('the activity log records the import once, not once per row', async () => {
    const p = await newProject();
    await A.scoped.prompts.importMany(p.id, [
      q('Logged question one here'),
      q('Logged question two here'),
    ]);
    const log = (await A.scoped.activity.recent({ limit: 20 })).filter(
      (l) => l.action === 'prompt.imported',
    );
    assert.ok(log.some((l) => l.target_id === p.id && /2 questions added/.test(l.summary)));
  });
});
