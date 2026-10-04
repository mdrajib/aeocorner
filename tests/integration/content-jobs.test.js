import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { UnrecoverableError } from 'bullmq';
import { sanitizeBody } from '../../src/core/content-html.js';
import { connectTestDb, fixtures } from '../../src/db/testing.js';
import { ProviderError } from '../../src/engines/contract.js';
import { createWordPressClient } from '../../src/integrations/wordpress.js';
import { createSecretBox } from '../../src/lib/secrets.js';
import { createLogger } from '../../src/lib/logger.js';
import { actionHandlers } from '../../src/worker/handlers/actions.js';
import { contentHandlers, liveKey, plainReason } from '../../src/worker/handlers/content.js';
import { testFetcher } from '../helpers/http-fixture.js';
import { startWordPressStub } from '../helpers/wordpress-stub.js';

/**
 * The Content Studio's jobs (Milestone 7): each pipeline stage against the real database with Claude as a stand-in
 * that answers as the test says, and publishing against the WordPress stand-in (tests/helpers/wordpress-stub.js),
 * ending with the recommendation marked done, its baseline saved and the live-page check passing.
 */
const db = connectTestDb();
const fx = fixtures(db);
const logger = createLogger({ isTest: true, appEnv: 'test' });
const box = createSecretBox({ current: { version: 1, key: randomBytes(32) } });
const SECRET = 'a'.repeat(64);
const unique = () => Math.random().toString(36).slice(2, 8);

let stub;
let fetcher;

before(async () => {
  stub = await startWordPressStub();
  fetcher = testFetcher({ ports: [stub.port] });
});
after(async () => {
  await stub.close();
  await fx.cleanup();
  await db.close();
});

// --- stand-ins -----------------------------------------------------------------------------------------------------

const usage = (extra = {}) => ({ input_tokens: 2_000, output_tokens: 600, ...extra });
const textMessage = (text, over = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: usage(),
  ...over,
});

const PAGE =
  'A porcelain crown typically costs between $800 and $1,700 per tooth. Most crowns last 10 to 15 years.';
const researchMessage = (facts, { seen = ['https://www.ada.org/crowns'], page = PAGE } = {}) => ({
  stop_reason: 'end_turn',
  usage: usage({ server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } }),
  content: [
    {
      type: 'web_search_tool_result',
      tool_use_id: 's1',
      content: seen.map((url) => ({
        type: 'web_search_result',
        url,
        title: 't',
        encrypted_content: 'x',
      })),
    },
    {
      type: 'web_fetch_tool_result',
      tool_use_id: 'f1',
      content: {
        type: 'web_fetch_result',
        url: seen[0],
        content: {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: page },
        },
      },
    },
    { type: 'text', text: JSON.stringify({ facts }) },
  ],
});
const GOOD_FACT = {
  claim: 'A porcelain crown typically costs $800 to $1,700 per tooth.',
  url: 'https://www.ada.org/crowns',
  quote: 'typically costs between $800 and $1,700 per tooth',
};

const section = (heading) => ({
  heading,
  directAnswer:
    'A crown usually costs between $800 and $1,700, depending on the tooth and the material.',
  points: ['price range'],
  factIds: ['r1'],
});
const briefJson = (over = {}) => ({
  format: 'faq',
  title: 'How much does a dental crown cost in Austin?',
  metaDescription:
    'What a porcelain crown costs in Austin, what changes the price and how to pay for it.',
  audience: 'adults who need a crown',
  outline: [
    section('How much does a crown cost?'),
    section('What changes the price of a crown?'),
    section('Does insurance cover a crown?'),
    section('How long does a crown last?'),
  ],
  entities: ['Austin'],
  internalLinks: [],
  schemaType: 'FAQPage',
  ...over,
});

const para = (text, n) => `<p>${Array.from({ length: n }, () => text).join(' ')}</p>`;
const draftHtml = () =>
  [
    '<p>A crown is a cap that covers a damaged tooth. A porcelain crown typically costs $800 to $1,700 per tooth.</p>',
    ...[
      'How much does a crown cost?',
      'What changes the price of a crown?',
      'Does insurance cover a crown?',
      'How long does a crown last?',
    ].flatMap((h) => [
      `<h2>${h}</h2>`,
      '<p>A crown usually costs between $800 and $1,700 depending on the tooth and the material you pick.</p>',
      para('We explain every step before we start and give you a written quote.', 4),
    ]),
    '<p>See the <a href="https://www.ada.org/crowns">ADA guide</a> and <a href="https://evil.example/x">this site</a>.</p>',
  ].join('\n');

