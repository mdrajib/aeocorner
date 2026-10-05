import { UnrecoverableError } from 'bullmq';
import { DEFAULT_ENGINE_LABELS } from '../../core/narrative.js';
import { checkCodeOf } from '../../core/recommendation-lifecycle.js';
import {
  declineOf,
  decideClose,
  diagnose,
  estimateOnset,
  findLastingDeclines,
  foldOwnCitations,
  regressedChecks,
  repairsFor,
  selectDeclines,
} from '../../core/recovery.js';
import { windowsAt } from '../../core/trends.js';
import { RUBRIC_VERSION } from '../../crawler/readiness/index.js';
import { recoveryAlertsJobId, recoveryAlertSlot, recoveryRecheckJobId } from '../../lib/job-ids.js';
import { checkLivePage, judgeCheck } from './actions.js';
import { executeScan } from './crawl.js';

/**
 * Visibility recovery cases (Milestone 14; MILESTONES_SERVICES.md). Two jobs:
 *
 *   recovery.evaluate   after a finished run: open a case for each decline that has LASTED (core/recovery.js), close the
 *                       open ones that recovered, and diagnose the ones that are waiting for a diagnosis. Safe to repeat:
 *                       a decline opens exactly one case (the open key is unique), a closed case stays closed, and a
 *                       diagnosis that did not change adds nothing to the timeline.
 *   recovery.recheck    once, when a case opens: a fresh site scan, and a look at each earlier fix to see whether it is still
 *                       on the site (a theme or plugin update can remove injected markup). Free of provider cost.
 *
 * The case moves only by the system. Nothing here changes a customer's site: the repairs are pointers to ordinary
 * Action Center items, which a person approves the usual way.
 */

const dayText = (date) => date.toISOString().slice(0, 10);
const RECHECK_RETRY_AFTER_MS = 3_600_000;

async function namesOf(scoped, projectId) {
  const entities = await scoped.entities.list(projectId);
  return {
    brand: entities.find((e) => e.kind === 'brand') ?? null,
    entityNames: Object.fromEntries(entities.map((e) => [String(e.id), e.name])),
  };
}

/** Make or repeat the diagnosis of one open case from the evidence we have now. */
export async function diagnoseCase(ctx, scoped, kase, { now }) {
  const projectId = kase.projectId;
  const { brand, entityNames } = await namesOf(scoped, projectId);
  if (!brand) return null;
  const decline = declineOf(kase);
  // The windows the case was measured in, so the facts line up with the numbers it was opened on.
  const asOf = kase.decline.end;
  const windows = windowsAt(asOf);
  const rows = await scoped.metrics.range(projectId, { from: windows.before[0], to: asOf });
  const evidence = await scoped.recovery.evidence(projectId, {
    onset: kase.onsetDate ?? kase.decline.start,
    now,
  });
  const live = new Map(
    (kase.recheck?.fixes ?? []).map((f) => [String(f.recommendationId), f.live]),
  );
  const earlierFixes = evidence.fixes.map((f) => ({
    ...f,
    live: live.get(String(f.recommendationId)) ?? 'unknown',
  }));

  const [before, after] = await Promise.all(
    [windows.before, windows.after].map(async ([from, to]) =>
      foldOwnCitations(await scoped.dashboard.ownPageCitations(projectId, { from, to })),
    ),
  );

  const diagnosis = diagnose({
    decline,
    rows,
    brandId: String(brand.id),
    asOf,
    siteChanges: evidence.siteChanges,
    scans: evidence.scans,
    earlierFixes,
    ownCitations: { before, after },
    engineNames: DEFAULT_ENGINE_LABELS,
    entityNames,
  });
  const regressed = regressedChecks(evidence.scans?.before, evidence.scans?.latest);
  const repairs = repairsFor(diagnosis, { regressed });
  return scoped.recovery.saveDiagnosis(projectId, kase.id, { diagnosis, repairs, now });
}

