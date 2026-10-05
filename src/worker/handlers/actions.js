import { createHash } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { canonicalJson } from '../../core/canonical-json.js';
import {
  CITATION_LIMITS,
  ownPageRows,
  rankOpportunities,
  uncitedKeyPages,
} from '../../core/citation-opportunities.js';
import { checkFacts } from '../../core/entity-accuracy.js';
import {
  adviceTextFor,
  DEFAULT_ENGINE_LABELS,
  factsFor,
  templateNarrative,
} from '../../core/narrative.js';
import {
  checkCodeOf,
  decideVerification,
  EDITABLE_STATUSES,
  MAX_VERIFY_ATTEMPTS,
} from '../../core/recommendation-lifecycle.js';
import { judgeLivePage } from '../../core/live-check.js';
import { evaluateRules, scoreCandidates } from '../../core/recommendations.js';
import { fromMicros } from '../../core/spend.js';
import { RUBRIC_VERSION } from '../../crawler/readiness/index.js';
import { extractPage } from '../../crawler/html.js';
import { ProviderError } from '../../engines/contract.js';
import {
  citationFormatsJobId,
  fixVerifyJobId,
  narrateJobId,
  outcomeJobId,
} from '../../lib/job-ids.js';
import { costMicros, modelProfile } from '../../llm/models.js';
import {
  buildNarrativeRequest,
  NARRATIVE_VERSION,
  readNarrativeReply,
} from '../../llm/narrative.js';
import { Deferral } from '../deferral.js';
import { ledgerKey } from '../provider-call.js';
import { executeScan } from './crawl.js';

/**
 * Handlers for the Action Center (Milestone 6, MVP F7):
 *
 *   recommendations.refresh   read the project (latest scan, the last four weeks of answers, the sources cited), run the
 *                             rules, and bring its recommendations in line: raise new ones, update the open ones, mark
 *                             the ones whose signal is gone. Queued after every finished run and scan. Safe to repeat.
 *   recommendations.narrate   have Claude rewrite one recommendation's words from its evidence. The reply is checked
 *                             against the evidence in code, and the stored template stays if it claims more.
 *   fix.verify                the same-day re-check of a fix marked done: scan the site again and read the check the fix
 *                             is about. Attempt 1 at once, 2 after an hour, 3 after a day; a pass at any of them verifies.
 *   outcomes.sweep            daily: queue the before/after measurement of every fix that is due, and ask again for
 *                             re-checks that never ran (a lost delayed job).
 *   outcomes.measure          one fix's +2 or +4 week before/after comparison.
 *
 * The rules, scoring, lifecycle and significance test are pure code in `src/core`; the writes are in
 * `src/db/repos/org-actions.js`. This file only decides when each runs.
 */

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 28;
const engineLabel = (code) => DEFAULT_ENGINE_LABELS[code] ?? code;

export const evidenceHash = (evidence) =>
  createHash('sha256').update(canonicalJson(evidence)).digest('hex').slice(0, 12);

/**
 * Run the rules over one project and reconcile its recommendations. Exported so a test runs exactly what the worker runs.
 *
 * @returns `{ candidates, created, updated, cleared, suppressed, needsNarrative }` (`created` and `needsNarrative` are IDs)
 */