function fakeClaude({ extract = () => textMessage('{}'), stream = null } = {}) {
  const requests = [];
  return {
    requests,
    async extract(request) {
      requests.push({ kind: 'extract', request });
      return extract(request, requests.length);
    },
    async stream(request, { onText } = {}) {
      requests.push({ kind: 'stream', request });
      const message = stream ? await stream(request) : textMessage(draftHtml());
      const text = message.content.map((b) => b.text ?? '').join('');
      for (let i = 0; i < 3; i += 1)
        onText?.(text.slice(i * 10, i * 10 + 10), text.slice(0, i * 10 + 10));
      return message;
    },
  };
}

const callProvider = async (job, params, fn) => {
  const { value, usage: u } = await fn();
  if (u && !u.free) {
    await db.forOrg(BigInt(params.orgId)).usage.record({
      ...u,
      projectId: BigInt(params.projectId),
      providerCode: params.provider,
      idempotencyKey: params.idempotencyKey,
    });
  }
  return { value };
};

const fakeRedis = () => {
  const values = new Map();
  const sets = [];
  return {
    values,
    sets,
    async set(key, value) {
      sets.push([key, value]);
      values.set(key, value);
      return 'OK';
    },
    async del(key) {
      values.delete(key);
      return 1;
    },
  };
};

const recorder = () => {
  const added = [];
  return { added, add: async (name, data, opts) => added.push({ name, data, opts }) };
};

let clock = () => new Date();
const ctxFor = (claude, over = {}) => ({
  db,
  logger,
  prefix: 'test',
  redis: fakeRedis(),
  now: () => clock(),
  jobs: recorder(),
  callProvider,
  crawler: { fetcher, store: null, renderer: null },
  content: { claude, model: 'opus55', secrets: box },
  ...over,
});

let jobSeq = 0;
const job = (attemptsMade = 0, attempts = 3) => ({
  id: `ct-${(jobSeq += 1)}`,
  attemptsMade,
  opts: { attempts },
});

const KIT = {
  identity: {
    brandName: 'Data Dental',
    aliases: [],
    legalName: '',
    domains: [],
    definition: 'a family dental practice in Austin',
    category: 'dental practice',
    geography: 'Austin, Texas',
  },
  offerings: {
    items: [
      { name: 'Porcelain crowns', url: '', description: 'Same-day crowns', price: '$900-$1,500' },
    ],
    audiences: [],
    differentiators: [],
  },
  facts: [{ label: 'Founded', value: '2009' }],
  voice: { tone: ['friendly'], readingLevel: 'Grade 9', use: [], avoid: ['cheap'], personas: [] },
};

/** A fresh organization (each has its own month of draft allowance), a project with a Brand Kit and a question. */
async function world({ withRecommendation = false, kind = 'new', targetUrl = null } = {}) {
  const o = await fx.org();
  const scoped = db.forOrg(o.org.id);
  const project = await scoped.projects.create({
    name: `Data Dental ${unique()}`,
    domain: `${unique()}.example.test`,
    country: 'US',
    language: 'en',
  });
  await scoped.brandKits.save(project.id, { kit: KIT, source: 'edited', expectedVersion: null });
  const prompt = await fx.prompt(project, { text: `How much does a crown cost? ${unique()}` });
  const rec = withRecommendation
    ? await fx.recommendation(project, {
        status: 'open',
        evidence: {
          type: 'lost_prompt',
          promptId: String(prompt.id),
          question: prompt.text,
          competitors: [{ name: 'Rival', k: 3 }],
        },
      })
    : null;
  const item = await scoped.content.create(project.id, {
    title: 'Crowns',
    promptIds: [prompt.id],
    recommendationId: rec?.id ?? null,
    kind,
    targetUrl,
    userId: o.owner.id,
  });
  const data = { orgId: String(o.org.id), projectId: String(project.id), itemId: String(item.id) };
  return { o, scoped, project, prompt, rec, item, data };
}

const statusOf = async (w) => (await w.scoped.content.get(w.project.id, w.item.id)).status;

// --- the pipeline ------------------------------------------------------------------------------------------------

