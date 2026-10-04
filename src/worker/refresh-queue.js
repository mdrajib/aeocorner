import { recsRefreshJobId } from '../lib/job-ids.js';

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
