import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ROWS, parseQuestionCsv, splitCsv } from './prompt-csv.js';

describe('splitCsv', () => {
  test('reads quoted fields, doubled quotes, commas and line breaks inside quotes, and CRLF', () => {
    const records = splitCsv('a,"b, ""c""",d\r\n"line one\nline two",x,y\r\n');
    assert.deepEqual(records[0].fields, ['a', 'b, "c"', 'd']);
    assert.deepEqual(records[1].fields, ['line one\nline two', 'x', 'y']);
    assert.equal(records[1].line, 2);
  });

  test('skips blank lines, strips a byte-order mark, and reads tabs when the first line has one', () => {
    assert.deepEqual(
      splitCsv(`${String.fromCharCode(0xfeff)}one\n\n\ntwo`).map((r) => r.fields),
      [['one'], ['two']],
    );
    assert.deepEqual(splitCsv('q\tintent\nbest dentist\tdiscovery')[1].fields, [
      'best dentist',
      'discovery',
    ]);
  });

  test('an unclosed quote swallows the rest as one field instead of failing', () => {
    const records = splitCsv('ok,1\n"never closed,2\nmore');
    assert.equal(records.length, 2);
    assert.match(records[1].fields[0], /never closed/);
  });

  test('is linear: a huge hostile paste is read quickly', () => {
    const started = Date.now();
    splitCsv('"'.repeat(400_000));
    splitCsv(',"'.repeat(200_000));
    splitCsv('a,'.repeat(300_000));
    // Deliberately loose: it only has to prove "not quadratic" on a busy machine.
    assert.ok(Date.now() - started < 5_000);
  });
});

describe('parseQuestionCsv', () => {
  test('a plain list of questions is discovery questions at normal priority', () => {
    const read = parseQuestionCsv(
      'What is the best family dentist in Austin?\nWhere can I book a dentist today?',
    );
    assert.equal(read.ok, true);
    assert.deepEqual(
      read.rows.map((r) => [r.line, r.intent, r.priority, r.clusterName]),
      [
        [1, 'discovery', 2, ''],
        [2, 'discovery', 2, ''],
      ],
    );
  });

  test('a header row names the columns in any order, and intents may be keys or labels', () => {
    const read = parseQuestionCsv(
      'Topic,Question,Intent,Priority\n' +
        'Costs,How much does a crown cost?,Solving a problem,high\n' +
        'Brand,"Is Acme good, really?",brand,3\n' +
        'Local,Dentist near me open Saturday?,Near me,\n',
    );
    assert.equal(read.ok, true);
    assert.deepEqual(
      read.rows.map((r) => [r.text, r.intent, r.clusterName, r.priority]),
      [
        ['How much does a crown cost?', 'problem_solution', 'Costs', 1],
        ['Is Acme good, really?', 'brand', 'Brand', 3],
        ['Dentist near me open Saturday?', 'local', 'Local', 2],
      ],
    );
    assert.deepEqual(read.problems, []);
  });

  test('a row that can’t be read is reported with its line, and the rest still come through', () => {
    const read = parseQuestionCsv(
      'question,intent,priority\n' +
        'Good question here about dentists,discovery,1\n' +
        ',discovery,1\n' +
        'Another fine question about braces,haggling,1\n' +
        'Third fine question about implants,brand,urgent\n',
    );
    assert.equal(read.ok, true);
    assert.equal(read.rows.length, 1);
    assert.deepEqual(
      read.problems.map((p) => p.line),
      [3, 4, 5],
    );
    assert.match(read.problems[1].error, /haggling/);
  });

  test('empty input, a header alone, and more than the limit are refused with a reason', () => {
    assert.equal(parseQuestionCsv('  \n\n').ok, false);
    assert.equal(parseQuestionCsv('question,intent').ok, false);
    const many = Array.from(
      { length: MAX_ROWS + 1 },
      (_, i) => `question number ${i} about dentists`,
    ).join('\n');
    const read = parseQuestionCsv(many);
    assert.equal(read.ok, false);
    assert.match(read.error, /500/);
  });

  test('text that looks like a formula or a tag is kept as text, never interpreted', () => {
    const read = parseQuestionCsv(
      '=1+1 best dentist in town?\n<script>alert(1)</script> best dentist',
    );
    assert.equal(read.ok, true);
    assert.equal(read.rows[0].text, '=1+1 best dentist in town?');
    assert.equal(read.rows[1].text, '<script>alert(1)</script> best dentist');
  });
});
