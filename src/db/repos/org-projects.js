import { BRAND_KIT_SCHEMA_VERSION, parseBrandKit } from '../../core/brand-kit.js';
import { engineAccess, engineChoices, featureForEngine } from '../../core/engines.js';
import {
  checkProjectFields,
  normalizeEntityName,
  weeklySlotHour,
} from '../../core/project-rules.js';
import { newVerificationToken } from '../../core/domain-verification.js';
import { ulid } from '../../lib/ulid.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * One organization's projects (DATABASE_SCHEMA §3): the project itself, the engines it tracks, and the brand,
 * competitors and aliases it is read for. Merged into `forOrg(orgId)`: the organization is bound once and no
 * function takes an `org_id` from its arguments (see org-scoped.js).
 *
 * A project is never deleted here. `archive` sets `deleted_at`, which frees the domain for a new project (the
 * unique key is on the generated `active_domain`) and starts the purge clock.
 */

const PURGE_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function projectRepos(prisma, orgId, { appendActivity }) {
  async function ownProject(tx, projectId) {
    const project = await tx.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
    });
    if (!project) throw new DomainError('NOT_FOUND');
    return project;
  }

  async function activeEngineCodes(tx) {
    const rows = await tx.engines.findMany({
      where: { status: 'active' },
      select: { code: true },
      orderBy: { sort_order: 'asc' },
    });
    return rows.map((r) => r.code);
  }

  /**
   * Which plan-gated engines (src/core/engines.js) this organization may use. An organization with no plan is not held
   * back (as `billing.featureAllowed`: billing is not on yet, or it has not chosen one); one with a plan needs the
   * feature. `included` is stricter: only a plan that explicitly lists it, which is what a NEW project is given by
   * default (task 16.05); an engine that costs money is never switched on for a project by the absence of a plan.
   */
  async function planEngines(db) {
    const org = await db.organizations.findFirst({
      where: { id: orgId },
      select: { plan_code: true, claude_until: true },
    });
    const plan = org?.plan_code
      ? await db.plans.findUnique({ where: { code: org.plan_code } })
      : null;
    const hasPlan = Boolean(org?.plan_code);
    return {
      allowed: (code) => {
        const feature = featureForEngine(code);
        return !feature || !hasPlan || Boolean(plan?.features?.[feature]);
      },
      included: (code) => {
        const feature = featureForEngine(code);
        return !feature || Boolean(plan?.features?.[feature]);
      },
      /** Until when a project that already tracks the engine keeps it after a downgrade (F3, option C); null if no grace runs. */
      graceUntil: (code) =>
        engineAccess({ code, hasPlan, plan, graceUntil: org?.claude_until, now: new Date() }) ===
        'grace'
          ? org.claude_until
          : null,
    };
  }

  const versionRow = (client, projectId, version) =>
    client.brand_profiles.findFirst({
      where: { project_id: projectId, org_id: orgId, version },
    });

  /**
   * Make the brand entity's name and domain aliases (and its own name) match the kit. Aliases that came from the
   * Brand Kit are replaced; "That's not us" rules and aliases added by other routes stay.
   */
  async function syncBrandNames(tx, projectId, kit, actorUserId) {
    const brand = await tx.tracked_entities.findFirst({
      where: { project_id: projectId, org_id: orgId, kind: 'brand' },
    });
    if (!brand) return;
    const name = kit.identity.brandName;
    if (name !== brand.name) {
      await tx.tracked_entities.update({
        where: { id: brand.id, org_id: orgId },
        data: { name, name_normalized: normalizeEntityName(name) },
      });
      await tx.projects.update({
        where: { id: projectId, org_id: orgId },
        data: { name: name.slice(0, 128) },
      });
    }
    await tx.entity_aliases.deleteMany({
      where: { entity_id: brand.id, org_id: orgId, source: 'brand_kit' },
    });
    const own = normalizeEntityName(name);
    const wanted = new Map();
    for (const alias of kit.identity.aliases) {
      const key = normalizeEntityName(alias);
      if (key && key !== own) wanted.set(`name:${key}`, { kind: 'name', value: alias, key });
    }
    for (const domain of kit.identity.domains) {
      const key = domain.toLowerCase();
      wanted.set(`domain:${key}`, { kind: 'domain', value: domain, key });
    }
    for (const a of wanted.values()) {
      const exists = await tx.entity_aliases.findFirst({
        where: { entity_id: brand.id, org_id: orgId, kind: a.kind, value_normalized: a.key },
        select: { id: true },
      });
      if (exists) continue; // the customer already added this one by hand
      await tx.entity_aliases.create({
        data: {
          org_id: orgId,
          project_id: projectId,
          entity_id: brand.id,
          kind: a.kind,
          value: a.value,
          value_normalized: a.key,
          source: 'brand_kit',
          created_by_user_id: actorUserId ?? null,
        },
      });
    }
  }

  const projects = {
    /**
     * Create a project with its brand entity and every active engine switched on, in one transaction. `domain`
     * is a bare host name (already through `normalizeWebsite`); one live project per domain per organization.
     */
    async create({
      name,
      domain,
      country,
      language,
      city,
      timezone,
      cadence,
      sourceAuditPublicId,
      createdByUserId,
    }) {
      const checked = checkProjectFields({ name, country, language, city, timezone, cadence });
      if (!checked.ok) throw new DomainError('INVALID_PROJECT', JSON.stringify(checked.errors));
      const host = String(domain ?? '').toLowerCase();
      if (!DOMAIN.test(host)) throw new DomainError('INVALID_DOMAIN');

      const publicId = ulid();
      try {
        return await transaction(prisma, async (tx) => {
          // The audit's secret address is the proof the visitor ran it; one already owned by another organization is refused.
          let sourceAuditId = null;
          let auditHasProject = false;
          if (sourceAuditPublicId != null) {
            const audit = await tx.audits.findFirst({
              where: { public_id: String(sourceAuditPublicId) },
              select: { id: true, org_id: true, project_id: true },
            });
            if (!audit || (audit.org_id !== null && audit.org_id !== orgId)) {
              throw new DomainError('NOT_FOUND');
            }
            sourceAuditId = audit.id;
            auditHasProject = audit.project_id !== null;
          }
          const project = await tx.projects.create({
            data: {
              public_id: publicId,
              org_id: orgId,
              ...checked.value,
              domain: host,
              weekly_slot_hour: weeklySlotHour(publicId),
              domain_verify_token: newVerificationToken(),
              source_audit_id: sourceAuditId,
              created_by_user_id: createdByUserId ?? null,
            },
          });
          if (sourceAuditId !== null) {
            // Signing up from a report claims it: it now belongs to this organization (and to its first project).
            await tx.audits.update({
              where: { id: sourceAuditId },
              data: { org_id: orgId, ...(auditHasProject ? {} : { project_id: project.id }) },
            });
          }
          await tx.tracked_entities.create({
            data: {
              org_id: orgId,
              project_id: project.id,
              kind: 'brand',
              name: checked.value.name,
              name_normalized: normalizeEntityName(checked.value.name),
              primary_domain: host,
              source: sourceAuditId === null ? 'user' : 'audit',
            },
          });
          const gate = await planEngines(tx);
          const codes = (await activeEngineCodes(tx)).filter(gate.included);
          if (codes.length) {
            await tx.project_engines.createMany({
              data: codes.map((engine_code) => ({
                project_id: project.id,
                org_id: orgId,
                engine_code,
              })),
            });
          }
          await appendActivity(tx, {
            actorUserId: createdByUserId,
            action: 'project.created',
            targetType: 'project',
            targetId: project.id,
            summary: `Project ${checked.value.name} was created`,
          });
          return project;
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_projects_org_domain')) throw new DomainError('DOMAIN_TAKEN');
        throw err;
      }
    },

    /** A live project by its internal ID, or null. */
    get: (projectId) =>
      prisma.projects.findFirst({ where: { id: projectId, org_id: orgId, deleted_at: null } }),

    /** A live project by the ID shown in URLs, or null. A malformed ID simply finds nothing. */
    getByPublicId: (publicId) =>
      typeof publicId === 'string' && publicId.length === 26
        ? prisma.projects.findFirst({
            where: { public_id: publicId, org_id: orgId, deleted_at: null },
          })
        : null,

    /** Live projects, oldest first. `onlyIds` limits the list to a client seat's selected projects. */
    list: ({ onlyIds } = {}) =>
      prisma.projects.findMany({
        where: {
          org_id: orgId,
          deleted_at: null,
          ...(onlyIds ? { id: { in: onlyIds } } : {}),
        },
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      }),

    /** Change a project's settings. The domain can't change: it identifies the brand. */
    async update(projectId, changes, { actorUserId } = {}) {
      const checked = checkProjectFields(changes, { partial: true });
      if (!checked.ok) throw new DomainError('INVALID_PROJECT', JSON.stringify(checked.errors));
      return transaction(prisma, async (tx) => {
        const project = await ownProject(tx, projectId);
        if (Object.keys(checked.value).length === 0) return project;
        const updated = await tx.projects.update({
          where: { id: project.id, org_id: orgId },
          data: checked.value,
        });
        if (checked.value.name && checked.value.name !== project.name) {
          await tx.tracked_entities.updateMany({
            where: { project_id: project.id, org_id: orgId, kind: 'brand' },
            data: {
              name: checked.value.name,
              name_normalized: normalizeEntityName(checked.value.name),
            },
          });
        }
        await appendActivity(tx, {
          actorUserId,
          action: 'project.updated',
          targetType: 'project',
          targetId: project.id,
          summary: `Project ${updated.name} was changed`,
          metadata: { fields: Object.keys(checked.value) },
        });
        return updated;
      });
    },

    /**
     * Move a project, and every question that is still in use, to another country and city. A question carries the
     * place it is asked from, so changing only the project would leave the next check asking from the old one.
     * Archived questions stay where they were asked (they are history, and their answers belong to that place).
     * A question whose text already exists at the new place (from an earlier move) cannot move: the whole change is
     * refused with LOCATION_CONFLICT and nothing is changed. Returns `{ project, moved }`.
     */
    async setLocation(projectId, { country, city = '' }, { actorUserId } = {}) {
      const checked = checkProjectFields({ country: country ?? '', city }, { partial: true });
      if (!checked.ok) throw new DomainError('INVALID_PROJECT', JSON.stringify(checked.errors));
      const next = { country: checked.value.country, city: checked.value.city ?? '' };
      return transaction(prisma, async (tx) => {
        const project = await ownProject(tx, projectId);
        if (project.country === next.country && project.city === next.city) {
          return { project, moved: 0 };
        }
        const live = await tx.prompts.findMany({
          where: {
            project_id: project.id,
            org_id: orgId,
            status: { in: ['active', 'paused'] },
          },
          select: { id: true, language: true, text_hash: true },
        });
        if (live.length) {
          const clash = await tx.prompts.findFirst({
            where: {
              project_id: project.id,
              org_id: orgId,
              country: next.country,
              city: next.city,
              id: { notIn: live.map((p) => p.id) },
              OR: live.map((p) => ({ language: p.language, text_hash: p.text_hash })),
            },
            select: { id: true },
          });
          if (clash) throw new DomainError('LOCATION_CONFLICT');
        }
        const moved = await tx.prompts.updateMany({
          where: {
            project_id: project.id,
            org_id: orgId,
            status: { in: ['active', 'paused'] },
          },
          data: next,
        });
        const updated = await tx.projects.update({
          where: { id: project.id, org_id: orgId },
          data: next,
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'project.location_changed',
          targetType: 'project',
          targetId: project.id,
          summary: `Project ${updated.name} moved to ${next.city ? `${next.city}, ` : ''}${next.country}`,
          metadata: {
            from: { country: project.country, city: project.city },
            to: next,
            questions: moved.count,
          },
        });
        return { project: updated, moved: moved.count };
      });
    },

    /**
     * What the customer needs to prove they own the site, and whether they have: `{ token, verifiedAt, method }`.
     * A project made before verification existed gets its token the first time it is asked for.
     */
    async verification(projectId) {
      await ownProject(prisma, projectId);
      await prisma.projects.updateMany({
        where: { id: projectId, org_id: orgId, domain_verify_token: null },
        data: { domain_verify_token: newVerificationToken() },
      });
      const p = await ownProject(prisma, projectId);
      return {
        token: p.domain_verify_token,
        verifiedAt: p.domain_verified_at,
        method: p.domain_verify_method,
      };
    },

    /** Record that ownership was proven (by `dns` or `file`). Repeating it keeps the first time. */
    async markVerified(projectId, method, { actorUserId } = {}) {
      if (!['dns', 'file'].includes(method)) throw new DomainError('INVALID_METHOD');
      return transaction(prisma, async (tx) => {
        const project = await ownProject(tx, projectId);
        if (project.domain_verified_at) return project;
        const updated = await tx.projects.update({
          where: { id: project.id, org_id: orgId },
          data: { domain_verified_at: new Date(), domain_verify_method: method },
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'project.domain_verified',
          targetType: 'project',
          targetId: project.id,
          summary: `Ownership of ${project.domain} was verified (${method === 'dns' ? 'DNS record' : 'file'})`,
          metadata: { method },
        });
        return updated;
      });
    },

    /**
     * Switch tracking on: an `onboarding` project becomes `active`, so the hourly scheduler picks it up at its weekly
     * slot. It needs at least one active question and one enabled engine (NOT_READY otherwise). Already active:
     * nothing changes (`changed: false`). A paused or archived project cannot be started (PROJECT_NOT_TRACKABLE).
     */
    async startTracking(projectId, { actorUserId } = {}) {
      return transaction(prisma, async (tx) => {
        const project = await ownProject(tx, projectId);
        if (project.status === 'active') return { changed: false, project };
        if (project.status !== 'onboarding') throw new DomainError('PROJECT_NOT_TRACKABLE');
        const [questions, engines] = await Promise.all([
          tx.prompts.count({ where: { project_id: project.id, org_id: orgId, status: 'active' } }),
          tx.project_engines.count({
            where: { project_id: project.id, org_id: orgId, enabled: true },
          }),
        ]);
        if (questions === 0 || engines === 0) throw new DomainError('NOT_READY');
        const updated = await tx.projects.update({
          where: { id: project.id, org_id: orgId },
          data: { status: 'active' },
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'project.tracking_started',
          targetType: 'project',
          targetId: project.id,
          summary: `Tracking started for ${project.name}`,
        });
        return { changed: true, project: updated };
      });
    },

    /** Archive a project: it leaves every list, its domain is free again, and it is purged after 30 days. */
    async archive(projectId, { actorUserId } = {}) {
      return transaction(prisma, async (tx) => {
        const project = await ownProject(tx, projectId);
        const now = new Date();
        await tx.projects.update({
          where: { id: project.id, org_id: orgId },
          data: {
            status: 'archived',
            deleted_at: now,
            purge_after: new Date(now.getTime() + PURGE_AFTER_DAYS * DAY_MS),
          },
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'project.archived',
          targetType: 'project',
          targetId: project.id,
          summary: `Project ${project.name} was archived`,
        });
      });
    },
  };

  const projectEngines = {
    /** Every engine with this project's setting for it (switched on or off, weight). */
    async list(projectId) {
      await ownProject(prisma, projectId);
      return prisma.project_engines.findMany({
        where: { project_id: projectId, org_id: orgId },
        orderBy: { engine_code: 'asc' },
      });
    },

    /**
     * Every live engine with this project's setting for it, in catalog order, and whether the plan lets the organization
     * use it. An engine the project has no row for was never offered to it: `notTracked`, which a screen shows as "Not
     * tracked" and which is not a measurement of any kind (src/core/engines.js).
     */
    async choices(projectId) {
      await ownProject(prisma, projectId);
      const [catalog, rows, gate] = await Promise.all([
        prisma.engines.findMany({
          where: { status: 'active' },
          select: { code: true, name: true },
          orderBy: { sort_order: 'asc' },
        }),
        prisma.project_engines.findMany({ where: { project_id: projectId, org_id: orgId } }),
        planEngines(prisma),
      ]);
      return engineChoices(catalog, rows, gate.allowed, gate.graceUntil);
    },

    /** Switch engines on or off. Only engines that are live in the catalog can be enabled; at least one stays on. */
    async setEnabled(projectId, enabledCodes, { actorUserId } = {}) {
      const wanted = [...new Set(enabledCodes)];
      if (wanted.length === 0) throw new DomainError('NO_ENGINES');
      return transaction(prisma, async (tx) => {
        const project = await ownProject(tx, projectId);
        const live = new Set(await activeEngineCodes(tx));
        if (!wanted.every((code) => live.has(code))) throw new DomainError('UNKNOWN_ENGINE');
        const gate = await planEngines(tx);
        // Keeping an engine the plan no longer includes is fine while its paid period runs (it can only be switched off then).
        const current = await tx.project_engines.findMany({
          where: { project_id: project.id, org_id: orgId, enabled: true },
          select: { engine_code: true },
        });
        const keeping = new Set(current.map((r) => r.engine_code));
        if (
          !wanted.every(
            (code) => gate.allowed(code) || (keeping.has(code) && gate.graceUntil(code)),
          )
        )
          throw new DomainError('ENGINE_NOT_IN_PLAN');
        for (const code of live) {
          const enabled = wanted.includes(code);
          const result = await tx.project_engines.updateMany({
            where: { project_id: project.id, org_id: orgId, engine_code: code },
            data: { enabled },
          });
          if (result.count === 0) {
            await tx.project_engines.create({
              data: { project_id: project.id, org_id: orgId, engine_code: code, enabled },
            });
          }
        }
        await appendActivity(tx, {
          actorUserId,
          action: 'project.engines_changed',
          targetType: 'project',
          targetId: project.id,
          summary: 'The tracked engines were changed',
          metadata: { enabled: wanted },
        });
        return tx.project_engines.findMany({
          where: { project_id: project.id, org_id: orgId },
          orderBy: { engine_code: 'asc' },
        });
      });
    },
  };

  const entities = {
    /** The brand, competitors and discovered brands of a project, brand first. */
    async list(projectId, { kind } = {}) {
      await ownProject(prisma, projectId);
      const rows = await prisma.tracked_entities.findMany({
        where: { project_id: projectId, org_id: orgId, ...(kind ? { kind } : {}) },
        include: { entity_aliases: { orderBy: { id: 'asc' } } },
        orderBy: [{ id: 'asc' }],
      });
      const rank = { brand: 0, competitor: 1, discovered: 2 };
      return rows
        .map(({ entity_aliases: aliases, ...entity }) => ({ ...entity, aliases }))
        .sort((a, b) => rank[a.kind] - rank[b.kind] || Number(a.id - b.id));
    },

    /** Add a competitor (or, for the audit prefill, an entity found elsewhere). The brand is made with the project. */
    async addCompetitor(
      projectId,
      { name, primaryDomain, source = 'user', status = 'active' },
      { actorUserId } = {},
    ) {
      if (!['active', 'suggested'].includes(status)) throw new DomainError('INVALID_STATUS');
      const clean = String(name ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      if (clean.length < 2 || clean.length > 255) throw new DomainError('INVALID_NAME');
      const domain = primaryDomain ? String(primaryDomain).toLowerCase() : null;
      if (domain && !DOMAIN.test(domain)) throw new DomainError('INVALID_DOMAIN');
      try {
        return await transaction(prisma, async (tx) => {
          await ownProject(tx, projectId);
          const entity = await tx.tracked_entities.create({
            data: {
              org_id: orgId,
              project_id: projectId,
              kind: 'competitor',
              name: clean,
              name_normalized: normalizeEntityName(clean),
              primary_domain: domain,
              source,
              status,
            },
          });
          await appendActivity(tx, {
            actorUserId,
            action: 'entity.added',
            targetType: 'tracked_entity',
            targetId: entity.id,
            summary: `Competitor ${clean} was added`,
          });
          return entity;
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_tracked_entities_name')) throw new DomainError('DUPLICATE');
        throw err;
      }
    },

    /** Rename an entity or change its domain; a brand's name follows the project's own name edit instead. */
    async update(entityId, { name, primaryDomain }, { actorUserId } = {}) {
      return transaction(prisma, async (tx) => {
        const entity = await tx.tracked_entities.findFirst({
          where: { id: entityId, org_id: orgId },
        });
        if (!entity) throw new DomainError('NOT_FOUND');
        const data = {};
        if (name !== undefined) {
          const clean = String(name).trim().replace(/\s+/g, ' ');
          if (clean.length < 2 || clean.length > 255) throw new DomainError('INVALID_NAME');
          data.name = clean;
          data.name_normalized = normalizeEntityName(clean);
        }
        if (primaryDomain !== undefined) {
          const domain = primaryDomain ? String(primaryDomain).toLowerCase() : null;
          if (domain && !DOMAIN.test(domain)) throw new DomainError('INVALID_DOMAIN');
          data.primary_domain = domain;
        }
        try {
          const updated = await tx.tracked_entities.update({
            where: { id: entity.id, org_id: orgId },
            data,
          });
          await appendActivity(tx, {
            actorUserId,
            action: 'entity.updated',
            targetType: 'tracked_entity',
            targetId: entity.id,
            summary: `${entity.kind === 'brand' ? 'The brand' : 'A competitor'} was changed`,
          });
          return updated;
        } catch (err) {
          if (isUniqueViolation(err, 'uq_tracked_entities_name'))
            throw new DomainError('DUPLICATE');
          throw err;
        }
      });
    },

    /** Stop tracking a competitor, or confirm a suggested one. The brand itself can't be switched off. */
    async setStatus(entityId, status, { actorUserId } = {}) {
      if (!['active', 'paused', 'ignored'].includes(status))
        throw new DomainError('INVALID_STATUS');
      return transaction(prisma, async (tx) => {
        const entity = await tx.tracked_entities.findFirst({
          where: { id: entityId, org_id: orgId },
        });
        if (!entity) throw new DomainError('NOT_FOUND');
        if (entity.kind === 'brand') throw new DomainError('BRAND_IS_FIXED');
        // A confirmed discovered brand becomes a competitor: it is tracked from now on.
        const kind =
          entity.kind === 'discovered' && status === 'active' ? 'competitor' : entity.kind;
        const updated = await tx.tracked_entities.update({
          where: { id: entity.id, org_id: orgId },
          data: { status, kind },
        });
        await appendActivity(tx, {
          actorUserId,
          action: 'entity.status_changed',
          targetType: 'tracked_entity',
          targetId: entity.id,
          summary: `A competitor was set to ${status}`,
          metadata: { status },
        });
        return updated;
      });
    },

    /** Add a name, domain or "that's not us" rule the pre-pass uses to find (or rule out) this entity. */
    async addAlias(entityId, { kind, value, source = 'user' }, { actorUserId } = {}) {
      if (!['name', 'domain', 'exclude'].includes(kind)) throw new DomainError('INVALID_KIND');
      const clean = String(value ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      if (clean.length < 2 || clean.length > 255) throw new DomainError('INVALID_NAME');
      const normalized = kind === 'domain' ? clean.toLowerCase() : normalizeEntityName(clean);
      if (!normalized) throw new DomainError('INVALID_NAME');
      try {
        return await transaction(prisma, async (tx) => {
          const entity = await tx.tracked_entities.findFirst({
            where: { id: entityId, org_id: orgId },
          });
          if (!entity) throw new DomainError('NOT_FOUND');
          return tx.entity_aliases.create({
            data: {
              org_id: orgId,
              project_id: entity.project_id,
              entity_id: entity.id,
              kind,
              value: clean,
              value_normalized: normalized,
              source,
              created_by_user_id: actorUserId ?? null,
            },
          });
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_entity_aliases_value')) throw new DomainError('DUPLICATE');
        throw err;
      }
    },

    async removeAlias(aliasId) {
      const result = await prisma.entity_aliases.deleteMany({
        where: { id: aliasId, org_id: orgId },
      });
      if (result.count === 0) throw new DomainError('NOT_FOUND');
    },
  };

  const brandKits = {
    /** The active version of a project's Brand Kit, or null before the first one exists. */
    async current(projectId) {
      const project = await ownProject(prisma, projectId);
      if (project.brand_profile_version == null) return null;
      return versionRow(prisma, projectId, project.brand_profile_version);
    },

    /** One stored version (any age), or null. */
    async get(projectId, version) {
      await ownProject(prisma, projectId);
      return versionRow(prisma, projectId, version);
    },

    /** Every version, newest first, with who saved it and where it came from. The kit itself is included. */
    async history(projectId) {
      await ownProject(prisma, projectId);
      const rows = await prisma.brand_profiles.findMany({
        where: { project_id: projectId, org_id: orgId },
        orderBy: { version: 'desc' },
        include: { users: { select: { name: true, email: true } } },
      });
      return rows.map(({ users: author, ...row }) => ({ ...row, author }));
    },

    /**
     * Save a new version. Versions are never changed: an edit is a new row, and `projects.brand_profile_version`
     * moves to it. `expectedVersion` is the version the editor started from; if someone saved in between, nothing is
     * written (`STALE_VERSION`) so one person's edit can't silently erase another's. The brand's aliases follow the
     * kit (rows the customer added by hand elsewhere are left alone).
     */
    async save(projectId, { kit, source, expectedVersion = null, actorUserId }) {
      if (!['audit', 'extracted', 'edited', 'reanalyzed'].includes(source)) {
        throw new DomainError('INVALID_SOURCE');
      }
      const parsed = parseBrandKit(kit);
      if (!parsed.ok) throw new DomainError('INVALID_KIT', JSON.stringify(parsed.errors));
      return transaction(prisma, async (tx) => {
        // Lock the project row: two saves at once take turns, and the second sees the first one's version.
        const [locked] = await tx.$queryRaw`
          SELECT brand_profile_version AS version FROM projects
          WHERE id = ${projectId} AND org_id = ${orgId} AND deleted_at IS NULL FOR UPDATE`;
        if (!locked) throw new DomainError('NOT_FOUND');
        const latest = locked.version == null ? null : Number(locked.version);
        if (expectedVersion !== latest) throw new DomainError('STALE_VERSION');
        const version = (latest ?? 0) + 1;

        const row = await tx.brand_profiles.create({
          data: {
            org_id: orgId,
            project_id: projectId,
            version,
            schema_version: BRAND_KIT_SCHEMA_VERSION,
            data: parsed.kit,
            source,
            created_by_user_id: actorUserId ?? null,
          },
        });
        await tx.projects.update({
          where: { id: projectId, org_id: orgId },
          data: { brand_profile_version: version },
        });
        await syncBrandNames(tx, projectId, parsed.kit, actorUserId);
        await appendActivity(tx, {
          actorUserId,
          action: 'brand_kit.saved',
          targetType: 'project',
          targetId: projectId,
          summary:
            version === 1 ? 'The Brand Kit was created' : `The Brand Kit was updated (v${version})`,
          metadata: { version, source },
        });
        return row;
      });
    },
  };

  return { projects, projectEngines, entities, brandKits };
}
