import { UnrecoverableError } from 'bullmq';
import { chooseRoute } from '../../core/routing.js';
import { buildFixList } from '../../core/fix-list.js';
import { fromMicros, toMicros } from '../../core/spend.js';
import { aeoScore, scoreVisibility, VISIBILITY_VERSION } from '../../core/visibility.js';
import { runSiteScan } from '../../crawler/scan.js';
import { RUBRIC_VERSION } from '../../crawler/readiness/rubric.js';
import { collectTaskSchema, ProviderError } from '../../engines/contract.js';
import { storeRaw } from '../../integrations/spaces.js';
import { BRAND_KIT_VERSION, buildBrandKitRequest, readBrandKitReply } from '../../llm/brand-kit.js';
import {
  buildExtractionRequest,
  extractionVersion,
  mergeReading,
  readReply,
  trackedEntities,
} from '../../llm/extraction.js';
import { costMicros, modelProfile } from '../../llm/models.js';
import { normalizeDomain } from '../../llm/names.js';
import { runPrepass } from '../../llm/prepass.js';
import {
  buildQuestionsRequest,
  QUESTIONS_VERSION,
  readQuestionsReply,
} from '../../llm/questions.js';
import { Deferral } from '../deferral.js';
import { ledgerKey } from '../provider-call.js';

/**
 * Handler for the `audit` queue: one free audit, from a verified request to a finished report (MVP F1, §7.6):
 *
 *   1. admit    the daily audit budget (checked once, when the audit is first picked up: an audit that has
 *               started always finishes)
 *   2. scan     read the site and score its AI readiness, with no organization on any row (the free audit obeys
 *               robots.txt, ADR-0005)
 *   3. setup    the lite Brand Kit and the five questions, from the pages the scan read
 *   4. answers  four engines × five questions, in live mode, each read at once by the pre-pass and Claude
 *   5. score    visibility, the AEO Score and the top five fixes, saved with the audit's cost from the ledger
 *   6. email    "your report is ready", once
 *
 * Every step can be repeated: a retried job finds what it already saved and skips it (the scan is written once, an
 * answer is one row per question and engine, a ledger key is one charge, the email is marked as sent). An answer we
 * could not get is `failed` and the scores leave it out: it is "couldn't check", never "not mentioned", and the
 * audit is `partial`, not `complete`.
 *
 * It goes through `callProvider` like every other paid call, as an audit rather than an organization.
 */

export const AUDIT_ENGINES = Object.freeze(['chatgpt', 'perplexity', 'gemini', 'google_aio']);
export const AUDIT_LOCALE = Object.freeze({ country: 'US', language: 'en' });
const CELL_CONCURRENCY = 5;
const FINAL = new Set(['complete', 'partial', 'failed']);

/** An audit is not done until every question has an answer from every engine, or a reason there isn't one. */
const isSettled = (row) => row.status !== 'pending';

const configured = (ctx) => {
  const { crawler, collection, extraction, audit } = ctx;
  if (!crawler?.fetcher || !crawler?.store) {
    throw new UnrecoverableError('The crawler is not configured on this worker');
  }
  if (!collection?.adapters || !collection?.store) {
    throw new UnrecoverableError('Answer collection is not configured on this worker');
  }
  if (!extraction?.claude) {
    throw new UnrecoverableError('Claude is not configured on this worker (ANTHROPIC_API_KEY)');
  }
  if (!audit?.budget)
    throw new UnrecoverableError('The audit budget is not configured on this worker');
  return {
    claude: extraction.claude,
    setupProfile: modelProfile(audit.setupModel ?? 'haiku45'),
    readProfile: modelProfile(audit.extractionModel ?? extraction.model ?? 'opus55'),
  };
};

const claudeUsage = (profile, usage, { meter, auditId }) => ({
  meter,
  unit: 'request',
  quantity: 1,
  model: profile.id,
  tokensIn: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  tokensOut: usage.output_tokens ?? 0,
  tokensCached: usage.cache_read_input_tokens ?? 0,
  costUsd: fromMicros(costMicros(profile, usage)),
  refType: 'audit',
  refId: auditId,
});

const reasonOf = (err) =>
  `${err?.status ?? err?.name ?? 'error'}: ${String(err?.message ?? '').slice(0, 200)}`;