export async function refreshProject(
  { db, scoped },
  { projectId, runId = null, now = new Date() },
) {
  const from = new Date(now.getTime() - (WINDOW_DAYS - 1) * DAY_MS);
  const signals = await scoped.recommendations.signals(projectId, { from, to: now });

  // Citations (Milestone 13): who engines cite for the brand's questions, and which of the brand's own pages they do not.
  const range = { from, to: now };
  const [who, rows, own, keyPages] = await Promise.all([
    scoped.dashboard.citationContext(projectId),
    scoped.dashboard.citationOpportunityRows(projectId, range),
    scoped.dashboard.ownPageCitations(projectId, range),
    scoped.dashboard.keyPages(projectId),
  ]);
  const ownCited = ownPageRows(own.pages);
  const citations = {
    opportunities: rankOpportunities(rows, who).bySite,
    uncitedPages: uncitedKeyPages({
      keyPages,
      cited: ownCited,
      ownCitations: own.ownCitations,
      homeUrl: who.homeUrl,
    }),
    ownCitations: own.ownCitations,
    ownPagesCited: ownCited.length,
    ownPagesJudged: keyPages.length > 0 && own.ownCitations >= CITATION_LIMITS.minOwnCitations,
  };

  // Entity (Milestone 12): the latest profile and Wikidata checks, and what the engines said about the brand's facts.
  const kit = await scoped.brandKits.current(projectId);
  let entity = null;
  if (kit) {
    const [checks, said] = await Promise.all([
      scoped.entityChecks.checks(projectId),
      scoped.entityChecks.accuracyInputs(projectId, { from, to: now }),
    ]);
    entity = {
      checks,
      accuracy: checkFacts({ kit: kit.data, claims: said.claims, answersRead: said.answersRead }),
      wikidataId: kit.data.entity?.wikidataId ?? '',
      profilesListed: kit.data.entity?.profiles?.length ?? 0,
    };
  }

  const found = evaluateRules({
    brandName: signals.brandName,
    scan: signals.scan,
    prompts: signals.prompts,
    enginesCount: signals.enginesCount,
    grid: signals.grid,
    sentiment: signals.sentiment,
    citations,
    answersTotal: signals.answersTotal,
    windowRange: signals.window,
    entity,
  });
  const outcomes = await db.system.outcomes.ruleStats();
  const scored = scoreCandidates(found.candidates, {
    prompts: signals.prompts,
    enginesCount: signals.enginesCount,
    outcomes,
  });
  const words = { brandName: signals.brandName, domain: signals.project.domain, engineLabel };
  const items = scored.map((c) => {
    const narrative = templateNarrative(
      { ruleCode: c.ruleCode, category: c.category, evidence: c.evidence },
      words,
    );
    return {
      ...c,
      why: narrative.why,
      steps: narrative.steps,
      narrativeVersion: narrative.version,
    };
  });
  const summary = await scoped.recommendations.reconcile(projectId, {
    items,
    detectedKeys: found.detectedKeys,
    evaluated: found.evaluated,
    runId,
    now,
  });
  return { candidates: items.length, ...summary };
}

async function recommendationsRefresh(ctx, data) {
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scoped = ctx.db.forOrg(orgId);
  const project = await scoped.projects.get(projectId);
  // A project archived since the job was queued has nothing to recommend.
  if (!project || project.status === 'archived') return { skipped: 'project_gone' };

  const summary = await refreshProject(
    { db: ctx.db, scoped },
    { projectId, runId: data.runId ? BigInt(data.runId) : null, now: ctx.now() },
  );

  // New words for what is new, if Claude is there to write them. The template already stands in until it does.
  let queued = 0;
  if (ctx.extraction?.claude) {
    for (const id of summary.needsNarrative) {
      const rec = await scoped.recommendations.load(id);
      if (!rec) continue;
      await ctx.jobs.add(
        'recommendations.narrate',
        { orgId: data.orgId, recommendationId: String(id) },
        { jobId: narrateJobId(id, evidenceHash(rec.evidence)) },
      );
      queued += 1;
    }
  }
  // Pages engines cite that nobody has read yet: read them (at most once a day), then look again at the rules.
  const unread = await scoped.dashboard.unreadCitedUrls(projectId, {
    from: new Date(ctx.now().getTime() - (WINDOW_DAYS - 1) * DAY_MS),
    to: ctx.now(),
    limit: 1,
    now: ctx.now(),
  });
  if (unread.length > 0 && ctx.crawler?.fetcher) {
    await ctx.jobs.add(
      'citations.formats',
      { orgId: data.orgId, projectId: data.projectId },
      { jobId: citationFormatsJobId(projectId, ctx.now().toISOString().slice(0, 10)) },
    );
  }
  return {
    projectId: data.projectId,
    candidates: summary.candidates,
    created: summary.created.length,
    updated: summary.updated,
    cleared: summary.cleared,
    suppressed: summary.suppressed,
    narrations: queued,
  };
}

