import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { after, describe, test } from 'node:test';
import request from 'supertest';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { createAuditLimiter } from '../../src/lib/audit-limits.js';
import { createAuditMail } from '../../src/lib/audit-mail.js';
import { loadConfig } from '../../src/lib/config.js';
import { createFunnel } from '../../src/lib/funnel.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createOtpStore } from '../../src/lib/otp.js';
import { createApp } from '../../src/web/app.js';
import { auditFixtures } from '../helpers/audit-fixtures.js';
import { connectTestRedis } from '../helpers/redis.js';
import { envs, silentLogger } from './helpers.js';

/**
 * The free audit's pages, from the address to the report (Milestone 2, tasks 2.01–2.04): real MySQL and Redis, the
 * real code store and limiter, and stand-ins for Turnstile, the mailer, the job queue and PostHog.
 */
const db = connectTestDb();
const fx = fixtures(db);
const { redis, prefix, close } = connectTestRedis({ role: 'producer' });

const unique = () => randomBytes(4).toString('hex');
const ip = () => `198.51.100.${1 + (randomBytes(1)[0] % 250)}`;

let human = { ok: true };
const turnstile = { calls: [], verify: async (args) => (turnstile.calls.push(args), human) };
const mailer = memoryMailer();
const jobs = { added: [], failWith: null };
jobs.add = async (name, data, options) => {
  if (jobs.failWith) throw jobs.failWith;
  jobs.added.push({ name, data, options });
};
const posthogCalls = [];
const funnel = createFunnel({
  posthog: { host: 'https://posthog.test', apiKey: 'phc_test' },
  fetchImpl: async (url, init) => {
    posthogCalls.push(JSON.parse(init.body));
    return { ok: true };
  },
});

const config = loadConfig({
  ...envs.production,
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
  TURNSTILE_SECRET_KEY: 'test-secret',
});
const app = createApp({
  config,
  logger: silentLogger,
  db,
  audit: {
    otp: createOtpStore(redis, { prefix, secret: 'otp-test-secret-otp-test-secret' }),
    limiter: createAuditLimiter({ redis, prefix, db }),
    turnstile,
    mail: createAuditMail({ mailer, baseUrl: config.baseUrl }),
    jobs,
    funnel,
  },
});
const agent = request(app);

after(async () => {
  await fx.cleanup();
  await close();
  await db.close();
});

const eventsNamed = (name) => posthogCalls.filter((c) => c.event === name);
const codeSentTo = (address) => {
  const message = [...mailer.sent].reverse().find((m) => m.to === address);
  return message?.email.text.match(/\b(\d{6})\b/)?.[1];
};

/** Run the form up to the code screen for a fresh address and website. */
async function startAudit({
  email = `lead-${unique()}@acme-corp.test`,
  consent = false,
  url,
} = {}) {
  const domain = `site-${unique()}.test`;
  const from = ip();
  const res = await agent
    .post('/audit/email')
    .set('X-Forwarded-For', from)
    .type('form')
    .send({
      url: url ?? domain,
      email,
      ...(consent ? { consent: '1' } : {}),
      'cf-turnstile-response': 'ok-token',
    });
  const publicId = res.headers.location?.match(/\/audit\/([0-9A-Z]{26})\/verify/)?.[1];
  const audit = publicId ? await fx.adoptAudit(publicId) : null;
  return { res, email, domain, publicId, audit, from };
}

const { QUESTIONS, seedAudit, answer, finishedAudit } = auditFixtures({ db, fx });

