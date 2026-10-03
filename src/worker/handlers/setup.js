import { UnrecoverableError } from 'bullmq';
import { brandNames, emptyBrandKit } from '../../core/brand-kit.js';
import { INTENT_LABELS, MAX_SET } from '../../core/prompt-rules.js';
import { COUNTRIES } from '../../core/project-rules.js';
import { fromMicros } from '../../core/spend.js';
import { runSiteScan } from '../../crawler/scan.js';
import { DomainError } from '../../db/errors.js';
import { ProviderError } from '../../engines/contract.js';
import {
  buildFullBrandKitRequest,
  FULL_MAX_PAGES,
  readFullBrandKitReply,
} from '../../llm/brand-kit.js';
import { costMicros, modelProfile } from '../../llm/models.js';
import { buildProjectQuestionsRequest, readProjectQuestionsReply } from '../../llm/questions.js';
import { ledgerKey } from '../provider-call.js';

/**
 * Handlers for a new project's setup (Milestone 3), both on the `content` queue because they hold large prompts:
 *
 *   brandkit.extract    read the project's website and save a draft Brand Kit ("extracted", or "reanalyzed" over an
 *                       existing kit) plus the
 *                       competitors it suggests. A kit saved by anyone since the request (the version moved) wins:
 *                       the draft is dropped, never written over a person's edit.
 *   questions.generate  write the project's question set from its current Brand Kit and competitors, judged by the
 *                       same rules as a customer's own edits (src/core/prompt-rules.js), and save it as active
 *                       questions with source "generated".
 *
 * Both are paid Claude calls, so both go through `callProvider` as the organization, and both are safe to repeat: the
 * ledger row is keyed by the attempt, an extract only saves from the version it started from, and generated
 * questions that already exist come back as duplicates.
 */

const configured = (ctx) => {
  if (!ctx.extraction?.claude) {
    throw new UnrecoverableError('Claude is not configured on this worker (ANTHROPIC_API_KEY)');
  }
  return {
    claude: ctx.extraction.claude,
    profile: modelProfile(ctx.audit?.setupModel ?? 'haiku45'),
  };
};

const usageOf = (profile, usage, { meter, projectId }) => ({
  meter,
  unit: 'request',
  quantity: 1,
  model: profile.id,
  tokensIn: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  tokensOut: usage.output_tokens ?? 0,
  tokensCached: usage.cache_read_input_tokens ?? 0,
  costUsd: fromMicros(costMicros(profile, usage)),
  refType: 'project',
  refId: projectId,
});

/** A reply we can't use may be fine on the next try (Claude's wording varies), so it is a retryable error. */
const unusableReply = (what, read) =>
  new ProviderError(`Claude's reply for ${what} was not usable: ${read.reason}`, {
    status: `unusable_${read.reason}`,
    countsAgainstProvider: false,
  });

async function loadProject(ctx, data) {
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scoped = ctx.db.forOrg(orgId);
  // Read through the organization: a project that is not this organization's is simply not found.
  const project = await scoped.projects.get(projectId);
  if (!project) throw new UnrecoverableError(`Project ${data.projectId} was not found`);
  return { projectId, scoped, project };
}

