import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * One organization's entity checks (Milestone 12). Merged into `forOrg(orgId)` as `entityChecks` (not `entities`, which is the tracked brand and competitors). The organization is bound once
 * and no function takes an `org_id` from its arguments; every query below names it.
 *
 * Two kinds of thing live here:
 *   - the LATEST check of each profile address a customer listed, and of Wikidata (`entity_checks`, one row per
 *     project, kind and subject, replaced by the next attempt), and
 *   - what the engines said about the brand (`accuracyInputs`): the brand's claims in the brand-intent answers of a
 *     window, which `src/core/entity-accuracy.js` compares with the Brand Kit.
 *
 * A check that errored is stored as `error` and is never read as `failed` by anything that reads it.
 */

/** How long a real result stands when a later attempt could not look. */
export const KEEP_VERDICT_DAYS = 30;

const day = (value) => new Date(`${new Date(value).toISOString().slice(0, 10)}T00:00:00Z`);

const toCheck = (r) => ({
  id: r.id,
  kind: r.kind,
  subject: r.subject,
  platform: r.platform,
  status: r.status,
  finding: r.finding,
  httpStatus: r.http_status,
  details: r.details ?? {},
  checkedAt: r.checked_at,
  confirmedAt: r.confirmed_at ?? null,
  confirmedByUserId: r.confirmed_by_user_id ?? null,
});

