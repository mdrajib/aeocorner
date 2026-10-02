import { scanJobId } from '../lib/job-ids.js';
import { RUBRIC_VERSION } from './readiness/index.js';

/**
 * Ask for a scan of one of an organization's projects: create the scan row ("queued") and put the job on the
 * crawl queue. Called by whatever starts scans (onboarding, the weekly re-check, "scan again").
 *
 * The job's ID comes from the scan, so a double click can't start the same scan twice.
 *
 * @param {object} deps
 * @param {object} deps.db     createDb()
 * @param {object} deps.jobs   createJobClient()
 */
export async function requestScan({ db, jobs }, { orgId, projectId, trigger = 'manual' }) {
  const scan = await db
    .forOrg(orgId)
    .scans.create({ projectId, trigger, rubricVersion: RUBRIC_VERSION });
  await jobs.add(
    'crawl.readiness',
    { orgId: String(orgId), projectId: String(projectId), scanId: String(scan.id) },
    { jobId: scanJobId(scan.id) },
  );
  return scan;
}
