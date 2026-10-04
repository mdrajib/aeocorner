import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createHostPacer } from '../../src/crawler/pacer.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { checkedAnswer } from '../../src/engines/contract.js';
import { adapterRegistry } from '../../src/engines/index.js';
import { createFileStore } from '../../src/integrations/spaces.js';
import { createStripe, signStripePayload } from '../../src/integrations/stripe.js';
import { syncCatalog } from '../../src/integrations/stripe-catalog.js';
import { createAuditLimiter } from '../../src/lib/audit-limits.js';
import { createAuditMail } from '../../src/lib/audit-mail.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { createOtpStore } from '../../src/lib/otp.js';
import {
  FULL_SYSTEM_PROMPT as FULL_KIT_PROMPT,
  SYSTEM_PROMPT as KIT_PROMPT,
} from '../../src/llm/brand-kit.js';
import { SYSTEM_PROMPT as READ_PROMPT } from '../../src/llm/extraction-prompt.js';
import {
  PROJECT_SYSTEM_PROMPT as PROJECT_QUESTIONS_PROMPT,
  SYSTEM_PROMPT as QUESTIONS_PROMPT,
} from '../../src/llm/questions.js';
import { authHarness, orgPathOf } from '../routes/auth-helpers.js';
import { goodSite, serveRoutes } from '../helpers/fixture-sites.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';
import { generatedSet } from '../helpers/question-sets.js';
import { connectTestRedis } from '../helpers/redis.js';
import { startStripeStub } from '../helpers/stripe-stub.js';
import { startRuntime, until } from '../helpers/worker.js';

/**
 * The whole journey a new customer takes with no human help (Milestone 10, task 10.12; MVP §13.3, first box):
 *
 *   a visitor runs the free audit  →  reads the report  →  "Track this every week"  →  signs up and makes an organization
 *   →  the project is prefilled from the audit  →  starts the 14-day trial (Stripe Checkout)  →  confirms the competitor
 *   and gets 30 questions  →  "Start tracking"  →  the first check runs  →  the dashboard shows it  →  the Action Center
 *   has a recommendation  →  the customer starts it and marks it done  →  the re-check is queued and the baseline saved.
 *
 * Everything is the real thing except what has to be outside: the web app is driven over HTTP (supertest) with a fake
 * sign-in provider; the worker is a real BullMQ worker on real Redis and MySQL; the website is a fixture server; the four
 * engines, Claude, Stripe and the mailer are stand-ins that answer like the real ones (the same ones the per-feature
 * suites use). It lives in its own directory and runs on its own (`npm run test:journey`) because it sets the plans'
 * Stripe prices, which the billing route tests also do.
 */

const BRAND = 'Acme Widgets';
const RIVAL = 'Bright Widgets';
const WEBHOOK_SECRET = 'whsec_journey_test_secret';

const db = connectTestDb();
const fx = fixtures(db);
const unique = () => randomBytes(4).toString('hex');

let stub;
let stripe;
let catalog;
let site;
let storeDir;
let store;
let worker;
let web;
let redisClient;
const workerMail = memoryMailer();
let asked = []; // every question put to an engine
const claudeCalls = []; // every call to Claude, by kind

// ---------------------------------------------------------------------------------------------------------------------
// Stand-ins for the outside world

const kitLite = {
  brand_name: BRAND,
  aliases: [],
  category: 'industrial widgets for small factories',
  definition: `${BRAND} sells industrial widgets to small factories.`,
  offerings: ['Widget Pro'],
  audience: 'small factories',
  geography: null,
  competitors: [{ name: RIVAL, domain: 'bright.example' }],
};
const kitFull = {
  brand_name: BRAND,
  aliases: ['Acme'],
  legal_name: '',
  category: 'industrial widgets for small factories',
  definition: `${BRAND} sells industrial widgets to small factories.`,
  geography: 'Ohio',
  offerings: [{ name: 'Widget Pro', url: '', description: 'A widget.', price: '' }],
  audiences: ['small factories'],
  differentiators: ['Ships in two days'],
  facts: [{ label: 'Founded', value: '2009' }],
  voice: { tone: ['plain'], reading_level: 'plain', use: [], avoid: [] },
  competitors: [{ name: RIVAL, domain: 'bright.example' }],
};
const auditQuestion = (intent, text, searchQuery) => ({ intent, text, search_query: searchQuery });
const auditQuestions = {
  questions: [
    auditQuestion(
      'discovery',
      'What are the best industrial widget suppliers for small factories?',
      'best industrial widget suppliers',
    ),
    auditQuestion(
      'discovery',
      'Which widget makers offer fast delivery for small factories in Ohio?',
      'widget makers fast delivery ohio',
    ),
    auditQuestion(
      'comparison',
      `${BRAND} vs ${RIVAL}: which is better for a small factory?`,
      'acme widgets vs bright widgets',
    ),
    auditQuestion(
      'problem_solution',
      'How can a small factory cut downtime caused by worn-out widgets?',
      'reduce downtime worn widgets',
    ),
    auditQuestion(
      'brand',
      `Is ${BRAND} a good supplier for a small factory with a tight budget?`,
      'is acme widgets good',
    ),
  ],
};