export function entityRepos(prisma, orgId, { appendActivity } = {}) {
  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true, domain: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  const entityChecks = {
    /** The latest check of each profile and of Wikidata, oldest subject first. */
    async checks(projectId) {
      await ownProject(projectId);
      const rows = await prisma.entity_checks.findMany({
        where: { org_id: orgId, project_id: projectId },
        orderBy: [{ kind: 'asc' }, { id: 'asc' }],
      });
      return rows.map(toCheck);
    },

    /**
     * Record one attempt. Safe to repeat and to race: the key is `(project, kind, subject)`.
     *
     * A real result (`passed` or `failed`) replaces the row. A "couldn't check" (`error`) must not erase what we already
     * knew: if the row holds a real result from the last `KEEP_VERDICT_DAYS`, the row keeps it and notes the failed attempt
     * in `details.lastAttempt`, so a profile that passed last week and blocks us today still reads as verified, with a
     * note that we could not look again. Past that age the error replaces it: a result that old is not worth keeping.
     *
     * @param {object} c  `{ kind, subject, platform?, status, finding, httpStatus?, details?, now? }`
     * @returns {Promise<{ kept: boolean }>}  `kept`: an earlier real result was kept over this error
     */
    async saveCheck(projectId, c) {
      await ownProject(projectId);
      const now = c.now ?? new Date();
      const where = { org_id: orgId, project_id: projectId, kind: c.kind, subject: c.subject };

      if (c.status === 'error') {
        const earlier = await prisma.entity_checks.findFirst({ where });
        const fresh =
          earlier &&
          earlier.status !== 'error' &&
          now.getTime() - earlier.checked_at.getTime() < KEEP_VERDICT_DAYS * 86_400_000;
        if (fresh) {
          await prisma.entity_checks.updateMany({
            where: { ...where, id: earlier.id },
            data: {
              details: {
                ...(earlier.details ?? {}),
                lastAttempt: { status: 'error', finding: String(c.finding), at: now.toISOString() },
              },
            },
          });
          return { kept: true };
        }
      }

      const data = {
        platform: c.platform ?? null,
        status: c.status,
        finding: String(c.finding).slice(0, 32),
        http_status: c.httpStatus ?? null,
        details: c.details ?? {},
        checked_at: now,
        // What we could read outranks what a person said: a real result ends a self-confirmation.
        ...(c.status === 'error' ? {} : { confirmed_at: null, confirmed_by_user_id: null }),
      };
      const update = () => prisma.entity_checks.updateMany({ where, data });
      if ((await update()).count === 1) return { kept: false };
      try {
        await prisma.entity_checks.create({ data: { ...where, ...data } });
      } catch (err) {
        // Two checks of the same address at once: the other one made the row first.
        if (!isUniqueViolation(err)) throw err;
        await update();
      }
      return { kept: false };
    },

    /**
     * A person says they have looked at a profile our crawler could not read, and it describes the business. Only for a
     * listed profile whose LATEST check could not look (`error`): a page we did read and found wanting is fixed on the
     * page, not confirmed away, and a passed one needs no confirming. `NOT_FOUND` when the profile has no check row yet,
     * `NOT_CONFIRMABLE` when its check read the page. Safe to repeat: the first confirmation stands.
     */
    async confirmProfile(projectId, subject, { userId, now = new Date() } = {}) {
      return transaction(prisma, async (tx) => {
        const project = await tx.projects.findFirst({
          where: { id: projectId, org_id: orgId, deleted_at: null },
          select: { id: true },
        });
        if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
        const row = await tx.entity_checks.findFirst({
          where: {
            org_id: orgId,
            project_id: projectId,
            kind: 'profile',
            subject: String(subject),
          },
        });
        if (!row) throw new DomainError('NOT_FOUND');
        if (row.status !== 'error') throw new DomainError('NOT_CONFIRMABLE');
        if (row.confirmed_at) return toCheck(row);
        const updated = await tx.entity_checks.update({
          where: { id: row.id, org_id: orgId },
          data: { confirmed_at: now, confirmed_by_user_id: userId ?? null },
        });
        await appendActivity?.(tx, {
          actorUserId: userId,
          action: 'entity.profile_confirmed',
          targetType: 'project',
          targetId: projectId,
          summary: `A ${row.platform ?? 'profile'} profile was confirmed by a person`,
          metadata: { platform: row.platform },
        });
        return toCheck(updated);
      });
    },

    /** Take a self-confirmation back. Returns whether there was one to remove. */
    async unconfirmProfile(projectId, subject, { userId } = {}) {
      return transaction(prisma, async (tx) => {
        const project = await tx.projects.findFirst({
          where: { id: projectId, org_id: orgId, deleted_at: null },
          select: { id: true },
        });
        if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
        const done = await tx.entity_checks.updateMany({
          where: {
            org_id: orgId,
            project_id: projectId,
            kind: 'profile',
            subject: String(subject),
            confirmed_at: { not: null },
          },
          data: { confirmed_at: null, confirmed_by_user_id: null },
        });
        if (done.count === 1) {
          await appendActivity?.(tx, {
            actorUserId: userId,
            action: 'entity.profile_unconfirmed',
            targetType: 'project',
            targetId: projectId,
            summary: 'A profile confirmation was taken back',
          });
        }
        return done.count === 1;
      });
    },

    /** Forget the profile checks whose address is no longer in the Brand Kit. Returns how many were removed. */
    async forgetProfilesExcept(projectId, subjects) {
      await ownProject(projectId);
      const r = await prisma.entity_checks.deleteMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          kind: 'profile',
          subject: { notIn: subjects.length ? subjects : [''] },
        },
      });
      return r.count;
    },

    /**
     * What the engines said about the brand in a window, for the accuracy comparison: the brand's claims in answers to the
     * active brand-intent questions that were collected AND read. `answersRead` is how many such answers there were, so
     * "not mentioned" is only said where something was read.
     *
     * @returns {Promise<{ claims: {id, engineCode, attribute, value}[], answersRead: number }>}
     */
    async accuracyInputs(projectId, { from, to }) {
      await ownProject(projectId);
      const brand = await prisma.tracked_entities.findFirst({
        where: { project_id: projectId, org_id: orgId, kind: 'brand' },
        select: { id: true },
      });
      const prompts = await prisma.prompts.findMany({
        where: { project_id: projectId, org_id: orgId, status: 'active', intent: 'brand' },
        select: { id: true },
      });
      if (!brand || prompts.length === 0) return { claims: [], answersRead: 0 };
      const range = { gte: day(from), lte: day(to) };
      const snapshots = await prisma.answer_snapshots.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          run_date: range,
          prompt_id: { in: prompts.map((p) => p.id) },
          status: 'ok',
          extraction_status: 'done',
        },
        select: { id: true, engine_code: true },
      });
      if (snapshots.length === 0) return { claims: [], answersRead: 0 };
      const engineOf = new Map(snapshots.map((s) => [s.id, s.engine_code]));
      const claims = await prisma.claims.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          run_date: range,
          entity_id: brand.id,
          snapshot_id: { in: [...engineOf.keys()] },
        },
        select: { id: true, snapshot_id: true, attribute: true, claim_value: true },
        orderBy: { id: 'asc' },
      });
      return {
        answersRead: snapshots.length,
        claims: claims.map((c) => ({
          id: c.id,
          engineCode: engineOf.get(c.snapshot_id),
          attribute: c.attribute,
          value: c.claim_value,
        })),
      };
    },
  };

  return { entityChecks };
}
