import { UnrecoverableError } from 'bullmq';
import {
  isRobotsLines,
  mergedPageDocument,
  mergeRobotsLines,
  payloadProblems,
} from '../../core/autofix-fixes.js';
import { validateJsonLd } from '../../core/jsonld.js';
import { WordPressError } from '../../integrations/wordpress.js';
import { fixVerifyJobId } from '../../lib/job-ids.js';
import { wordpressFor } from './content.js';

/**
 * Auto-fix (UI_DESIGN D3). One job per approved change:
 *
 *   autofix.apply   write what the customer previewed to their site through the AEO Corner plugin, then mark the
 *                   recommendation done, which saves the baseline and starts the same-day re-check (the site is
 *                   fetched again the way an AI crawler would, and the check the fix is about is read).
 *   autofix.undo    take it off again.
 *
 * A change is one of three kinds (see `core/autofix.js`): structured data (the home page's graph, or a block for each of
 * several key pages), titles and descriptions, or Allow lines in robots.txt. What is written is exactly the `payload` of the
 * approved `site_changes` row, checked against the fingerprint saved with it and validated again before it leaves.
 *
 * The plugin is the only thing that knows what it already holds for a page. So before a page, title or robots.txt change is
 * written, the job reads that state and saves it as `previous_value` (once: a retry after the write must not read our own
 * change back as "before"); an undo puts exactly that back. Every step is safe to repeat. "We could not write it" ends the
 * change as `failed` with a reason in plain words and leaves the recommendation in progress; a change that wrote some pages
 * and then failed puts those back first, so nothing is left half-changed.
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

/** The graph the plugin held before a change, in the shape the plugin stores: one block per address. */
const graphOf = (nodes) => ({ '@context': 'https://schema.org', '@graph': nodes });

const SAFELY =
  'What was on your page before could not be put back safely, so nothing was changed. Remove it in the plugin’s settings instead.';

// --- Writing each kind ----------------------------------------------------------------------------------------------

/** The addresses to tell IndexNow about after a write. Telling it is a courtesy: the fix stands without it. */
const addressesOf = (change) => {
  if (change.kind === 'robots_txt') return [];
  if (change.payload?.jsonld) return [change.targetUrl];
  return (change.payload?.items ?? []).map((i) => i.url);
};

/** The home page: the whole graph replaces the block (the plugin keeps one block per address). */
async function writeHomeSchema(client, change) {
  await client.plugin.setSchema({ url: change.targetUrl, jsonld: change.payload.jsonld });
}

/** Key pages: read what each holds, save it, then write our node beside the nodes of any other type. */
async function writePageSchemas(scoped, projectId, client, change) {
  const items = change.payload.items;
  const states = [];
  for (const item of items) states.push(await client.plugin.state({ url: item.url }));
  await scoped.autofix.savePrevious(projectId, change.id, {
    pages: items.map((item, i) => ({ url: item.url, jsonld: states[i].schema })),
  });
  const documents = items.map((item, i) => mergedPageDocument(states[i].schema, item.node));
  if (documents.some((doc) => !validateJsonLd(doc).ok)) {
    throw new WordPressError(
      'bad_response',
      'The structured data already on one of those pages could not be combined with ours safely, so nothing was changed.',
    );
  }
  const written = [];
  try {
    for (let i = 0; i < items.length; i += 1) {
      await client.plugin.setSchema({ url: items[i].url, jsonld: documents[i] });
      written.push(i);
    }
  } catch (err) {
    // Some pages are written and one is not: put those back, so a failed change leaves nothing behind.
    await Promise.allSettled(
      written.map((i) => putBackSchema(client, items[i].url, states[i].schema)),
    );
    throw err;
  }
}

const putBackSchema = (client, url, jsonld) =>
  jsonld ? client.plugin.setSchema({ url, jsonld }) : client.plugin.removeSchema({ url });

/** Titles and descriptions: a part we do not propose keeps what the plugin already held for that page. */
async function writeMeta(scoped, projectId, client, change) {
  const items = change.payload.items;
  const states = [];
  for (const item of items) states.push(await client.plugin.state({ url: item.url }));
  await scoped.autofix.savePrevious(projectId, change.id, {
    pages: items.map((item, i) => ({
      url: item.url,
      title: states[i].title,
      description: states[i].description,
    })),
  });
  const written = [];
  try {
    for (let i = 0; i < items.length; i += 1) {
      await client.plugin.setMeta({
        url: items[i].url,
        title: items[i].title ?? states[i].title,
        description: items[i].description ?? states[i].description,
      });
      written.push(i);
    }
  } catch (err) {
    await Promise.allSettled(
      written.map((i) =>
        client.plugin.setMeta({
          url: items[i].url,
          title: states[i].title,
          description: states[i].description,
        }),
      ),
    );
    throw err;
  }
}

