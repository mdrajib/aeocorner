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

/** The graph the plugin held before a change, in the shape the plugin stores: one block per address. */
const graphOf = (nodes) => ({ '@context': 'https://schema.org', '@graph': nodes });

/**
 * Take a written fix off the site (the undo screen). The plugin keeps one block per address, so "undo" is: put back the nodes
 * that were there before this change (`previous_value`), or remove the block if there were none. Safe to repeat. A failed
 * removal releases the claim with a reason, and leaves the recommendation exactly as it was: nothing is stepped back
 * until the code is really gone.
 */
export async function autofixUndo(ctx, data, job) {
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const changeId = BigInt(data.siteChangeId);
  const scoped = ctx.db.forOrg(orgId);

  const change = await scoped.autofix.forApply(projectId, changeId);
  if (!change) throw new UnrecoverableError(`Site change ${data.siteChangeId} was not found`);
  const stepBack = async () =>
    change.recommendationId
      ? scoped.recommendations.fixRemoved(projectId, change.recommendationId, { now: ctx.now() })
      : { changed: false };
  if (change.status === 'rolled_back') return { repeated: true, ...(await stepBack()) };
  if (change.status !== 'applied' || !change.undoRequestedByUserId) {
    return { skipped: change.status, repeated: true };
  }
  const fail = async (message) => {
    await scoped.autofix.finishUndo(projectId, changeId, {
      ok: false,
      error: message,
      now: ctx.now(),
    });
    return { failed: true, reason: message };
  };

  const restore = change.previousNodes;
  if (restore.length && !validateJsonLd(graphOf(restore)).ok) {
    return fail(
      'What was on your page before could not be put back safely, so nothing was changed. Remove it in the plugin’s settings instead.',
    );
  }
  const stored = await scoped.integrations.wordpressSecret(projectId);
  if (!stored || stored.status !== 'connected' || !stored.config?.pluginConnected) {
    return fail(
      'The AEO Corner plugin is not connected to your WordPress site, so nothing was changed. Connect it and try again.',
    );
  }

  try {
    const client = wordpressFor(ctx, orgId, projectId, stored);
    if (restore.length)
      await client.plugin.setSchema({ url: change.targetUrl, jsonld: graphOf(restore) });
    else await client.plugin.removeSchema({ url: change.targetUrl });
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
      'Auto-fix could not be removed',
    );
    return fail(err.message);
  }

  await scoped.integrations.wordpressResult(projectId, { ok: true, now: ctx.now() });
  await scoped.autofix.finishUndo(projectId, changeId, { ok: true, now: ctx.now() });
  return { undone: true, ...(await stepBack()) };
}

export const autofixHandlers = {
  'autofix.apply': autofixApply,
  'autofix.undo': autofixUndo,
};
