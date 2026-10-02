import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeBody } from './decode.js';

const latin1 = (text) => Buffer.from(text, 'latin1');

describe('decoding a page', () => {
  test('UTF-8 is the default', () => {
    const { text, charset } = decodeBody(Buffer.from('café — naïve ✓', 'utf8'), 'text/html');
    assert.equal(text, 'café — naïve ✓');
    assert.equal(charset, 'utf-8');
  });

  test('the HTTP header wins', () => {
    const { text, charset } = decodeBody(latin1('café'), 'text/html; charset=ISO-8859-1');
    assert.equal(text, 'café');
    assert.equal(charset, 'windows-1252'); // the web treats ISO-8859-1 as Windows-1252
  });

  test('a <meta charset> in the page is used when the header is silent', () => {
    const html = '<html><head><meta charset="iso-8859-1"><title>Café</title></head></html>';
    assert.match(decodeBody(latin1(html), 'text/html').text, /Café/);
    const old =
      '<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"></head><body>é</body></html>';
    assert.match(decodeBody(latin1(old), 'text/html').text, /é/);
  });

  test('a byte-order mark settles it', () => {
    assert.equal(
      decodeBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')])).text,
      'hi',
    );
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé', 'utf16le')]);
    assert.equal(decodeBody(utf16).text, 'hé');
  });

  test('legacy East Asian and Cyrillic encodings', () => {
    const shiftJis = Buffer.from([0x93, 0xfa, 0x96, 0x7b]); // 日本
    assert.equal(decodeBody(shiftJis, 'text/html; charset=Shift_JIS').text, '日本');
    const koi8 = Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]); // Привет
    assert.equal(decodeBody(koi8, 'text/html; charset=koi8-r').text, 'Привет');
  });

  test('an unknown charset name falls back to UTF-8 instead of failing', () => {
    assert.equal(decodeBody(Buffer.from('plain'), 'text/html; charset=made-up-9').text, 'plain');
  });

  test('invalid UTF-8 becomes replacement characters rather than an error', () => {
    const { text } = decodeBody(Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]), 'text/html');
    assert.match(text, /^hi.+!$/u);
  });

  test('empty input', () => {
    assert.equal(decodeBody(Buffer.alloc(0)).text, '');
  });
});
