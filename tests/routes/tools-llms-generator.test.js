import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import request from 'supertest';
import { loadConfig } from '../../src/lib/config.js';
import { createApp } from '../../src/web/app.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The llms.txt generator (Milestone 17, task 17.11) through the real tool: the page, the file for what was typed, what is
 * refused with a message by the field, that the page says plainly no engine is known to need the file, and the download.
 * A `generate` run: no request leaves the server and there is no bot check.
 */
const config = loadConfig({ ...envs.production, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' });
const PATH = '/tools/llms-txt-generator';

function appFor() {
  const log = { admit: [], verified: [] };
  const tools = {
    limiter: { admit: async (a) => (log.admit.push(a), { allowed: true }) },
    turnstile: { verify: async (a) => (log.verified.push(a), { ok: true }) },
    runner: {
      inFlight: () => 0,
      limits: { inFlight: 4 },
      run: async (tool, input) => ({ status: 'ok', result: await tool({}, input), fetches: 0 }),
    },
  };
  return { app: request(createApp({ config, logger: silentLogger, tools })), log };
}
const make = (app, body) => app.post(PATH).type('form').send(body);
const fileOf = (res) => {
  const m = /<textarea[^>]*id="tool-output"[^>]*readonly>([\s\S]*?)<\/textarea>/.exec(res.text);
  return m
    ? m[1]
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
    : null;
};

describe('the page', () => {
  test('three fields, no bot check, and the plain statement about engines up front', async () => {
    const { app } = appFor();
    const { text } = await app.get(PATH).expect(200);
    assert.match(text, /name="name"/);
    assert.match(text, /name="summary"/);
    assert.match(text, /<textarea[^>]*name="links"/);
    assert.doesNotMatch(text, /class="cf-turnstile"/);
    assert.match(text, /No AI engine is known to need the file|No engine is known to need it/);
    assert.match(text, /"@type":"FAQPage"/);
  });
});

describe('the file', () => {
  test('what was typed, in the common format, and nothing else', async () => {
    const { app, log } = appFor();
    const res = await make(app, {
      name: 'Acme Dental',
      summary: 'A family clinic in Leeds.',
      links:
        'Pricing | acme-test.com/pricing | Plans and prices\nAbout | https://acme-test.com/about',
    }).expect(200);
    assert.equal(
      fileOf(res),
      '# Acme Dental\n\n> A family clinic in Leeds.\n\n## Key pages\n- [Pricing](https://acme-test.com/pricing): Plans and prices\n- [About](https://acme-test.com/about)\n',
    );
    assert.match(res.text, /Your llms\.txt is ready, with 2 links/);
    assert.match(res.text, /No AI engine is known to need an llms\.txt file/);
    assert.deepEqual(log.verified, []);
    assert.deepEqual(
      log.admit.map((a) => [a.kind, a.domain]),
      [['generate', undefined]],
    );
  });

  test('a name alone is a title alone', async () => {
    const { app } = appFor();
    assert.equal(fileOf(await make(app, { name: 'Acme' }).expect(200)), '# Acme\n');
  });
});

describe('what is refused, with a message by the field', () => {
  const refuse = async (body, field, words) => {
    const { app, log } = appFor();
    const res = await make(app, body).expect(422);
    assert.match(res.text, words);
    assert.match(res.text, new RegExp(`id="tool-${field}-error"`));
    assert.equal(log.admit.length, 0, 'a mistake costs no check');
    assert.equal(fileOf(res), null, 'and no file');
  };

  test('a missing name, markup-like text, and bad lines named by number', async () => {
    await refuse({ links: 'A | acme-test.com' }, 'name', /Enter the name/);
    await refuse({ name: 'Acme [x](y)' }, 'name', /no brackets/);
    await refuse({ name: 'Acme', summary: 'a\nb' }, 'summary', /no brackets/);
    await refuse({ name: 'Acme', links: 'Pricing' }, 'links', /Line 1: write a title/);
    await refuse(
      { name: 'Acme', links: 'A | acme-test.com\nB | nope' },
      'links',
      /Line 2: enter a full web address/,
    );
    await refuse({ name: 'x'.repeat(101) }, 'name', /under 100/);
  });

  test('a repeated field is refused', async () => {
    const { app } = appFor();
    await app.post(PATH).type('form').send('name=A&name=B').expect(422);
  });

  test('what was typed is shown again beside the message, escaped', async () => {
    const { app } = appFor();
    const res = await make(app, { name: 'Acme', summary: '"><b>x</b> [y]' }).expect(422);
    assert.doesNotMatch(res.text, /"><b>x<\/b>/);
    assert.match(res.text, /value="&#34;&gt;&lt;b&gt;x&lt;\/b&gt; \[y\]"/);
  });
});

describe('the download', () => {
  test('the file that comes is the one that was shown, as plain text', async () => {
    const { app } = appFor();
    const body = { name: 'Acme', links: 'About | acme-test.com/about' };
    const shown = await make(app, body).expect(200);
    assert.match(shown.text, /action="\/tools\/llms-txt-generator\/download"/);
    const res = await app.post(`${PATH}/download`).type('form').send(body).expect(200);
    assert.equal(res.text, fileOf(shown));
    assert.equal(res.headers['content-disposition'], 'attachment; filename="llms.txt"');
    assert.match(res.headers['content-type'], /^text\/plain; charset=utf-8/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });
});