const entity = (name, ref, rank) => ({
  name,
  tracked_ref: ref,
  list_rank: rank,
  prominence: 'primary',
  stance: 'recommended',
  sentiment: 1,
  excerpt: `${name} is a good choice.`,
  claims: [],
});
/** What the stand-in Claude reads out of each engine's answer: the brand is E1, the rival E2. */
const READINGS = {
  chatgpt: [entity(BRAND, 'E1', 1), entity(RIVAL, 'E2', 2)],
  perplexity: [entity(RIVAL, 'E2', 1), entity(BRAND, 'E1', 2)],
  gemini: [entity(RIVAL, 'E2', null)],
};
const ANSWERS = {
  chatgpt: `1. ${BRAND}: great for factories.\n2. ${RIVAL}: also good.`,
  perplexity: `1. ${RIVAL}\n2. ${BRAND}`,
  gemini: `${RIVAL} is the usual choice.`,
};

const message = (json, usage = { input_tokens: 1500, output_tokens: 600 }) => ({
  id: 'msg_journey',
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(json) }],
  usage,
});

const claude = {
  provider: 'anthropic',
  async extract(params) {
    const system = params.system[0].text;
    const first = params.messages[0].content.map((b) => b.text ?? '').join('\n');
    if (system === KIT_PROMPT) return (claudeCalls.push('audit-kit'), message(kitLite));
    if (system === QUESTIONS_PROMPT)
      return (claudeCalls.push('audit-questions'), message(auditQuestions));
    if (system === FULL_KIT_PROMPT) return (claudeCalls.push('project-kit'), message(kitFull));
    if (system === PROJECT_QUESTIONS_PROMPT) {
      claudeCalls.push('project-questions');
      const wanted = Number(first.match(/Write (\d+) questions/)[1]);
      return message({ questions: generatedSet(wanted, { brand: BRAND }) });
    }
    assert.equal(system, READ_PROMPT, 'an unexpected prompt');
    const engine = /<engine>(\w+)<\/engine>/.exec(first)[1];
    claudeCalls.push(`read:${engine}`);
    return message({ answer_type: 'list', entities: READINGS[engine] ?? [], citations: [] });
  },
};