const unusableReply = (read) =>
  new ProviderError(`Claude's narrative was not usable: ${read.reason}`, {
    status: `unusable_${read.reason}`,
    countsAgainstProvider: false,
  });

async function recommendationsNarrate(ctx, data, job) {
  if (!ctx.extraction?.claude) {
    throw new UnrecoverableError('Claude is not configured on this worker (ANTHROPIC_API_KEY)');
  }
  const profile = modelProfile(ctx.audit?.setupModel ?? 'haiku45');
  const orgId = BigInt(data.orgId);
  const scoped = ctx.db.forOrg(orgId);
  const rec = await scoped.recommendations.load(BigInt(data.recommendationId));
  if (!rec) throw new UnrecoverableError(`Recommendation ${data.recommendationId} was not found`);
  // Only the template is replaced, and only while the recommendation is still open to change.
  if (!EDITABLE_STATUSES.includes(rec.status) || !String(rec.narrativeVersion).startsWith('t')) {
    return { skipped: 'not_needed', recommendationId: data.recommendationId };
  }

  const project = await scoped.projects.get(rec.projectId);
  const [brand] = await scoped.entities.list(rec.projectId, { kind: 'brand' });
  const words = {
    brandName: brand?.name ?? project.domain,
    domain: project.domain,
    engineLabel,
  };
  const facts = factsFor(rec.evidence, words);
  if (facts.length === 0) return { skipped: 'no_facts', recommendationId: data.recommendationId };
  const advice = adviceTextFor(rec.ruleCode, rec.evidence);

  const { value: message } = await ctx.callProvider(
    job,
    {
      orgId: data.orgId,
      projectId: String(rec.projectId),
      provider: 'anthropic',
      scope: 'content',
      idempotencyKey: ledgerKey('narrate', job, `n${job.attemptsMade}`),
    },
    async () => {
      const reply = await ctx.extraction.claude.extract(
        buildNarrativeRequest({
          profile,
          title: rec.title,
          facts,
          advice,
          brandName: words.brandName,
        }),
      );
      const usage = reply.usage ?? {};
      return {
        value: reply,
        usage: {
          meter: 'llm_narrative',
          unit: 'request',
          quantity: 1,
          model: profile.id,
          tokensIn: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          tokensOut: usage.output_tokens ?? 0,
          tokensCached: usage.cache_read_input_tokens ?? 0,
          costUsd: fromMicros(costMicros(profile, usage)),
          refType: 'project',
          refId: rec.projectId,
        },
      };
    },
  );

  const read = readNarrativeReply(message, { facts, advice, ...words });
  if (!read.ok) {
    // A reply that adds a claim is not retried into existence: the template stays. A malformed one gets a second try.
    const transient = ['invalid_json', 'no_text', 'max_tokens', 'invalid_shape'].includes(
      read.reason,
    );
    if (transient && job.attemptsMade < 1) throw unusableReply(read);
    ctx.logger.warn(
      {
        recommendationId: data.recommendationId,
        reason: read.reason,
        problems: Array.isArray(read.detail) ? read.detail.slice(0, 5) : read.detail,
      },
      'Narrative not used',
    );
    return { skipped: read.reason, recommendationId: data.recommendationId };
  }
  const saved = await scoped.recommendations.saveNarrative(rec.projectId, rec.id, {
    why: read.why,
    steps: read.steps,
    version: NARRATIVE_VERSION,
    evidenceHash: canonicalJson(rec.evidence),
  });
  return { recommendationId: data.recommendationId, saved };
}

