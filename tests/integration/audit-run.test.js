import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createHostPacer } from '../../src/crawler/pacer.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { checkedAnswer, ProviderError } from '../../src/engines/contract.js';
import { adapterRegistry } from '../../src/engines/index.js';
import { createFileStore } from '../../src/integrations/spaces.js';
import { createAuditMail } from '../../src/lib/audit-mail.js';
import { auditRunJobId } from '../../src/lib/job-ids.js';
import { memoryMailer } from '../../src/lib/mailer.js';
import { SYSTEM_PROMPT as KIT_PROMPT } from '../../src/llm/brand-kit.js';
import { SYSTEM_PROMPT as READ_PROMPT } from '../../src/llm/extraction-prompt.js';
import { SYSTEM_PROMPT as QUESTIONS_PROMPT } from '../../src/llm/questions.js';
import { toMicros } from '../../src/core/spend.js';
import { closedSite, goodSite, serveRoutes } from '../helpers/fixture-sites.js';
import { startServer, testFetcher } from '../helpers/http-fixture.js';
import { startRuntime, until, waitForJob } from '../helpers/worker.js';

/**
 * A free audit end to end (Milestone 1, task 1.10), against real Redis and MySQL, a fixture website, stand-in
 * engines and a stand-in Claude: the site is read, the brand and its five questions worked out, four engines asked,
 * every answer read, and the scores, the fixes and the cost saved: once, however often the job runs.
 */
const db = connectTestDb();
const fx = fixtures(db);

const BRAND = 'Acme Widgets';
const RIVAL = 'Bright Widgets';

let site;
let closed;
let storeDir;
let store;
let h;
let mailer;
let asks = []; // every question put to an engine
let claudeCalls = []; // every call made to Claude, by kind
let behavior = {}; // per test: what goes wrong, and for whom
const domainTargets = new Map();

const kitJson = {
  brand_name: BRAND,
  aliases: [],
  category: 'industrial widgets for small factories',
  definition: 'Acme Widgets sells industrial widgets to small factories.',
  offerings: ['Widget Pro'],
  audience: 'small factories',
  geography: null,
  competitors: [{ name: RIVAL, domain: 'bright.example' }],
};
const q = (intent, text, searchQuery) => ({ intent, text, search_query: searchQuery });
const questionsJson = {
  questions: [
    q(
      'discovery',
      'What are the best industrial widget suppliers for small factories?',
      'best industrial widget suppliers',
    ),
    q(
      'discovery',
      'Which widget makers offer fast delivery for small factories in Ohio?',
      'widget makers fast delivery ohio',
    ),
    q(
      'comparison',
      `${BRAND} vs ${RIVAL}: which is better for a small factory?`,
      'acme widgets vs bright widgets',
    ),
    q(
      'problem_solution',
      'How can a small factory cut downtime caused by worn-out widgets?',
      'reduce downtime worn widgets',
    ),
    q(
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
/** What the stand-in Claude reads out of each engine's answer. */
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

const message = (json, usage) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(json) }],
  usage,
});

const claude = {
  async extract(params) {
    const system = params.system[0].text;
    if (system === KIT_PROMPT) {
      claudeCalls.push('kit');
      return message(kitJson, { input_tokens: 2000, output_tokens: 300 });
    }
    if (system === QUESTIONS_PROMPT) {
      claudeCalls.push('questions');
      return message(questionsJson, { input_tokens: 800, output_tokens: 300 });
    }
    assert.equal(system, READ_PROMPT);
    const text = params.messages[0].content.map((b) => b.text).join('\n');
    const engine = /<engine>(\w+)<\/engine>/.exec(text)[1];
    claudeCalls.push(`read:${engine}`);
    if (behavior.claudeDown) {
      behavior.claudeDown -= 1;
      throw new ProviderError('anthropic: HTTP 529 (overloaded_error)', { status: 'overloaded' });
    }
    return message(
      { answer_type: 'list', entities: READINGS[engine] ?? [], citations: [] },
      { input_tokens: 1500, output_tokens: 600 },
    );
  },
};