async function auditRun(ctx, data, job) {
  const auditId = BigInt(data.auditId);
  const audit = await ctx.db.audits.get(auditId);
  if (!audit) throw new UnrecoverableError(`Audit ${data.auditId} was not found`);
  if (FINAL.has(audit.status)) {
    // A duplicate job, or a retry after the report was saved. The one thing left to do is the email, if it failed.
    await sendReport(ctx, audit);
    return { auditId: data.auditId, status: audit.status, repeated: true };
  }
  if (audit.status === 'awaiting_verification') {
    throw new UnrecoverableError(`Audit ${data.auditId} has not been verified`);
  }
  const deps = configured(ctx);

  // The same site was audited in the last 24 hours: serve that result. It costs nothing, so it is also served on a
  // day the budget is spent.
  if (audit.status === 'queued') {
    const source = await ctx.db.audits.findReusable({
      domain: audit.domain,
      competitorDomain: audit.competitor_domain,
      excludeAuditId: audit.id,
      now: ctx.now(),
    });
    if (source && (await ctx.db.audits.completeFromCache(audit.id, source))) {
      await sendReport(ctx, await ctx.db.audits.get(audit.id));
      return { auditId: data.auditId, status: 'complete', cachedFrom: String(source.id) };
    }
  }

  // A new audit waits for tomorrow if the budget is spent. One already running (a retry) finishes.
  if (audit.status === 'queued') {
    const verdict = await ctx.audit.budget.admit();
    if (!verdict.open) {
      throw new Deferral(verdict.until.getTime() - ctx.now().getTime(), 'daily audit budget spent');
    }
  }
  await ctx.db.audits.start(auditId);

  try {
    const setup = await ensureSetup(ctx, deps, job, audit);
    if (setup.failed) {
      await ctx.db.audits.fail(auditId, setup.failed);
      return { auditId: data.auditId, status: 'failed', reason: setup.failed };
    }
    await collectAnswers(ctx, deps, job, audit, setup);
    const outcome = await finishAudit(ctx, deps, audit, setup);
    const fresh = await ctx.db.audits.get(auditId);
    await sendReport(ctx, fresh);
    return { auditId: data.auditId, ...outcome };
  } catch (err) {
    if (err instanceof Deferral) throw err;
    const giveUp =
      err instanceof UnrecoverableError || (err instanceof ProviderError && !err.retryable);
    const lastAttempt = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
    if (giveUp || lastAttempt) {
      await ctx.db.audits.fail(auditId, reasonOf(err)).catch(() => {});
    }
    if (giveUp && !(err instanceof UnrecoverableError)) throw new UnrecoverableError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 2 + 3. The scan, the Brand Kit and the questions

/**
 * Returns `{ kit, questions }`, or `{ failed: 'reason' }` when the site could not be read at all (a finished audit
 * of nothing would be a score of nothing). The scan is run again if a retry finds it done but the setup not saved,
 * because the pages the Brand Kit reads are not stored: they are in the scan's result.
 */
async function ensureSetup(ctx, deps, job, audit) {
  if (audit.brand_kit_lite && audit.prompts) {
    return { kit: audit.brand_kit_lite, questions: audit.prompts };
  }

  const scanRow = await ctx.db.audits.scans.start({
    auditId: audit.id,
    rubricVersion: RUBRIC_VERSION,
  });
  const crawler = ctx.crawler;
  const result = await runSiteScan(
    crawler.targetFor ? crawler.targetFor(audit.domain) : audit.domain,
    {
      fetcher: crawler.fetcher,
      renderer: crawler.renderer ?? null,
      store: crawler.store,
      now: ctx.now,
      // The free audit reads strangers' sites, so robots.txt applies (ADR-0005): `respectRobots` stays at its default.
      log: (event, details) =>
        ctx.logger.debug({ audit: String(audit.id), event, ...details }, 'audit scan'),
    },
  );
  await ctx.db.audits.scans.finish(scanRow.id, result);
  await ctx.db.audits.ledger.record(audit.id, {
    meter: 'crawl',
    providerCode: 'crawler',
    unit: 'request',
    quantity: result.connections.length,
    costUsd: '0',
    idempotencyKey: ledgerKey('audit', job, 'crawl'),
  });
  if (result.status === 'failed' || !result.brandPages?.length)
    return { failed: 'site_unreadable' };

  const call = (step, meter, request, profile) =>
    ctx.callProvider(
      job,
      {
        auditId: String(audit.id),
        provider: 'anthropic',
        scope: 'audit',
        idempotencyKey: ledgerKey('audit', job, `${step}${job.attemptsMade}`),
      },
      async () => {
        const reply = await deps.claude.extract(request);
        return {
          value: reply,
          usage: claudeUsage(profile, reply.usage ?? {}, { meter, auditId: audit.id }),
        };
      },
    );

  const { value: kitMessage } = await call(
    'kit',
    'llm_brand_kit',
    buildBrandKitRequest({
      profile: deps.setupProfile,
      domain: audit.domain,
      pages: result.brandPages,
    }),
    deps.setupProfile,
  );
  const kitRead = readBrandKitReply(kitMessage, { domain: audit.domain });
  if (!kitRead.ok) throw unusableReply('the Brand Kit', kitRead);

  const { value: questionsMessage } = await call(
    'questions',
    'llm_prompts',
    buildQuestionsRequest({ profile: deps.setupProfile, kit: kitRead.kit }),
    deps.setupProfile,
  );
  const questionsRead = readQuestionsReply(questionsMessage, { brandName: kitRead.kit.brand_name });
  if (!questionsRead.ok) throw unusableReply('the questions', questionsRead);

  const kit = {
    ...kitRead.kit,
    version: BRAND_KIT_VERSION,
    questionsVersion: QUESTIONS_VERSION,
  };
  await ctx.db.audits.saveSetup(audit.id, {
    brandKitLite: kit,
    prompts: questionsRead.questions,
    suggestedCompetitors: kit.competitors,
  });
  return { kit, questions: questionsRead.questions };
}

/** A reply we can't use may be fine on the next try (Claude's wording varies), so it is a retryable error. */
const unusableReply = (what, read) =>
  new ProviderError(`Claude's reply for ${what} was not usable: ${read.reason}`, {
    status: `unusable_${read.reason}`,
    countsAgainstProvider: false,
  });

// ---------------------------------------------------------------------------------------------------------------
// 4. Four engines × five questions

const lastAttemptOf = (job) => job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);

async function collectAnswers(ctx, deps, job, audit, setup) {
  const rows = new Map(
    (await ctx.db.audits.answers(audit.id)).map((r) => [`${r.prompt_idx}:${r.engine_code}`, r]),
  );
  const cells = setup.questions
    .flatMap((question) => AUDIT_ENGINES.map((engine) => ({ question, engine })))
    .map((cell) => ({
      ...cell,
      earlier: rows.get(`${cell.question.promptIdx}:${cell.engine}`) ?? null,
    }))
    // A settled answer is done. One still "pending" was asked and stored but not read yet: it resumes from the
    // stored answer instead of being asked (and paid for) again.
    .filter((cell) => !cell.earlier || !isSettled(cell.earlier));
  if (cells.length === 0) return;

  const entities = trackedEntities([
    {
      id: 1n,
      kind: 'brand',
      name: setup.kit.brand_name,
      aliases: setup.kit.aliases ?? [],
      domains: [audit.domain],
    },
    ...(setup.kit.competitors ?? []).map((c, i) => ({
      id: BigInt(2 + i),
      kind: 'competitor',
      name: c.name,
      domains: c.domain ? [c.domain] : [],
    })),
  ]);

  // A pool: a few cells at a time. A wait (a Deferral) stops new cells and is thrown once the running ones finish,
  // so what was already collected is kept; a transient error leaves its cell for the next attempt.
  const queue = [...cells];
  let deferral = null;
  const transient = [];
  const run = async () => {
    for (let cell = queue.shift(); cell && !deferral; cell = queue.shift()) {
      try {
        await collectCell(ctx, deps, job, audit, { ...cell, entities });
      } catch (err) {
        if (err instanceof Deferral) deferral ??= err;
        else if (
          err instanceof UnrecoverableError ||
          (err instanceof ProviderError && !err.retryable)
        ) {
          await saveFailed(ctx, audit, cell, err);
        } else transient.push({ cell, err });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CELL_CONCURRENCY, cells.length) }, run));
  if (deferral) throw deferral;
  if (transient.length > 0) {
    if (!lastAttemptOf(job)) throw transient[0].err;
    for (const { cell, err } of transient) await saveFailed(ctx, audit, cell, err);
  }
}