/** Run the evaluation over one project. Exported so a test runs exactly what the worker runs. */
export async function evaluateProject(ctx, { orgId, projectId, now = ctx.now() }) {
  const scoped = ctx.db.forOrg(orgId);
  const project = await scoped.projects.get(projectId);
  if (!project || project.status === 'archived') return { skipped: 'project_gone' };
  const { brand } = await namesOf(scoped, projectId);
  if (!brand) return { skipped: 'no_brand' };
  const brandId = String(brand.id);
  const asOf = dayText(now);
  const summary = { opened: [], closed: [], diagnosed: 0, rechecksQueued: 0 };

  // 1. Open a case for each decline that has lasted.
  const windows = windowsAt(asOf);
  const rows = await scoped.metrics.range(projectId, { from: windows.before[0], to: asOf });
  const open = await scoped.recovery.list(projectId, { view: 'open' });
  const found = selectDeclines(
    findLastingDeclines({ rows, brandId, asOf }),
    open.map((c) => c.openKey),
  );
  for (const decline of found) {
    const onset = estimateOnset({ rows, brandId, decline });
    const event = await scoped.recovery.matchingEvent(projectId, decline, asOf);
    const result = await scoped.recovery.open(projectId, decline, {
      onset,
      triggerEventId: event?.id ?? null,
      asOf,
      now,
    });
    if (result.created) {
      summary.opened.push(String(result.case.id));
      await queueRecheck(ctx, { orgId, projectId, caseId: result.case.id });
      summary.rechecksQueued += 1;
    }
  }

  // 2. Close the ones that recovered, or diagnose the ones still waiting.
  for (const kase of await scoped.recovery.list(projectId, { view: 'open' })) {
    const { repaired } = await scoped.recovery.repairProgress(projectId, kase);
    const decision = decideClose({ kase, rows, brandId, asOf, repaired, now });
    if (decision.status) {
      if (
        await scoped.recovery.close(projectId, kase.id, {
          status: decision.status,
          recent: decision.recent,
          now,
        })
      ) {
        summary.closed.push({ id: String(kase.id), status: decision.status });
      }
      continue;
    }
    if (kase.recheckDoneAt) {
      // Still looking for the cause: a diagnosis that was "can't tell" is tried again with whatever is new. A named one is
      // kept (the repairs are what the customer is working through), and only re-read if the evidence moved.
      if (kase.status === 'diagnosing') {
        await diagnoseCase(ctx, scoped, kase, { now });
        summary.diagnosed += 1;
      }
    } else if (now.getTime() - kase.openedAt.getTime() > RECHECK_RETRY_AFTER_MS) {
      // The re-check job never ran (a lost delayed job): ask again, once a day.
      await queueRecheck(ctx, { orgId, projectId, caseId: kase.id, tag: asOf });
      summary.rechecksQueued += 1;
    }
  }

  // 3. A case somebody has not been told about is an alert (plan-gated and switched off in the alert job).
  const pending = await scoped.recovery.pendingAlerts(projectId, { now });
  if (pending.length > 0 && ctx.jobs) {
    for (const c of pending) {
      try {
        await ctx.jobs.add(
          'alerts.evaluate',
          { orgId: String(orgId), projectId: String(projectId), slot: recoveryAlertSlot(c.id) },
          { jobId: recoveryAlertsJobId(projectId, c.id, asOf) },
        );
      } catch (err) {
        ctx.logger.warn(
          { err: err.message, projectId: String(projectId) },
          'Could not queue the recovery alert',
        );
      }
    }
  }
  return summary;
}

async function queueRecheck(ctx, { orgId, projectId, caseId, tag }) {
  try {
    await ctx.jobs.add(
      'recovery.recheck',
      { orgId: String(orgId), projectId: String(projectId), caseId: String(caseId) },
      { jobId: recoveryRecheckJobId(caseId, tag) },
    );
    return true;
  } catch (err) {
    ctx.logger.warn(
      { err: err.message, caseId: String(caseId) },
      'Could not queue the recovery re-check',
    );
    return false;
  }
}

async function recoveryEvaluate(ctx, data) {
  return evaluateProject(ctx, { orgId: BigInt(data.orgId), projectId: BigInt(data.projectId) });
}

/**
 * Look at the site as it is now: a fresh scan, then each earlier fix. A fix with a readiness check is judged by that check in
 * the fresh scan; a published page is fetched and read as a crawler would. "We could not look" is `unknown`, never "gone".
 */
async function recoveryRecheck(ctx, data, job) {
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scoped = ctx.db.forOrg(orgId);
  const kase = await scoped.recovery.byId(projectId, BigInt(data.caseId));
  if (!kase) throw new UnrecoverableError(`Recovery case ${data.caseId} was not found`);
  if (!['diagnosing', 'repairing'].includes(kase.status) || kase.recheckDoneAt) {
    return { skipped: kase.status, repeated: true };
  }
  const now = ctx.now();
  const evidence = await scoped.recovery.evidence(projectId, {
    onset: kase.onsetDate ?? kase.decline.start,
    now,
  });

  // A fresh scan of the site, as its own row (the same way a fix's re-check scans).
  let scanId = null;
  let scanStatus = 'failed';
  let checks = [];
  if (ctx.crawler?.fetcher && ctx.crawler?.store) {
    const scan = await scoped.scans.create({
      projectId,
      trigger: 'verification',
      rubricVersion: RUBRIC_VERSION,
    });
    scanId = scan.id;
    const scanned = await executeScan(
      ctx,
      { orgId: data.orgId, projectId: data.projectId, scanId: String(scanId) },
      job,
    );
    scanStatus = scanned.status;
    checks = await scoped.scans.checks(scanId);
  }

  const fixes = [];
  for (const fix of evidence.fixes) {
    const code = checkCodeOf(fix.ruleCode);
    let live = 'unknown';
    let via = null;
    if (fix.publishedUrl && ctx.crawler?.fetcher) {
      const judged = await checkLivePage(ctx, {
        targetUrl: fix.publishedUrl,
        details: { expect: {} },
      });
      via = 'live_page';
      live = judged.couldntCheck ? 'unknown' : judged.status === 'passed' ? 'present' : 'gone';
    } else if (code && scanId) {
      const judged = judgeCheck(
        scanStatus,
        checks.find((c) => c.check_code === code),
      );
      via = 'scan_check';
      live = judged.couldntCheck ? 'unknown' : judged.status === 'passed' ? 'present' : 'gone';
    }
    fixes.push({ recommendationId: String(fix.recommendationId), live, via });
  }

  await scoped.recovery.saveRecheck(
    projectId,
    kase.id,
    { scanId: scanId == null ? null : String(scanId), scanStatus, fixes },
    { now: ctx.now() },
  );
  // The re-check was the last thing the diagnosis was waiting for.
  const fresh = await scoped.recovery.byId(projectId, kase.id);
  const status = fresh ? await diagnoseCase(ctx, scoped, fresh, { now: ctx.now() }) : null;
  return { caseId: data.caseId, scanStatus, fixes: fixes.length, status };
}

export const recoveryHandlers = {
  'recovery.evaluate': recoveryEvaluate,
  'recovery.recheck': recoveryRecheck,
};
