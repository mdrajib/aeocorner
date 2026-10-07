/**
 * What a free tool may hand back (ADR-0017, decision 2): findings, never what it fetched. Every tool returns the same
 * shape and the page draws it with one partial, so a tool cannot add a field that would carry a response through.
 *
 *   {
 *     headline,                                         one sentence: what we found
 *     sections: [{ heading, note?, rows: [{ label, state, value?, detail? }] }],
 *     lines?: { heading, items: [string] },             a few lines of a file we read, to show the rule that decided
 *     output?: { filename, text },                      a generator's result: our text, built from what was typed
 *     notes?: [string]                                  what the tool cannot see, in words
 *   }
 *
 * `state` is `good`, `warn`, `bad`, `neutral` or `unknown`; `unknown` is "Couldn't check" and is never drawn as a
 * pass or a failure. `normalizeFindings` is the gate: it cuts every string to its length, drops control characters,
 * caps every list and throws on a shape that is not this one (a bug in a tool, shown to the visitor as "couldn't
 * check"). Nothing here escapes HTML: the page escapes every string, so text from a hostile file is only text.
 */

export const FINDINGS_LIMITS = Object.freeze({
  headline: 200,
  sections: 8,
  rowsPerSection: 60,
  heading: 100,
  label: 80,
  value: 120,
  detail: 300,
  note: 300,
  notes: 8,
  /** A line of a fetched file, and how many lines of it may be shown. */
  lineChars: 300,
  lines: 20,
  filename: 60,
  /** A generator's output is our own text from what the visitor typed, so it may be longer. */
  outputChars: 50_000,
});

export const FINDING_STATES = Object.freeze(['good', 'warn', 'bad', 'neutral', 'unknown']);

export class FindingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FindingsError';
  }
}

// Control characters, the C1 range, line and paragraph separators, and the text-direction overrides.
const CONTROL_RANGES = [
  [0, 8],
  [0xb, 0xc],
  [0xe, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const CONTROL = new RegExp(
  `[${CONTROL_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`,
  'gu',
);

/** One line of text: control and bidirectional-override characters removed, runs of white space folded, cut to `max`. */
export function cutLine(value, max) {
  const text = String(value ?? '')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
}

/** Text with its line breaks kept (a generator's file): control characters removed, cut to `max`. */
function cutBlock(value, max) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '');
  return text.length > max ? text.slice(0, max) : text;
}

const need = (condition, message) => {
  if (!condition) throw new FindingsError(message);
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The lines of a file worth showing: the first `lines` of `items`, each cut. `more` says how many were left out, so the
 * page can say "and 14 more lines" without showing them.
 */
export function excerptLines(
  items,
  { lines = FINDINGS_LIMITS.lines, chars = FINDINGS_LIMITS.lineChars } = {},
) {
  const list = Array.isArray(items) ? items : [];
  return {
    items: list.slice(0, lines).map((l) => cutLine(l, chars)),
    more: Math.max(0, list.length - lines),
  };
}

/** The findings a page may draw, or a `FindingsError` for anything that is not the shape. */
export function normalizeFindings(input) {
  const L = FINDINGS_LIMITS;
  need(isObject(input), 'findings must be an object');
  const out = { headline: cutLine(input.headline, L.headline), sections: [], notes: [] };
  need(out.headline, 'findings need a headline');

  need(Array.isArray(input.sections ?? []), 'sections must be a list');
  for (const section of (input.sections ?? []).slice(0, L.sections)) {
    need(isObject(section) && Array.isArray(section.rows ?? []), 'a section needs rows');
    out.sections.push({
      heading: cutLine(section.heading, L.heading),
      note: section.note ? cutLine(section.note, L.note) : null,
      rows: (section.rows ?? []).slice(0, L.rowsPerSection).map((row) => {
        need(isObject(row), 'a row must be an object');
        need(FINDING_STATES.includes(row.state), `unknown state "${row.state}"`);
        return {
          label: cutLine(row.label, L.label),
          state: row.state,
          value: row.value == null ? '' : cutLine(row.value, L.value),
          detail: row.detail ? cutLine(row.detail, L.detail) : '',
        };
      }),
    });
  }

  if (input.lines !== undefined && input.lines !== null) {
    need(isObject(input.lines) && Array.isArray(input.lines.items), 'lines need items');
    const shown = excerptLines(input.lines.items);
    out.lines = {
      heading: cutLine(input.lines.heading, L.heading),
      items: shown.items,
      more: shown.more + Math.max(0, Number(input.lines.more) || 0),
    };
  }

  if (input.output !== undefined && input.output !== null) {
    need(isObject(input.output), 'output must be an object');
    out.output = {
      filename: cutLine(input.output.filename, L.filename).replace(/[^A-Za-z0-9._-]/g, '-'),
      text: cutBlock(input.output.text, L.outputChars),
    };
    need(out.output.filename, 'output needs a file name');
  }

  need(Array.isArray(input.notes ?? []), 'notes must be a list');
  out.notes = (input.notes ?? []).slice(0, L.notes).map((n) => cutLine(n, L.note));
  return out;
}