describe('research', () => {
  test('keeps only facts whose page was returned and whose quotation is on it; costs include the searches; the plan is queued', async () => {
    const w = await world();
    const claude = fakeClaude({
      extract: () =>
        researchMessage([
          GOOD_FACT,
          {
            claim: 'Crowns last twenty years in every case anywhere.',
            url: 'https://made-up.example/page',
          },
          {
            claim: 'Crowns always cost less than five hundred dollars.',
            url: 'https://www.ada.org/crowns',
            quote: 'always cost less than $500',
          },
        ]),
    });
    const ctx = ctxFor(claude);
    const result = await contentHandlers['content.research'](ctx, w.data, job());
    assert.deepEqual([result.facts, result.verified], [1, 1]);
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.equal(got.status, 'briefing');
    assert.equal(got.research.facts.length, 1);
    assert.equal(got.research.facts[0].verified, true);
    assert.equal(got.research.dropped, 2);
    assert.equal(got.research.pack.question.startsWith('How much does a crown cost?'), true);
    assert.equal(got.research.searches, 2);
    // 2,000 in + 600 out on Opus 5.5 ($4/$20 per million) = $0.02, plus two searches at $0.01
    assert.ok(Math.abs(got.llmCostUsd - 0.04) < 1e-6, String(got.llmCostUsd));
    assert.deepEqual(
      ctx.jobs.added.map((a) => a.name),
      ['content.brief'],
    );
    assert.match(ctx.jobs.added[0].opts.jobId, /^content-brief-\d+-r\d+$/);
    const request = claude.requests[0].request;
    assert.deepEqual(
      request.tools.map((t) => t.type),
      ['web_search_20250305', 'web_fetch_20250910'],
    );
    const ledger = await w.scoped.usage.recent({ limit: 5 });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].meter, 'llm_content');
  });

  test('a repeated job after the item moved on does nothing; no facts at all still goes on, with a warning', async () => {
    const w = await world();
    const ctx = ctxFor(
      fakeClaude({
        extract: () =>
          researchMessage([
            { claim: 'Crowns need two visits when made in a lab.', url: 'https://ghost.example/x' },
          ]),
      }),
    );
    const first = await contentHandlers['content.research'](ctx, w.data, job());
    assert.equal(first.facts, 0);
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.equal(got.status, 'briefing');
    assert.match(got.research.warning, /only your Brand Kit/);
    const again = await contentHandlers['content.research'](ctx, w.data, job());
    assert.deepEqual([again.skipped, again.repeated], ['briefing', true]);
    assert.equal(ctx.jobs.added.length, 1);
  });

  test('an unusable reply is retried; on the last attempt the item fails in plain words and the draft is given back', async () => {
    const w = await world();
    const bad = fakeClaude({
      extract: () => textMessage('I could not find anything useful, sorry!'),
    });
    const ctx = ctxFor(bad);
    await assert.rejects(
      contentHandlers['content.research'](ctx, w.data, job(0, 3)),
      (e) => e instanceof ProviderError && e.retryable,
    );
    assert.equal(await statusOf(w), 'researching');
    const result = await contentHandlers['content.research'](ctx, w.data, job(2, 3));
    assert.deepEqual([result.failed, result.stage], [true, 'researching']);
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.deepEqual([got.status, got.failedStage], ['failed', 'researching']);
    assert.match(got.failureReason, /answer we could not use/);
    assert.ok(!got.failureReason.includes('sorry'), 'never a fragment of the reply');
    assert.equal((await w.scoped.draftQuota.draftsUsed()).used, 0);
  });

  test('a refusal fails at once, and a missing key is a plain "not set up"', async () => {
    const w = await world();
    const refusing = fakeClaude({
      extract: () => ({ stop_reason: 'refusal', content: [], usage: usage() }),
    });
    const r = await contentHandlers['content.research'](ctxFor(refusing), w.data, job(0, 3));
    assert.match(r.reason, /declined/);
    const w2 = await world();
    const none = await contentHandlers['content.research'](
      ctxFor(null, { content: { claude: null, secrets: box } }),
      w2.data,
      job(0, 3),
    );
    assert.match(none.reason, /not set up/);
  });

  test('a pause is continued: the same research asked again with what came back', async () => {
    const w = await world();
    let calls = 0;
    const claude = fakeClaude({
      extract: () => {
        calls += 1;
        return calls === 1
          ? {
              stop_reason: 'pause_turn',
              usage: usage({ server_tool_use: { web_search_requests: 3 } }),
              content: [
                { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
              ],
            }
          : researchMessage([GOOD_FACT]);
      },
    });
    const result = await contentHandlers['content.research'](ctxFor(claude), w.data, job());
    assert.equal(result.verified, 1);
    assert.equal(claude.requests.length, 2);
    assert.equal(claude.requests[1].request.messages.length, 2);
  });
});