describe('step 1: the address', () => {
  test('a valid address gets the email step, naming the domain and carrying the address in hidden fields', async () => {
    const res = await agent
      .post('/audit')
      .type('form')
      .send({ url: 'https://www.Example.com/pricing', competitor_url: 'rival.io' })
      .expect(200);
    assert.match(res.text, /Where should we send your report\?/);
    assert.match(res.text, /<strong>example\.com<\/strong>/);
    assert.match(res.text, /name="url" value="https:\/\/www\.Example\.com\/pricing"/);
    assert.match(res.text, /name="competitor_url" value="rival\.io"/);
    assert.match(res.text, /<meta name="robots" content="noindex, nofollow"/);
    assert.equal(eventsNamed('audit_form_submitted').at(-1).properties.has_competitor, true);
  });

  test('the bot check is on this step: the widget renders and Cloudflare’s script loads, and only here', async () => {
    const step = await agent.post('/audit').type('form').send({ url: 'example.com' }).expect(200);
    assert.match(step.text, /<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"/);
    assert.match(step.text, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
    const homePage = await agent.get('/').expect(200);
    assert.doesNotMatch(homePage.text, /cf-turnstile|challenges\.cloudflare\.com/);
  });

  test('an invalid address goes back to the home page with the field error and nothing is stored', async () => {
    const res = await agent.post('/audit').type('form').send({ url: 'localhost' }).expect(422);
    assert.match(res.text, /Is AI sending your customers to your competitors\?/);
    assert.match(res.text, /id="hero-url-error"/);
  });
});

describe('step 2: the email', () => {
  test('a good request makes an audit, a lead and a code, emails the code and moves on without queueing anything', async () => {
    const before = jobs.added.length;
    const { res, email, audit } = await startAudit({ consent: true });
    assert.equal(res.status, 303);
    assert.ok(audit, 'an audit exists');
    assert.equal(audit.status, 'awaiting_verification');
    assert.equal(jobs.added.length, before, 'nothing is queued until the code is right');

    const lead = await db.leads.get(audit.lead_id);
    assert.equal(lead.email, email);
    assert.equal(lead.consent_marketing, true);
    assert.equal(lead.verified_at, null);
    assert.match(codeSentTo(email), /^\d{6}$/);
    assert.equal(eventsNamed('audit_email_submitted').at(-1).properties.consent, true);
  });

  test('an unticked consent box is stored as no consent', async () => {
    const { audit } = await startAudit({ consent: false });
    assert.equal((await db.leads.get(audit.lead_id)).consent_marketing, false);
  });

  test('the funnel events carry no email, domain, address or audit id', async () => {
    await startAudit({ email: `private-${unique()}@acme-corp.test` });
    const text = JSON.stringify(posthogCalls);
    assert.doesNotMatch(text, /private-|@acme-corp|site-.*\.test|\/audit\/|198\.51\.100/);
    for (const call of posthogCalls) assert.equal(call.properties.$process_person_profile, false);
  });

  test('a bad email address is a field error, and no audit is made', async () => {
    const domain = `bad-${unique()}.test`;
    const res = await agent
      .post('/audit/email')
      .set('X-Forwarded-For', ip())
      .type('form')
      .send({ url: domain, email: 'not-an-email', 'cf-turnstile-response': 't' })
      .expect(422);
    assert.match(res.text, /id="audit-email-error"[^>]*>[\s\S]*Enter your email address/);
    assert.match(res.text, /aria-invalid="true"/);
    assert.equal(await db.audits.findReusable({ domain }), null);
  });

  test('a failed bot check re-shows the step with an honest message and makes nothing', async () => {
    human = { ok: false, reason: 'rejected' };
    try {
      const res = await agent
        .post('/audit/email')
        .set('X-Forwarded-For', ip())
        .type('form')
        .send({
          url: 'a-site.test',
          email: `x-${unique()}@acme-corp.test`,
          'cf-turnstile-response': 'bad',
        })
        .expect(422);
      assert.match(res.text, /couldn’t confirm you’re a person/);
      assert.match(res.text, /name="url" value="a-site\.test"/, 'the address is kept');
    } finally {
      human = { ok: true };
    }
  });

  test('a bot check that is unreachable (or has no key) is a 503, not a pass', async () => {
    for (const reason of ['unavailable', 'not_configured']) {
      human = { ok: false, reason };
      try {
        await agent
          .post('/audit/email')
          .set('X-Forwarded-For', ip())
          .type('form')
          .send({
            url: 'a-site.test',
            email: `x-${unique()}@acme-corp.test`,
            'cf-turnstile-response': 'x',
          })
          .expect(503);
      } finally {
        human = { ok: true };
      }
    }
  });

  test('a throwaway address is refused with a field error', async () => {
    const res = await agent
      .post('/audit/email')
      .set('X-Forwarded-For', ip())
      .type('form')
      .send({ url: 'a-site.test', email: `a@mailinator.com`, 'cf-turnstile-response': 't' })
      .expect(422);
    assert.match(res.text, /temporary email address/);
  });

  test('the fourth audit for one mailbox in a day is refused with when to come back, never blaming the visitor', async () => {
    const email = `limit-${unique()}@acme-corp.test`;
    for (let i = 0; i < 3; i += 1) await startAudit({ email });
    const res = await agent
      .post('/audit/email')
      .set('X-Forwarded-For', ip())
      .type('form')
      .send({
        url: `site-${unique()}.test`,
        email: email.replace('@', '+tag@'),
        'cf-turnstile-response': 't',
      })
      .expect(429);
    assert.match(res.text, /used today’s free audits for this email address/);
    assert.match(res.text, /try again in about \d+ (seconds|minutes|hours?)/);
  });

  test('a code email that cannot be sent says so and offers another try', async () => {
    let publicId = null;
    const failing = createApp({
      config,
      logger: silentLogger,
      db,
      audit: {
        otp: createOtpStore(redis, { prefix, secret: 'otp-test-secret-otp-test-secret' }),
        limiter: createAuditLimiter({ redis, prefix, db }),
        turnstile: { verify: async () => ({ ok: true }) },
        mail: {
          sendVerificationCode: async ({ auditPublicId }) => {
            publicId = auditPublicId;
            throw new Error('resend is down');
          },
        },
        jobs,
      },
    });
    const res = await request(failing)
      .post('/audit/email')
      .set('X-Forwarded-For', ip())
      .type('form')
      .send({
        url: 'a-site.test',
        email: `f-${unique()}@acme-corp.test`,
        'cf-turnstile-response': 't',
      })
      .expect(502);
    assert.match(res.text, /couldn’t send the email/);
    assert.doesNotMatch(res.text, /resend is down/);
    await fx.adoptAudit(publicId);
  });
});

describe('step 3: the code', () => {
  test('the code page shows the masked address, never the whole one', async () => {
    const { res, email } = await startAudit();
    const page = await agent.get(res.headers.location).expect(200);
    const [local] = email.split('@');
    assert.match(page.text, /Enter your 6-digit code/);
    assert.doesNotMatch(page.text, new RegExp(email));
    assert.match(page.text, new RegExp(`${local.slice(0, 2)}•+@acme-corp\\.test`));
    assert.match(page.text, /autocomplete="one-time-code"/);
    assert.equal(page.headers['cache-control'], 'no-store');
  });

  test('a wrong code is refused with the tries left; the right one queues the audit once and starts the progress page', async () => {
    const { res, email, audit } = await startAudit();
    const verify = res.headers.location;
    const code = codeSentTo(email);

    const wrong = await agent
      .post(verify)
      .type('form')
      .send({ code: code === '000000' ? '111111' : '000000' })
      .expect(422);
    assert.match(wrong.text, /That code isn’t right\. You have 4 tries left/);
    assert.equal((await db.audits.get(audit.id)).status, 'awaiting_verification');
    assert.equal(jobs.added.filter((j) => j.data.auditId === String(audit.id)).length, 0);

    const ok = await agent.post(verify).type('form').send({ code }).expect(303);
    assert.equal(ok.headers.location, verify.replace('/verify', '/progress'));
    const after = await db.audits.get(audit.id);
    assert.equal(after.status, 'queued');
    assert.ok((await db.leads.get(audit.lead_id)).verified_at, 'the address is now proven');
    const queued = jobs.added.filter((j) => j.data.auditId === String(audit.id));
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].options, { jobId: `audit-${audit.id}` });
    assert.equal(eventsNamed('audit_code_verified').length >= 1, true);

    // A double submit, or the back button: nothing more is queued and the visitor lands on the progress page.
    const again = await agent.post(verify).type('form').send({ code }).expect(303);
    assert.equal(again.headers.location, verify.replace('/verify', '/progress'));
    assert.equal(jobs.added.filter((j) => j.data.auditId === String(audit.id)).length, 1);
  });

  test('a code that is not six digits is refused without using up a try', async () => {
    const { res } = await startAudit();
    const bad = await agent
      .post(res.headers.location)
      .type('form')
      .send({ code: 'abc' })
      .expect(422);
    assert.match(bad.text, /Enter the 6 digits/);
    const arrays = await agent
      .post(res.headers.location)
      .type('form')
      .send('code=123456&code=123456')
      .expect(422);
    assert.match(arrays.text, /Enter the 6 digits/);
  });

  test('five wrong codes kill the code: even the right one then fails, and a new one works', async () => {
    const { res, email } = await startAudit();
    const verify = res.headers.location;
    const code = codeSentTo(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1)
      await agent.post(verify).type('form').send({ code: wrong }).expect(422);
    const locked = await agent.post(verify).type('form').send({ code: wrong }).expect(422);
    assert.match(locked.text, /Too many wrong tries/);
    const dead = await agent.post(verify).type('form').send({ code }).expect(422);
    assert.match(dead.text, /expired/);
  });

  test('asking again straight away is refused; the page says how long to wait', async () => {
    const { res } = await startAudit();
    const verify = res.headers.location;
    const resend = await agent
      .post(verify.replace('/verify', '/resend'))
      .type('form')
      .send({})
      .expect(429);
    assert.match(resend.text, /A code was just sent\. You can ask for another in \d+ seconds/);
  });

  test('a code page for an unknown or malformed address is a plain 404', async () => {
    await agent.get('/audit/01HZZZZZZZZZZZZZZZZZZZZZZZ/verify').expect(404);
    await agent.get('/audit/not-an-id/verify').expect(404);
    await agent
      .post('/audit/01HZZZZZZZZZZZZZZZZZZZZZZZ/verify')
      .type('form')
      .send({ code: '123456' })
      .expect(404);
  });

  test('if the job cannot be queued the visitor still reaches the progress page, and it is asked for again later', async () => {
    const { res, email, audit } = await startAudit();
    jobs.failWith = new Error('redis went away');
    try {
      await agent
        .post(res.headers.location)
        .type('form')
        .send({ code: codeSentTo(email) })
        .expect(303);
    } finally {
      jobs.failWith = null;
    }
    assert.equal((await db.audits.get(audit.id)).status, 'queued');
    const before = jobs.added.length;

    // Soon after: the page just shows. Long after: it asks for the job again (the job ID makes that safe).
    await agent.get(`/audit/${audit.public_id}/progress`).expect(200);
    assert.equal(jobs.added.length, before);
    await fx.backdateVerification(audit.id, new Date(Date.now() - 5 * 60_000));
    await agent.get(`/audit/${audit.public_id}/progress`).expect(200);
    assert.equal(jobs.added.length, before + 1);
    assert.deepEqual(jobs.added.at(-1).options, { jobId: `audit-${audit.id}` });
  });
});

