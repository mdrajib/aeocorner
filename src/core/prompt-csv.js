import { INTENTS, INTENT_LABELS } from './prompt-rules.js';

/**
 * Reading pasted CSV into questions for the Prompt Manager's import (MVP F3). Pure and linear: one pass over the
 * text, no regular expression ever sees the whole input, so a hostile paste can't make it slow.
 *
 * Columns, in this order unless a header row names them: question, intent, topic, priority. Only the question is
 * required. An intent may be written as its key ("problem_solution") or as the label the screens show ("Solving a
 * problem"); a blank intent means "discovery". A header row is recognised by a cell that says "question", "prompt" or
 * "text". Fields may be quoted with "double quotes" (a doubled quote inside is one quote), and a quoted field may
 * span lines. A row that can't be read is reported with its line number, never dropped silently.
 */

export const MAX_ROWS = 500;
const HEADER_NAMES = new Map([
  ['question', 'text'],
  ['questions', 'text'],
  ['prompt', 'text'],
  ['text', 'text'],
  ['intent', 'intent'],
  ['topic', 'topic'],
  ['cluster', 'topic'],
  ['priority', 'priority'],
]);
const DEFAULT_COLUMNS = ['text', 'intent', 'topic', 'priority'];

const intentByWord = new Map();
for (const key of INTENTS) {
  intentByWord.set(key, key);
  intentByWord.set(INTENT_LABELS[key].toLowerCase(), key);
  intentByWord.set(key.replace('_', ' '), key);
}
intentByWord.set('problem/solution', 'problem_solution');
intentByWord.set('near me', 'local');

const PRIORITY_WORDS = new Map([
  ['1', 1],
  ['high', 1],
  ['2', 2],
  ['medium', 2],
  ['normal', 2],
  ['3', 3],
  ['low', 3],
]);

/** Split CSV text into records of fields, each with the line it started on. Delimiter is a comma, or a tab. */
export function splitCsv(input) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = text.split('\n', 1)[0].includes('\t') ? '\t' : ',';
  const records = [];
  let fields = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;

  const endField = () => {
    fields.push(wasQuoted ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    if (fields.some((f) => f !== '')) records.push({ line: startLine, fields });
    fields = [];
    startLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (c === '\n') line += 1;
        field += c;
      }
    } else if (c === '"' && field.trim() === '') {
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (c === delimiter) {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      line += 1;
      endRecord();
    } else {
      field += c;
    }
  }
  endRecord();
  return records;
}

/**
 * @returns {{ ok: true, rows: Array<{ line: number, text: string, intent: string, clusterName: string,
 *   priority: number }>, problems: Array<{ line: number, error: string }> } | { ok: false, error: string }}
 *   `ok: false` only for input that can't be read at all (empty, too many rows); row-level problems are `problems`.
 */
export function parseQuestionCsv(input) {
  const records = splitCsv(input);
  if (records.length === 0)
    return { ok: false, error: 'Paste your questions first, one per line.' };

  const hasHeader = records[0].fields.some((f) => HEADER_NAMES.get(f.toLowerCase()) === 'text');
  const columns = hasHeader
    ? records[0].fields.map((f) => HEADER_NAMES.get(f.toLowerCase()) ?? null)
    : DEFAULT_COLUMNS;
  const body = hasHeader ? records.slice(1) : records;
  if (body.length === 0)
    return { ok: false, error: 'There are no questions under the header row.' };
  if (body.length > MAX_ROWS) {
    return { ok: false, error: `Import up to ${MAX_ROWS} questions at a time.` };
  }

  const rows = [];
  const problems = [];
  for (const { line, fields } of body) {
    const cell = (name) => {
      const at = columns.indexOf(name);
      return at === -1 ? '' : (fields[at] ?? '');
    };
    const text = cell('text');
    const intentWord = cell('intent').toLowerCase().replace(/\s+/g, ' ');
    const priorityWord = cell('priority').toLowerCase();
    if (!text) {
      problems.push({ line, error: 'There is no question on this line.' });
      continue;
    }
    if (intentWord && !intentByWord.has(intentWord)) {
      problems.push({
        line,
        error: `“${cell('intent').slice(0, 40)}” isn’t a kind of question we know.`,
      });
      continue;
    }
    if (priorityWord && !PRIORITY_WORDS.has(priorityWord)) {
      problems.push({ line, error: 'Priority should be 1, 2 or 3.' });
      continue;
    }
    rows.push({
      line,
      text,
      intent: intentWord ? intentByWord.get(intentWord) : 'discovery',
      clusterName: cell('topic').slice(0, 128),
      priority: priorityWord ? PRIORITY_WORDS.get(priorityWord) : 2,
    });
  }
  return { ok: true, rows, problems };
}