describe('brief and draft', () => {
  async function atBriefing() {
    const w = await world();
    await contentHandlers['content.research'](
      ctxFor(fakeClaude({ extract: () => researchMessage([GOOD_FACT]) })),
      w.data,
      job(),
    );
    return w;
  }

  test('a good plan is saved, the title follows it and the draft is queued', async () => {
    const w = await atBriefing();
    const ctx = ctxFor(fakeClaude({ extract: () => textMessage(JSON.stringify(briefJson())) }));
    const result = await contentHandlers['content.brief'](ctx, w.data, job());
    assert.equal(result.sections, 4);
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.deepEqual(
      [got.status, got.format, got.title],
      ['drafting', 'faq', 'How much does a dental crown cost in Austin?'],
    );
    assert.equal(got.brief.version, 'b1');
    assert.deepEqual(
      ctx.jobs.added.map((a) => a.name),
      ['content.draft'],
    );
    const sent = ctx.content.claude.requests[0].request.messages[0].content[0].text;
    assert.match(sent, /\[b1\]/, 'the Brand Kit facts are offered by id');
    assert.match(sent, /\[r1\] A porcelain crown typically costs/);
  });

  test('a plan that breaks the rules is not saved (a heading that is not a question)', async () => {
    const w = await atBriefing();
    const bad = briefJson({
      outline: [section('Crown pricing overview'), section('Is it covered?'), section('How long?')],
    });
    const ctx = ctxFor(fakeClaude({ extract: () => textMessage(JSON.stringify(bad)) }));
    await assert.rejects(
      contentHandlers['content.brief'](ctx, w.data, job()),
      /not usable: rule_broken/,
    );
    assert.equal(await statusOf(w), 'briefing');
  });

  test('the draft is streamed to Redis while it is written and removed after; links to strangers are unwrapped', async () => {
    const w = await atBriefing();
    await contentHandlers['content.brief'](
      ctxFor(fakeClaude({ extract: () => textMessage(JSON.stringify(briefJson())) })),
      w.data,
      job(),
    );
    const redis = fakeRedis();
    const ctx = ctxFor(fakeClaude(), { redis });
    const result = await contentHandlers['content.draft'](ctx, w.data, job());
    assert.equal(result.revision, 1);
    const key = liveKey('test', w.item.id);
    assert.ok(
      redis.sets.some(([k]) => k === key),
      'progress was published',
    );
    assert.equal(redis.values.has(key), false, 'and removed when the stage ended');
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.equal(got.status, 'qc');
    assert.match(got.current.bodyHtml, /<a href="https:\/\/www\.ada\.org\/crowns">ADA guide<\/a>/);
    assert.ok(!got.current.bodyHtml.includes('evil.example'));
    assert.deepEqual(
      ctx.jobs.added.map((a) => a.name),
      ['content.qc'],
    );
    assert.match(ctx.jobs.added[0].opts.jobId, /content-qc-\d+-r1/);
    const system = ctx.content.claude.requests[0].request.system[0].text;
    assert.match(system, /\[needs source\]/);
  });

  test('a draft that was cut off is not kept; a retry writes a new revision', async () => {
    const w = await atBriefing();
    await contentHandlers['content.brief'](
      ctxFor(fakeClaude({ extract: () => textMessage(JSON.stringify(briefJson())) })),
      w.data,
      job(),
    );
    const cut = fakeClaude({
      stream: () => textMessage(draftHtml(), { stop_reason: 'max_tokens' }),
    });
    await assert.rejects(
      contentHandlers['content.draft'](ctxFor(cut), w.data, job(0)),
      /not usable: max_tokens/,
    );
    assert.equal(await statusOf(w), 'drafting');
    assert.equal((await w.scoped.content.get(w.project.id, w.item.id)).revisions.length, 0);
    const ok = await contentHandlers['content.draft'](ctxFor(fakeClaude()), w.data, job(1));
    assert.equal(ok.revision, 1);
  });
});

