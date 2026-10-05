import { planTick, SKIP_TEXT, withdrawalReason } from '../../core/autopilot.js';
import { contentStartFor } from '../../core/content-start.js';
import { isoWeekKey } from '../../core/slots.js';
import { DomainError } from '../../db/errors.js';
import { proposeAutofix } from '../../lib/autofix-proposal.js';
import { contentJobId, slotOf } from '../../lib/job-ids.js';

/**
 * Autopilot (Milestone 15; ADR-0016). One job, `autopilot.tick` (queue `content`), queued after a refresh of a project's
 * recommendations when the project has Autopilot on (`queueAutopilot`, src/worker/refresh-queue.js).
 *
 * It PREPARES and never decides. For each of the best open recommendations that has a path it does one of two things a person
 * could have done by pressing the existing buttons, up to the approval:
 *   - a fix the plugin can write: works out the exact change (the same function the preview uses) and keeps its fingerprint.
 *     Nothing is sent to the plugin and nothing is written to `site_changes`.
 *   - a page: starts a Content Studio item (which takes a unit of the month's draft allowance, like a click) and queues its
 *     research; the pipeline stops at the quality check, which is where a person takes over. Nothing is published.
 * Then the item sits `ready` until a person approves it through the Action Center's own approve route, or rejects it.
 *
 * Safe to repeat: an item's identity is (recommendation, basis), so a second tick for the same state prepares nothing, and a
 * crash and retry finds what was already made. Free of provider cost itself; the drafts it starts cost what a draft costs and
 * come out of the same allowance, the daily spend cap and the same provider guards as a draft a person started.
 */

/** A line of words for what a fix would do, for the inbox. Built from the preview's own list of what it includes. */
function summaryOfFix(rule, built) {
  const parts = Array.isArray(built.includes) ? built.includes.slice(0, 4) : [];
  const more =
    Array.isArray(built.includes) && built.includes.length > 4
      ? ` and ${built.includes.length - 4} more`
      : '';
  return parts.length ? `${parts.join('; ')}${more}.` : `${rule.label}.`;
}

/** Where a fix lands, as the inbox says it. Counts and a kind only: never the code itself. */
function preparedOf(built) {
  return {
    kind: built.kind,
    scope: built.scope,
    place: built.targetUrl ?? null,
    items: Array.isArray(built.items) ? built.items.length : null,
    lines: Array.isArray(built.lines) ? built.lines.length : null,
  };
}

async function draftsLeft(scoped, now) {
  const { used, limit } = await scoped.draftQuota.draftsUsed({ now });
  return limit == null ? null : Math.max(0, limit - used);
}

