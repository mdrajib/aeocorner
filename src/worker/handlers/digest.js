import { alertSubject, selectAlerts } from '../../core/alerts.js';
import { headline, RANGES } from '../../core/dashboard.js';
import { buildDigest } from '../../core/digest.js';
import { digestWeekKey, isDigestHour } from '../../core/notify.js';
import { windowsAt } from '../../core/trends.js';
import { digestSendJobId } from '../../lib/job-ids.js';

/**
 * The weekly digest and the alert emails (Milestone 8, tasks 8.13–8.15). Every email goes through the notifier
 * (`ctx.mail`, src/lib/notify.js), which owns dedupe, the suppression list, the one-a-day cap and the unsubscribe link, so
 * a job that runs twice, or a retry after a crash, sends nothing twice.
 *
 *   digest.tick       hourly: which timezones are at Monday 08:00 now, and which projects have someone there
 *   digest.send       one project: build its digest once and send it to each member whose local time it is
 *   alerts.evaluate   after a run: significant drops, a rising competitor and negative claims → one alert email
 */

const dayText = (d) => d.toISOString().slice(0, 10);
const hourKey = (at) => at.toISOString().slice(0, 13).replaceAll(/[-T:]/g, '');

export async function digestTick(ctx, data) {
  if (!(await ctx.db.system.flags.isEnabled('digest.weekly'))) return { skipped: 'switched off' };
  const at = data.at ? new Date(data.at) : ctx.now();
  const timezones = (await ctx.db.system.digest.timezones()).filter((tz) => isDigestHour(at, tz));
  if (timezones.length === 0) return { timezones: 0, projects: 0 };
  const projects = await ctx.db.system.digest.projectsInTimezones({
    timezones,
    enforced: Boolean(ctx.billing?.enforced),
    now: at,
  });
  for (const p of projects) {
    await ctx.jobs.add(
      'digest.send',
      { orgId: String(p.orgId), projectId: String(p.projectId), at: at.toISOString() },
      // One digest job per project per hour: a tick that fires twice makes one.
      { jobId: digestSendJobId(p.projectId, hourKey(at)) },
    );
  }
  return { timezones: timezones.length, projects: projects.length };
}

export async function digestSend(ctx, data) {
  if (!ctx.mail) return { skipped: 'email is not configured' };
  const at = new Date(data.at);
  const scoped = ctx.db.forOrg(BigInt(data.orgId));
  const projectId = BigInt(data.projectId);
  if (!(await ctx.db.system.flags.isEnabled('digest.weekly', scoped.orgId))) {
    return { skipped: 'switched off' };
  }
  const project = await scoped.projects.get(projectId);
  if (!project || project.status !== 'active') return { skipped: 'project is not active' };

  const recipients = (await scoped.alerts.recipients(projectId, 'digest')).filter((r) =>
    isDigestHour(at, r.timezone),
  );
  if (recipients.length === 0) return { sent: 0 };

  const facts = await scoped.alerts.digestFacts(projectId, { now: at });
  if (!facts.brandId) return { skipped: 'no brand' };
  const windows = windowsAt(dayText(at), RANGES['4w'].days);
  const rows = await scoped.metrics.range(projectId, {
    from: windows.before[0],
    to: windows.after[1],
  });
  const top = await scoped.recommendations.top(projectId, 3);
  const { tiles, hasData } = headline({ rows, brandId: facts.brandId, asOf: dayText(at) });

  const digest = buildDigest({
    project: { name: project.name, domain: project.domain },
    tiles,
    hasData,
    events: facts.events,
    actions: top.map((r) => ({ title: r.title })),
    wins: facts.wins,
    cases: await scoped.recovery.list(projectId, { limit: 10 }),
    lastFinishedAt: facts.lastFinishedAt,
    engineNames: facts.engineNames,
    entityNames: facts.entityNames,
    now: at,
  });

  const { orgPublicId } = await scoped.billing.summary({ now: at });
  const base = `${ctx.mail.baseUrl}/app/o/${orgPublicId}/projects/${project.public_id}`;
  let sent = 0;
  for (const r of recipients) {
    const result = await ctx.mail.send({
      to: r.email,
      userId: r.userId,
      orgId: scoped.orgId,
      projectId,
      kind: 'digest',
      dedupeKey: `digest.${projectId}.${r.userId}.${digestWeekKey(at, r.timezone)}`,
      data: {
        digest,
        dashboardUrl: `${base}/dashboard`,
        settingsUrl: `${ctx.mail.baseUrl}/app/o/${orgPublicId}/notifications`,
      },
    });
    if (result.status === 'sent') sent += 1;
  }
  return { sent, recipients: recipients.length };
}

