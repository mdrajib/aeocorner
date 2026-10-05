import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CITABLE_CHECKS, citableChecks, QC_CHECKS, scoreDraft } from './content-qc.js';
import { qcView } from './content-studio.js';

const body = (extra = '') =>
  `<h2>How much does it cost?</h2><p>Plans start at 49 dollars a month. ${extra}</p>`;

const byCode = (checks) => Object.fromEntries(checks.map((c) => [c.code, c]));

describe('citableChecks', () => {
  test('a bare page passes nothing and says what to add', () => {
    const out = byCode(
      citableChecks({ bodyHtml: body(), jsonld: null, facts: [], ownDomain: 'acme.com' }),
    );
    for (const c of CITABLE_CHECKS) assert.equal(out[c.code].status, 'warn');
    assert.match(out.author.finding, /never make up a person/);
    assert.match(out.own_figures.finding, /never make one up/);
  });

  test('two outside sources, a date, an author and a figure from the facts pass', () => {
    const html = body(
      '<a href="https://who.int/a">WHO</a> and <a href="https://cdc.gov/b">CDC</a> agree. <a href="https://www.acme.com/x">Ours</a>',
    );
    const out = byCode(
      citableChecks({
        bodyHtml: html,
        jsonld: {
          '@graph': [
            { '@type': 'Article', author: { name: 'Dr Lee' }, dateModified: '2026-10-01' },
          ],
        },
        facts: ['Plans start at 49 dollars a month.'],
        ownDomain: 'acme.com',
      }),
    );
    for (const c of CITABLE_CHECKS) assert.equal(out[c.code].status, 'pass', c.code);
  });

  test('links to the business’s own site do not count as outside sources, and one outside source is not enough', () => {
    const out = byCode(
      citableChecks({
        bodyHtml: body(
          '<a href="https://acme.com/a">a</a> <a href="https://blog.acme.com/b">b</a> <a href="https://who.int/a">WHO</a>',
        ),
        ownDomain: 'acme.com',
      }),
    );
    assert.equal(out.sources_linked.status, 'warn');
    assert.match(out.sources_linked.finding, /one outside source/);
  });

  test('a figure that is not in the facts is not "your own"', () => {
    const out = byCode(
      citableChecks({ bodyHtml: body(), facts: ['Founded in 2014.'], ownDomain: 'acme.com' }),
    );
    assert.equal(out.own_figures.status, 'warn');
  });

  test('they never change the score, never block, and are never "fail"', () => {
    const draft = { bodyHtml: body(), jsonld: null, facts: [], sources: [], existingPages: [] };
    const before = scoreDraft(draft);
    citableChecks({ bodyHtml: draft.bodyHtml });
    assert.deepEqual(scoreDraft(draft), before);
    assert.equal(
      QC_CHECKS.reduce((n, c) => n + c.weight, 0),
      100,
    );
    assert.ok(!citableChecks({ bodyHtml: '' }).some((c) => c.status === 'fail'));
  });

  test('a hostile body with thousands of links is read in linear time', () => {
    const links = Array.from(
      { length: 20_000 },
      (_, i) => `<a href="https://s${i}.example/">x</a>`,
    ).join('');
    const t = Date.now();
    citableChecks({ bodyHtml: `<p>${links}</p>`, ownDomain: 'acme.com' });
    assert.ok(Date.now() - t < 20_000);
  });
});

describe('qcView', () => {
  const qc = { score: 90, blocking: [], ready: true, checks: [] };

  test('has no "easy to cite" panel unless the page was written to win citations', () => {
    assert.equal(qcView(qc).citable, null);
  });

  test('shows it as advice, in a warning tone, with the finding', () => {
    const view = qcView({ ...qc, citable: citableChecks({ bodyHtml: body() }) });
    assert.equal(view.citable.length, CITABLE_CHECKS.length);
    assert.equal(view.citable[0].tone, 'warning');
    assert.equal(view.citable[0].statusText, 'Could be better');
    assert.ok(view.citable[0].finding);
  });
});
