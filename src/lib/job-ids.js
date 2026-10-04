/**
 * Job IDs are how the queue refuses duplicates: adding a job whose ID already exists does nothing. So the ID
 * must be derived from what the job IS (this project, this week), never from when it was created, and a double
 * firing scheduler then can't start a run twice (MVP §7.8).
 *
 * BullMQ forbids ':' in a custom ID and IDs that are plain integers (it keeps those for its own counters), so
 * parts are joined with '-', and every part has to be a safe word.
 */
const SAFE_PART = /^[A-Za-z0-9_.-]+$/;

export function jobId(...parts) {
  if (parts.length === 0) throw new TypeError('A job ID needs at least one part');
  const strings = parts.map(String);
  for (const part of strings) {
    if (!SAFE_PART.test(part)) throw new TypeError(`Not usable in a job ID: "${part}"`);
  }
  const id = strings.join('-');
  if (/^\d+$/.test(id)) throw new TypeError('A job ID cannot be only digits');
  if (id.length > 200) throw new TypeError('Job ID is too long');
  return id;
}

/** The weekly tracking run of one project: the same ID for every firing of the same slot. */
export const trackingRunJobId = (projectId, weekKey) => jobId('run', projectId, weekKey);

/** Planning one run that already has its row (a first run or a "run now"): the run is the identity. */
export const trackingPlanJobId = (runId) => jobId('plan', runId);

/** Moving one run along (collect, read, roll up): one job per run, which waits by deferring itself. */
export const trackingAdvanceJobId = (runId) => jobId('advance', runId);

/** The one scan of a website: a scan has its own ID in the database, so asking twice for it is one job. */
export const scanJobId = (scanId) => jobId('scan', scanId);

/** The one job that keeps a recurring task alive (a BullMQ job scheduler's own ID). */
export const schedulerId = (name) => jobId('schedule', name.replaceAll('.', '_'));

/** The collection of one answer: one snapshot row, one job, however often it is asked for. */
export const answerJobId = (snapshotId) => jobId('answer', snapshotId);

/**
 * Reading a run's answers with one Claude batch. `round` counts extraction passes over the same run (a later
 * re-extraction is round 2), so a finished round's ID can't swallow the next one.
 */
export const extractRunJobId = (runId, round = 1) => jobId('extract', runId, `r${round}`);

/** Waiting for one Claude batch and storing its results: one job per batch. */
export const extractPollJobId = (batchId) => jobId('extract-poll', batchId);

/** Reading one answer now. `reason` tells passes apart (e.g. the batch whose item failed). */
export const extractAnswerJobId = (snapshotId, reason = 'now') =>
  jobId('extract-answer', snapshotId, reason);

/** The one run of a free audit: asking twice (a retried request, a double click on verify) is one job. */
export const auditRunJobId = (auditId) => jobId('audit', auditId);

/**
 * Reading a project's website into a Brand Kit. A job is "this project, starting from this kit version, in this
 * ten-minute slot": a double click is one job, a retry after the slot is a new one, and a kit saved in between
 * (the version moved) makes a stale job a no-op.
 */
export const brandKitJobId = (projectId, baseVersion, slot) =>
  jobId('brandkit', projectId, `v${baseVersion}`, `s${slot}`);

/** Writing a project's question set: this project, with this many active questions, in this ten-minute slot. */
export const questionsJobId = (projectId, active, slot) =>
  jobId('questions', projectId, `n${active}`, `s${slot}`);

/**
 * Bringing a project's recommendations up to date after a run or a scan finished: one job per project per cause, so a
 * run and a scan that finish together are two jobs, and the same run finishing twice is one.
 */
export const recsRefreshJobId = (projectId, cause) => jobId('recs', projectId, cause);

/**
 * Looking at a project's entity (its profiles and Wikidata). `tag` says why (`kit<version>` after a Brand Kit save, a day for
 * the sweep), so a save and the sweep are separate jobs and the same save twice is one.
 */
export const entityCheckJobId = (projectId, tag) => jobId('entity', projectId, tag);

/** Writing one recommendation's words with the model, for this evidence (the hash is of the stored evidence). */
export const narrateJobId = (recommendationId, evidenceHash) =>
  jobId('narrate', recommendationId, evidenceHash);

/** One same-day re-check attempt of one fix. `sweep` is set by the safety net, which may ask again in a later hour. */
export const fixVerifyJobId = (recommendationId, attempt, sweep = null) =>
  jobId('fixverify', recommendationId, `a${attempt}`, ...(sweep == null ? [] : [`s${sweep}`]));

/** The before/after measurement of one fix, at most once a day. */
export const outcomeJobId = (recommendationId, dayText) =>
  jobId('measure', recommendationId, dayText);

/**
 * One stage of one Content Studio item. `round` tells apart the same stage run again for the same item (the next
 * revision number for a draft and its check, the ten-minute slot for research and the plan), so a finished stage's ID
 * can't swallow a later one, and a double click is one job.
 */
export const contentJobId = (stage, itemId, round) => jobId('content', stage, itemId, `r${round}`);

/** Sending one approved change to WordPress: the change row is the identity. */
export const publishJobId = (siteChangeId) => jobId('publish', siteChangeId);

/** Writing one approved auto-fix to the customer's site: the change row is the identity. */
export const autofixJobId = (siteChangeId) => jobId('autofix', siteChangeId);

/** Taking one written auto-fix off the site: the change row is the identity (a change is undone at most once). */
export const autofixUndoJobId = (siteChangeId) => jobId('autofix-undo', siteChangeId);

/** Testing a project's WordPress connection, at most once per ten-minute slot. */
export const wordpressTestJobId = (projectId, slot) => jobId('wptest', projectId, `s${slot}`);

/** Reading one project's Google data: once a day, or once per ten-minute slot for a "sync now". */
export const googleSyncJobId = (projectId, tag) => jobId('google', projectId, tag);

/** One project's weekly digest in one hour (the hour is part of the identity: a tick that fires twice makes one). */
export const digestSendJobId = (projectId, hour) => jobId('digest', projectId, `h${hour}`);

/** The alerts for what one finished run found. */
export const alertsJobId = (projectId, runId) => jobId('alerts', projectId, `r${runId}`);

/** The ten-minute slot a time falls in. */
export const slotOf = (date) => Math.floor(date.getTime() / 600_000);