export async function alertsEvaluate(ctx, data) {
  if (!ctx.mail) return { skipped: 'email is not configured' };
  const scoped = ctx.db.forOrg(BigInt(data.orgId));
  const projectId = BigInt(data.projectId);
  if (!(await ctx.db.system.flags.isEnabled('alerts.emails', scoped.orgId))) {
    return { skipped: 'switched off' };
  }
  const project = await scoped.projects.get(projectId);
  if (!project) return { skipped: 'project is gone' };
  // Alerts are a plan feature. A plan without them leaves the events alone: they age out of the window unalerted.
  if (!(await scoped.billing.featureAllowed('alerts')))
    return { skipped: 'the plan has no alerts' };

  const now = ctx.now();
  const pending = await scoped.alerts.pending(projectId, { now });
  // A recovery case is opened by `recovery.evaluate`; each one is told about once, ever.
  const cases = await scoped.recovery.pendingAlerts(projectId, { now });
  const { items, eventIds, caseIds } = selectAlerts({
    events: pending.events,
    claims: pending.claims,
    engineNames: pending.engineNames,
    entityNames: pending.entityNames,
    cases,
  });
  if (items.length === 0) return { alerts: 0 };

  const recipients = await scoped.alerts.recipients(projectId, 'alert');
  const { orgPublicId } = await scoped.billing.summary({ now });
  const base = `${ctx.mail.baseUrl}/app/o/${orgPublicId}`;
  // A case's slot carries the day: a held-back email is tried again tomorrow under a new key.
  const slot = data.slot
    ? `${data.slot}.${now.toISOString().slice(0, 10)}`
    : (data.runId ?? (eventIds.join('-') || 'x'));
  let sent = 0;
  let capped = 0;
  for (const r of recipients) {
    const result = await ctx.mail.send({
      to: r.email,
      userId: r.userId,
      orgId: scoped.orgId,
      projectId,
      kind: 'alert',
      dedupeKey: `alert.${projectId}.${slot}.${r.userId}`,
      about: { keys: items.map((i) => i.key) },
      data: {
        subject: alertSubject(items, project.name),
        projectName: project.name,
        items,
        dashboardUrl: `${base}/projects/${project.public_id}/dashboard`,
        settingsUrl: `${base}/notifications`,
      },
    });
    if (result.status === 'sent') sent += 1;
    if (result.status === 'capped') capped += 1;
  }
  // The events are told about now, whether or not anyone was sent one (everyone may have switched alerts off).
  await scoped.alerts.markAlerted(projectId, eventIds, { now });
  // A case is different: it is told once and it matters, so while someone's daily limit held the email back it stays
  // untold and the next evaluation tries again (it is looked at for two weeks).
  if (caseIds.length > 0 && (sent > 0 || capped === 0)) {
    await scoped.recovery.markAlerted(projectId, caseIds, { now });
  }
  return { alerts: items.length, sent, recipients: recipients.length };
}

export const digestHandlers = {
  'digest.tick': digestTick,
  'digest.send': digestSend,
  'alerts.evaluate': alertsEvaluate,
};