const saveFailed = (ctx, audit, { question, engine, earlier }, err) =>
  ctx.db.audits.saveAnswer(audit.id, {
    promptIdx: question.promptIdx,
    engineCode: engine,
    providerCode: earlier?.provider_code ?? err?.provider ?? 'unknown',
    method: earlier?.method ?? 'serp',
    status: 'failed',
    rawUri: earlier?.raw_uri ?? null,
    textExcerpt: reasonOf(err),
    brandPresent: null,
    costUsd: earlier?.cost_usd ?? 0,
  });

/**
 * One engine's answer to one question: ask it (unless an earlier attempt already did), keep the raw answer, save it
 * as pending, then read it and complete it. Saving before reading is what keeps a Claude outage from costing a
 * second paid ask: the retry reads the stored answer.
 */
async function collectCell(
  ctx,
  deps,
  job,
  audit,
  { question, engine: engineCode, entities, earlier },
) {
  const { store } = ctx.collection;
  const engine = await ctx.db.reference.engines.get(engineCode);
  if (!engine) throw new UnrecoverableError(`Unknown engine ${engineCode}`);
  const useQuery = engine.queryField === 'search_query';
  const step = `c${question.promptIdx}-${engine.code}`;
  const callFor = (provider, suffix, engineKey = engine.code) => ({
    auditId: String(audit.id),
    provider,
    engine: engineKey,
    scope: 'audit',
    idempotencyKey: ledgerKey('audit', job, `${step}.${suffix}`),
  });

  let answer; // { normalized, base, askCostMicros }
  if (earlier?.raw_uri) {
    answer = await resume(store, earlier);
  } else {
    answer = await ask(ctx, job, audit, { question, engine, useQuery, callFor, store });
    if (answer.noAnswer) {
      await ctx.db.audits.saveAnswer(audit.id, {
        ...answer.base,
        status: 'no_answer',
        costUsd: fromMicros(answer.askCostMicros),
      });
      return;
    }
    await ctx.db.audits.saveAnswer(audit.id, {
      ...answer.base,
      status: 'pending',
      textExcerpt: answer.normalized.text,
      costUsd: fromMicros(answer.askCostMicros),
    });
  }
  const { normalized, base, askCostMicros } = answer;

  // Read it now, with the pre-pass and Claude together, as a project's answers are (ADR-0007).
  const prepass = runPrepass(normalized, entities);
  const prepassBrand = prepass.mentions.some((m) => m.entity.kind === 'brand');
  let reading = null;
  let readCostMicros = 0;
  try {
    const request = buildExtractionRequest({
      profile: deps.readProfile,
      entities,
      question: useQuery && question.searchQuery ? question.searchQuery : question.text,
      engine: engine.code,
      text: normalized.text,
      citations: prepass.citations,
    });
    const { value: message } = await ctx.callProvider(
      job,
      callFor('anthropic', `read${job.attemptsMade}`, ''),
      async () => {
        const reply = await deps.claude.extract(request);
        return {
          value: reply,
          usage: claudeUsage(deps.readProfile, reply.usage ?? {}, {
            meter: 'llm_extract',
            auditId: audit.id,
          }),
        };
      },
    );
    readCostMicros = costMicros(deps.readProfile, message.usage ?? {});
    const reply = readReply(message);
    if (reply.ok) reading = reply.reading;
    else {
      ctx.logger.warn(
        { audit: String(audit.id), step, reason: reply.reason },
        'audit answer not read by Claude',
      );
    }
  } catch (err) {
    // A wait, or a failure worth another try: the answer is saved as pending, so the retry only reads it.
    if (err instanceof Deferral) throw err;
    if (!(err instanceof ProviderError)) throw err;
    if (err.retryable && !lastAttemptOf(job)) throw err;
    ctx.logger.warn(
      { audit: String(audit.id), step, err: err.message },
      'audit answer not read by Claude',
    );
  }

  const plan = reading ? mergeReading({ entities, prepass, reading, text: normalized.text }) : null;
  const brand = plan ? plan.mentions.find((m) => m.entityKind === 'brand') : null;
  // With no reading from Claude only the pre-pass speaks: a brand it found is present, and a brand it missed is not
  // "absent" (Claude might have found it), so brand_present stays unknown rather than false.
  const brandPresent = plan ? Boolean(brand) : prepassBrand ? true : null;
  const citations = (plan?.citations ?? prepass.citations).slice(0, 30).map((c) => ({
    url: c.url,
    domain: c.domain ?? null,
    title: c.title ?? null,
    isOwn: plan ? c.isOwn : c.owner?.kind === 'brand',
  }));

  await ctx.db.audits.saveAnswer(audit.id, {
    ...base,
    status: 'ok',
    textExcerpt: normalized.text,
    brandPresent,
    brandRank: brand?.listRank ?? null,
    brandStance: brand?.stance ?? null,
    entities: plan
      ? plan.mentions.map((m) => ({
          name: m.entityKind === 'discovered' ? m.discoveredName : m.nameAsWritten,
          kind: m.entityKind,
          rank: m.listRank,
          stance: m.stance,
        }))
      : null,
    citations,
    costUsd: fromMicros(askCostMicros + readCostMicros),
  });
}

