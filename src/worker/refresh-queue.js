import {
  alertsJobId,
  autopilotTickJobId,
  recoveryEvaluateJobId,
  recsRefreshJobId,
} from '../lib/job-ids.js';

/**
 * Ask for a project's recommendations to be brought up to date (`recommendations.refresh`), after a run or a scan
 * finished. A failure to queue it is logged and swallowed: the run or scan it follows is already saved, and the next
 * one asks again, so the Action Center is at worst a little stale, never the reason a run is reported as failed.
 */
export async function queueRefresh(ctx, { orgId, projectId, cause, runId = null }) {
  try {
    await ctx.jobs.add(
      'recommendations.refresh',
      {
        orgId: String(orgId),
        projectId: String(projectId),
        ...(runId == null ? {} : { runId: String(runId) }),
      },
      { jobId: recsRefreshJobId(projectId, cause) },
    );
    return true;
  } catch (err) {
    ctx.logger.warn(
      { err: err.message, projectId: String(projectId), cause },
      'Could not queue a recommendations refresh',
    );
    return false;
  }
}

/**
 * Ask for the alerts a finished run may have earned (`alerts.evaluate`). Like the refresh, a failure to queue is logged and
 * swallowed: the run is already saved, and the next one asks again (the events stay un-alerted for two weeks).
 */
export async function queueAlerts(ctx, { orgId, projectId, runId }) {
  try {
    await ctx.jobs.add(
      'alerts.evaluate',
      { orgId: String(orgId), projectId: String(projectId), runId: String(runId) },
      { jobId: alertsJobId(projectId, runId) },
    );
    return true;
  } catch (err) {
    ctx.logger.warn(
      { err: err.message, projectId: String(projectId) },
      'Could not queue the alerts',
    );
    return false;
  }
}

/**
 * Ask for a project's decline to be looked at (`recovery.evaluate`) after a finished run: open a case for a decline that has
 * lasted, and close or diagnose the open ones. Like the refresh, a failure to queue is logged and swallowed: the next run asks again.
 */
export async function queueRecovery(ctx, { orgId, projectId, runId }) {
  try {
    await ctx.jobs.add(
      'recovery.evaluate',
      { orgId: String(orgId), projectId: String(projectId), runId: String(runId) },
      { jobId: recoveryEvaluateJobId(projectId, `r${runId}`) },
    );
    return true;
  } catch (err) {
    ctx.logger.warn(
      { err: err.message, projectId: String(projectId) },
      'Could not queue the recovery evaluation',
    );
    return false;
  }
}

/**
 * Ask for what Autopilot should prepare for a project (`autopilot.tick`) after its recommendations were brought up to date.
 * Only when the project has Autopilot on and not paused: a project that has not asked for it costs no job. Like the others, a
 * failure to queue is logged and swallowed: the next refresh asks again.
 */
export async function queueAutopilot(ctx, { orgId, projectId, tag }) {
  try {
    const settings = await ctx.db.forOrg(orgId).autopilot.settings(projectId);
    if (!settings.enabled || settings.pausedAt) return false;
    await ctx.jobs.add(
      'autopilot.tick',
      { orgId: String(orgId), projectId: String(projectId) },
      { jobId: autopilotTickJobId(projectId, tag) },
    );
    return true;
  } catch (err) {
    ctx.logger.warn(
      { err: err.message, projectId: String(projectId) },
      'Could not queue the Autopilot tick',
    );
    return false;
  }
}
