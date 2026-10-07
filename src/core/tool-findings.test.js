import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cutLine,
  excerptLines,
  FINDINGS_LIMITS as L,
  FindingsError,
  normalizeFindings,
} from './tool-findings.js';

const good = (over = {}) => ({
  headline: 'GPTBot is blocked',
  sections: [{ heading: 'Bots', rows: [{ label: 'GPTBot', state: 'bad', value: 'Blocked' }] }],
  ...over,
});

describe('cutLine', () => {
  test('folds white space and cuts to the length with an ellipsis', () => {
    assert.equal(cutLine('  a \n\t b  ', 10), 'a b');
    const cut = cutLine('x'.repeat(1000), 300);
    assert.equal(cut.length, 300);
    assert.ok(cut.endsWith('…'));
  });

  test('control characters and text-direction overrides are removed', () => {
    assert.equal(cutLine('a\u0000b‮evil⁦c\u007f', 50), 'abevilc');
  });
});

describe('excerptLines', () => {
  test('shows at most 20 lines of 300 characters and says how many were left out', () => {
    const file = Array.from({ length: 1_000_000 }, (_, i) => `Disallow: /${'x'.repeat(i % 500)}`);
    const shown = excerptLines(file);
    assert.equal(shown.items.length, L.lines);
    assert.ok(shown.items.every((l) => l.length <= L.lineChars));
    assert.equal(shown.more, 1_000_000 - L.lines);
  });
});

describe('normalizeFindings: the gate between a tool and the page', () => {
  test('a good shape comes through with its defaults filled in', () => {
    const out = normalizeFindings(good());
    assert.equal(out.headline, 'GPTBot is blocked');
    assert.deepEqual(out.sections[0].rows[0], {
      label: 'GPTBot',
      state: 'bad',
      value: 'Blocked',
      detail: '',
    });
    assert.deepEqual(out.notes, []);
  });

  test('every string is cut and every list is capped, whatever the tool handed over', () => {
    const huge = 'y'.repeat(100_000);
    const out = normalizeFindings({
      headline: huge,
      sections: Array.from({ length: 50 }, () => ({
        heading: huge,
        note: huge,
        rows: Array.from({ length: 500 }, () => ({
          label: huge,
          state: 'good',
          value: huge,
          detail: huge,
        })),
      })),
      lines: { heading: huge, items: Array(5000).fill(huge) },
      notes: Array(100).fill(huge),
    });
    assert.ok(out.headline.length <= L.headline);
    assert.equal(out.sections.length, L.sections);
    for (const s of out.sections) {
      assert.ok(s.heading.length <= L.heading && s.note.length <= L.note);
      assert.equal(s.rows.length, L.rowsPerSection);
      for (const r of s.rows)
        assert.ok(
          r.label.length <= L.label && r.value.length <= L.value && r.detail.length <= L.detail,
        );
    }
    assert.equal(out.lines.items.length, L.lines);
    assert.ok(out.lines.items.every((x) => x.length <= L.lineChars));
    assert.equal(out.notes.length, L.notes);
    assert.ok(out.notes.every((n) => n.length <= L.note));
    // The whole result is small: a response of any size cannot be passed through it.
    assert.ok(JSON.stringify(out).length < 600_000);
  });

  test('extra fields a tool adds are dropped, so a body or a header cannot ride along', () => {
    const out = normalizeFindings({
      ...good(),
      body: 'raw response',
      headers: { server: 'x' },
      sections: [
        {
          heading: 'h',
          raw: 'raw',
          rows: [{ label: 'a', state: 'good', html: '<b>x</b>', body: 'raw' }],
        },
      ],
    });
    const text = JSON.stringify(out);
    assert.ok(
      !text.includes('raw response') && !text.includes('"server"') && !text.includes('<b>'),
    );
  });

  test('a generator output keeps its line breaks, is cut at its own cap, and its name is made safe', () => {
    const out = normalizeFindings(
      good({
        output: {
          filename: '../etc/passwd\u0000.txt',
          text: `line one\r\nline two\u0000${'z'.repeat(80_000)}`,
        },
      }),
    );
    assert.equal(out.output.filename, '..-etc-passwd.txt');
    assert.ok(out.output.text.startsWith('line one\nline two'));
    assert.ok(!out.output.text.includes('\u0000'));
    assert.equal(out.output.text.length, L.outputChars);
  });

  test('a wrong shape is an error (a bug in the tool), not something to draw', () => {
    for (const bad of [
      null,
      'text',
      [],
      {},
      { headline: '   ' },
      good({ sections: 'rows' }),
      good({ sections: [{ heading: 'h', rows: [{ label: 'a', state: 'great' }] }] }),
      good({ sections: [{ heading: 'h', rows: ['a'] }] }),
      good({ lines: { items: 'a' } }),
      good({ output: { text: 'x' } }),
      good({ notes: 'no' }),
    ]) {
      assert.throws(() => normalizeFindings(bad), FindingsError, JSON.stringify(bad));
    }
  });
});