/** robots.txt: only when WordPress builds the file; groups already saved by an earlier fix are kept. */
async function writeRobots(scoped, projectId, client, change) {
  const state = await client.plugin.state();
  if (!state.robots.virtual) {
    throw new WordPressError(
      'robots_file',
      'Your site has a real robots.txt file, so WordPress does not build one and the plugin cannot add to it. Add the lines to that file yourself.',
    );
  }
  await scoped.autofix.savePrevious(projectId, change.id, { lines: state.robots.lines });
  const lines = mergeRobotsLines(state.robots.lines, change.payload.lines);
  if (!isRobotsLines(lines)) {
    throw new WordPressError(
      'bad_response',
      'The lines already saved for robots.txt could not be combined with ours safely, so nothing was changed.',
    );
  }
  await client.plugin.setRobots({ lines });
}

async function write(scoped, projectId, client, change) {
  if (change.kind === 'meta') return writeMeta(scoped, projectId, client, change);
  if (change.kind === 'robots_txt') return writeRobots(scoped, projectId, client, change);
  if (change.payload?.jsonld) return writeHomeSchema(client, change);
  return writePageSchemas(scoped, projectId, client, change);
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

  if (payloadProblems(change.kind, change.payload).length) {
    return failChange(
      ctx,
      scoped,
      projectId,
      changeId,
      'What we were about to send did not match what was approved, so nothing was sent. Preview the fix and approve it again.',
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
    await write(scoped, projectId, client, change);
    const urls = addressesOf(change);
    // Telling search engines is a courtesy: the fix stands without it.
    if (urls.length) await client.plugin.indexNow(urls).catch(() => null);
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

// --- Taking each kind off -------------------------------------------------------------------------------------------

/** Put back what the plugin held before the change. Returns a plain reason when that cannot be done safely. */
async function restore(client, change) {
  const previous = change.previous ?? {};
  if (change.kind === 'meta') {
    if (!previous.captured || !Array.isArray(previous.pages)) return SAFELY;
    for (const page of previous.pages) {
      await client.plugin.setMeta({
        url: page.url,
        title: page.title ?? null,
        description: page.description ?? null,
      });
    }
    return null;
  }
  if (change.kind === 'robots_txt') {
    if (!previous.captured) return SAFELY;
    if (previous.lines) await client.plugin.setRobots({ lines: previous.lines });
    else await client.plugin.removeRobots();
    return null;
  }
  if (change.payload?.jsonld) {
    const nodes = change.previousNodes;
    if (nodes.length)
      await client.plugin.setSchema({ url: change.targetUrl, jsonld: graphOf(nodes) });
    else await client.plugin.removeSchema({ url: change.targetUrl });
    return null;
  }
  if (!previous.captured || !Array.isArray(previous.pages)) return SAFELY;
  for (const page of previous.pages) await putBackSchema(client, page.url, page.jsonld);
  return null;
}

/** Can what the plugin held before be put back as it is? Checked before anything is touched. */
function restorable(change) {
  if (change.kind === 'jsonld' && change.payload?.jsonld) {
    const nodes = change.previousNodes;
    return !nodes.length || validateJsonLd(graphOf(nodes)).ok;
  }
  if (change.kind === 'robots_txt') {
    return (
      Boolean(change.previous?.captured) &&
      (!change.previous.lines || isRobotsLines(change.previous.lines))
    );
  }
  if (!change.previous?.captured || !Array.isArray(change.previous.pages)) return false;
  if (change.kind === 'jsonld') {
    return change.previous.pages.every((p) => !p.jsonld || validateJsonLd(p.jsonld).ok);
  }
  return true;
}

/**
 * Take a written fix off the site (the undo screen): put back what the plugin held before this change (`previous_value`),
 * or remove ours if it held nothing. Safe to repeat. A failed removal releases the claim with a reason, and leaves the
 * recommendation exactly as it was: nothing is stepped back until the change is really gone.
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

  if (!restorable(change)) return fail(SAFELY);
  const stored = await scoped.integrations.wordpressSecret(projectId);
  if (!stored || stored.status !== 'connected' || !stored.config?.pluginConnected) {
    return fail(
      'The AEO Corner plugin is not connected to your WordPress site, so nothing was changed. Connect it and try again.',
    );
  }

  try {
    const client = wordpressFor(ctx, orgId, projectId, stored);
    const refused = await restore(client, change);
    if (refused) return fail(refused);
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