export async function autopilotTick(ctx, data) {
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scoped = ctx.db.forOrg(orgId);
  const project = await scoped.projects.get(projectId);
  if (!project || project.status === 'archived') return { skipped: 'project_gone' };
  const now = ctx.now();
  const weekKey = isoWeekKey(now);

  // First follow what people did, so the inbox and the limits are counted from the truth.
  const { approved: settled } = await scoped.autopilot.settle(projectId, { now });

  const todo = await scoped.recommendations.list(projectId, { view: 'todo' });
  let withdrawn = 0;
  for (const item of await scoped.autopilot.list(projectId, { statuses: ['ready'] })) {
    const rec = await scoped.recommendations.load(item.recommendationId);
    let reason = withdrawalReason(item, rec, { now });
    // A draft a person archived on the Content board is not waiting for them any more.
    if (!reason && item.kind === 'content' && item.contentItemId != null) {
      const draft = await scoped.content.get(projectId, String(item.contentItemId));
      if (!draft || draft.status === 'archived') reason = 'The draft was archived.';
    }
    if (reason) {
      const { withdrawn: done } = await scoped.autopilot.withdraw(projectId, item.id, reason, {
        now,
      });
      if (done) withdrawn += 1;
    }
  }

  const [settings, flagOn, planAllows, access, spend, left, integration, items] = await Promise.all(
    [
      scoped.autopilot.settings(projectId),
      ctx.db.system.flags.isEnabled('autopilot', orgId),
      scoped.billing.featureAllowed('autopilot'),
      scoped.billing.access({ now, enforced: Boolean(ctx.billing?.enforced) }),
      scoped.spend.state(),
      draftsLeft(scoped, now),
      scoped.integrations.wordpress(projectId),
      scoped.autopilot.forPlanning(projectId),
    ],
  );
  const plan = planTick({
    settings,
    planAllows,
    flagOn,
    collecting: access.collect,
    spendPaused: Boolean(spend.pausedUntil && spend.pausedUntil.getTime() > now.getTime()),
    pluginReady:
      integration?.status === 'connected' && Boolean(integration.config?.pluginConnected),
    recommendations: todo,
    items,
    weekKey,
    now,
    draftsLeft: left,
  });

  const made = [];
  const couldNot = [];
  for (const pick of plan.picks) {
    const { rec, kind, basis } = pick;
    try {
      if (kind === 'auto_fix') {
        const proposal = await proposeAutofix({ scoped, project, rec });
        if (!proposal.pluginReady || !proposal.built?.ok) {
          couldNot.push({
            recommendationId: String(rec.id),
            why: proposal.built?.reason ?? 'no plugin',
          });
          continue;
        }
        const out = await scoped.autopilot.prepare(projectId, {
          recommendationId: rec.id,
          kind,
          basisHash: basis,
          weekKey,
          title: proposal.rule.action,
          summary: summaryOfFix(proposal.rule, proposal.built),
          preparedHash: proposal.built.hash,
          prepared: preparedOf(proposal.built),
          now,
        });
        if (out.created) made.push({ id: String(out.item.id), kind });
      } else {
        const start = contentStartFor(rec);
        let item;
        try {
          item = await scoped.content.create(projectId, {
            recommendationId: rec.id,
            userId: null,
            now,
            ...start,
          });
        } catch (err) {
          // A draft is already open for it (a person's, or an earlier crash's): it is theirs, not Autopilot's to claim.
          if (err instanceof DomainError && err.code === 'CONTENT_ALREADY_OPEN') {
            couldNot.push({ recommendationId: String(rec.id), why: 'a draft is already open' });
            continue;
          }
          throw err;
        }
        if (item.blocked === 'quota') {
          couldNot.push({
            recommendationId: String(rec.id),
            why: 'the draft allowance is used up',
          });
          break; // no unit for this one means none for the rest
        }
        const out = await scoped.autopilot.prepare(projectId, {
          recommendationId: rec.id,
          kind,
          basisHash: basis,
          weekKey,
          title: rec.title,
          summary: `A draft ${start.kind === 'refresh' ? 'refresh of an existing page' : 'new page'}, written from your Brand Kit and checked before you see it.`,
          contentItemId: item.id,
          now,
        });
        if (out.created) made.push({ id: String(out.item.id), kind });
        try {
          await ctx.jobs.add(
            'content.research',
            { orgId: data.orgId, projectId: data.projectId, itemId: String(item.id) },
            { jobId: contentJobId('research', item.id, slotOf(now)) },
          );
        } catch (err) {
          ctx.logger.warn(
            { err: err.message },
            'Could not queue the research for an Autopilot draft',
          );
          await scoped.content
            .fail(projectId, item.id, {
              stage: 'researching',
              reason: 'We could not start this just now. Try again in a minute.',
            })
            .catch(() => {});
        }
      }
    } catch (err) {
      // One recommendation that cannot be prepared must not stop the rest, and nothing here is worth failing the job for:
      // the next tick looks again.
      ctx.logger.warn(
        { err: err.message, recommendationId: String(rec.id) },
        'Autopilot could not prepare an item',
      );
      couldNot.push({ recommendationId: String(rec.id), why: 'an error' });
    }
  }

  const skipped = made.length ? null : (plan.skipped ?? 'nothing');
  const summary = {
    weekKey,
    prepared: made.length,
    withdrawn,
    settled,
    skipped,
    ...(couldNot.length ? { couldNot: couldNot.slice(0, 5) } : {}),
  };
  // Only a project that has it on keeps a note of what happened; a tick for one that is off is not worth a row.
  if (settings.enabled) await scoped.autopilot.recordTick(projectId, summary, { now });
  return {
    projectId: data.projectId,
    ...summary,
    skippedText: skipped ? SKIP_TEXT[skipped] : null,
  };
}

export const autopilotHandlers = { 'autopilot.tick': autopilotTick };