/**
 * What one scan says about the check a fix was about. `pass` and `not_applicable` (the problem no longer applies) are
 * a pass; `fail` and `partial` are still failing; a check that errored, or a scan that could not run, is "we could not
 * look", which is never counted as a failure of the customer's fix.
 */
export function judgeCheck(scanStatus, check) {
  if (scanStatus === 'failed' || !check) {
    return { status: 'failed', couldntCheck: true, checkStatus: check?.status ?? null };
  }
  if (check.status === 'pass' || check.status === 'not_applicable') {
    return { status: 'passed', couldntCheck: false, checkStatus: check.status };
  }
  if (check.status === 'error')
    return { status: 'failed', couldntCheck: true, checkStatus: 'error' };
  return { status: 'failed', couldntCheck: false, checkStatus: check.status };
}

/** One look at a published page: the address from the re-check attempt, fetched with the safe fetcher, read as a crawler reads it. */
export async function checkLivePage(ctx, attempt) {
  const fetcher = ctx.crawler?.fetcher;
  if (!attempt.targetUrl || !fetcher)
    throw new UnrecoverableError('A live-page check needs an address and the crawler');
  let res;
  try {
    res = await fetcher.fetch(attempt.targetUrl, { bodyTypes: [/html/i, /xml/i] });
  } catch {
    return judgeLivePage({ status: null, facts: null, expect: {} });
  }
  const facts = res.body?.length
    ? extractPage(res.body.toString('utf8'), res.url, { headers: res.headers })
    : null;
  return judgeLivePage({ status: res.status, facts, expect: attempt.details?.expect ?? {} });
}

async function fixVerify(ctx, data, job) {
  const orgId = BigInt(data.orgId);
  const recId = BigInt(data.recommendationId);
  const scoped = ctx.db.forOrg(orgId);
  const rec = await scoped.recommendations.load(recId);
  if (!rec) throw new UnrecoverableError(`Recommendation ${data.recommendationId} was not found`);
  // A repeated job, or one that outlived the fix (it was fixed again, or moved on): nothing to check.
  if (rec.status !== 'done') return { skipped: rec.status, repeated: true };
  const projectId = rec.projectId;
  const code = checkCodeOf(rec.ruleCode);

  const now = ctx.now();
  let attempts = await scoped.recommendations.verificationsOf(projectId, recId);
  const next = attempts.find((a) => a.status === 'pending');
  if (next) {
    // The earliest attempt still waiting runs, whichever one this job was queued for.
    if (next.scheduledFor.getTime() > now.getTime()) {
      throw new Deferral(
        next.scheduledFor.getTime() - now.getTime(),
        'not time for the re-check yet',
      );
    }
    if (next.method === 'url_live') {
      // A published page: fetch it as a crawler would and see that it is there with what we sent.
      const judged = await checkLivePage(ctx, next);
      await scoped.recommendations.recordVerification(projectId, recId, {
        attempt: next.attempt,
        status: judged.status,
        details: {
          method: 'url_live',
          reasons: judged.reasons,
          couldntCheck: judged.couldntCheck,
          expect: next.details?.expect ?? null,
        },
        now: ctx.now(),
      });
      attempts = await scoped.recommendations.verificationsOf(projectId, recId);
    } else {
      if (!code) throw new UnrecoverableError(`${rec.ruleCode} has no automatic check`);
      let scanId = next.scanId;
      if (!scanId) {
        const scan = await scoped.scans.create({
          projectId,
          trigger: 'verification',
          rubricVersion: RUBRIC_VERSION,
        });
        scanId = scan.id;
        await scoped.recommendations.attachScan(projectId, recId, {
          attempt: next.attempt,
          scanId,
        });
      }
      const scanned = await executeScan(
        ctx,
        { orgId: data.orgId, projectId: String(projectId), scanId: String(scanId) },
        job,
      );
      const checks = await scoped.scans.checks(scanId);
      const judged = judgeCheck(
        scanned.status,
        checks.find((c) => c.check_code === code),
      );
      await scoped.recommendations.recordVerification(projectId, recId, {
        attempt: next.attempt,
        status: judged.status,
        scanId,
        details: {
          check: code,
          checkStatus: judged.checkStatus,
          couldntCheck: judged.couldntCheck,
        },
        now: ctx.now(),
      });
      attempts = await scoped.recommendations.verificationsOf(projectId, recId);
    }
  }

  const decision = decideVerification(
    attempts.map((a) => ({
      attempt: a.attempt,
      status: a.status,
      couldntCheck: a.details?.couldntCheck === true,
    })),
  );
  if (decision.verdict === 'continue') {
    const waiting = attempts.find((a) => a.status === 'pending');
    if (!waiting) return { recommendationId: data.recommendationId, verdict: 'continue' };
    const delayMs = Math.max(1_000, waiting.scheduledFor.getTime() - ctx.now().getTime());
    await ctx.jobs.add(
      'fix.verify',
      { orgId: data.orgId, recommendationId: data.recommendationId, attempt: waiting.attempt },
      { jobId: fixVerifyJobId(recId, waiting.attempt), delayMs },
    );
    return {
      recommendationId: data.recommendationId,
      verdict: 'continue',
      nextAttempt: waiting.attempt,
    };
  }
  const settled = await scoped.recommendations.settleVerification(projectId, recId, {
    verdict: decision.verdict,
    reason: decision.reason,
    details: { attempts: attempts.length },
    now: ctx.now(),
  });
  return {
    recommendationId: data.recommendationId,
    verdict: decision.verdict,
    reason: decision.reason,
    status: settled.status,
  };
}