describe('step 4: progress', () => {
  test('before the code is right, progress goes back to the code page', async () => {
    const audit = await seedAudit('awaiting_verification');
    const res = await agent.get(`/audit/${audit.public_id}/progress`).expect(302);
    assert.equal(res.headers.location, `/audit/${audit.public_id}/verify`);
  });

  test('a queued audit shows every step waiting, the engines named, and works with scripts off', async () => {
    const audit = await seedAudit('queued');
    const res = await agent.get(`/audit/${audit.public_id}/progress`).expect(200);
    assert.match(res.text, new RegExp(`Checking ${audit.domain}`));
    assert.match(res.text, /data-step="engine-chatgpt" data-state="waiting"/);
    assert.match(res.text, /Waiting to ask Google AI Overviews/);
    assert.match(res.text, /data-events="\/audit\/[0-9A-Z]{26}\/events"/);
    assert.match(res.text, /<noscript>/);
    assert.match(res.text, /We’ll email you the link/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.doesNotMatch(res.text, /posthog/i);
  });

  test('when the day’s free-audit budget is spent the page says the audit may wait for midnight, and otherwise says nothing', async () => {
    const audit = await seedAudit('queued');
    const open = await agent.get(`/audit/${audit.public_id}/progress`).expect(200);
    assert.doesNotMatch(open.text, /today’s limit for free audits/);

    await db.audits.ledger.record(audit.id, {
      meter: 'answer_collect',
      providerCode: 'dataforseo',
      unit: 'request',
      costUsd: '0.02',
      idempotencyKey: `flow-test-${audit.id}`,
    });
    const tight = request(
      createApp({
        config: loadConfig({ ...envs.production, AUDIT_DAILY_BUDGET_USD: '0.000001' }),
        logger: silentLogger,
        db,
        audit: { jobs, funnel: createFunnel({ posthog: null }) },
      }),
    );
    const closed = await tight.get(`/audit/${audit.public_id}/progress`).expect(200);
    assert.match(closed.text, /We’re at today’s limit for free audits/);
    assert.match(closed.text, /after midnight UTC, in about \d+ hours?/);
    assert.match(closed.text, /we’ll email your report/);
  });

  test('a running audit shows real answers as they arrive, and a failed engine as "couldn’t check"', async () => {
    const audit = await seedAudit('running');
    await db.audits.saveSetup(audit.id, {
      brandKitLite: { brand_name: 'Acme Widgets' },
      prompts: QUESTIONS,
      suggestedCompetitors: [],
    });
    for (let i = 0; i < 5; i += 1) await answer(audit, i, 'chatgpt');
    for (let i = 0; i < 5; i += 1)
      await answer(audit, i, 'gemini', {
        status: 'failed',
        textExcerpt: null,
        brandPresent: null,
        entities: null,
      });
    const res = await agent.get(`/audit/${audit.public_id}/progress`).expect(200);
    assert.match(res.text, /data-step="engine-chatgpt" data-state="done"/);
    assert.match(res.text, /data-step="engine-gemini" data-state="unknown"/);
    assert.match(res.text, /We couldn’t check Gemini right now/);
    assert.match(res.text, /Answers so far/);
    assert.match(res.text, /<mark class="mark-brand"[^>]*>Acme Widgets<\/mark>/);
    assert.match(res.text, /<mark class="mark-competitor"[^>]*>Bright Widgets<\/mark>/);
  });

  test('a finished audit sends the progress page on to the report', async () => {
    const audit = await finishedAudit();
    const res = await agent.get(`/audit/${audit.public_id}/progress`).expect(302);
    assert.equal(res.headers.location, `/r/${audit.public_id}`);
  });

  test('page text from an engine is escaped in the feed', async () => {
    const audit = await seedAudit('running');
    await db.audits.saveSetup(audit.id, {
      brandKitLite: { brand_name: 'Acme' },
      prompts: QUESTIONS,
      suggestedCompetitors: [],
    });
    await answer(audit, 0, 'chatgpt', {
      textExcerpt: '<script>alert(1)</script> Acme',
      entities: [{ name: '<img src=x onerror=alert(1)>', kind: 'competitor' }],
    });
    const res = await agent.get(`/audit/${audit.public_id}/progress`).expect(200);
    assert.doesNotMatch(res.text, /<script>alert/);
    assert.doesNotMatch(res.text, /<img src=x/);
    assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

/** Open the event stream for a moment and collect what it says. */
function readStream(path, { until, ms = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      let body = '';
      let finished = false;
      const done = (value) => {
        if (finished) return;
        finished = true;
        server.close();
        resolve(value);
      };
      const req = http.get(
        { port: server.address().port, path, headers: { 'X-Forwarded-For': ip() } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            if (until.test(body)) {
              req.destroy();
              done({ status: res.statusCode, headers: res.headers, body });
            }
          });
          res.on('end', () => done({ status: res.statusCode, headers: res.headers, body }));
        },
      );
      req.on('error', (err) =>
        /aborted|ECONNRESET|socket hang up/.test(err.message) ? null : reject(err),
      );
      setTimeout(() => done({ status: 0, headers: {}, body }), ms).unref();
    });
  });
}

