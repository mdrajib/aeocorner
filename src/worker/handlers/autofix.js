import { UnrecoverableError } from 'bullmq';
import { fingerprint } from '../../core/autofix.js';
import { validateJsonLd } from '../../core/jsonld.js';
import { WordPressError } from '../../integrations/wordpress.js';
import { fixVerifyJobId } from '../../lib/job-ids.js';
import { wordpressFor } from './content.js';

/**
 * Auto-fix (UI_DESIGN D3). One job per approved change:
 *
 *   autofix.apply   write the structured data the customer previewed to their site through the AEO Corner plugin, then
 *                   mark the recommendation done, which saves the baseline and starts the same-day re-check (the site is
 *                   fetched again the way an AI crawler would, and the check the fix is about is read).
 *
 * What is written is exactly `payload.jsonld` of the approved `site_changes` row, checked against the fingerprint saved
 * with it and validated again before it leaves. Every step is safe to repeat: a retry after a crash writes the same block
 * (the plugin replaces the block for an address) and marks the recommendation done only if it is still open or in progress.
 * "We could not write it" ends the change as `failed` with a reason in plain words and leaves the recommendation in progress.
 */

/** The recommendation behind a written fix is done: baseline saved, re-check queued. Safe to run twice. */
async function afterApply(ctx, scoped, projectId, change) {
  const recId = change.recommendationId;
  if (!recId) return { recommendation: 'none' };
  const rec = await scoped.recommendations.load(recId);
  if (!rec || !['open', 'in_progress'].includes(rec.status)) {
    return { recommendation: 'left_alone', status: rec?.status ?? null };
  }
  const userId = change.approvedByUserId;
  if (rec.status === 'open') {
    await scoped.recommendations.transition(projectId, recId, 'in_progress', {
      userId,
      now: ctx.now(),
    });
  }
  const done = await scoped.recommendations.markDone(projectId, recId, { userId, now: ctx.now() });
  if (done.verifiable) {
    await ctx.jobs.add(
      'fix.verify',
      { orgId: String(scoped.orgId), recommendationId: String(recId), attempt: 1 },
      { jobId: fixVerifyJobId(recId, 1) },
    );
  }
  return { recommendation: 'done', verifiable: done.verifiable };
}

async function failChange(ctx, scoped, projectId, changeId, message) {
  await scoped.autofix.finish(projectId, changeId, { ok: false, error: message, now: ctx.now() });
  return { failed: true, reason: message };
}

export async function autofixApply(ctx, data, job) {
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const changeId = BigInt(data.siteChangeId);
  const scoped = ctx.db.forOrg(orgId);

  const change = await scoped.autofix.forApply(projectId, changeId);
  if (!change) throw new UnrecoverableError(`Site change ${data.siteChangeId} was not found`);
  if (change.status === 'applied') {
    // A retry after the write but before the recommendation moved on.
    return { repeated: true, ...(await afterApply(ctx, scoped, projectId, change)) };
  }
  if (!['approved', 'applying'].includes(change.status)) {
    return { skipped: change.status, repeated: true };
  }

  const jsonld = change.payload?.jsonld;
  if (!jsonld || fingerprint(jsonld) !== change.payload?.hash || !validateJsonLd(jsonld).ok) {
    return failChange(
      ctx,
      scoped,
      projectId,
      changeId,
      'The structured data did not match what was approved, so nothing was sent. Preview the fix and approve it again.',
    );
  }

  const stored = await scoped.integrations.wordpressSecret(projectId);
  if (!stored || stored.status !== 'connected' || !stored.config?.pluginConnected) {
    return failChange(
      ctx,
      scoped,
      projectId,
      changeId,
      'The AEO Corner plugin is not connected to your WordPress site, so nothing was changed. Connect it and try again.',
    );
  }

  await scoped.autofix.markApplying(projectId, changeId);
  try {
    const client = wordpressFor(ctx, orgId, projectId, stored);
    await client.plugin.setSchema({ url: change.targetUrl, jsonld });
    // Telling search engines is a courtesy: the fix stands without it.
    await client.plugin.indexNow([change.targetUrl]).catch(() => null);
  } catch (err) {
    if (!(err instanceof WordPressError)) throw err;
    if (['auth_failed', 'forbidden'].includes(err.code)) {
      await scoped.integrations.wordpressResult(projectId, {
        ok: false,
        error: err.message,
        now: ctx.now(),
      });
    }
    const last = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
    if (err.retryable && !last) throw err;
    ctx.logger.warn(
      { changeId: data.siteChangeId, code: err.code },
      'Auto-fix could not be written',
    );
    return failChange(ctx, scoped, projectId, changeId, err.message);
  }

  await scoped.integrations.wordpressResult(projectId, { ok: true, now: ctx.now() });
  await scoped.autofix.finish(projectId, changeId, { ok: true, now: ctx.now() });
  const fresh = await scoped.autofix.forApply(projectId, changeId);
  return { applied: true, ...(await afterApply(ctx, scoped, projectId, fresh)) };
}

export const autofixHandlers = {
  'autofix.apply': autofixApply,
};