async function outcomesSweep(ctx) {
  const now = ctx.now();
  const day = now.toISOString().slice(0, 10);
  const due = await ctx.db.system.outcomes.due({ now });
  for (const d of due) {
    await ctx.jobs.add(
      'outcomes.measure',
      { orgId: String(d.orgId), recommendationId: String(d.recommendationId) },
      { jobId: outcomeJobId(d.recommendationId, day) },
    );
  }
  // A re-check whose delayed job was lost (Redis restarted) would leave a fix "checking" for ever: ask again, once an hour.
  const hour = Math.floor(now.getTime() / 3_600_000);
  const overdue = await ctx.db.system.verifications.overdue({ now });
  for (const o of overdue) {
    await ctx.jobs.add(
      'fix.verify',
      {
        orgId: String(o.orgId),
        recommendationId: String(o.recommendationId),
        attempt: Math.min(o.attempt, MAX_VERIFY_ATTEMPTS),
      },
      { jobId: fixVerifyJobId(o.recommendationId, o.attempt, hour) },
    );
  }
  return { measurements: due.length, reverifications: overdue.length };
}

async function outcomesMeasure(ctx, data) {
  const orgId = BigInt(data.orgId);
  const scoped = ctx.db.forOrg(orgId);
  const rec = await scoped.recommendations.load(BigInt(data.recommendationId));
  if (!rec) throw new UnrecoverableError(`Recommendation ${data.recommendationId} was not found`);
  // Two horizons can be due together (the sweep was down for weeks): take them in order.
  const done = [];
  for (let i = 0; i < 2; i += 1) {
    const result = await scoped.outcomes.measure(rec.projectId, rec.id, { now: ctx.now() });
    if (result.skipped) break;
    done.push(result);
  }
  return { recommendationId: data.recommendationId, measured: done };
}

export const actionHandlers = {
  'recommendations.refresh': recommendationsRefresh,
  'recommendations.narrate': recommendationsNarrate,
  'fix.verify': fixVerify,
  'outcomes.sweep': outcomesSweep,
  'outcomes.measure': outcomesMeasure,
};
