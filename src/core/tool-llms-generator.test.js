import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeFindings } from './tool-findings.js';
import {
  generateLlms,
  linkAddress,
  llmsGeneratorFindings,
  MAX_LINKS,
  parseLinks,
  plainLine,
} from './tool-llms-generator.js';

describe('links, one per line', () => {
  test('title | address | optional note, a missing https:// added, duplicates dropped', () => {
    const { links } = parseLinks(
      'Pricing | acme.test/pricing | Plans and prices\n\nAbout | https://acme.test/about\nPricing again | acme.test/pricing',
    );
    assert.deepEqual(links, [
      { title: 'Pricing', address: 'https://acme.test/pricing', note: 'Plans and prices' },
      { title: 'About', address: 'https://acme.test/about', note: '' },
    ]);
    assert.deepEqual(parseLinks('').links, []);
  });

  test('a bad line is refused with its number and what to write', () => {
    assert.match(parseLinks('Pricing').error, /^Line 1: write a title, then \|/);
    assert.match(parseLinks('A | b.test/x\nB |').error, /^Line 2: write a title/);
    assert.match(parseLinks('A | b.test/x | n | extra').error, /^Line 1: write a title/);
    assert.match(parseLinks('A | not an address').error, /^Line 1: enter a full web address/);
    assert.match(parseLinks('A | javascript:alert(1)').error, /enter a full web address/);
    assert.match(parseLinks('A | https://u:p@acme.test/').error, /enter a full web address/);
    assert.match(parseLinks('[A] | acme.test/x').error, /Line 1: Use plain text in the title/);
    assert.match(parseLinks(`${'t'.repeat(101)} | acme.test/x`).error, /under 100/);
    assert.match(parseLinks(`A | acme.test/x | ${'n'.repeat(201)}`).error, /under 200/);
    const many = Array.from({ length: MAX_LINKS + 1 }, (_, i) => `P${i} | acme.test/${i}`).join(
      '\n',
    );
    assert.match(parseLinks(many).error, /at most 10 links/);
  });

  test('parentheses in an address are escaped so the Markdown link cannot end early', () => {
    assert.equal(linkAddress('acme.test/a_(b)'), 'https://acme.test/a_%28b%29');
    assert.equal(linkAddress('acme.test/x#top'), 'https://acme.test/x');
    assert.equal(linkAddress('localhost'), null);
  });

  test('plainLine refuses line breaks and brackets', () => {
    assert.ok(plainLine('a\nb', 'x', 50).error);
    assert.ok(plainLine('a [b](c)', 'x', 50).error);
    assert.equal(plainLine('  Acme  ', 'x', 50).value, 'Acme');
    assert.equal(plainLine(undefined, 'x', 50).value, '');
  });
});

describe('the file', () => {
  test('the common format: title, summary, a section of links', () => {
    const { text } = generateLlms({
      name: 'Acme',
      summary: 'We make anvils.',
      links: [
        { title: 'Pricing', address: 'https://acme.test/pricing', note: 'Plans' },
        { title: 'About', address: 'https://acme.test/about', note: '' },
      ],
    });
    assert.equal(
      text,
      '# Acme\n\n> We make anvils.\n\n## Key pages\n- [Pricing](https://acme.test/pricing): Plans\n- [About](https://acme.test/about)\n',
    );
  });

  test('nothing is invented: a name alone is a title alone', () => {
    assert.equal(generateLlms({ name: 'Acme' }).text, '# Acme\n');
  });
});

describe('the findings', () => {
  const make = (input) => {
    const { text } = generateLlms(input);
    return normalizeFindings(llmsGeneratorFindings({ ...input, text }));
  };

  test('the file comes with the plain statement that no engine is known to need it', () => {
    const f = make({
      name: 'Acme',
      summary: 'We make anvils.',
      links: [{ title: 'About', address: 'https://acme.test/about', note: '' }],
    });
    assert.match(f.headline, /Your llms\.txt is ready, with 1 link$/);
    assert.equal(f.output.filename, 'llms.txt');
    assert.ok(f.notes.some((n) => /No AI engine is known to need an llms\.txt file/.test(n)));
    assert.ok(f.notes.some((n) => /does not promise/.test(n)));
  });

  test('a missing summary or no links is neutral, never an error', () => {
    const f = make({ name: 'Acme' });
    const rows = f.sections.flatMap((s) => s.rows);
    assert.ok(rows.every((r) => r.state !== 'bad' && r.state !== 'warn'));
    assert.match(f.headline, /with 0 links/);
  });
});

describe('hostile input', () => {
  // The loosest bounds that still catch a quadratic pattern: a busy machine must not fail them (CLAUDE.md).
  const within = (ms, fn) => {
    const started = Date.now();
    const out = fn();
    assert.ok(Date.now() - started < ms, `took ${Date.now() - started} ms`);
    return out;
  };

  test('200,000 lines and one line of a million characters are refused or read in linear time', () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `P${i} | acme.test/${i}`).join('\n');
    assert.match(within(5_000, () => parseLinks(lines)).error, /at most 10 links/);
    assert.match(
      within(5_000, () => parseLinks(`${'a'.repeat(1_000_000)} | acme.test`)).error,
      /under 100/,
    );
    assert.match(
      within(5_000, () => parseLinks('|'.repeat(1_000_000))).error,
      /Line 1: write a title/,
    );
    assert.match(
      within(5_000, () => parseLinks('\n'.repeat(1_000_000) + 'x')).error,
      /Line 1000001/,
    );
  });

  test('an address over 2,048 characters is refused, and one full of parentheses is escaped', () => {
    assert.equal(
      within(5_000, () => linkAddress(`acme.test/${'('.repeat(500_000)}`)),
      null,
    );
    assert.equal(
      within(5_000, () => linkAddress(`${'a'.repeat(1_000_000)}.com`)),
      null,
    );
    assert.equal(linkAddress(`acme.test/${'('.repeat(500)}`).includes('('), false);
  });
});