describe('the check', () => {
  test('scores the draft, builds the structured data from it and makes it ready to review', async () => {
    const w = await world();
    const research = researchMessage([GOOD_FACT]);
    await contentHandlers['content.research'](
      ctxFor(fakeClaude({ extract: () => research })),
      w.data,
      job(),
    );
    await contentHandlers['content.brief'](
      ctxFor(fakeClaude({ extract: () => textMessage(JSON.stringify(briefJson())) })),
      w.data,
      job(),
    );
    await contentHandlers['content.draft'](ctxFor(fakeClaude()), w.data, job());
    const ctx = ctxFor(null);
    const result = await contentHandlers['content.qc'](ctx, w.data, job());
    assert.equal(typeof result.score, 'number');
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.equal(got.status, 'ready');
    assert.equal(got.qcScore, result.score);
    assert.equal(got.qc.revisionId, String(got.currentRevisionId));
    assert.equal(got.qc.checks.length, 7);
    assert.ok(got.jsonld['@graph'].some((n) => n['@type'] === 'FAQPage'));
    assert.ok(got.jsonld['@graph'].some((n) => n['@type'] === 'Article'));
    assert.equal(ctx.jobs.added.length, 0);
    assert.equal(
      (await w.scoped.usage.recent({ limit: 10 })).filter((u) => u.meter === 'llm_content').length,
      3,
      'the check is free: research, plan and draft only',
    );
    const again = await contentHandlers['content.qc'](ctx, w.data, job());
    assert.deepEqual([again.skipped, again.repeated], ['ready', true]);
  });
});

// --- publishing -----------------------------------------------------------------------------------------------------

