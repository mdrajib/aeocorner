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
