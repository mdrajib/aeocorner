import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWikidata, WikidataError } from './wikidata.js';

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** A fake Wikidata: answers each action from a table, and remembers what it was asked. */
function fake(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const params = Object.fromEntries(new URL(url).searchParams);
    calls.push({ params, init });
    const handler = handlers[params.action];
    if (!handler) throw new Error(`unexpected action ${params.action}`);
    return handler(params);
  };
  return { fetchImpl, calls };
}

const entity = (id, label, aliases = []) => ({
  id,
  labels: { en: { language: 'en', value: label } },
  aliases: { en: aliases.map((value) => ({ language: 'en', value })) },
  descriptions: { en: { language: 'en', value: 'a company' } },
});

describe('the Wikidata client', () => {
  test('finds candidates by name, reads them, and brings only their website statements', async () => {
    const site = { P856: [{ mainsnak: { datavalue: { value: 'https://acme.test' } } }] };
    const { fetchImpl, calls } = fake({
      wbsearchentities: () => reply({ search: [{ id: 'Q1' }, { id: 'Q2' }, { id: 'junk' }] }),
      wbgetentities: () =>
        reply({ entities: { Q1: entity('Q1', 'Acme'), Q2: entity('Q2', 'Acme Two') } }),
      wbgetclaims: (p) => reply({ claims: p.entity === 'Q1' ? site : {} }),
    });
    const items = await createWikidata({ fetchImpl }).lookup({ names: ['Acme'] });
    assert.deepEqual(
      items.map((i) => i.id),
      ['Q1', 'Q2'],
    );
    assert.equal(items[0].claims.P856.length, 1);
    assert.deepEqual(items[1].claims, {});
    const claimCalls = calls.filter((c) => c.params.action === 'wbgetclaims');
    assert.ok(claimCalls.every((c) => c.params.property === 'P856'));
    assert.match(calls[0].init.headers['user-agent'], /AEOCornerBot/);
  });

  test('sends only the name: no project, domain or customer detail', async () => {
    const { fetchImpl, calls } = fake({
      wbsearchentities: () => reply({ search: [] }),
      wbgetentities: () => reply({ entities: {} }),
    });
    await createWikidata({ fetchImpl }).lookup({ names: ['Acme Dental'] });
    const sent = JSON.stringify(calls.map((c) => c.params));
    assert.ok(sent.includes('Acme Dental'));
    assert.ok(!/acme\.test|org|project/i.test(sent.replace(/Acme Dental/g, '')));
  });

  test('searches at most a few names and reads at most a few candidates', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `Q${i + 10}` }));
    let searches = 0;
    const { fetchImpl, calls } = fake({
      wbsearchentities: () => {
        searches += 1;
        return reply({
          search: many.map((m, i) => ({ id: `Q${Number(m.id.slice(1)) + searches * 100 + i}` })),
        });
      },
      wbgetentities: () => reply({ entities: {} }),
      wbgetclaims: () => reply({ claims: {} }),
    });
    await createWikidata({ fetchImpl }).lookup({ names: ['a1', 'a2', 'a3', 'a4', 'a5'] });
    assert.equal(searches, 3);
    const ids = calls.find((c) => c.params.action === 'wbgetentities').params.ids.split('|');
    assert.ok(ids.length <= 10);
  });

  test('a number that does not exist is a missing item, not an error', async () => {
    const { fetchImpl } = fake({
      wbgetentities: () => reply({ error: { code: 'no-such-entity', info: 'x' } }),
    });
    const items = await createWikidata({ fetchImpl }).lookup({ names: [], givenId: 'Q999999999' });
    assert.equal(items.length, 1);
    assert.notEqual(items[0].missing, undefined);
  });

  test('errors say what happened and never carry the response', async () => {
    const down = createWikidata({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED secret-detail');
      },
    });
    await assert.rejects(
      down.search('Acme'),
      (e) => e instanceof WikidataError && e.code === 'unreachable' && !/secret/.test(e.message),
    );
    const slow = createWikidata({ fetchImpl: async () => reply({}, 429) });
    await assert.rejects(slow.search('Acme'), (e) => e.code === 'quota');
    const broken = createWikidata({ fetchImpl: async () => reply({ unexpected: true }) });
    await assert.rejects(broken.search('Acme'), (e) => e.code === 'bad_response');
    const html = createWikidata({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('<html>');
        },
      }),
    });
    await assert.rejects(html.search('Acme'), (e) => e.code === 'bad_response');
  });
});
