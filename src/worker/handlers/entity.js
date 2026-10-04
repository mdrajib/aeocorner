import { UnrecoverableError } from 'bullmq';
import { brandNames } from '../../core/brand-kit.js';
import { judgeWikidata } from '../../core/entity-checks.js';
import { createProfileChecker } from '../../crawler/profile.js';
import { WikidataError } from '../../integrations/wikidata.js';
import { entityCheckJobId } from '../../lib/job-ids.js';
import { queueRefresh } from '../refresh-queue.js';

/**
 * Handlers for a project's entity (Milestone 12):
 *
 *   entity.check   look at each profile address in the project's Brand Kit, and ask Wikidata whether it knows the business.
 *                  Each result is saved over the one before (`forOrg().entityChecks.saveCheck`). Safe to repeat: a second
 *                  run replaces the same rows. Afterwards the project's recommendations are refreshed, because a failed
 *                  profile or a missing Wikidata item may be one.
 *   entity.sweep   daily: queue one `entity.check` for every active project whose checks are a week old, or were never made.
 *
 * Nothing here costs money (a profile page and Wikidata are free to read), so neither goes through `callProvider`, and a
 * lookup that cannot be made is "couldn't check" (`error`), never a failure of the customer's profile.
 */

async function entityCheck(ctx, data) {
  const crawler = ctx.crawler;
  if (!crawler?.fetcher) {
    throw new UnrecoverableError('The crawler is not configured on this worker');
  }
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scoped = ctx.db.forOrg(orgId);
  const project = await scoped.projects.get(projectId);
  if (!project || project.status === 'archived') return { skipped: 'project_gone' };
  const kit = await scoped.brandKits.current(projectId);
  if (!kit) return { skipped: 'no_brand_kit' };

  const now = ctx.now();
  const names = brandNames(kit.data);
  const profiles = kit.data.entity?.profiles ?? [];
  const checker = ctx.entity?.profiles ?? createProfileChecker({ fetcher: crawler.fetcher });
  const counts = { passed: 0, failed: 0, error: 0 };

  for (const profile of profiles) {
    const result = await checker.check({
      url: profile.url,
      brandNames: names,
      domain: project.domain,
    });
    counts[result.status] += 1;
    await scoped.entityChecks.saveCheck(projectId, {
      kind: 'profile',
      subject: profile.url,
      platform: profile.platform,
      status: result.status,
      finding: result.finding,
      httpStatus: result.httpStatus,
      details: {
        reachable: result.reachable,
        namesBrand: result.namesBrand,
        linksBack: result.linksBack,
      },
      now,
    });
  }
  await scoped.entityChecks.forgetProfilesExcept(
    projectId,
    profiles.map((p) => p.url),
  );

  let wikidata = 'not_configured';
  if (ctx.entity?.wikidata) {
    try {
      const givenId = kit.data.entity?.wikidataId ?? '';
      const items = await ctx.entity.wikidata.lookup({ names, givenId });
      const verdict = judgeWikidata({ brandNames: names, domain: project.domain, givenId, items });
      await scoped.entityChecks.saveCheck(projectId, {
        kind: 'wikidata',
        subject: 'wikidata',
        status: verdict.status,
        finding: verdict.finding,
        details: { item: verdict.item, candidates: verdict.candidates },
        now,
      });
      wikidata = verdict.finding;
    } catch (err) {
      if (!(err instanceof WikidataError)) throw err;
      // Wikidata being down says nothing about the customer. The earlier result, if any, stands.
      await scoped.entityChecks.saveCheck(projectId, {
        kind: 'wikidata',
        subject: 'wikidata',
        status: 'error',
        finding: 'lookup_failed',
        now,
      });
      wikidata = 'lookup_failed';
    }
  }

  await queueRefresh(ctx, { orgId, projectId, cause: `entity${now.toISOString().slice(0, 10)}` });
  return { profiles: counts, wikidata };
}

async function entitySweep(ctx) {
  const now = ctx.now();
  const day = now.toISOString().slice(0, 10);
  const due = await ctx.db.system.entity.due({ now });
  for (const d of due) {
    await ctx.jobs.add(
      'entity.check',
      { orgId: String(d.orgId), projectId: String(d.projectId) },
      { jobId: entityCheckJobId(d.projectId, `d${day}`) },
    );
  }
  return { queued: due.length };
}

export const entityHandlers = {
  'entity.check': entityCheck,
  'entity.sweep': entitySweep,
};
