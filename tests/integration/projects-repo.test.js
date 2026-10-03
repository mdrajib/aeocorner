import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DomainError } from '../../src/db/index.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';

/** Projects, their engines, and the brand and competitors (Milestone 3, tasks 3.02, 3.03 and 3.07). */
const db = connectTestDb();
const fx = fixtures(db);

let A;
const refuses = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof DomainError && e.code === code);

let n = 0;
const site = () => `proj-${Date.now().toString(36)}-${n++}.example.test`;
const input = (extra = {}) => ({
  name: 'Acme Dental',
  domain: site(),
  country: 'us',
  language: 'en',
  ...extra,
});

before(async () => {
  A = await fx.org();
});

after(async () => {
  await fx.cleanup();
  await db.close();
});

describe('creating a project', () => {
  test('makes the project, its brand entity and every live engine, in one step', async () => {
    const p = await A.scoped.projects.create({ ...input(), createdByUserId: A.owner.id });
    assert.equal(p.status, 'onboarding');
    assert.equal(p.country, 'US');
    assert.match(p.public_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(p.weekly_slot_hour >= 0 && p.weekly_slot_hour < 168);

    const entities = await A.scoped.entities.list(p.id);
    assert.equal(entities.length, 1);
    assert.equal(entities[0].kind, 'brand');
    assert.equal(entities[0].primary_domain, p.domain);
    // The generated column is what makes "one brand per project" a database rule.
    const brandRow = await fx.entityRow(entities[0].id);
    assert.equal(brandRow.brand_project_id, p.id);

    const engines = await A.scoped.projectEngines.list(p.id);
    assert.deepEqual(engines.map((e) => e.engine_code).sort(), [
      'chatgpt',
      'gemini',
      'google_aio',
      'perplexity',
    ]);
    assert.ok(engines.every((e) => e.enabled));
  });

  test('refuses a bad name, a bad domain and a second live project on the same domain', async () => {
    await refuses(A.scoped.projects.create(input({ name: 'A' })), 'INVALID_PROJECT');
    await refuses(A.scoped.projects.create(input({ domain: 'not a domain' })), 'INVALID_DOMAIN');
    const first = input();
    await A.scoped.projects.create(first);
    await refuses(A.scoped.projects.create(first), 'DOMAIN_TAKEN');
  });

  test('the same domain is allowed in another organization', async () => {
    const other = await fx.org();
    const shared = input();
    await A.scoped.projects.create(shared);
    await other.scoped.projects.create(shared);
  });

  test('an audit prefills a project only through its secret address', async () => {
    const audit = await fx.audit();
    const p = await A.scoped.projects.create({ ...input(), sourceAuditPublicId: audit.public_id });
    assert.equal(p.source_audit_id, audit.id);
    const brand = (await A.scoped.entities.list(p.id))[0];
    assert.equal(brand.source, 'audit');
    await refuses(
      A.scoped.projects.create({ ...input(), sourceAuditPublicId: '0'.repeat(26) }),
      'NOT_FOUND',
    );
  });

  test('creating from an audit claims it for the organization and its first project, once', async () => {
    const audit = await fx.audit();
    assert.equal(audit.org_id, null);
    const first = await A.scoped.projects.create({
      ...input(),
      sourceAuditPublicId: audit.public_id,
    });
    const claimed = await db.audits.get(audit.id);
    assert.equal(claimed.org_id, A.org.id);
    assert.equal(claimed.project_id, first.id);

    // A second project from the same audit (another website of the same business) does not take it over.
    const second = await A.scoped.projects.create({
      ...input(),
      sourceAuditPublicId: audit.public_id,
    });
    assert.equal(second.source_audit_id, audit.id);
    assert.equal((await db.audits.get(audit.id)).project_id, first.id);
  });
});

describe('editing and archiving', () => {
  test('an edit changes only what it names, and renaming the project renames its brand', async () => {
    const p = await A.scoped.projects.create(input());
    const updated = await A.scoped.projects.update(p.id, { city: ' Austin ', name: 'Acme Smiles' });
    assert.equal(updated.city, 'Austin');
    assert.equal(updated.language, 'en');
    assert.equal(updated.domain, p.domain, 'the domain never changes');
    const brand = (await A.scoped.entities.list(p.id))[0];
    assert.equal(brand.name, 'Acme Smiles');
    assert.equal(brand.name_normalized, 'acme smiles');
    // The brand is still the project's one brand after the update.
    assert.equal((await fx.entityRow(brand.id)).brand_project_id, p.id);
    await refuses(A.scoped.projects.update(p.id, { cadence: 'hourly' }), 'INVALID_PROJECT');
  });

  test('archiving removes it from lists, frees the domain and writes the activity log', async () => {
    const data = input();
    const p = await A.scoped.projects.create(data);
    await A.scoped.projects.archive(p.id, { actorUserId: A.owner.id });
    assert.equal(await A.scoped.projects.get(p.id), null);
    assert.equal(await A.scoped.projects.getByPublicId(p.public_id), null);
    assert.ok(!(await A.scoped.projects.list()).some((x) => x.id === p.id));
    await refuses(A.scoped.projects.archive(p.id), 'NOT_FOUND');
    await refuses(A.scoped.projects.update(p.id, { city: 'X' }), 'NOT_FOUND');
    const again = await A.scoped.projects.create(data);
    assert.notEqual(again.id, p.id);
    const log = await A.scoped.activity.recent({ limit: 50 });
    assert.ok(log.some((l) => l.action === 'project.archived' && l.target_id === p.id));
  });

  test('a client seat sees only its selected projects', async () => {
    const one = await A.scoped.projects.create(input());
    const two = await A.scoped.projects.create(input());
    const listed = await A.scoped.projects.list({ onlyIds: [one.id] });
    assert.deepEqual(
      listed.map((x) => x.id),
      [one.id],
    );
    assert.ok((await A.scoped.projects.list()).some((x) => x.id === two.id));
    assert.deepEqual(await A.scoped.projects.list({ onlyIds: [] }), []);
  });
});

describe('engines', () => {
  test('switches engines on and off, keeps one on, and refuses a catalog engine that is not live', async () => {
    const p = await A.scoped.projects.create(input());
    const rows = await A.scoped.projectEngines.setEnabled(p.id, ['chatgpt', 'google_aio']);
    assert.deepEqual(
      rows.filter((r) => r.enabled).map((r) => r.engine_code),
      ['chatgpt', 'google_aio'],
    );
    await refuses(A.scoped.projectEngines.setEnabled(p.id, []), 'NO_ENGINES');
    await refuses(A.scoped.projectEngines.setEnabled(p.id, ['claude']), 'UNKNOWN_ENGINE');
    await refuses(A.scoped.projectEngines.setEnabled(p.id, ['nonsense']), 'UNKNOWN_ENGINE');
  });
});

describe('brand, competitors and aliases', () => {
  test('adds competitors, and refuses the same name written differently', async () => {
    const p = await A.scoped.projects.create(input());
    const rival = await A.scoped.entities.addCompetitor(p.id, {
      name: 'Rival Smiles, Inc.',
      primaryDomain: 'rival.example.test',
    });
    assert.equal(rival.kind, 'competitor');
    assert.equal((await fx.entityRow(rival.id)).brand_project_id, null);
    await refuses(A.scoped.entities.addCompetitor(p.id, { name: 'RIVAL smiles inc' }), 'DUPLICATE');
    await refuses(A.scoped.entities.addCompetitor(p.id, { name: 'X' }), 'INVALID_NAME');
    await refuses(
      A.scoped.entities.addCompetitor(p.id, { name: 'Good Name', primaryDomain: 'no good' }),
      'INVALID_DOMAIN',
    );
    const all = await A.scoped.entities.list(p.id);
    assert.deepEqual(
      all.map((e) => e.kind),
      ['brand', 'competitor'],
    );
  });

  test('a brand can be renamed but never switched off, and a confirmed discovered brand becomes a competitor', async () => {
    const p = await A.scoped.projects.create(input());
    const brand = (await A.scoped.entities.list(p.id))[0];
    await refuses(A.scoped.entities.setStatus(brand.id, 'ignored'), 'BRAND_IS_FIXED');
    const renamed = await A.scoped.entities.update(brand.id, { name: 'New Brand Name' });
    assert.equal(renamed.name_normalized, 'new brand name');

    const found = await fx.entity(p, { kind: 'discovered', name: 'Found Co', status: 'suggested' });
    const confirmed = await A.scoped.entities.setStatus(found.id, 'active');
    assert.equal(confirmed.kind, 'competitor');
    const dropped = await A.scoped.entities.setStatus(confirmed.id, 'ignored');
    assert.equal(dropped.status, 'ignored');
    await refuses(A.scoped.entities.setStatus(confirmed.id, 'deleted'), 'INVALID_STATUS');
  });

  test('aliases are stored normalized, are unique per entity, and can be removed', async () => {
    const p = await A.scoped.projects.create(input());
    const brand = (await A.scoped.entities.list(p.id))[0];
    const alias = await A.scoped.entities.addAlias(brand.id, {
      kind: 'name',
      value: 'Acme Dental Co.',
    });
    assert.equal(alias.value_normalized, 'acme dental co');
    await refuses(
      A.scoped.entities.addAlias(brand.id, { kind: 'name', value: 'ACME dental co' }),
      'DUPLICATE',
    );
    await A.scoped.entities.addAlias(brand.id, {
      kind: 'exclude',
      value: 'Acme Corp (the roadrunner one)',
    });
    await refuses(
      A.scoped.entities.addAlias(brand.id, { kind: 'nope', value: 'xx' }),
      'INVALID_KIND',
    );
    assert.equal((await A.scoped.entities.list(p.id))[0].aliases.length, 2);
    await A.scoped.entities.removeAlias(alias.id);
    assert.equal((await A.scoped.entities.list(p.id))[0].aliases.length, 1);
    await refuses(A.scoped.entities.removeAlias(alias.id), 'NOT_FOUND');
  });
});

describe('suggested competitors', () => {
  test('are stored as suggestions until confirmed, and the status must be one we allow', async () => {
    const p = await A.scoped.projects.create(input());
    const suggested = await A.scoped.entities.addCompetitor(p.id, {
      name: 'Suggested Smiles',
      source: 'audit',
      status: 'suggested',
    });
    assert.equal(suggested.status, 'suggested');
    assert.equal(suggested.source, 'audit');
    const tracked = await A.scoped.entities.setStatus(suggested.id, 'active');
    assert.equal(tracked.status, 'active');
    await refuses(
      A.scoped.entities.addCompetitor(p.id, { name: 'Sneaky Smiles', status: 'ignored' }),
      'INVALID_STATUS',
    );
    // The default is unchanged: a competitor a person types in is tracked at once.
    const typed = await A.scoped.entities.addCompetitor(p.id, { name: 'Typed Smiles' });
    assert.equal(typed.status, 'active');
  });
});

describe('the Brand Kit: every save is a new version', () => {
  const kitFor = (name, extra = {}) => ({
    identity: { brandName: name, domains: [], ...extra },
  });

  test('the first save is version 1; an edit is version 2 and version 1 is kept as it was', async () => {
    const p = await A.scoped.projects.create(input());
    assert.equal(await A.scoped.brandKits.current(p.id), null);
    const v1 = await A.scoped.brandKits.save(p.id, {
      kit: kitFor('Acme Dental', { category: 'dentist' }),
      source: 'extracted',
      expectedVersion: null,
    });
    assert.equal(v1.version, 1);
    const v2 = await A.scoped.brandKits.save(p.id, {
      kit: kitFor('Acme Dental', { category: 'family dentist' }),
      source: 'edited',
      expectedVersion: 1,
      actorUserId: A.owner.id,
    });
    assert.equal(v2.version, 2);
    assert.equal((await A.scoped.brandKits.current(p.id)).data.identity.category, 'family dentist');
    assert.equal((await A.scoped.brandKits.get(p.id, 1)).data.identity.category, 'dentist');
    assert.equal((await A.scoped.projects.get(p.id)).brand_profile_version, 2);

    const history = await A.scoped.brandKits.history(p.id);
    assert.deepEqual(
      history.map((h) => [h.version, h.source]),
      [
        [2, 'edited'],
        [1, 'extracted'],
      ],
    );
    assert.equal(history[0].author.email, A.owner.email);
    assert.equal(history[1].author, null);
  });

  test('a save from an out-of-date screen writes nothing', async () => {
    const p = await A.scoped.projects.create(input());
    await A.scoped.brandKits.save(p.id, {
      kit: kitFor('One'),
      source: 'extracted',
      expectedVersion: null,
    });
    await A.scoped.brandKits.save(p.id, {
      kit: kitFor('Two'),
      source: 'edited',
      expectedVersion: 1,
    });
    await refuses(
      A.scoped.brandKits.save(p.id, { kit: kitFor('Stale'), source: 'edited', expectedVersion: 1 }),
      'STALE_VERSION',
    );
    await refuses(
      A.scoped.brandKits.save(p.id, {
        kit: kitFor('Stale'),
        source: 'edited',
        expectedVersion: null,
      }),
      'STALE_VERSION',
    );
    assert.equal((await A.scoped.brandKits.history(p.id)).length, 2);
  });

  test('two saves at the same moment: exactly one wins', async () => {
    const p = await A.scoped.projects.create(input());
    await A.scoped.brandKits.save(p.id, {
      kit: kitFor('Race'),
      source: 'extracted',
      expectedVersion: null,
    });
    const results = await Promise.allSettled(
      ['Left', 'Right'].map((side) =>
        A.scoped.brandKits.save(p.id, {
          kit: kitFor(`Race ${side}`),
          source: 'edited',
          expectedVersion: 1,
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await A.scoped.brandKits.history(p.id)).length, 2);
  });

  test('a bad kit or an unknown source is refused', async () => {
    const p = await A.scoped.projects.create(input());
    await refuses(
      A.scoped.brandKits.save(p.id, {
        kit: { identity: { brandName: ' ' } },
        source: 'edited',
        expectedVersion: null,
      }),
      'INVALID_KIT',
    );
    await refuses(
      A.scoped.brandKits.save(p.id, { kit: kitFor('Ok'), source: 'magic', expectedVersion: null }),
      'INVALID_SOURCE',
    );
    assert.equal(await A.scoped.brandKits.current(p.id), null);
  });

  test('the brand entity follows the kit: its name, aliases and domains; hand-made rules stay', async () => {
    const p = await A.scoped.projects.create(input());
    const brand = (await A.scoped.entities.list(p.id))[0];
    await A.scoped.entities.addAlias(brand.id, { kind: 'exclude', value: 'Acme Roadrunner Corp' });
    await A.scoped.brandKits.save(p.id, {
      kit: kitFor('Acme Smiles', {
        aliases: ['Acme', 'AcmeSmiles'],
        domains: ['acme.example.test'],
      }),
      source: 'extracted',
      expectedVersion: null,
    });
    let now = (await A.scoped.entities.list(p.id))[0];
    assert.equal(now.name, 'Acme Smiles');
    assert.equal((await A.scoped.projects.get(p.id)).name, 'Acme Smiles');
    const byKind = (kind) =>
      now.aliases
        .filter((a) => a.kind === kind)
        .map((a) => a.value_normalized)
        .sort();
    assert.deepEqual(byKind('name'), ['acme', 'acmesmiles']);
    assert.deepEqual(byKind('domain'), ['acme.example.test']);
    assert.deepEqual(byKind('exclude'), ['acme roadrunner corp']);

    await A.scoped.brandKits.save(p.id, {
      kit: kitFor('Acme Smiles', { aliases: ['Acme'], domains: [] }),
      source: 'edited',
      expectedVersion: 1,
    });
    now = (await A.scoped.entities.list(p.id))[0];
    assert.deepEqual(byKind('name'), ['acme']);
    assert.deepEqual(byKind('domain'), []);
    assert.deepEqual(byKind('exclude'), ['acme roadrunner corp']);
    assert.equal((await fx.entityRow(now.id)).brand_project_id, p.id);
  });
});

describe('proving the site is theirs', () => {
  test('a new project has a token, the token never changes, and it starts unverified', async () => {
    const p = await A.scoped.projects.create(input());
    const first = await A.scoped.projects.verification(p.id);
    assert.match(first.token, /^[0-9a-f]{32}$/);
    assert.equal(first.verifiedAt, null);
    assert.equal(first.method, null);
    assert.equal((await A.scoped.projects.verification(p.id)).token, first.token);
  });

  test('a project from before verification existed gets its token when it first asks', async () => {
    const p = await fx.project(A.org.id, 'Old project');
    assert.equal(p.domain_verify_token, null);
    const v = await A.scoped.projects.verification(p.id);
    assert.match(v.token, /^[0-9a-f]{32}$/);
    assert.equal((await A.scoped.projects.verification(p.id)).token, v.token);
  });

  test('marking it verified records how and when, once, and writes the activity log', async () => {
    const p = await A.scoped.projects.create(input());
    const done = await A.scoped.projects.markVerified(p.id, 'file', { actorUserId: A.owner.id });
    assert.ok(done.domain_verified_at);
    assert.equal(done.domain_verify_method, 'file');
    const again = await A.scoped.projects.markVerified(p.id, 'dns');
    assert.equal(again.domain_verify_method, 'file', 'the first proof stands');
    assert.deepEqual(again.domain_verified_at, done.domain_verified_at);
    const v = await A.scoped.projects.verification(p.id);
    assert.equal(v.method, 'file');
    await refuses(A.scoped.projects.markVerified(p.id, 'carrier-pigeon'), 'INVALID_METHOD');
    const log = await A.scoped.activity.recent({ limit: 50 });
    assert.equal(
      log.filter((l) => l.action === 'project.domain_verified' && l.target_id === p.id).length,
      1,
    );
  });
});