/** A stand-in engine: answers from ANSWERS, or says it has none (the AI Overview). */
function stubEngine(row) {
  const { code, primaryProviderCode: provider, primaryMethod: method } = row;
  return {
    engine: code,
    provider,
    method,
    estimateCostUsd: () => 0.004,
    estimateCostMicros: () => 4_000,
    async submit(task) {
      asked.push({ engine: code, text: task.text });
      return {
        providerRef: `${code}-${task.ref}`,
        raw: { text: ANSWERS[code] ?? '', none: code === 'google_aio' },
        costMicros: 4_000,
      };
    },
    poll: async (handle) => handle.raw,
    normalize: (raw, task) =>
      checkedAnswer({
        status: raw.none ? 'no_answer' : 'ok',
        engine: code,
        provider,
        method,
        text: raw.text,
        sources: raw.none
          ? []
          : [
              {
                url: 'https://g2.com/best-widgets',
                domain: 'g2.com',
                title: 'Best widgets',
                snippet: null,
                position: 1,
              },
            ],
        modelVersion: 'stub-1',
        locale: { country: task.country, language: task.language },
        answeredAt: null,
        providerRef: null,
      }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Set up: a worker, a web app, and the stand-ins between them

before(async () => {
  stub = await startStripeStub();
  stripe = createStripe({ secretKey: stub.secretKey, baseUrl: stub.url });

  const routes = { current: {} };
  site = await startServer((req, res) => serveRoutes(routes.current)(req, res));
  routes.current = goodSite(site.origin('good.test'));

  storeDir = await mkdtemp(path.join(os.tmpdir(), 'aeo-journey-store-'));
  store = createFileStore({ dir: storeDir, prefix: 'test/' });
  const fetcher = testFetcher({ ports: [site.port], pacer: createHostPacer({ minGapMs: 0 }) });
  const engines = await Promise.all(
    ['chatgpt', 'perplexity', 'gemini', 'google_aio'].map((code) => db.reference.engines.get(code)),
  );

  worker = await startRuntime({
    db,
    queueNames: ['audit', 'crawl', 'collect', 'extract', 'content', 'system'],
    crawler: { fetcher, renderer: null, store, targetFor: () => site.origin('good.test') },
    collection: { adapters: adapterRegistry(engines.map(stubEngine)), store },
    extraction: { claude, store, model: 'opus55', polling: { everyMs: 500 } },
    audit: {
      dailyBudgetUsd: 1_000_000,
      mail: createAuditMail({ mailer: workerMail, baseUrl: 'https://aeocorner.test' }),
    },
    tracking: {
      timing: {
        collectEveryMs: 1_000,
        extractEveryMs: 1_000,
        collectDeadlineMs: 60_000,
        extractDeadlineMs: 60_000,
      },
    },
  });

  // Billing: the plans need their Stripe prices (the same step `npm run stripe:sync` does).
  catalog = await syncCatalog({ stripe, plans: await db.reference.plans.list() });
  for (const p of catalog.plans) await db.system.billing.plans.setStripePrice(p.code, p.priceId);

  redisClient = connectTestRedis({ role: 'producer' });
  const webMailer = memoryMailer();
  web = authHarness({
    logger: pino({ level: process.env.JOURNEY_LOG ?? 'silent' }),
    jobs: worker.runtime.jobs,
    billing: { stripe },
    env: {
      STRIPE_SECRET_KEY: 'sk_test_stub',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: 'test-secret',
    },
    audit: {
      otp: createOtpStore(redisClient.redis, {
        prefix: redisClient.prefix,
        secret: 'otp-test-secret-otp-test-secret',
      }),
      limiter: createAuditLimiter({ redis: redisClient.redis, prefix: redisClient.prefix, db }),
      turnstile: { verify: async () => ({ ok: true }) },
      mail: createAuditMail({ mailer: webMailer, baseUrl: 'https://aeocorner.com' }),
      jobs: worker.runtime.jobs,
      funnel: { capture: () => {} },
    },
  });
  web.webMailer = webMailer;
});

after(async () => {
  for (const p of catalog?.plans ?? []) await db.system.billing.plans.setStripePrice(p.code, null);
  await web?.close();
  await redisClient?.close();
  await worker?.stop();
  await site?.close();
  await stub?.close();
  await rm(storeDir, { recursive: true, force: true });
  await fx.cleanup();
  await db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// The journey. The steps share state, so they run in order and each one starts from what the last left behind.

const journey = {};
const domain = `journey-${unique()}.test`;
const cookies = (res) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]);

describe('a new customer, from the free audit to a first executed recommendation', () => {
  test('1. a visitor runs the free audit: address, email, code, and the report appears', async () => {
    const email = `visitor-${unique()}@acme-corp.test`;
    const ip = `198.51.100.${1 + (randomBytes(1)[0] % 250)}`;
    const start = await web.agent.post('/audit').type('form').send({ url: domain }).expect(200);
    assert.match(start.text, /Where should we send your report\?/);

    const sent = await web.agent
      .post('/audit/email')
      .set('X-Forwarded-For', ip)
      .type('form')
      .send({ url: domain, email, 'cf-turnstile-response': 'ok-token' });
    assert.equal(sent.status, 303, sent.text?.slice(0, 300));
    const publicId = sent.headers.location.match(/\/audit\/([0-9A-Z]{26})\/verify/)[1];
    journey.publicId = publicId;
    journey.auditEmail = email;

    const code = [...web.webMailer.sent]
      .reverse()
      .find((m) => m.to === email)
      .email.text.match(/\b(\d{6})\b/)[1];
    const verified = await web.agent
      .post(`/audit/${publicId}/verify`)
      .set('X-Forwarded-For', ip)
      .type('form')
      .send({ code });
    assert.equal(verified.status, 303, verified.text?.slice(0, 300));

    // The worker runs it for real; nobody touches anything.
    const audit = await until(
      async () => {
        const row = await db.audits.getByPublicId(publicId);
        return ['complete', 'partial', 'failed', 'blocked'].includes(row.status) ? row : null;
      },
      { timeoutMs: 90_000, message: 'the audit did not finish' },
    );
    assert.equal(audit.status, 'complete');
    journey.audit = audit;
    assert.equal(asked.length, 20, 'five questions on four engines');
    assert.ok(
      workerMail.sent.some((m) => m.to === email),
      'the "report ready" email was sent once',
    );
    assert.equal(workerMail.sent.filter((m) => m.to === email).length, 1);
  });

  test('2. the report shows a score and keeps its address private', async () => {
    const report = await web.agent.get(`/r/${journey.publicId}`).expect(200);
    assert.match(report.text, new RegExp(domain.replace('.', '\\.')));
    assert.match(report.headers['cache-control'], /no-store/);
    assert.match(report.text, /noindex/);
    assert.ok(journey.audit.aeo_score >= 1, 'a real AEO Score, not "couldn’t check"');
    await web.agent.get('/r/01AAAAAAAAAAAAAAAAAAAAAAAA').expect(404);
  });

  test('3. "Track this every week" sends a visitor to sign-up carrying the audit in a short-lived cookie, not in the address', async () => {
    const track = await web.agent.get(`/r/${journey.publicId}/track`).expect(302);
    assert.match(track.headers.location, /^\/app\/new-org\?domain=/);
    assert.ok(
      !track.headers.location.includes(journey.publicId),
      'the secret address is not in the sign-up URL',
    );
    journey.claim = cookies(track).find((c) => c.startsWith('aeo_audit='));
    assert.ok(journey.claim, 'the claim cookie was set');
  });

  test('4. they sign up, make an organization, and start the 14-day trial through Stripe Checkout', async () => {
    journey.owner = await web.signedIn({ name: 'Jordan Owner' });
    const created = await journey.owner
      .post('/app/new-org', { name: 'Acme Widgets Inc' }, { extra: { Cookie: journey.claim } })
      .expect(303);
    journey.orgId = orgPathOf(created);
    const found = await db.organizations.findForUser({
      publicId: journey.orgId,
      userId: journey.owner.user.id,
    });
    journey.org = found.org;
    journey.base = `/app/o/${journey.orgId}`;
    journey.scoped = db.forOrg(found.org.id);

    // Plans are enforced: with no subscription nothing is tracked, and the screen says why.
    const checkout = await journey.owner
      .post(`${journey.base}/billing/checkout`, { plan: 'starter' })
      .expect(303);
    assert.match(checkout.headers.location, /^https:\/\/checkout\.stripe\.test\//);
    const session = stub.state.checkouts.at(-1);
    assert.equal(session.subscription_data.trial_period_days, '14');

    // Stripe finishes the Checkout and tells us, signed.
    const customer = session.customer;
    const sub = stub.setSubscription({
      customer,
      status: 'trialing',
      metadata: { org_id: found.org.public_id },
      items: {
        data: [
          stub.item({
            priceId: catalog.plans.find((p) => p.code === 'starter').priceId,
            lookupKey: 'aeo-plan-starter-monthly-7900',
          }),
        ],
      },
    });
    const body = JSON.stringify({
      id: web.fx.stripeEventId(),
      object: 'event',
      type: 'customer.subscription.created',
      data: { object: sub },
    });
    await web.agent
      .post('/webhooks/stripe')
      .set('stripe-signature', signStripePayload(body, WEBHOOK_SECRET))
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    const summary = await journey.scoped.billing.summary();
    assert.equal(summary.planCode, 'starter');
    assert.equal(summary.billingStatus, 'trialing');
  });

  test('5. the project is prefilled from the audit: its brand and the competitor it suggested', async () => {
    const res = await journey.owner
      .post(
        `${journey.base}/projects`,
        { website: domain, name: BRAND, country: 'US', language: 'en' },
        { extra: { Cookie: journey.claim } },
      )
      .expect(303);
    journey.pid = res.headers.location.match(/\/projects\/([0-9A-Z]{26})/)[1];
    journey.project = await journey.scoped.projects.getByPublicId(journey.pid);
    journey.projectBase = `${journey.base}/projects/${journey.pid}`;
    assert.ok(journey.project.source_audit_id, 'the audit became the project’s source');

    const kit = await journey.scoped.brandKits.current(journey.project.id);
    assert.equal(kit.data.identity.brandName, BRAND);
    const entities = await journey.scoped.entities.list(journey.project.id);
    const rival = entities.find((e) => e.name === RIVAL);
    assert.equal(
      rival.status,
      'suggested',
      'a suggested competitor is never tracked until confirmed',
    );
    journey.rival = rival;
    // The claim is used up: a second project made now would not be tied to the audit.
  });

  test('6. in the background the site is scanned and the Brand Kit is read, with no one waiting on a screen', async () => {
    const scan = await until(
      async () => {
        const [latest] = await journey.scoped.scans.recent({ projectId: journey.project.id });
        return latest && ['complete', 'partial', 'failed'].includes(latest.status) ? latest : null;
      },
      { timeoutMs: 60_000, message: 'the readiness scan did not finish' },
    );
    assert.ok(['complete', 'partial'].includes(scan.status), `the scan ended ${scan.status}`);
    await until(async () => claudeCalls.includes('project-kit'), {
      timeoutMs: 60_000,
      message: 'the Brand Kit was not read from the site',
    });
    const setup = await journey.owner.get(`${journey.projectBase}/setup/brand`).expect(200);
    assert.match(setup.text, new RegExp(BRAND));
  });

  test('7. they confirm the competitor and get thirty questions written for them', async () => {
    await journey.owner
      .post(`${journey.projectBase}/competitors/${journey.rival.id}/track`, {})
      .expect(303);
    const tracked = await journey.scoped.entities.list(journey.project.id);
    assert.equal(tracked.find((e) => e.id === journey.rival.id).status, 'active');

    await journey.owner.post(`${journey.projectBase}/setup/competitors`, {}).expect(303);
    const prompts = await until(
      async () => {
        const rows = await journey.scoped.prompts.list(journey.project.id, { status: 'active' });
        return rows.length >= 25 ? rows : null;
      },
      { timeoutMs: 60_000, message: 'the questions were not written' },
    );
    assert.ok(prompts.length >= 25);
    const page = await journey.owner.get(`${journey.projectBase}/setup/start`).expect(200);
    assert.match(page.text, /Start tracking/);
  });

  test('8. "Start tracking" runs the first check: every answer collected and read, nothing counted that could not be read', async () => {
    asked = [];
    await journey.owner.post(`${journey.projectBase}/setup/start`, {}).expect(303);
    assert.equal((await journey.scoped.projects.get(journey.project.id)).status, 'active');

    const [run] = await journey.scoped.runs.recent(journey.project.id);
    const finished = await until(
      async () => {
        const row = (await journey.scoped.runs.recent(journey.project.id))[0];
        return ['complete', 'partial', 'failed'].includes(row.status) ? row : null;
      },
      { timeoutMs: 180_000, intervalMs: 250, message: 'the first check did not finish' },
    );
    journey.run = finished;
    assert.equal(run.id, finished.id);
    assert.ok(
      ['complete', 'partial'].includes(finished.status),
      `the run ended ${finished.status}`,
    );
    assert.ok(asked.length >= 25, `the engines were asked ${asked.length} times`);
    const snapshots = await journey.scoped.snapshots.forRun?.(finished.id);
    if (snapshots)
      assert.ok(
        snapshots.every((s) => s.status !== 'pending'),
        'no answer is left waiting',
      );
  });

  test('9. the dashboard shows the first numbers, and a figure that could not be read says so instead of showing 0', async () => {
    const page = await journey.owner.get(`${journey.projectBase}/dashboard`).expect(200);
    assert.doesNotMatch(page.text, /Tracking isn’t on yet/);
    assert.match(page.text, /Mention rate|Visibility|AEO Score/i);
    const answers = await journey.owner.get(`${journey.projectBase}/answers`).expect(200);
    assert.match(answers.text, /Who is the best|best|Which|How/i);
  });

  test('10. the Action Center has a recommendation, written from this customer’s own evidence', async () => {
    const found = await until(
      async () => {
        const list = await journey.scoped.recommendations.list(journey.project.id, {
          view: 'todo',
        });
        return list.length ? list : null;
      },
      { timeoutMs: 60_000, message: 'no recommendation was raised' },
    );
    journey.rec = found[0];
    const page = await journey.owner.get(`${journey.projectBase}/actions`).expect(200);
    assert.match(page.text, new RegExp(`/actions/${journey.rec.id}`));
    const detail = await journey.owner
      .get(`${journey.projectBase}/actions/${journey.rec.id}`)
      .expect(200);
    assert.match(detail.text, /evidence|Evidence|Why/i);
  });

  test('11. they start it and mark it done: the baseline is saved and the re-check is queued, with no one else involved', async () => {
    await journey.owner
      .post(`${journey.projectBase}/actions/${journey.rec.id}/start`, {})
      .expect(303);
    await journey.owner
      .post(`${journey.projectBase}/actions/${journey.rec.id}/done`, {})
      .expect(303);
    const { recommendation, verifications } = await journey.scoped.recommendations.get(
      journey.project.id,
      journey.rec.id,
    );
    assert.ok(
      ['done', 'verifying', 'measuring'].includes(recommendation.status),
      `the recommendation is ${recommendation.status}`,
    );
    assert.ok(recommendation.baseline, 'the starting point was saved when it was marked done');
    assert.ok(verifications.length >= 1, 're-checks were planned');
    const log = await journey.scoped.activity.recent();
    assert.ok(log.length >= 3, 'the organization’s activity log recorded the journey');
  });
});
