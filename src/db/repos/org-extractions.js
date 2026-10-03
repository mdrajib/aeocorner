import { normalizeName } from '../../llm/names.js';
import { urlHash } from '../../llm/prepass.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';

/**
 * One organization's answer extraction (MVP §6.4, DATABASE_SCHEMA §4): the tracked entities the pre-pass and
 * Claude look for, the run's Claude batches, and the rows a reading becomes (`mentions`, `citations`, `claims`,
 * plus `review_items` where the pre-pass and Claude disagree). Merged into `forOrg(orgId)`; no function takes an
 * `org_id` from its arguments.
 *
 * The fact tables have no foreign keys (so they can be partitioned later). Nothing in the database stops a mention
 * from naming another project's entity, so `save` checks every entity ID against the snapshot's project here.
 *
 * `save` replaces a snapshot's rows in one transaction: re-extraction deletes and re-inserts (DATABASE_SCHEMA §4),
 * and a reading that failed writes nothing at all, so the rows are always one whole reading or none.
 */

const clip = (text, max) => (text == null ? null : String(text).slice(0, max));
const tinyint = (n) => (n == null ? null : Math.max(0, Math.min(255, Math.trunc(n))));

export function extractionRepos(prisma, orgId) {
  const findSnapshot = (snapshotId) =>
    prisma.answer_snapshots.findFirst({ where: { id: snapshotId, org_id: orgId } });

  const promptOf = (snapshot) =>
    prisma.prompts.findFirst({
      where: { id: snapshot.prompt_id, org_id: orgId, project_id: snapshot.project_id },
      select: { text: true, search_query: true },
    });

  const findRun = (runId) => prisma.runs.findFirst({ where: { id: runId, org_id: orgId } });

  /** The run row, locked until the transaction ends (its batch list is read, changed and written back). */
  async function lockedRun(tx, runId) {
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId} AND org_id = ${orgId} FOR UPDATE`;
    return tx.runs.findFirst({
      where: { id: runId, org_id: orgId },
      select: { id: true, llm_batch_ids: true },
    });
  }

  /** A discovered brand's entity: found by its normalized name in the project, or created as a suggestion. */
  async function discoveredEntityId(projectId, name, now) {
    const normalized = normalizeName(name);
    if (!normalized) return null;
    const where = { project_id: projectId, org_id: orgId, name_normalized: normalized };
    const existing = await prisma.tracked_entities.findFirst({
      where,
      select: { id: true, kind: true },
    });
    if (existing) {
      if (existing.kind === 'discovered') {
        await prisma.tracked_entities.updateMany({
          where: { id: existing.id, org_id: orgId },
          data: { last_seen_at: now },
        });
      }
      return existing.id;
    }
    try {
      const created = await prisma.tracked_entities.create({
        data: {
          org_id: orgId,
          project_id: projectId,
          kind: 'discovered',
          name: clip(name.trim(), 255),
          name_normalized: normalized,
          status: 'suggested',
          source: 'discovered',
          first_seen_at: now,
          last_seen_at: now,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      // Another answer of the same run created it a moment ago.
      if (!isUniqueViolation(err, 'uq_tracked_entities_name')) throw err;
      return (await prisma.tracked_entities.findFirst({ where, select: { id: true } })).id;
    }
  }

  /**
   * The global URL dictionary (`web_domains`, `web_urls`): not tenant data, shared by every organization so a
   * citation row stays small. Insert-if-missing, then read back the IDs.
   */
  async function dictionaryIds(citation) {
    await prisma.$executeRaw`
      INSERT INTO web_domains (domain) VALUES (${citation.domain})
      ON DUPLICATE KEY UPDATE id = id`;
    const domain = await prisma.web_domains.findUnique({
      where: { domain: citation.domain },
      select: { id: true },
    });
    const hash = urlHash(citation.url);
    await prisma.$executeRaw`
      INSERT INTO web_urls (url_hash, url, domain_id, title)
      VALUES (${hash}, ${citation.url}, ${domain.id}, ${clip(citation.title, 512)})
      ON DUPLICATE KEY UPDATE id = id`;
    const url = await prisma.web_urls.findUnique({
      where: { url_hash: hash },
      select: { id: true },
    });
    return { domainId: domain.id, urlId: url.id };
  }

  const extractions = {
    /**
     * The tracked entities of one of this organization's projects that answers are read for: the brand and its
     * active competitors, each with its names, domains and "That's not us" rules. Empty for a project that isn't
     * this organization's.
     */
    async entitiesFor(projectId) {
      const rows = await prisma.tracked_entities.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          kind: { in: ['brand', 'competitor'] },
          status: 'active',
        },
        select: { id: true, kind: true, name: true, primary_domain: true },
        orderBy: { id: 'asc' },
      });
      if (rows.length === 0) return [];
      const aliases = await prisma.entity_aliases.findMany({
        where: { org_id: orgId, project_id: projectId, entity_id: { in: rows.map((r) => r.id) } },
        select: { entity_id: true, kind: true, value: true },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => {
        const own = aliases.filter((a) => a.entity_id === r.id);
        const of = (kind) => own.filter((a) => a.kind === kind).map((a) => a.value);
        return {
          id: r.id,
          kind: r.kind,
          name: r.name,
          aliases: of('name'),
          domains: [...(r.primary_domain ? [r.primary_domain] : []), ...of('domain')],
          excludes: of('exclude'),
        };
      });
    },

    /** One snapshot with what extraction needs (its question and where its raw answer is), or null. */
    async snapshot(snapshotId) {
      const snapshot = await findSnapshot(snapshotId);
      if (!snapshot) return null;
      return { ...snapshot, prompt: await promptOf(snapshot) };
    },

    /** The run, or null if it isn't this organization's. */
    run: (runId) => findRun(runId),

    /** The answers of a run still waiting to be read: collected (`ok`) and not yet extracted. */
    async pendingForRun(runId) {
      const run = await findRun(runId);
      if (!run) return [];
      const snapshots = await prisma.answer_snapshots.findMany({
        where: {
          run_id: run.id,
          org_id: orgId,
          run_date: run.run_date,
          status: 'ok',
          extraction_status: 'pending',
        },
        orderBy: [{ prompt_id: 'asc' }, { engine_code: 'asc' }, { sample_idx: 'asc' }],
      });
      const prompts = await prisma.prompts.findMany({
        where: {
          org_id: orgId,
          project_id: run.project_id,
          id: { in: [...new Set(snapshots.map((s) => s.prompt_id))] },
        },
        select: { id: true, text: true, search_query: true },
      });
      const byId = new Map(prompts.map((p) => [p.id, p]));
      return snapshots.map((s) => ({ ...s, prompt: byId.get(s.prompt_id) ?? null }));
    },

    /**
     * Note a Claude batch on its run (`runs.llm_batch_ids`), so a poll job can be checked against it and a
     * repeated submit job can see one is already out. `entities` fingerprints the numbered brand list the prompts
     * used. False if the run isn't this organization's.
     */
    async addBatch(runId, { batchId, model, count, submittedAt, entities = null }) {
      return transaction(prisma, async (tx) => {
        const run = await lockedRun(tx, runId);
        if (!run) return false;
        const batches = Array.isArray(run.llm_batch_ids) ? run.llm_batch_ids : [];
        if (batches.some((b) => b.id === batchId)) return true;
        await tx.runs.updateMany({
          where: { id: runId, org_id: orgId },
          data: {
            llm_batch_ids: [
              ...batches,
              {
                id: batchId,
                model,
                count,
                entities,
                submittedAt: submittedAt.toISOString(),
                processedAt: null,
              },
            ],
            status: 'extracting',
          },
        });
        return true;
      });
    },

    /** The run's batches as recorded: `[{ id, model, count, entities, submittedAt, processedAt }]`. */
    async batchesOf(runId) {
      const run = await findRun(runId);
      return Array.isArray(run?.llm_batch_ids) ? run.llm_batch_ids : [];
    },

    /** A batch's results have all been stored. */
    async batchProcessed(runId, batchId, at) {
      return transaction(prisma, async (tx) => {
        const run = await lockedRun(tx, runId);
        if (!run) return false;
        const batches = Array.isArray(run.llm_batch_ids) ? run.llm_batch_ids : [];
        if (!batches.some((b) => b.id === batchId)) return false;
        await tx.runs.updateMany({
          where: { id: runId, org_id: orgId },
          data: {
            llm_batch_ids: batches.map((b) =>
              b.id === batchId && !b.processedAt ? { ...b, processedAt: at.toISOString() } : b,
            ),
          },
        });
        return true;
      });
    },

    /**
     * Store one answer's reading. `plan` is `mergeReading(...)` (src/llm/extraction.js); `prepass` is what the
     * snapshot keeps of the pre-pass (`prepassRecord`). Replaces whatever an earlier extraction of the snapshot
     * stored. Throws DomainError NOT_FOUND (not this organization's), NOT_EXTRACTABLE (no answer to read) or
     * ENTITY_NOT_IN_PROJECT (the plan names an entity of another project).
     */
    async save(snapshotId, { plan, prepass, version, extractedAt = new Date() }) {
      const snapshot = await findSnapshot(snapshotId);
      if (!snapshot) throw new DomainError('NOT_FOUND');
      if (snapshot.status !== 'ok') throw new DomainError('NOT_EXTRACTABLE');
      const projectId = snapshot.project_id;

      // Every tracked entity the plan names must be this project's.
      const named = new Set();
      for (const m of plan.mentions) if (m.entityId != null) named.add(String(m.entityId));
      for (const c of plan.citations) {
        if (c.ownerEntityId != null) named.add(String(c.ownerEntityId));
        for (const id of c.supportsEntityIds) named.add(String(id));
      }
      for (const d of plan.disagreements) named.add(String(d.entityId));
      if (named.size) {
        const own = await prisma.tracked_entities.count({
          where: { org_id: orgId, project_id: projectId, id: { in: [...named].map(BigInt) } },
        });
        if (own !== named.size) throw new DomainError('ENTITY_NOT_IN_PROJECT');
      }

      // Brands Claude found that aren't tracked: find or create their "discovered" entity first (outside the
      // transaction, so a unique-key race is retried on its own).
      const discovered = new Map();
      const wanted = [
        ...plan.mentions.filter((m) => m.entityId == null).map((m) => m.discoveredName),
        ...plan.citations.flatMap((c) => c.supportsDiscovered),
      ];
      for (const name of wanted) {
        const key = normalizeName(name);
        if (key && !discovered.has(key)) {
          discovered.set(key, await discoveredEntityId(projectId, name, extractedAt));
        }
      }
      const idOf = (m) =>
        m.entityId != null ? BigInt(m.entityId) : discovered.get(normalizeName(m.discoveredName));

      const dictionary = [];
      for (const c of plan.citations) dictionary.push(await dictionaryIds(c));

      const where = { org_id: orgId, snapshot_id: snapshot.id, run_date: snapshot.run_date };
      const fact = {
        run_date: snapshot.run_date,
        org_id: orgId,
        project_id: projectId,
        snapshot_id: snapshot.id,
      };

      return transaction(prisma, async (tx) => {
        // One reading at a time per snapshot: a duplicate job waits here, then replaces this one's rows whole.
        await tx.$queryRaw`
          SELECT id FROM answer_snapshots
          WHERE id = ${snapshot.id} AND run_date = ${snapshot.run_date} AND org_id = ${orgId} FOR UPDATE`;

        await tx.claims.deleteMany({ where });
        await tx.mentions.deleteMany({ where });
        await tx.citations.deleteMany({ where });

        const seen = new Set();
        let mentionCount = 0;
        let claimCount = 0;
        for (const m of plan.mentions) {
          const entityId = idOf(m);
          if (entityId == null || seen.has(String(entityId))) continue;
          seen.add(String(entityId));
          const row = await tx.mentions.create({
            data: {
              ...fact,
              run_id: snapshot.run_id,
              prompt_id: snapshot.prompt_id,
              engine_code: snapshot.engine_code,
              entity_id: entityId,
              name_as_written: clip(m.nameAsWritten, 255),
              list_rank: tinyint(m.listRank),
              mention_order: tinyint(m.mentionOrder),
              prominence: m.prominence,
              stance: m.stance,
              sentiment: m.sentiment,
              excerpt: m.entityId != null ? clip(m.excerpt, 300) : null,
              detected_by: m.detectedBy,
              extraction_version: version,
            },
            select: { id: true },
          });
          mentionCount += 1;
          if (m.entityId != null && m.claims.length) {
            await tx.claims.createMany({
              data: m.claims.map((c) => ({
                ...fact,
                mention_id: row.id,
                entity_id: entityId,
                attribute: clip(c.attribute, 64),
                claim_value: clip(c.value, 500),
                polarity: c.polarity,
              })),
            });
            claimCount += m.claims.length;
          }
        }

        if (plan.citations.length) {
          await tx.citations.createMany({
            data: plan.citations.map((c, i) => ({
              ...fact,
              run_id: snapshot.run_id,
              prompt_id: snapshot.prompt_id,
              engine_code: snapshot.engine_code,
              position: c.position,
              url_id: dictionary[i].urlId,
              domain_id: dictionary[i].domainId,
              owner_entity_id: c.ownerEntityId != null ? BigInt(c.ownerEntityId) : null,
              is_own: Boolean(c.isOwn),
              supports_entity_ids: [
                ...new Set([
                  ...c.supportsEntityIds.map(String),
                  ...c.supportsDiscovered
                    .map((n) => discovered.get(normalizeName(n)))
                    .filter((id) => id != null)
                    .map(String),
                ]),
              ],
              extraction_version: version,
            })),
          });
        }

        // The review queue: this snapshot's open disagreements are replaced by the new reading's.
        await tx.review_items.deleteMany({
          where: {
            org_id: orgId,
            snapshot_id: snapshot.id,
            source: 'disagreement',
            status: 'open',
          },
        });
        for (const d of plan.disagreements) {
          await tx.review_items.create({
            data: {
              org_id: orgId,
              project_id: projectId,
              source: 'disagreement',
              snapshot_id: snapshot.id,
              run_date: snapshot.run_date,
              entity_id: BigInt(d.entityId),
              details: {
                prepass: d.prepass,
                llm: d.llm,
                nameAsWritten: clip(d.nameAsWritten, 255),
                excerpt: clip(d.excerpt, 300),
                extractionVersion: version,
              },
            },
          });
        }

        await tx.answer_snapshots.updateMany({
          where: { id: snapshot.id, run_date: snapshot.run_date, org_id: orgId },
          data: {
            answer_type: plan.answerType,
            prepass,
            extraction_status: 'done',
            extraction_version: version,
            extracted_at: extractedAt,
          },
        });
        return {
          mentions: mentionCount,
          citations: plan.citations.length,
          claims: claimCount,
          disagreements: plan.disagreements.length,
        };
      });
    },

    /**
     * The answer couldn't be read (Claude refused, the reply was cut off or malformed). Its earlier rows, if any,
     * stay as they were. False if it isn't this organization's or has already been read.
     */
    async fail(snapshotId, reason, { prepass } = {}) {
      const snapshot = await findSnapshot(snapshotId);
      if (!snapshot) return false;
      const { count } = await prisma.answer_snapshots.updateMany({
        where: {
          id: snapshot.id,
          run_date: snapshot.run_date,
          org_id: orgId,
          extraction_status: 'pending',
        },
        data: {
          extraction_status: 'failed',
          failure_reason: clip(`extraction: ${reason}`, 255),
          ...(prepass ? { prepass } : {}),
        },
      });
      return count === 1;
    },

    /** Put a read (or failed) snapshot back in the queue, for re-extraction. */
    async requeue(snapshotId) {
      const snapshot = await findSnapshot(snapshotId);
      if (!snapshot || snapshot.status !== 'ok') return false;
      const { count } = await prisma.answer_snapshots.updateMany({
        where: { id: snapshot.id, run_date: snapshot.run_date, org_id: orgId },
        data: { extraction_status: 'pending' },
      });
      return count === 1;
    },

    /** A snapshot's stored reading, for checks and the review queue. */
    async readingOf(snapshotId) {
      const snapshot = await findSnapshot(snapshotId);
      if (!snapshot) return null;
      const where = { org_id: orgId, snapshot_id: snapshot.id, run_date: snapshot.run_date };
      const [mentions, citations, claims, reviews] = await Promise.all([
        prisma.mentions.findMany({ where, orderBy: { mention_order: 'asc' } }),
        prisma.citations.findMany({ where, orderBy: { position: 'asc' } }),
        prisma.claims.findMany({ where, orderBy: { id: 'asc' } }),
        prisma.review_items.findMany({
          where: { org_id: orgId, snapshot_id: snapshot.id },
          orderBy: { id: 'asc' },
        }),
      ]);
      return { snapshot, mentions, citations, claims, reviews };
    },
  };

  return { extractions };
}