/** An answer an earlier attempt asked for and stored, read back from the bucket. */
async function resume(store, row) {
  const object = await store.get(row.raw_uri);
  if (!object) {
    throw new ProviderError('the stored answer is missing', { status: 'store_missing' });
  }
  const normalized = JSON.parse(object.body.toString('utf8'))?.normalized;
  if (typeof normalized?.text !== 'string' || !Array.isArray(normalized.sources)) {
    throw new ProviderError('the stored answer has no normalized reading', {
      status: 'bad_response',
      retryable: false,
    });
  }
  return {
    normalized,
    askCostMicros: toMicros(row.cost_usd),
    base: {
      promptIdx: row.prompt_idx,
      engineCode: row.engine_code,
      providerCode: row.provider_code,
      method: row.method,
      modelVersion: row.model_version,
      rawUri: row.raw_uri,
      collectedAt: row.collected_at,
    },
  };
}

/** Route, ask in live mode, keep the raw answer. Returns the answer, or `noAnswer` when the engine said it had none. */
async function ask(ctx, job, audit, { question, engine, useQuery, callFor, store }) {
  const { adapters } = ctx.collection;
  const route = await chooseRoute(engine, async (provider, code) => {
    if (!adapters.has(provider, code)) return 'deny';
    const { state } = await ctx.health.state(provider, code);
    return state === 'open' ? 'deny' : 'allow';
  });
  if (!route) {
    if (!adapters.list().some((a) => a.engine === engine.code)) {
      throw new ProviderError(`No provider is configured for ${engine.code}`, {
        status: 'no_provider',
        retryable: false,
        countsAgainstProvider: false,
      });
    }
    throw new Deferral(60_000, `every provider for ${engine.code} is unavailable`);
  }
  const adapter = adapters.get(route.provider, engine.code);
  const task = collectTaskSchema.parse({
    ref: `a${audit.id}-${question.promptIdx}`,
    engine: engine.code,
    text: question.text,
    searchQuery: question.searchQuery,
    ...AUDIT_LOCALE,
    city: '',
    mode: 'live',
  });

  const { value: handle } = await ctx.callProvider(
    job,
    callFor(adapter.provider, `ask${job.attemptsMade}`),
    async () => {
      const h = await adapter.submit(task);
      return {
        value: h,
        usage: {
          meter: useQuery ? 'serp' : 'answer_collect',
          unit: useQuery ? 'search' : 'result',
          quantity: h.quantity ?? 1,
          model: h.model ?? null,
          tokensIn: h.tokensIn ?? null,
          tokensOut: h.tokensOut ?? null,
          costUsd: fromMicros(h.costMicros),
          refType: 'audit',
          refId: audit.id,
        },
      };
    },
  );
  // The audit asks in live mode, which answers at once. A provider that queued the question instead is not usable
  // here: the visitor is waiting and the charge is already made, so this is a failed cell, not a wait.
  if (!handle.raw) {
    const err = new ProviderError(`${adapter.provider} queued a live question`, {
      status: 'not_live',
      retryable: false,
      countsAgainstProvider: false,
    });
    err.provider = adapter.provider;
    throw err;
  }

  const collectedAt = ctx.now();
  let normalized = null;
  let readError = null;
  try {
    normalized = adapter.normalize(handle.raw, task);
  } catch (err) {
    readError = err;
  }
  // Raw-first: the provider's bytes are kept even when we can't read them.
  const stored = await storeRaw(store, {
    kind: 'answer',
    body: JSON.stringify({
      format: 'aeo-corner.answer.v1',
      provider: adapter.provider,
      engine: adapter.engine,
      method: adapter.method,
      providerRef: handle.providerRef ?? null,
      locale: AUDIT_LOCALE,
      mode: 'live',
      raw: handle.raw,
      normalized,
      readError: readError ? String(readError.message).slice(0, 300) : null,
    }),
    contentType: 'application/json',
    url: `${adapter.provider}/${adapter.engine}`,
    status: normalized?.status ?? 'unreadable',
    fetchedAt: collectedAt,
  });
  if (readError) {
    const err =
      readError instanceof ProviderError
        ? readError
        : new ProviderError(`${adapter.provider}/${adapter.engine}: ${readError.message}`, {
            status: 'bad_response',
          });
    err.retryable = false; // the same bytes will be just as unreadable next time
    err.provider = adapter.provider;
    throw err;
  }
  return {
    normalized,
    noAnswer: normalized.status === 'no_answer',
    askCostMicros: handle.costMicros ?? 0,
    base: {
      promptIdx: question.promptIdx,
      engineCode: engine.code,
      providerCode: adapter.provider,
      method: adapter.method,
      modelVersion: normalized.modelVersion,
      rawUri: stored.key,
      collectedAt,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 5. Scores and fixes

async function finishAudit(ctx, deps, audit, setup) {
  const rows = await ctx.db.audits.answers(audit.id);
  const scan = await ctx.db.audits.scans.forAudit(audit.id);
  const checkRows = scan ? await ctx.db.audits.scans.checks(scan.id) : [];
  const checks = checkRows.map((c) => ({
    code: c.check_code,
    status: c.status,
    points: Number(c.points_awarded),
    possible: Number(c.points_possible),
    summary: c.evidence?.summary ?? '',
  }));

  const answers = rows.map((r) => {
    const entities = Array.isArray(r.entities) ? r.entities : [];
    const citations = Array.isArray(r.citations) ? r.citations : [];
    return {
      promptIdx: r.prompt_idx,
      engineCode: r.engine_code,
      status: r.status,
      brandPresent: r.brand_present,
      brandRank: r.brand_rank,
      brandStance: r.brand_stance,
      domainCited: citations.some((c) => c.isOwn),
      competitorsNamed: entities
        .filter((e) => e.kind === 'competitor' || e.kind === 'discovered')
        .map((e) => e.name),
      citedDomains: [
        ...new Set(
          citations.filter((c) => !c.isOwn && c.domain).map((c) => normalizeDomain(c.domain)),
        ),
      ].filter(Boolean),
    };
  });

  const visibility = scoreVisibility(answers);
  const readiness = scan?.readiness_score ?? null;
  const total = setup.questions.length * AUDIT_ENGINES.length;
  const settled = rows.filter((r) => r.status === 'ok' || r.status === 'no_answer').length;
  const complete =
    rows.length === total && settled === total && readiness !== null && visibility.score !== null;

  const status = complete ? 'complete' : 'partial';
  await ctx.db.audits.finish(audit.id, {
    status,
    readinessScore: readiness,
    visibilityScore: visibility.score,
    aeoScore: aeoScore({ readiness, visibility: visibility.score }),
    subScores: {
      visibilityVersion: VISIBILITY_VERSION,
      perEngine: visibility.perEngine,
      coverage: visibility.coverage,
      mentioned: visibility.mentioned,
      unreadable: visibility.unreadable,
      noAnswer: visibility.noAnswer,
    },
    topFixes: buildFixList({ checks, answers, brandName: setup.kit.brand_name }),
    rubricVersion: scan?.rubric_version ?? RUBRIC_VERSION,
    extractionVersion: extractionVersion(deps.readProfile),
    costUsd: fromMicros(await ctx.db.audits.ledger.costMicros(audit.id)),
  });
  return { status, readinessScore: readiness, visibilityScore: visibility.score };
}

// ---------------------------------------------------------------------------------------------------------------
// 6. The email

/** "Your report is ready", once. A failed send is retried by the job; a send that was recorded is not repeated. */
async function sendReport(ctx, audit) {
  const mail = ctx.audit?.mail;
  if (
    !mail ||
    !audit.lead_id ||
    audit.report_emailed_at ||
    !['complete', 'partial'].includes(audit.status)
  ) {
    return;
  }
  const lead = await ctx.db.leads.get(audit.lead_id);
  if (!lead) return;
  try {
    await mail.sendReportReady({
      to: lead.email,
      domain: audit.domain,
      aeoScore: audit.aeo_score,
      auditPublicId: audit.public_id,
    });
  } catch (err) {
    if (err?.retryable === false) {
      ctx.logger.error(
        { audit: String(audit.id), err: err.message },
        'The report email was refused',
      );
      return;
    }
    throw err;
  }
  await ctx.db.audits.markReportEmailed(audit.id, ctx.now());
}

export const auditHandlers = {
  'audit.run': auditRun,
};
