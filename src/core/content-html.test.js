import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBody, analyzeBody, isQuestionHeading, faqPairs, wordsOf } from './content-html.js';

test('allowed markup is kept and everything else is stripped', () => {
  const { html, dropped } = sanitizeBody(
    '<h1>Title</h1><p onclick="x()" style="color:red">Hello <b>bold</b> <i>it</i> <span class="x">span</span></p>' +
      '<script>alert(1)</script><iframe src="//evil"></iframe><img src=x onerror=alert(1)><ul><li>one</li></ul>',
  );
  assert.equal(
    html,
    '<h2>Title</h2>\n<p>Hello <strong>bold</strong> <em>it</em> span</p>\n<ul><li>one</li></ul>',
  );
  assert.deepEqual(dropped.sort(), ['iframe', 'img', 'script']);
});

test('links keep only safe addresses and lose every other attribute', () => {
  const { html } = sanitizeBody(
    '<p><a href="https://a.com/x?y=1&z=2" target="_blank" onclick="x">ok</a> <a href="javascript:alert(1)">bad</a> ' +
      '<a href=" java\nscript:alert(1)">sneaky</a> <a href="//evil.com">proto</a> <a href="/about">rel</a> <a href="data:text/html,x">d</a> <a href="mailto:a@b.com">m</a></p>',
  );
  assert.match(html, /<a href="https:\/\/a\.com\/x\?y=1&amp;z=2">ok<\/a>/);
  assert.equal((html.match(/javascript/gi) ?? []).length, 0);
  assert.match(html, /<a>bad<\/a>/);
  assert.match(html, /<a>sneaky<\/a>/);
  assert.match(html, /<a>proto<\/a>/);
  assert.match(html, /<a href="\/about">rel<\/a>/);
  assert.match(html, /<a>d<\/a>/);
  assert.match(html, /<a href="mailto:a@b\.com">m<\/a>/);
  assert.ok(!/target|onclick/.test(html));
});

test('bare text becomes a paragraph, wrappers are unwrapped, empty blocks go', () => {
  const { html } = sanitizeBody(
    'loose text<div><section>inner <strong>x</strong></section></div><p>  </p><h3></h3><h5>deep</h5>',
  );
  assert.equal(html, '<p>loose text inner <strong>x</strong></p>\n<h4>deep</h4>');
});

test('text is escaped again so an entity cannot become markup', () => {
  const { html } = sanitizeBody(
    '<p>&lt;script&gt;alert(1)&lt;/script&gt; and 5 &lt; 6 &amp; 7</p>',
  );
  assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt; and 5 &lt; 6 &amp; 7</p>');
  assert.ok(!/<script/i.test(html));
});

test('tables keep their structure; th scope survives only as col or row', () => {
  const { html } = sanitizeBody(
    '<table style="x"><thead><tr><th scope="col" onclick="x">A</th><th scope="evil">B</th></tr></thead><tbody><tr><td colspan="2">1</td></tr></tbody></table>',
  );
  assert.match(html, /<th scope="col">A<\/th><th>B<\/th>/);
  assert.match(html, /<td>1<\/td>/);
  assert.ok(!/colspan|style|onclick/.test(html));
});

test('comments, CDATA and forms are removed; the result is a fixed point', () => {
  const dirty = '<!-- hi --><p>a<!--x--></p><form><input name=x><button>Go</button></form><p>b</p>';
  const once = sanitizeBody(dirty).html;
  assert.equal(once, '<p>a</p>\n<p>b</p>');
  assert.equal(sanitizeBody(once).html, once);
});

test('hostile input: deep nesting and huge input end quickly with only allowed tags', () => {
  const started = Date.now();
  const deep = `${'<div>'.repeat(5_000)}deep${'</div>'.repeat(5_000)}${'<ul><li>'.repeat(300)}x`;
  const { html } = sanitizeBody(deep);
  assert.ok(Date.now() - started < 5_000);
  assert.ok(!/<div/.test(html));
  const big = sanitizeBody(`<p>${'word '.repeat(300_000)}</p>`).html;
  assert.ok(big.length <= 400_100);
  assert.equal(sanitizeBody(null).html, '');
  assert.equal(sanitizeBody(undefined).html, '');
});

test('analysis finds headings with the paragraph straight under each, lists, tables and links', () => {
  const { html } = sanitizeBody(
    '<h2>How much does a crown cost?</h2><p>A crown usually costs $900 to $1,500 in Austin.</p><p>More text <a href="https://a.com">source</a>.</p>' +
      '<h2>Compare options</h2><ul><li>a</li></ul><table><tr><td>x</td></tr></table><h3>Why choose us</h3><p>Because.</p>',
  );
  const a = analyzeBody(html);
  assert.deepEqual(
    a.headings.map((h) => [h.level, h.text, h.answerWords]),
    [
      [2, 'How much does a crown cost?', 9],
      [2, 'Compare options', 0],
      [3, 'Why choose us', 1],
    ],
  );
  assert.equal(a.headings[1].answer, null);
  assert.equal(a.lists, 1);
  assert.equal(a.tables, 1);
  assert.deepEqual(a.links, [{ href: 'https://a.com', text: 'source' }]);
  assert.equal(a.paragraphs.length, 3);
  assert.ok(a.words > 20);
});

test('question headings and FAQ pairs', () => {
  assert.equal(isQuestionHeading('How much does it cost'), true);
  assert.equal(isQuestionHeading('Pricing?'), true);
  assert.equal(isQuestionHeading('Our services'), false);
  assert.equal(isQuestionHeading('Does it hurt'), true);
  const a = analyzeBody(
    '<h2>Is it safe?</h2><p>Yes.</p><h2>Our story</h2><p>Long ago.</p><h2>What next?</h2><ul><li>x</li></ul>',
  );
  assert.deepEqual(faqPairs(a), [{ question: 'Is it safe?', answer: 'Yes.' }]);
});

test('wordsOf keeps contractions and numbers together', () => {
  assert.deepEqual(wordsOf("Don't pay $4,000 for a well-known crown."), [
    "Don't",
    'pay',
    '4,000',
    'for',
    'a',
    'well-known',
    'crown.',
  ]);
  assert.deepEqual(wordsOf(''), []);
});
