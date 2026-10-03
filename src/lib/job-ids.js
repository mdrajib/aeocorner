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

/** The ten-minute slot a time falls in. */
export const slotOf = (date) => Math.floor(date.getTime() / 600_000);
