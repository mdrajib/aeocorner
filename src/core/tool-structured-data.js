import { SUPPORTED_TYPES, validateJsonLd } from './jsonld.js';

/**
 * What the free structured-data validator says about the JSON-LD blocks it was given (Milestone 17, task 17.07). Pure: it
 * takes parsed blocks and returns the findings shape of `tool-findings.js`.
 *
 * Markup somebody else wrote is checked leniently (`validateJsonLd(..., { lenient: true })`): a problem with a value, the
 * structure or the @context is an error, but a type or property outside the vocabulary we write is listed as "not
 * checked" and never called wrong. A block that cannot be read at all is a problem; a block that is too large to read is
 * "couldn't check". Nothing here says a valid block will earn a search or AI result.
 */

const MAX_ROWS_PER_KIND = 10;
const MAX_BLOCKS_SHOWN = 7;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The types we check, as notes short enough to be shown whole (the findings gate cuts a note at 300 characters). */
function typeNotes() {
  const lines = [];
  let line = '';
  for (const type of SUPPORTED_TYPES) {
    if (line.length + type.length > 240) {
      lines.push(line.replace(/, $/, ''));
      line = '';
    }
    line += `${type}, `;
  }
  lines.push(line.replace(/, $/, ''));
  return [
    `We check these types in detail: ${lines[0]}${lines.length > 1 ? ',' : '.'}`,
    ...lines
      .slice(1)
      .map((l, i) =>
        i === lines.length - 2
          ? `${l}. Any other type or property is read for syntax only.`
          : `${l},`,
      ),
    ...(lines.length === 1 ? ['Any other type or property is read for syntax only.'] : []),
  ];
}

/** One block's verdict: `{ block, problem?, errors, warnings, types, unchecked }`. */
export function checkBlock({ block, data, problem }) {
  if (problem) return { block, problem, errors: [], warnings: [], types: [], unchecked: [] };
  const result = validateJsonLd(data, { lenient: true });
  return {
    block,
    problem: null,
    errors: result.errors,
    warnings: result.warnings,
    types: result.types,
    unchecked: result.unchecked,
  };
}

const uncheckedWords = (unchecked) => {
  const names = [];
  for (const u of unchecked) {
    const label =
      u.kind === 'type'
        ? `${u.name} (a type)`
        : u.kind === 'property'
          ? `${u.name} (on ${u.owner})`
          : `${u.name} (a keyword)`;
    if (!names.includes(label)) names.push(label);
  }
  const shown = names.slice(0, 8).join(', ');
  return names.length > 8 ? `${shown} and ${names.length - 8} more` : shown;
};

/**
 * @param {object} input
 * @param {'page' | 'paste'} input.source
 * @param {{ block: number, data?: unknown, problem?: string }[]} input.items  every block, in order
 * @param {string} [input.pageUrl]  the page that was read, for the "page" source
 * @param {number} [input.httpStatus]
 */
export function structuredDataFindings({ source, items, pageUrl = null, httpStatus = null }) {
  const blocks = items.map(checkBlock);
  const bad = blocks.filter((b) => b.problem === 'invalid_json' || b.errors.length > 0);
  const unreadable = blocks.filter((b) => b.problem === 'too_large');
  const withWarnings = blocks.filter(
    (b) => !b.problem && b.errors.length === 0 && b.warnings.length > 0,
  );

  let headline;
  if (blocks.length === 0) {
    headline =
      source === 'page'
        ? 'We found no structured data in the page’s HTML'
        : 'There is no JSON-LD in what you pasted';
  } else if (bad.length === 0 && unreadable.length === 0) {
    headline = `${plural(blocks.length, 'block')} of structured data, no errors found`;
  } else if (bad.length === 0) {
    headline = `${plural(unreadable.length, 'block')} too large to check, and no errors in the rest`;
  } else {
    const errors = blocks.reduce(
      (n, b) => n + b.errors.length + (b.problem === 'invalid_json' ? 1 : 0),
      0,
    );
    headline = `${plural(errors, 'problem')} in ${plural(bad.length, 'block')} of structured data`;
  }

  const sections = [];
  if (source === 'page' && pageUrl) {
    sections.push({
      heading: 'The page',
      rows: [
        {
          label: 'Page read',
          state: 'neutral',
          value: httpStatus ? `HTTP ${httpStatus}` : '',
          detail: pageUrl,
        },
        {
          label: 'JSON-LD blocks in the HTML',
          state: 'neutral',
          value: String(blocks.length),
          detail: blocks.length
            ? ''
            : 'Some sites add structured data with JavaScript after the page loads. We read the HTML as a crawler that does not run JavaScript would, so that kind is not seen here.',
        },
      ],
    });
  }

  // The page shows at most 8 sections; the page's own section and the notes make room for 7 blocks.
  const shown = blocks.slice(0, MAX_BLOCKS_SHOWN);
  for (const b of shown) {
    const rows = [];
    if (b.problem === 'invalid_json') {
      rows.push({
        label: 'Not valid JSON',
        state: 'bad',
        detail:
          'This block cannot be read, so search engines and AI crawlers will skip it. Look for a trailing comma, a missing quote or a stray character.',
      });
    } else if (b.problem === 'too_large') {
      rows.push({
        label: 'Too large to check',
        state: 'unknown',
        detail: 'This block is larger than we read.',
      });
    } else {
      rows.push({
        label: 'Result',
        state: b.errors.length ? 'bad' : b.warnings.length ? 'warn' : 'good',
        value: b.errors.length
          ? plural(b.errors.length, 'problem')
          : b.warnings.length
            ? plural(b.warnings.length, 'suggestion')
            : 'No errors',
      });
      if (b.types.length) {
        rows.push({ label: 'Types we checked', state: 'neutral', value: b.types.join(', ') });
      }
      for (const e of b.errors.slice(0, MAX_ROWS_PER_KIND))
        rows.push({ label: e.path, state: 'bad', detail: e.message });
      if (b.errors.length > MAX_ROWS_PER_KIND)
        rows.push({
          label: 'More problems',
          state: 'bad',
          detail: `and ${b.errors.length - MAX_ROWS_PER_KIND} more.`,
        });
      for (const w of b.warnings.slice(0, MAX_ROWS_PER_KIND))
        rows.push({ label: w.path, state: 'warn', detail: w.message });
      if (b.unchecked.length) {
        rows.push({
          label: 'Not checked',
          state: 'neutral',
          value: String(b.unchecked.length),
          detail: `We only check the vocabulary listed below, so these were read for syntax only: ${uncheckedWords(b.unchecked)}. That does not mean they are wrong.`,
        });
      }
    }
    sections.push({ heading: `Block ${b.block}`, rows });
  }

  const notes = [
    ...typeNotes(),
    'Valid structured data does not promise a rich result or a mention in an AI answer. It makes your pages easier to read for the crawlers that use it.',
  ];
  if (source === 'page')
    notes.push(
      'We read one page, as a crawler that does not run JavaScript would. Other pages on the site may differ.',
    );
  if (blocks.length > MAX_BLOCKS_SHOWN)
    notes.unshift(
      `The first ${MAX_BLOCKS_SHOWN} of ${blocks.length} blocks are shown. The headline counts all of them.`,
    );
  if (withWarnings.length)
    notes.unshift('A suggestion is not an error: the block is valid without it.');

  return { headline, sections, notes };
}
