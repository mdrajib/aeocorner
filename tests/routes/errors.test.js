import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import pino from 'pino';
import { appFor, envs, silentLogger, titleOf } from './helpers.js';

const SECRET = 'db password hunter2 at /srv/aeo/src/db/secret.js:42';

function throwingRoutes(app) {
  app.get('/boom', () => {
    throw new Error(SECRET);
  });
  app.get('/boom-async', async () => {
    throw new Error(SECRET);
  });
  app.get('/teapot', (req, res, next) => {
    const err = new Error('short and stout');
    err.status = 418;
    next(err);
  });
}

describe('404', () => {
  for (const [name, env] of Object.entries(envs)) {
    test(`an unknown path renders the 404 page with status 404 (${name})`, async () => {
      const res = await appFor(env)
        .get('/definitely/not/a/page')
        .expect(404)
        .expect('Content-Type', /html/);
      assert.match(res.text, /We can’t find that page/);
      assert.match(titleOf(res.text), /Page not found/);
      assert.match(res.text, /<meta name="robots" content="noindex, nofollow">/);
      assert.equal(res.headers['x-robots-tag'], 'noindex');
    });
  }

  test('a POST to an unknown path is also a 404, not a 405 or a crash', async () => {
    await appFor().post('/nope').type('form').send({ a: 1 }).expect(404);
  });
});

describe('500', () => {
  for (const [label, path] of [
    ['sync', '/boom'],
    ['async', '/boom-async'],
  ]) {
    test(`a thrown ${label} error renders the 500 page without leaking anything`, async () => {
      const res = await appFor(envs.production, { extraRoutes: throwingRoutes })
        .get(path)
        .expect(500)
        .expect('Content-Type', /html/);
      assert.match(res.text, /Something went wrong on our side/);
      assert.doesNotMatch(res.text, /hunter2|secret\.js|\/srv\/aeo|Error:|\bat .*\(.*:\d+:\d+\)/);
      assert.match(res.text, /<meta name="robots" content="noindex, nofollow">/);
      assert.equal(res.headers['x-robots-tag'], 'noindex');
    });
  }

  test('the 500 page quotes the request id, and the same id is in the response header and the log', async () => {
    const lines = [];
    const logger = pino({ level: 'error' }, { write: (line) => lines.push(JSON.parse(line)) });
    const res = await appFor(envs.production, { logger, extraRoutes: throwingRoutes })
      .get('/boom')
      .expect(500);
    const id = res.headers['x-request-id'];
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.ok(res.text.includes(id), 'page shows the reference');
    const logged = lines.find((l) => l.msg === 'Unhandled error');
    assert.ok(logged, 'the real error is logged');
    assert.equal(logged.requestId, id);
    assert.match(logged.err.message, /hunter2/, 'the log (not the page) has the detail');
  });

  test('errors with a 4xx status keep that status and a calm message', async () => {
    const res = await appFor(envs.production, { extraRoutes: throwingRoutes })
      .get('/teapot')
      .expect(418);
    assert.doesNotMatch(res.text, /short and stout/);
    assert.doesNotMatch(res.text, /quote this reference/, 'no reference needed for client errors');
  });

  test('an oversized form body is a clean 413 page', async () => {
    const res = await appFor()
      .post('/audit')
      .type('form')
      .send({ url: 'a'.repeat(20_000) })
      .expect(413);
    assert.match(res.text, /That request is too large/);
  });

  test('the styleguide error preview renders the 500 page in development', async () => {
    const res = await appFor(envs.development).get('/_styleguide/error').expect(500);
    assert.match(res.text, /Something went wrong on our side/);
  });
});

describe('maintenance mode', () => {
  const maintenance = appFor(envs.production, { env: { MAINTENANCE_MODE: 'true' } });

  test('pages answer 503 with Retry-After and are not indexed', async () => {
    for (const path of ['/', '/methodology', '/anything']) {
      const res = await maintenance.get(path).expect(503);
      assert.equal(res.headers['retry-after'], '3600');
      assert.match(res.text, /AEO Corner is being updated/);
      assert.equal(res.headers['x-robots-tag'], 'noindex');
    }
  });

  test('the audit endpoint is also paused', async () => {
    await maintenance.post('/audit').type('form').send({ url: 'example.com' }).expect(503);
  });

  test('the health check and static assets keep working', async () => {
    await maintenance.get('/healthz').expect(200, { status: 'ok' });
    await maintenance.get('/favicon.svg').expect(200);
  });
});

describe('health check', () => {
  test('/healthz is plain JSON and cheap', async () => {
    const res = await appFor().get('/healthz').expect(200);
    assert.deepEqual(res.body, { status: 'ok' });
    assert.ok(silentLogger);
  });
});