describe('publishing', () => {
  async function approvedItem({
    pluginConnected = true,
    withRecommendation = true,
    kind = 'new',
    targetUrl = null,
  } = {}) {
    const w = await world({ withRecommendation, kind, targetUrl });
    await w.scoped.content.saveResearch(w.project.id, w.item.id, {
      research: { facts: [], pack: {} },
    });
    await w.scoped.content.saveBrief(w.project.id, w.item.id, {
      brief: {
        ...briefJson({ title: `How much does a crown cost in Austin ${unique()}?` }),
        schemaType: 'Article',
      },
    });
    const html = sanitizeBody(draftHtml()).html;
    const draft = await w.scoped.content.saveDraft(w.project.id, w.item.id, { html });
    await contentHandlers['content.qc'](ctxFor(null), w.data, job());
    const ready = await w.scoped.content.get(w.project.id, w.item.id);
    assert.equal(ready.status, 'ready');
    // a person's check of the draft: nothing blocks it
    await w.scoped.content.approve(w.project.id, w.item.id, {
      userId: w.o.owner.id,
      revisionId: draft.revisionId,
    });
    const approved = await w.scoped.content.get(w.project.id, w.item.id);
    assert.equal(approved.status, 'approved');
    // the connection, as the web process saves it after the handshake
    const context = `wordpress:${w.o.org.id}:${w.project.id}`;
    await createWordPressClient({
      fetcher,
      siteUrl: stub.siteUrl,
      username: stub.username,
      appPassword: stub.appPassword,
    }).plugin.connect({ secret: SECRET });
    await w.scoped.integrations.saveWordpress(w.project.id, {
      config: { siteUrl: stub.siteUrl, username: stub.username, pluginConnected },
      secret: box.encrypt(
        { appPassword: stub.appPassword, hmacSecret: pluginConnected ? SECRET : undefined },
        context,
      ),
      userId: w.o.owner.id,
    });
    return w;
  }

  async function publish(w, mode) {
    const begun = await w.scoped.content.beginPublish(w.project.id, w.item.id, {
      userId: w.o.owner.id,
      mode,
    });
    const ctx = ctxFor(null);
    const result = await contentHandlers['content.publish'](
      ctx,
      { ...w.data, siteChangeId: String(begun.siteChangeId) },
      job(),
    );
    return { result, ctx, begun };
  }

  test('publish: the post goes live with its structured data from the plugin, the recommendation is done with a baseline, and the live page verifies it', async () => {
    const w = await approvedItem();
    const { result, ctx } = await publish(w, 'publish');
    assert.equal(result.outcome, 'published');
    assert.deepEqual(result.warnings, []);
    assert.equal(result.recommendation, 'done');
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.equal(got.status, 'published');
    assert.match(got.publishedUrl, /how-much-does-a-crown-cost-in-austin/);
    assert.equal(got.cmsRef, String([...stub.state.posts.keys()].at(-1)));
    const post = stub.state.posts.get(Number(got.cmsRef));
    assert.equal(post.status, 'publish');
    assert.ok(
      !post.content.includes('ld+json'),
      'with the plugin the structured data is not in the post body',
    );
    assert.ok(stub.state.schemas.has(got.publishedUrl), 'it is stored in the plugin for the page');
    assert.deepEqual(stub.state.indexNowPings.slice(-1), [got.publishedUrl]);
    const [change] = await w.scoped.content.siteChanges(w.project.id, w.item.id);
    assert.deepEqual([change.kind, change.status], ['post_create', 'applied']);

    // 7.12: marking the recommendation done saved the baseline and queued the live-page check
    const rec = await w.scoped.recommendations.load(w.rec.id);
    assert.equal(rec.status, 'done');
    assert.ok(rec.baseline);
    assert.equal(rec.doneAt instanceof Date, true);
    const checks = await w.scoped.recommendations.verificationsOf(w.project.id, w.rec.id);
    assert.deepEqual(
      [checks[0].method, checks[0].targetUrl, checks[0].status],
      ['url_live', got.publishedUrl, 'pending'],
    );
    assert.deepEqual(
      ctx.jobs.added.map((a) => [a.name, a.data.attempt]),
      [['fix.verify', 1]],
    );

    // the check itself: the crawler fetches the page as it is, and it is there
    const verifyCtx = ctxFor(null);
    const verified = await actionHandlers['fix.verify'](
      verifyCtx,
      { orgId: w.data.orgId, recommendationId: String(w.rec.id), attempt: 1 },
      job(),
    );
    assert.deepEqual([verified.verdict, verified.status], ['verified', 'measuring']);
  });

  test('without the plugin the structured data is inside the post; the live check then tells the truth about whether WordPress kept it', async () => {
    const w = await approvedItem({ pluginConnected: false });
    const { result } = await publish(w, 'publish');
    assert.equal(result.outcome, 'published');
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.match(
      stub.state.posts.get(Number(got.cmsRef)).content,
      /<script type="application\/ld\+json">/,
    );
    assert.equal(
      stub.state.schemas.has(got.publishedUrl),
      false,
      'nothing was stored in a plugin that is not there',
    );
    const verified = await actionHandlers['fix.verify'](
      ctxFor(null),
      { orgId: w.data.orgId, recommendationId: String(w.rec.id), attempt: 1 },
      job(),
    );
    assert.equal(verified.verdict, 'verified');
  });

  test('a draft saved in WordPress leaves the item approved and the recommendation untouched; publishing later updates the same post', async () => {
    const w = await approvedItem();
    const first = await publish(w, 'draft');
    assert.equal(first.result.outcome, 'drafted');
    assert.equal(first.result.recommendation, 'not_live');
    let got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.deepEqual([got.status, got.publishedAt], ['approved', null]);
    assert.equal(stub.state.posts.get(Number(got.cmsRef)).status, 'draft');
    assert.equal((await w.scoped.recommendations.load(w.rec.id)).status, 'open');
    const count = stub.state.posts.size;
    const second = await publish(w, 'publish');
    assert.equal(second.result.outcome, 'published');
    assert.equal(stub.state.posts.size, count, 'the same post was updated, not duplicated');
    got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.equal(got.status, 'published');
    assert.equal((await w.scoped.recommendations.load(w.rec.id)).status, 'done');
  });

  test('a wrong application password fails the item in plain words, marks the connection broken, and keeps the approval', async () => {
    const w = await approvedItem({ withRecommendation: false });
    const context = `wordpress:${w.o.org.id}:${w.project.id}`;
    await w.scoped.integrations.saveWordpress(w.project.id, {
      config: { siteUrl: stub.siteUrl, username: stub.username, pluginConnected: true },
      secret: box.encrypt({ appPassword: 'not the password', hmacSecret: SECRET }, context),
    });
    const { result } = await publish(w, 'publish');
    assert.equal(result.failed, true);
    assert.match(result.reason, /did not accept that user name and application password/);
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.deepEqual([got.status, got.failedStage], ['failed', 'publishing']);
    assert.equal(got.approvedRevisionId !== null, true);
    assert.equal((await w.scoped.integrations.wordpress(w.project.id)).status, 'broken');
    const [change] = await w.scoped.content.siteChanges(w.project.id, w.item.id);
    assert.equal(change.status, 'failed', 'the change is not left "working" for ever');
    assert.match(change.lastError, /application password/);
    assert.deepEqual(await w.scoped.content.retry(w.project.id, w.item.id), { to: 'approved' });
  });

  test('a refresh updates the existing page in place (found from its address), never a second post, and a refresh cannot be saved as a draft', async () => {
    const page = stub.addPage({ title: 'Old crowns page', slug: `crowns-${unique()}` });
    const w = await approvedItem({ kind: 'refresh', targetUrl: page.link });
    await assert.rejects(
      w.scoped.content.beginPublish(w.project.id, w.item.id, {
        userId: w.o.owner.id,
        mode: 'draft',
      }),
      (e) => e.code === 'BAD_MODE',
    );
    assert.equal(await statusOf(w), 'approved', 'refused before anything changed');
    const before = stub.state.posts.size;
    const { result } = await publish(w, 'publish');
    assert.equal(result.outcome, 'published');
    assert.equal(stub.state.posts.size, before, 'no second post');
    const updated = stub.state.posts.get(page.id);
    assert.match(updated.content, /How much does a crown cost\?/);
    assert.equal(updated.status, 'publish', 'a live page stays live');
    const got = await w.scoped.content.get(w.project.id, w.item.id);
    assert.deepEqual(
      [got.status, got.cmsRef, got.publishedUrl],
      ['published', String(page.id), page.link],
    );
    assert.equal(result.recommendation, 'done');
  });

  test('a refresh of an address WordPress does not know, or without the plugin, changes nothing and says why', async () => {
    const missing = await approvedItem({
      kind: 'refresh',
      targetUrl: `${stub.siteUrl}/there-is-no-such-page/`,
      withRecommendation: false,
    });
    const before = stub.state.posts.size;
    const notFound = await publish(missing, 'publish');
    assert.match(notFound.result.reason, /could not find that page on your WordPress site/);
    assert.equal(await statusOf(missing), 'failed');
    const noPlugin = await approvedItem({
      kind: 'refresh',
      targetUrl: `${stub.siteUrl}/anything/`,
      pluginConnected: false,
      withRecommendation: false,
    });
    const refused = await publish(noPlugin, 'publish');
    assert.match(refused.result.reason, /need the AEO Corner plugin/);
    assert.equal(stub.state.posts.size, before, 'nothing was created');
  });

  test('a refresh of a kind of page we cannot update is refused', async () => {
    const odd = stub.addPage({ title: 'A product', slug: `product-${unique()}`, type: 'product' });
    const w = await approvedItem({
      kind: 'refresh',
      targetUrl: odd.link,
      withRecommendation: false,
    });
    const { result } = await publish(w, 'publish');
    assert.match(result.reason, /only posts and pages/);
    assert.equal(stub.state.posts.get(odd.id).content, '<p>The old page.</p>');
  });

  test('a site that is down is retried; on the last attempt the item fails and nothing was made live', async () => {
    const w = await approvedItem({ withRecommendation: false });
    const begun = await w.scoped.content.beginPublish(w.project.id, w.item.id, {
      userId: w.o.owner.id,
      mode: 'publish',
    });
    stub.failNext(500);
    await assert.rejects(
      contentHandlers['content.publish'](
        ctxFor(null),
        { ...w.data, siteChangeId: String(begun.siteChangeId) },
        job(0, 3),
      ),
      (e) => e.code === 'server_error',
    );
    assert.equal(await statusOf(w), 'publishing');
    stub.failNext(500);
    const final = await contentHandlers['content.publish'](
      ctxFor(null),
      { ...w.data, siteChangeId: String(begun.siteChangeId) },
      job(2, 3),
    );
    assert.equal(final.failed, true);
    assert.equal(await statusOf(w), 'failed');
  });

  test('structured data that no longer validates is never sent', async () => {
    const w = await approvedItem({ withRecommendation: false });
    const before = stub.state.posts.size;
    await fx.forceContent(w.item.id, {
      jsonld: { '@context': 'https://schema.org', '@type': 'Article' },
    });
    const { result } = await publish(w, 'publish');
    assert.match(result.reason, /structured data did not pass/);
    assert.equal(stub.state.posts.size, before);
  });

  test("another change's job, or a repeated job, does nothing", async () => {
    const w = await approvedItem({ withRecommendation: false });
    const { begun } = await publish(w, 'draft');
    const repeat = await contentHandlers['content.publish'](
      ctxFor(null),
      { ...w.data, siteChangeId: String(begun.siteChangeId) },
      job(),
    );
    assert.equal(repeat.repeated, true);
  });
});