async function brandKitExtract(ctx, data, job) {
  const crawler = ctx.crawler;
  if (!crawler?.fetcher || !crawler?.store) {
    throw new UnrecoverableError('The crawler is not configured on this worker');
  }
  const deps = configured(ctx);
  const { projectId, scoped, project } = await loadProject(ctx, data);

  const current = await scoped.brandKits.current(projectId);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== data.baseVersion) {
    return { projectId: data.projectId, skipped: 'kit_changed', repeated: true };
  }

  const target = crawler.targetFor ? crawler.targetFor(project.domain) : project.domain;
  const result = await runSiteScan(target, {
    fetcher: crawler.fetcher,
    renderer: crawler.renderer ?? null,
    store: crawler.store,
    now: ctx.now,
    // Same rule as the readiness scan: robots.txt is ignored only once the owner has proven the site is theirs.
    respectRobots: !project.domain_verified_at,
    limits: { brandPages: FULL_MAX_PAGES },
    log: (event, details) =>
      ctx.logger.debug({ project: data.projectId, event, ...details }, 'brand kit scan'),
  });
  await scoped.usage.record({
    projectId,
    meter: 'crawl',
    providerCode: 'crawler',
    unit: 'request',
    quantity: result.connections.length,
    costUsd: '0',
    refType: 'project',
    refId: projectId,
    idempotencyKey: ledgerKey('brandkit', job, 'crawl'),
  });
  if (result.status === 'failed' || !result.brandPages?.length) {
    // Nothing to read is not a reason to keep retrying: the customer fills the kit in by hand.
    return { projectId: data.projectId, skipped: 'site_unreadable' };
  }

  const { value: message } = await ctx.callProvider(
    job,
    {
      orgId: data.orgId,
      projectId: data.projectId,
      provider: 'anthropic',
      scope: 'content',
      idempotencyKey: ledgerKey('brandkit', job, `kit${job.attemptsMade}`),
    },
    async () => {
      const reply = await deps.claude.extract(
        buildFullBrandKitRequest({
          profile: deps.profile,
          domain: project.domain,
          pages: result.brandPages,
        }),
      );
      return {
        value: reply,
        usage: usageOf(deps.profile, reply.usage ?? {}, {
          meter: 'llm_brand_kit',
          projectId,
        }),
      };
    },
  );
  const read = readFullBrandKitReply(message, { domain: project.domain });
  if (!read.ok) throw unusableReply('the Brand Kit', read);

  try {
    await scoped.brandKits.save(projectId, {
      kit: read.kit,
      // A first reading is "extracted"; reading again over an existing kit is "reanalyzed" (the old version is kept).
      source: current ? 'reanalyzed' : 'extracted',
      expectedVersion: current ? currentVersion : null,
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === 'STALE_VERSION') {
      return { projectId: data.projectId, skipped: 'kit_changed' };
    }
    throw err;
  }

  // Competitors are suggested, not tracked: the customer confirms each one.
  let suggested = 0;
  for (const c of read.competitors) {
    try {
      await scoped.entities.addCompetitor(projectId, {
        name: c.name,
        primaryDomain: c.domain,
        source: 'brand_kit',
        status: 'suggested',
      });
      suggested += 1;
    } catch (err) {
      if (!(err instanceof DomainError)) throw err; // a repeat, or a name we can't use: skip it
    }
  }
  return { projectId: data.projectId, saved: true, suggested };
}

async function questionsGenerate(ctx, data, job) {
  const deps = configured(ctx);
  const { projectId, scoped, project } = await loadProject(ctx, data);

  const [row, entities, existing] = await Promise.all([
    scoped.brandKits.current(projectId),
    scoped.entities.list(projectId),
    scoped.prompts.list(projectId),
  ]);
  const active = existing.filter((p) => p.status === 'active').length;
  if (active >= MAX_SET) return { projectId: data.projectId, skipped: 'full' };

  const kit = row?.data ?? emptyBrandKit({ name: project.name, domain: project.domain });
  const competitors = entities.filter((e) => e.kind === 'competitor' && e.status === 'active');
  const count = Math.min(data.count, MAX_SET - active);
  const hasCity = Boolean(project.city);

  const { value: message } = await ctx.callProvider(
    job,
    {
      orgId: data.orgId,
      projectId: data.projectId,
      provider: 'anthropic',
      scope: 'content',
      idempotencyKey: ledgerKey('questions', job, `set${job.attemptsMade}`),
    },
    async () => {
      const reply = await deps.claude.extract(
        buildProjectQuestionsRequest({
          profile: deps.profile,
          kit,
          competitors,
          city: project.city,
          country: COUNTRIES[project.country] ?? '',
          count: Math.max(25, count),
        }),
      );
      return {
        value: reply,
        usage: usageOf(deps.profile, reply.usage ?? {}, { meter: 'llm_prompts', projectId }),
      };
    },
  );
  const read = readProjectQuestionsReply(message, { names: brandNames(kit), hasCity });
  if (!read.ok) throw unusableReply('the questions', read);

  const results = await scoped.prompts.importMany(
    projectId,
    read.questions.slice(0, count).map((q) => ({
      text: q.text,
      intent: q.intent,
      clusterName: INTENT_LABELS[q.intent],
    })),
    { source: 'generated', limit: MAX_SET },
  );
  const added = results.filter((r) => r.result === 'added' || r.result === 'restored').length;
  return { projectId: data.projectId, added, dropped: read.dropped.length };
}

export const setupHandlers = {
  'brandkit.extract': brandKitExtract,
  'questions.generate': questionsGenerate,
};