/** A stand-in engine: answers from ANSWERS, or says it has none (`none`), or fails (`fail`). */
function stubEngine(engineRow) {
  const { code, primaryProviderCode: provider, primaryMethod: method } = engineRow;
  return {
    engine: code,
    provider,
    method,
    estimateCostUsd: () => 0.004,
    estimateCostMicros: () => 4_000,
    async submit(task) {
      asks.push({
        engine: code,
        ref: task.ref,
        mode: task.mode,
        text: task.text,
        query: task.searchQuery,
      });
      if (behavior.fail?.includes(code)) {
        throw new ProviderError(`${provider}: HTTP 400, the request was refused`, {
          status: 'http_400',
          retryable: false,
          countsAgainstProvider: false,
        });
      }
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

before(async () => {
  const holder = { routes: {} };
  site = await startServer((req, res) => serveRoutes(holder.routes)(req, res));
  holder.routes = goodSite(site.origin('good.test'));
  const closedHolder = { routes: {} };
  closed = await startServer((req, res) => serveRoutes(closedHolder.routes)(req, res));
  closedHolder.routes = closedSite(closed.origin('closed.test'));

  storeDir = await mkdtemp(path.join(os.tmpdir(), 'aeo-audit-store-'));
  store = createFileStore({ dir: storeDir, prefix: 'test/' });
  const fetcher = testFetcher({
    ports: [site.port, closed.port],
    pacer: createHostPacer({ minGapMs: 0 }),
  });

  const engines = await Promise.all(
    ['chatgpt', 'perplexity', 'gemini', 'google_aio'].map((code) => db.reference.engines.get(code)),
  );
  mailer = memoryMailer();
  h = await startRuntime({
    db,
    queueNames: ['audit'],
    crawler: {
      fetcher,
      renderer: null,
      store,
      targetFor: (domain) => domainTargets.get(domain) ?? site.origin('good.test'),
    },
    collection: { adapters: adapterRegistry(engines.map(stubEngine)), store },
    extraction: { claude, store, model: 'opus55' },
    audit: {
      dailyBudgetUsd: 1_000_000,
      mail: createAuditMail({ mailer, baseUrl: 'https://aeocorner.test' }),
    },
  });
});

after(async () => {
  await h?.stop();
  await site?.close();
  await closed?.close();
  await rm(storeDir, { recursive: true, force: true });
  await fx.cleanup();
  await db.close();
});

beforeEach(() => {
  asks = [];
  claudeCalls = [];
  behavior = {};
  mailer.sent.length = 0;
});

/** A verified audit, ready to run. */
async function queuedAudit(overrides = {}) {
  const audit = await fx.audit(overrides);
  await db.audits.verify(audit.id);
  return audit;
}
const run = async (audit, { timeoutMs = 60_000 } = {}) => {
  const id = auditRunJobId(audit.id);
  await h.runtime.jobs.add('audit.run', { auditId: String(audit.id) }, { jobId: id });
  return waitForJob(h.queue('audit'), id, ['completed', 'failed'], { timeoutMs });
};

describe('a free audit, end to end', () => {
  test('reads the site, asks four engines five questions, and saves the scores, the fixes and the cost', async () => {
    const audit = await queuedAudit();
    const job = await run(audit);
    assert.equal(job.returnvalue.status, 'complete', JSON.stringify(job.returnvalue));

    const done = await db.audits.get(audit.id);
    assert.equal(done.status, 'complete');
    assert.ok(done.started_at && done.finished_at);

    // The scan is the audit's own, with no organization.
    const scan = await db.audits.scans.forAudit(audit.id);
    assert.equal(scan.org_id, null);
    assert.equal((await db.audits.scans.checks(scan.id)).length, 24);
    assert.equal(done.readiness_score, scan.readiness_score);
    assert.ok(done.readiness_score >= 50, `readiness ${done.readiness_score}`);

    // The brand and its five questions, from the site.
    assert.equal(done.brand_kit_lite.brand_name, BRAND);
    assert.deepEqual(
      done.prompts.map((p) => p.intent),
      ['discovery', 'discovery', 'comparison', 'problem_solution', 'brand'],
    );
    assert.deepEqual(done.suggested_competitors, [{ name: RIVAL, domain: 'bright.example' }]);

    // Twenty answers, each engine asked in live mode, the AI Overview with the keyword form.
    const rows = await db.audits.answers(audit.id);
    assert.equal(rows.length, 20);
    assert.equal(asks.length, 20);
    assert.ok(asks.every((a) => a.mode === 'live'));
    assert.ok(asks.filter((a) => a.engine === 'google_aio').every((a) => a.query));
    const by = (engine) => rows.filter((r) => r.engine_code === engine);
    assert.ok(
      by('chatgpt').every(
        (r) => r.status === 'ok' && r.brand_present === true && r.brand_rank === 1,
      ),
    );
    assert.ok(by('perplexity').every((r) => r.brand_rank === 2));
    assert.ok(by('gemini').every((r) => r.status === 'ok' && r.brand_present === false));
    assert.ok(by('google_aio').every((r) => r.status === 'no_answer' && r.brand_present === null));
    assert.ok(rows.every((r) => r.raw_uri?.startsWith('test/answers/')));
    assert.deepEqual(
      by('chatgpt')[0].entities.map((e) => [e.name, e.kind]),
      [
        [BRAND, 'brand'],
        [RIVAL, 'competitor'],
      ],
    );

    // Visibility by hand: chatgpt 5 × 1.0, perplexity 5 × 0.85, gemini 5 × 0, the AI Overview said it had none
    // and is left out: (5 + 4.25 + 0) / 15 = 61.67%.
    assert.equal(done.visibility_score, 62);
    assert.equal(done.aeo_score, Math.round(0.6 * done.readiness_score + 0.4 * 62));
    assert.equal(done.sub_scores.perEngine.chatgpt.score, 100);
    assert.equal(done.sub_scores.perEngine.perplexity.score, 85);
    assert.equal(done.sub_scores.perEngine.gemini.score, 0);
    assert.equal(done.sub_scores.perEngine.google_aio.score, null);
    assert.equal(done.sub_scores.noAnswer, 5);

    // The fixes link to their evidence, and the answers' gap is among them (gemini never names the brand).
    assert.ok(done.top_fixes.length >= 1 && done.top_fixes.length <= 5);
    assert.deepEqual(
      done.top_fixes.map((f) => f.rank),
      done.top_fixes.map((_, i) => i + 1),
    );
    const notNamed = done.top_fixes.find((f) => f.id === 'not-named') ?? null;
    if (notNamed) assert.deepEqual(notNamed.evidence.engines, ['gemini']);
    assert.ok(done.top_fixes.every((f) => f.evidence?.type));

    // The cost is what the ledger says: the crawl (free), 2 reads of the site by Claude, 20 asks, 15 readings.
    const ledger = await fx.auditLedgerRows(audit.id);
    assert.equal(ledger.length, 1 + 2 + 20 + 15);
    assert.ok(ledger.every((r) => r.org_id === null && r.audit_id === audit.id));
    const total = ledger.reduce((sum, r) => sum + toMicros(r.cost_usd.toString()), 0);
    assert.equal(toMicros(done.cost_usd.toString()), total);
    // Haiku: 2000 in + 300 out and 800 in + 300 out; Opus: 15 × (1500 in × $4 + 600 out × $20) per million; 20 × $0.004.
    assert.equal(total, 3_500 + 2_300 + 15 * (6_000 + 12_000) + 20 * 4_000);
    assert.ok(total / 1e6 < 0.75, 'well inside the $0.75 budget per audit');
  });

  test('the report email is sent once, to the lead, with the report’s address', async () => {
    const audit = await queuedAudit();
    await run(audit);
    assert.equal(mailer.sent.length, 1);
    const [sent] = mailer.sent;
    const lead = await db.leads.get(audit.lead_id);
    assert.equal(sent.to, lead.email);
    assert.equal(sent.idempotencyKey, `audit-report.${audit.public_id}`);
    assert.match(sent.email.text, new RegExp(`https://aeocorner.test/r/${audit.public_id}`));
    assert.ok((await db.audits.get(audit.id)).report_emailed_at);
  });
});

describe('a job that runs twice', () => {
  test('writes no second set of rows, charges nothing again and sends no second email', async () => {
    const audit = await queuedAudit();
    await run(audit);
    const before = await fx.auditLedgerRows(audit.id);
    const asksBefore = asks.length;

    // The same job again, as a duplicate would be: a different job ID, so the queue does not swallow it.
    const again = await h.runtime.jobs.add(
      'audit.run',
      { auditId: String(audit.id) },
      { jobId: `repeat-${audit.id}` },
    );
    const job = await waitForJob(h.queue('audit'), again.id, ['completed', 'failed']);
    assert.equal(job.returnvalue.repeated, true);

    assert.equal(asks.length, asksBefore, 'no engine was asked again');
    assert.equal((await db.audits.answers(audit.id)).length, 20);
    assert.equal((await fx.auditLedgerRows(audit.id)).length, before.length);
    assert.equal(mailer.sent.length, 1);
  });

  test('a Claude outage while reading is retried from the stored answers: nobody is asked, or paid, twice', async () => {
    behavior.claudeDown = 3; // the first three readings fail with "overloaded"
    const audit = await queuedAudit();
    const job = await run(audit);
    assert.equal(job.returnvalue.status, 'complete', JSON.stringify(job.returnvalue));

    assert.equal(asks.length, 20, 'every question was asked exactly once');
    const rows = await db.audits.answers(audit.id);
    assert.equal(rows.length, 20);
    assert.ok(rows.every((r) => r.status !== 'pending'));
    // 15 readings were paid for, plus the 3 that failed never reached the ledger (they threw before a charge).
    const ledger = await fx.auditLedgerRows(audit.id);
    const keys = ledger.map((r) => r.idempotency_key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(
      ledger.filter((r) => r.meter === 'answer_collect' || r.meter === 'serp').length,
      20,
    );
    assert.equal(ledger.filter((r) => r.meter === 'llm_extract').length, 15);
    assert.equal((await db.audits.get(audit.id)).visibility_score, 62);
  });
});

describe('a repeat audit of the same site', () => {
  test('is served from the earlier one: no site read, no engine asked, no Claude, no cost, and its own email', async () => {
    const domain = `repeat-${Date.now()}.example.test`;
    const first = await queuedAudit({ domain, inputUrl: `https://${domain}/` });
    await run(first);
    const firstDone = await db.audits.get(first.id);
    assert.equal(firstDone.status, 'complete');
    asks = [];
    claudeCalls = [];
    mailer.sent.length = 0;

    const second = await queuedAudit({ domain, inputUrl: `https://${domain}/` });
    const job = await run(second);
    assert.equal(job.returnvalue.status, 'complete');
    assert.equal(job.returnvalue.cachedFrom, String(first.id));

    assert.equal(asks.length, 0);
    assert.deepEqual(claudeCalls, []);
    const served = await db.audits.get(second.id);
    assert.equal(served.cached_from_audit_id, first.id);
    assert.equal(served.aeo_score, firstDone.aeo_score);
    assert.deepEqual(served.top_fixes, firstDone.top_fixes);
    assert.equal(
      (await fx.auditLedgerRows(second.id)).length,
      0,
      'nothing was charged to the repeat',
    );
    assert.equal((await db.audits.answers(second.id)).length, 20, 'it shows the earlier answers');

    // Its own visitor still gets their email, with their own report address.
    assert.equal(mailer.sent.length, 1);
    assert.match(mailer.sent[0].email.text, new RegExp(second.public_id));
    assert.equal(mailer.sent[0].to, (await db.leads.get(second.lead_id)).email);
  });
});

describe('what goes wrong', () => {
  test('an engine that fails leaves "couldn’t check" and a partial audit, never "not mentioned"', async () => {
    behavior.fail = ['perplexity'];
    const audit = await queuedAudit();
    const job = await run(audit);
    assert.equal(job.returnvalue.status, 'partial');

    const rows = await db.audits.answers(audit.id);
    const failed = rows.filter((r) => r.engine_code === 'perplexity');
    assert.equal(failed.length, 5);
    assert.ok(failed.every((r) => r.status === 'failed' && r.brand_present === null));

    const done = await db.audits.get(audit.id);
    assert.equal(done.status, 'partial');
    // chatgpt 5 × 1.0 and gemini 5 × 0 out of 10: 50. The failed engine is not counted as 0.
    assert.equal(done.visibility_score, 50);
    assert.equal(done.sub_scores.perEngine.perplexity.score, null);
    assert.equal(done.sub_scores.unreadable, 5);
  });

  test('a site that cannot be read fails the audit before any engine is asked or any money is spent', async () => {
    const domain = `closed-${Date.now()}.example.test`;
    domainTargets.set(domain, closed.origin('closed.test'));
    const audit = await queuedAudit({ domain, inputUrl: `https://${domain}/` });
    const job = await run(audit);
    assert.equal(job.returnvalue.status, 'failed');
    assert.equal(job.returnvalue.reason, 'site_unreadable');

    const done = await db.audits.get(audit.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.sub_scores.failure, 'site_unreadable');
    assert.equal(asks.length, 0);
    assert.deepEqual(claudeCalls, []);
    assert.equal(mailer.sent.length, 0, 'no report email for a failed audit');
    const spent = (await fx.auditLedgerRows(audit.id)).filter(
      (r) => toMicros(r.cost_usd.toString()) > 0,
    );
    assert.equal(spent.length, 0);
  });

  test('an audit that was never verified is not run', async () => {
    const audit = await fx.audit();
    const job = await run(audit);
    assert.equal((await db.audits.get(audit.id)).status, 'awaiting_verification');
    assert.equal(job.finishedOn !== undefined, true);
    assert.equal(asks.length, 0);
  });
});

describe('the daily audit budget', () => {
  test('a new audit waits for tomorrow when the day’s budget is spent; nothing is asked', async () => {
    const budgeted = await startRuntime({
      db,
      queueNames: ['audit'],
      crawler: { fetcher: {}, store },
      collection: { adapters: adapterRegistry([]), store },
      extraction: { claude, store },
      audit: { dailyBudgetUsd: 0.01 },
    });
    try {
      const earlier = await queuedAudit();
      await db.audits.ledger.record(earlier.id, {
        meter: 'answer_collect',
        providerCode: 'dataforseo',
        unit: 'request',
        costUsd: '0.02',
        idempotencyKey: `budget-test-${earlier.id}`,
      });
      const audit = await queuedAudit();
      const id = auditRunJobId(audit.id);
      await budgeted.runtime.jobs.add('audit.run', { auditId: String(audit.id) }, { jobId: id });
      const job = await until(
        async () => {
          const found = await budgeted.queue('audit').getJob(id);
          return found && (await found.getState()) === 'delayed' ? found : null;
        },
        { message: 'the audit should be delayed until the budget resets' },
      );
      assert.ok(job.opts.delay > 0 || job.delay > 0);
      assert.equal((await db.audits.get(audit.id)).status, 'queued', 'not started');
      assert.equal(budgeted.alerts.sent.at(-1).key.startsWith('audit_budget:'), true);
      assert.equal(asks.length, 0);
    } finally {
      await budgeted.stop();
    }
  });
});
