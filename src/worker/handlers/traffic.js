import { brandTerms } from '../../core/traffic.js';
import { GoogleError } from '../../integrations/google.js';
import { fetchGa4, fetchSearchConsole, syncRange } from '../../integrations/google-sync.js';
import { googleSyncJobId } from '../../lib/job-ids.js';

/**
 * Reading a project's Google Analytics and Search Console every day (Milestone 8, tasks 8.10 and 8.11):
 *
 *   sync.google.sweep   daily: queue one `sync.google` per connected project
 *   sync.google         one project: open the stored login (only the worker can), read the days not yet read and a few
 *                       days back (late data settles), store them, and say what happened on the connection
 *
 * A login Google no longer accepts marks the connection broken and emails the project's owners and admins once a month to
 * reconnect (ADMIN_OPERATIONS §6). A temporary trouble (Google busy or unreachable) throws, so the job retries; one
 * project's trouble never stops the others, because each is its own job.
 */

const dayOf = (d) => d.toISOString().slice(0, 10);

export async function syncGoogleSweep(ctx) {
  if (!(await ctx.db.system.flags.isEnabled('google.sync'))) return { skipped: 'switched off' };
  const connections = await ctx.db.system.traffic.connections();
  const today = dayOf(ctx.now());
  for (const c of connections) {
    await ctx.jobs.add(
      'sync.google',
      { orgId: String(c.orgId), projectId: String(c.projectId) },
      { jobId: googleSyncJobId(c.projectId, today) },
    );
  }
  return { queued: connections.length };
}

export async function syncGoogle(ctx, data) {
  const secrets = ctx.content?.secrets;
  if (!ctx.google || !secrets) return { skipped: 'Google or the secrets key is not configured' };
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scoped = ctx.db.forOrg(orgId);
  if (!(await ctx.db.system.flags.isEnabled('google.sync', orgId)))
    return { skipped: 'switched off' };
  const conn = await scoped.google.secret(projectId);
  if (!conn) return { skipped: 'not connected' };
  const { ga4_property_id: propertyId, gsc_site_url: siteUrl } = conn.config;
  if (!propertyId && !siteUrl) return { skipped: 'nothing chosen yet' };

  const now = ctx.now();
  const range = syncRange(conn.config, now);
  let accessToken;
  try {
    const refreshToken = secrets.decryptText(conn.secret, `google:${orgId}:${projectId}`);
    ({ accessToken } = await ctx.google.refresh(refreshToken));
  } catch (err) {
    if (err instanceof GoogleError && err.code === 'revoked') {
      await scoped.google.syncResult(projectId, {
        ok: false,
        error: 'Google access was withdrawn or has expired. Reconnect to keep traffic up to date.',
        now,
      });
      await tellToReconnect(ctx, scoped, projectId, now);
      return { broken: 'revoked' };
    }
    if (err instanceof GoogleError) throw err; // busy or unreachable: retry
    // The token could not be opened (wrong key, moved row): nothing a retry would fix.
    await scoped.google.syncResult(projectId, {
      ok: false,
      error: 'The saved Google login could not be opened. Reconnect Google.',
      now,
    });
    ctx.logger.error(
      { projectId: String(projectId), err: err.message },
      'Could not open a Google login',
    );
    return { broken: 'unopenable' };
  }

  try {
    const project = await scoped.projects.get(projectId);
    const entities = await scoped.entities.list(projectId);
    const brand = entities.find((e) => e.kind === 'brand');
    const terms = brandTerms({
      names: brand
        ? [brand.name, ...brand.aliases.filter((a) => a.kind === 'name').map((a) => a.value)]
        : [],
      domain: project?.domain ?? '',
    });

    let ga4Rows = 0;
    let gscRows = 0;
    if (propertyId) {
      const rows = await fetchGa4({ google: ctx.google, accessToken, propertyId, ...range.ga4 });
      ga4Rows = await scoped.traffic.saveGa4(projectId, rows, { now });
    }
    if (siteUrl) {
      const rows = await fetchSearchConsole({
        google: ctx.google,
        accessToken,
        siteUrl,
        ...range.gsc,
        terms,
      });
      gscRows = await scoped.traffic.saveSearch(projectId, rows, { now });
    }
    const covered = propertyId ? range.ga4 : range.gsc;
    await scoped.google.syncResult(projectId, {
      ok: true,
      from: covered.startDate,
      to: covered.endDate,
      now,
    });
    return { ga4Rows, gscRows, from: covered.startDate, to: covered.endDate };
  } catch (err) {
    if (err instanceof GoogleError && ['quota', 'unreachable', 'http'].includes(err.code))
      throw err;
    if (err instanceof GoogleError) {
      const message =
        err.code === 'forbidden'
          ? 'This Google login can no longer read the property or site you chose. Choose again or reconnect.'
          : err.code === 'revoked'
            ? 'Google access was withdrawn or has expired. Reconnect to keep traffic up to date.'
            : 'Google answered in a way we could not read. We have been told.';
      await scoped.google.syncResult(projectId, { ok: false, error: message, now });
      if (err.code === 'revoked') await tellToReconnect(ctx, scoped, projectId, now);
      return { broken: err.code };
    }
    // A response that changed shape (parse error) or our own bug: say so on the connection and fail the job loudly.
    await scoped.google.syncResult(projectId, {
      ok: false,
      error: 'Google answered in a way we could not read. We have been told.',
      now,
    });
    throw err;
  }
}

/** One email a month to the owners and admins, whatever number of days the connection stays broken. */
async function tellToReconnect(ctx, scoped, projectId, now) {
  if (!ctx.mail) return;
  const project = await scoped.projects.get(projectId);
  const { orgPublicId } = await scoped.billing.summary({ now });
  const recipients = await scoped.alerts.recipients(projectId, 'google-reconnect');
  for (const r of recipients.filter((x) => ['owner', 'admin'].includes(x.role))) {
    await ctx.mail.sendGoogleReconnect({
      to: r.email,
      userId: r.userId,
      orgId: scoped.orgId,
      projectId,
      projectName: project.name,
      month: now.toISOString().slice(0, 7),
      trafficUrl: `${ctx.mail.baseUrl}/app/o/${orgPublicId}/projects/${project.public_id}/traffic`,
    });
  }
}

export const trafficHandlers = {
  'sync.google.sweep': syncGoogleSweep,
  'sync.google': syncGoogle,
};
