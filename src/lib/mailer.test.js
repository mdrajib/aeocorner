import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import pino from 'pino';
import { createMailer, MailError, memoryMailer, resendMailer } from './mailer.js';

const email = { subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };
const logger = pino({ level: 'silent' });

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(calls.length);
  };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => new Response(JSON.stringify(body), { status });

describe('Resend mailer', () => {
  test('posts the email with a bearer key and an idempotency key', async () => {
    const fetchImpl = fakeFetch(() => json(200, { id: 'abc' }));
    const mailer = resendMailer({
      apiKey: 're_test',
      from: 'AEO Corner <hi@aeocorner.com>',
      fetchImpl,
      logger,
    });
    const result = await mailer.send({ to: 'sam@example.com', email, idempotencyKey: 'invite-1' });

    assert.deepEqual(result, { id: 'abc' });
    const [call] = fetchImpl.calls;
    assert.equal(call.url, 'https://api.resend.com/emails');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer re_test');
    assert.equal(call.init.headers['Idempotency-Key'], 'invite-1');
    assert.deepEqual(call.body, {
      from: 'AEO Corner <hi@aeocorner.com>',
      to: ['sam@example.com'],
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });
  });

  test('rate limits and server errors are retryable; other refusals are not', async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [503, true],
      [422, false],
      [403, false],
    ]) {
      const mailer = resendMailer({
        apiKey: 'k',
        from: 'f',
        fetchImpl: fakeFetch(() => json(status, {})),
        logger,
      });
      await assert.rejects(mailer.send({ to: 'a@b.test', email }), (err) => {
        assert.ok(err instanceof MailError);
        assert.equal(err.retryable, retryable, `status ${status}`);
        assert.equal(err.status, status);
        return true;
      });
    }
  });

  test('a network failure is retryable and never leaks the API key into the message', async () => {
    const mailer = resendMailer({
      apiKey: 're_secret_key',
      from: 'f',
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.resend.com');
      },
      logger,
    });
    await assert.rejects(mailer.send({ to: 'a@b.test', email }), (err) => {
      assert.equal(err.retryable, true);
      assert.doesNotMatch(err.message, /re_secret_key/);
      return true;
    });
  });
});

describe('mailer selection', () => {
  const config = (resendApiKey) => ({ email: { resendApiKey, from: 'f' } });

  test('without an API key emails go to the log, not the network', async () => {
    const mailer = createMailer({ config: config(null), logger });
    assert.equal(mailer.kind, 'log');
    assert.deepEqual(await mailer.send({ to: 'a@b.test', email }), { id: null });
  });

  test('with an API key Resend is used', () => {
    assert.equal(createMailer({ config: config('re_x'), logger }).kind, 'resend');
  });

  test('the in-memory mailer keeps what was sent', async () => {
    const mailer = memoryMailer();
    await mailer.send({ to: 'a@b.test', email });
    assert.equal(mailer.sent.length, 1);
    assert.equal(mailer.sent[0].to, 'a@b.test');
  });
});
