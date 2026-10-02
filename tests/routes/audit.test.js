import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { appFor, envs, metaOf, titleOf } from './helpers.js';

const app = appFor(envs.production);
const post = (body) => app.post('/audit').type('form').send(body);

describe('POST /audit (stub until Phase 7)', () => {
  test('a valid address gets the "opens soon" page naming the domain; nothing is claimed as started', async () => {
    const res = await post({ url: 'https://www.Example.com/pricing' }).expect(200);
    assert.match(res.text, /The free audit opens soon/);
    assert.match(res.text, /<strong>example\.com<\/strong>/);
    assert.match(res.text, /haven’t saved anything/);
    assert.doesNotMatch(res.text, /report is ready|your audit is running/i);
    assert.equal(
      metaOf(res.text, 'robots'),
      'noindex, nofollow',
      'stub responses are not indexable',
    );
    assert.match(titleOf(res.text), /free audit opens soon/i);
  });

  test('a bare domain and an optional valid competitor are accepted', async () => {
    await post({ url: 'example.com', competitor_url: 'rival.io' }).expect(200);
  });

  test('an empty form re-renders the home page with a 422 and a clear field error', async () => {
    const res = await post({ url: '' }).expect(422);
    assert.match(res.text, /Is AI sending your customers to your competitors\?/);
    assert.match(res.text, /id="hero-url-error"[^>]*>[\s\S]*Enter your website address/);
    assert.match(res.text, /aria-invalid="true"/);
    assert.match(res.text, /aria-describedby="hero-url-hint hero-url-error"/);
    assert.equal(metaOf(res.text, 'robots'), 'noindex, nofollow');
    assert.match(res.text, /rel="canonical" href="https:\/\/aeocorner\.com\/"/);
  });

  test('a non-website value is rejected and echoed back safely', async () => {
    const evil = '"><script>alert(1)</script>';
    const res = await post({ url: evil }).expect(422);
    assert.doesNotMatch(res.text, /<script>alert/);
    assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(res.text, /doesn’t look like a website address/);
  });

  test('private and metadata addresses are rejected before anything could fetch them', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'localhost',
      'http://10.0.0.1',
      'file:///etc/passwd',
    ]) {
      await post({ url }).expect(422);
    }
  });

  test('a bad competitor address fails on the competitor field and opens the optional section', async () => {
    const res = await post({ url: 'example.com', competitor_url: 'nonsense' }).expect(422);
    assert.match(res.text, /id="hero-competitor-error"/);
    assert.doesNotMatch(res.text, /id="hero-url-error"/);
    assert.match(res.text, /<details class="group" open>/);
  });

  test('the visitor’s input survives a failed submit', async () => {
    const res = await post({ url: 'bad address', competitor_url: 'rival.io' }).expect(422);
    assert.match(res.text, /value="bad address"/);
    assert.match(res.text, /value="rival\.io"/);
  });

  test('repeated or non-string fields are rejected as invalid, never a crash', async () => {
    // A repeated field arrives as an array: not one website address, so the same friendly 422.
    await app.post('/audit').type('form').send('url=a.com&url=b.com').expect(422);
    await app
      .post('/audit')
      .type('form')
      .send('url=a.com&competitor_url=x&competitor_url=y')
      .expect(422);
    await app.post('/audit').type('form').send('').expect(422);
  });

  test('GET /audit sends people to the form on the home page', async () => {
    await app.get('/audit').expect(302).expect('Location', '/#audit');
  });
});