describe('server-sent events', () => {
  test('a running audit streams the rendered feed, with the headers a proxy needs not to buffer it', async () => {
    const audit = await seedAudit('running');
    const out = await readStream(`/audit/${audit.public_id}/events`, { until: /event: progress/ });
    assert.equal(out.status, 200);
    assert.match(out.headers['content-type'], /text\/event-stream/);
    assert.equal(out.headers['x-accel-buffering'], 'no');
    assert.match(out.headers['cache-control'], /no-store/);
    const data = JSON.parse(out.body.match(/event: progress\ndata: (.*)\n/)[1]);
    assert.match(data.html, /data-step="engine-chatgpt"/);
  });

  test('a finished audit says "done" and ends the stream', async () => {
    const audit = await finishedAudit();
    const out = await readStream(`/audit/${audit.public_id}/events`, { until: /event: done/ });
    assert.match(out.body, /event: done/);
    assert.match(out.body, new RegExp(`/r/${audit.public_id}`));
  });

  test('an unknown audit has no stream', async () => {
    await agent.get('/audit/01HZZZZZZZZZZZZZZZZZZZZZZZ/events').expect(404);
  });
});

describe('the report', () => {
  test('a complete report opens with the headline, then the scores, engines, real answers, fixes, the call to action and the honesty note', async () => {
    const audit = await finishedAudit();
    const res = await agent.get(`/r/${audit.public_id}`).expect(200);
    const t = res.text.replace(/\s+/g, ' ');
    assert.match(t, new RegExp(`AEO report for ${audit.domain}`));
    assert.match(t, /id="headline">ChatGPT named Acme Widgets in 2 of 5 buyer questions\./);
    assert.match(t, /AEO Score[\s\S]*38\/100/);
    assert.match(t, /Readiness[\s\S]*54/);
    assert.match(t, /Visibility[\s\S]*15/);
    for (const label of ['ChatGPT', 'Perplexity', 'Gemini', 'Google AI Overviews'])
      assert.match(t, new RegExp(label));
    assert.match(t, /The real answers/);
    assert.match(t, /id="answer-1-gemini"/);
    assert.match(t, /Let AI search crawlers read your site/);
    assert.match(t, /Evidence:<\/span> GPTBot is blocked \(0 of 8 points\)/);
    assert.match(t, /href="#answer-1-gemini"/, 'a visibility fix links to the answer it came from');
    assert.match(t, /href="\/r\/[0-9A-Z]{26}\/track"/);
    assert.match(t, /Start my 14-day trial/);
    assert.match(t, /one-sample snapshot/);
    assert.match(t, /href="\/methodology"/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers['x-robots-tag'], /noindex/);
    assert.doesNotMatch(t, /incomplete/i);
  });

  test('an engine that could not be checked says so; it is never "not mentioned" and the audit says it is partial', async () => {
    const audit = await finishedAudit({ status: 'partial', failEngine: 'gemini' });
    const res = await agent.get(`/r/${audit.public_id}`).expect(200);
    const card = res.text.split('data-engine="').find((part) => part.startsWith('gemini"'));
    assert.ok(card.indexOf('data-engine=') === -1);
    assert.match(card, /Couldn’t check/);
    assert.doesNotMatch(card, /Not mentioned/);
    assert.match(res.text, /Some of this audit is incomplete/);
    assert.match(res.text, /We couldn’t check Gemini this time/);
  });

  test('a score that could not be worked out is "Couldn’t check", never 0', async () => {
    const audit = await seedAudit('running');
    await db.audits.finish(audit.id, {
      status: 'partial',
      readinessScore: null,
      visibilityScore: null,
      aeoScore: null,
    });
    const res = await agent.get(`/r/${audit.public_id}`).expect(200);
    assert.doesNotMatch(res.text, /stat-value">0/);
    assert.match(res.text, /stat-unknown/);
    assert.match(res.text, /couldn’t read enough AI answers/);
  });

  test('a failed audit says it did not finish and offers another try', async () => {
    const audit = await seedAudit('running');
    await db.audits.fail(audit.id, 'site_unreadable');
    const res = await agent.get(`/r/${audit.public_id}`).expect(200);
    assert.match(res.text, /couldn’t finish the audit/);
    assert.match(res.text, /href="\/#audit"/);
    assert.doesNotMatch(res.text, /site_unreadable/, 'the internal reason is not shown');
  });

  test('a report that is still being made goes to the progress page', async () => {
    const audit = await seedAudit('running');
    const res = await agent.get(`/r/${audit.public_id}`).expect(302);
    assert.equal(res.headers.location, `/audit/${audit.public_id}/progress`);
  });

  test('an unknown address, a malformed one, and an audit nobody has verified are the same plain 404', async () => {
    const unverified = await seedAudit('awaiting_verification');
    const bodies = [];
    for (const id of [
      '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      'nope',
      unverified.public_id,
      '../etc/passwd',
    ]) {
      const res = await agent.get(`/r/${id}`).expect(404);
      bodies.push(res.text.replace(/[0-9A-Z]{26}/g, ''));
    }
    assert.equal(new Set(bodies).size, 1, 'nothing tells them apart');
  });

  test('"start the trial" counts the click and sends the visitor on with the domain, and nothing else', async () => {
    const audit = await finishedAudit();
    const res = await agent.get(`/r/${audit.public_id}/track`).expect(302);
    assert.equal(res.headers.location, `/app/new-org?domain=${encodeURIComponent(audit.domain)}`);
    assert.equal(eventsNamed('audit_track_clicked').length >= 1, true);
  });

  test('the report’s address travels in a short-lived HttpOnly cookie, never in the sign-up URL', async () => {
    const audit = await finishedAudit();
    const res = await agent.get(`/r/${audit.public_id}/track`).expect(302);
    assert.doesNotMatch(res.headers.location, new RegExp(audit.public_id));
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('aeo_audit='));
    assert.ok(cookie, 'the claim cookie is set');
    assert.ok(cookie.startsWith(`aeo_audit=${audit.public_id}`));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Path=\/app/);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Max-Age=7200|Expires=/i);
  });

  test('a report view is a funnel event with the score band and nothing identifying', async () => {
    const audit = await finishedAudit();
    await agent.get(`/r/${audit.public_id}`).expect(200);
    const event = eventsNamed('audit_report_viewed').at(-1);
    assert.deepEqual(event.properties.score_band, 'mid');
    assert.equal(event.properties.status, 'complete');
    assert.doesNotMatch(JSON.stringify(event), new RegExp(audit.public_id));
  });

  test('the report, progress and code pages are not in the sitemap and robots.txt keeps crawlers off them', async () => {
    const robots = await agent.get('/robots.txt').expect(200);
    assert.match(robots.text, /Disallow: \/r\//);
    assert.match(robots.text, /Disallow: \/audit/);
  });
});