describe('the connection test and the reasons given', () => {
  test('the test reads the site and who the login is, and records what it found', async () => {
    const w = await world();
    const context = `wordpress:${w.o.org.id}:${w.project.id}`;
    await createWordPressClient({
      fetcher,
      siteUrl: stub.siteUrl,
      username: stub.username,
      appPassword: stub.appPassword,
    }).plugin.connect({ secret: SECRET });
    await w.scoped.integrations.saveWordpress(w.project.id, {
      config: { siteUrl: stub.siteUrl, username: stub.username, pluginConnected: true },
      secret: box.encrypt({ appPassword: stub.appPassword, hmacSecret: SECRET }, context),
    });
    const result = await contentHandlers['wordpress.test'](
      ctxFor(null),
      { orgId: w.data.orgId, projectId: w.data.projectId },
      job(),
    );
    assert.deepEqual([result.ok, result.pluginInstalled, result.canPublish], [true, true, true]);
    const seen = await w.scoped.integrations.wordpress(w.project.id);
    assert.deepEqual(
      [seen.status, seen.config.siteName, seen.config.pluginVersion, seen.config.seoPlugin],
      ['connected', 'Stub Site', '1.1.0', 'yoast'],
    );
    await w.scoped.integrations.saveWordpress(w.project.id, {
      config: { siteUrl: stub.siteUrl, username: stub.username },
      secret: box.encrypt({ appPassword: 'wrong' }, context),
    });
    const broken = await contentHandlers['wordpress.test'](
      ctxFor(null),
      { orgId: w.data.orgId, projectId: w.data.projectId },
      job(),
    );
    assert.deepEqual([broken.ok, broken.code], [false, 'auth_failed']);
    assert.equal((await w.scoped.integrations.wordpress(w.project.id)).status, 'broken');
  });

  test('a plugin installed after the site was connected gets its secret from the check, and the new secret is stored encrypted', async () => {
    const w = await world();
    const context = `wordpress:${w.o.org.id}:${w.project.id}`;
    await w.scoped.integrations.saveWordpress(w.project.id, {
      config: { siteUrl: stub.siteUrl, username: stub.username, pluginConnected: false },
      secret: box.encrypt({ appPassword: stub.appPassword }, context),
      userId: w.o.owner.id,
    });
    const result = await contentHandlers['wordpress.test'](
      ctxFor(null),
      { orgId: w.data.orgId, projectId: w.data.projectId },
      job(),
    );
    assert.deepEqual([result.ok, result.handshake, result.pluginConnected], [true, true, true]);
    const seen = await w.scoped.integrations.wordpress(w.project.id);
    assert.deepEqual([seen.config.pluginConnected, seen.config.pluginVersion], [true, '1.1.0']);
    const stored = await w.scoped.integrations.wordpressSecret(w.project.id);
    const creds = box.decryptJson(stored.secret, context);
    assert.equal(creds.appPassword, stub.appPassword, 'the login is kept');
    assert.equal(creds.hmacSecret, stub.state.secret, 'and the plugin was given the new secret');
    // from now on signed calls work, and a second check needs no new handshake
    const again = await contentHandlers['wordpress.test'](
      ctxFor(null),
      { orgId: w.data.orgId, projectId: w.data.projectId },
      job(),
    );
    assert.equal(again.handshake, false);
  });

  test('reasons are plain words, never raw errors', () => {
    const cases = [
      [
        new ProviderError('anthropic: HTTP 503 secret-thing', { status: 'http_503' }),
        /busy or unavailable/,
      ],
      [new ProviderError('x', { status: 'auth', retryable: false }), /did not accept our key/],
      [new UnrecoverableError('ANTHROPIC_API_KEY missing on host abc'), /not set up/],
      [new Error('ECONNRESET at 10.0.0.1'), /went wrong on our side/],
    ];
    for (const [err, pattern] of cases) {
      const text = plainReason(err, 'drafting');
      assert.match(text, pattern);
      assert.ok(!/10\.0\.0\.1|ANTHROPIC|secret-thing/.test(text));
    }
    assert.match(plainReason(new Error('x'), 'publishing'), /Nothing was made live/);
  });
});
