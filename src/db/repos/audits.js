import { ulid } from '../../lib/ulid.js';
import { toMicros } from '../../core/spend.js';
import { DomainError, isUniqueViolation } from '../errors.js';
import { transaction } from '../transaction.js';
import { clip, toDate, writeScanResult } from './scan-results.js';

/**
 * Free audits (DATABASE_SCHEMA §2.8): a stranger's one-off report on a domain, made before any organization exists.
 * That is why this repository is global rather than part of `forOrg()`: an audit's owner is a lead (an email
 * address), not a tenant. Every function takes the audit by its ID and the callers (the web route and the
 * `audit.run` job) are the only code that knows which audit a visitor may see (by `public_id` plus a claim token).
 * It returns audit data only, never another visitor's.
 *
 * An audit's life: `create` (awaiting_verification) -> `verify` (queued) -> `start` (running) -> `finish`
 * (complete or partial) or `fail`. Its readiness scan is `audit_scans.start` + `audit_scans.finish`: the same
 * writer a project's scan uses (scan-results.js), with no organization on the rows.
 * Every write that a retried job may repeat replaces rather than adds.
 */

const ACTIVE = ['queued', 'running'];

export function auditsRepo(prisma) {
  /** The audit whose answers and scan this audit shows: itself, or the one it was served from. */
  async function sourceOf(auditId) {
    const row = await prisma.audits.findUnique({
      where: { id: auditId },
      select: { cached_from_audit_id: true },
    });
    return row?.cached_from_audit_id ?? auditId;
  }

  const audits = {
    /** A new audit, waiting for the visitor to prove they own the email address. */
    async create({ inputUrl, domain, competitorDomain = null, leadId = null, ipHash = null }) {
      return prisma.audits.create({
        data: {
          public_id: ulid(),
          input_url: clip(inputUrl, 2048),
          domain,
          competitor_domain: competitorDomain,
          lead_id: leadId,
          ip_hash: ipHash,
        },
      });
    },

    async get(auditId) {
      return prisma.audits.findUnique({ where: { id: auditId } });
    },

    /** The audit a report URL names, or null. */
    async getByPublicId(publicId) {
      return prisma.audits.findUnique({ where: { public_id: String(publicId) } });
    },

    /** The code was right: queue the audit. A repeat (a double click) changes nothing and says so. */
    async verify(auditId, { leadId } = {}) {
      const result = await prisma.audits.updateMany({
        where: { id: auditId, status: 'awaiting_verification' },
        data: { status: 'queued', verified_at: new Date(), ...(leadId ? { lead_id: leadId } : {}) },
      });
      return result.count === 1;
    },

    /** Mark a queued audit as running. A finished audit is left alone (a duplicate job). */
    async start(auditId) {
      const result = await prisma.audits.updateMany({
        where: { id: auditId, status: { in: ACTIVE } },
        data: { status: 'running', started_at: new Date() },
      });
      return result.count === 1;
    },

    /**
     * A finished audit of the same domain (and the same competitor, if one was named) from the last `maxAgeHours`
     * that a new request can be served from (MVP F1: "the same domain within 24 h is served from cache"). Only a
     * `complete` audit counts: a partial one is missing answers and the visitor deserves a fresh try. An audit that
     * was itself served from another is never the source, so a cache never ages by being copied.
     */
    async findReusable({
      domain,
      competitorDomain = null,
      excludeAuditId,
      now = new Date(),
      maxAgeHours = 24,
    }) {
      return prisma.audits.findFirst({
        where: {
          domain,
          competitor_domain: competitorDomain,
          status: 'complete',
          cached_from_audit_id: null,
          finished_at: { gte: new Date(now.getTime() - maxAgeHours * 3_600_000) },
          ...(excludeAuditId ? { id: { not: excludeAuditId } } : {}),
        },
        orderBy: { finished_at: 'desc' },
      });
    },

    /**
     * Finish a queued or running audit from an earlier one: the same scores, fixes, questions and Brand Kit, with
     * `cached_from_audit_id` saying where they came from and no cost of its own. Returns false if the audit had
     * already finished.
     */
    async completeFromCache(auditId, source) {
      const now = new Date();
      const done = await prisma.audits.updateMany({
        where: { id: auditId, status: { in: ACTIVE } },
        data: {
          status: 'complete',
          cached_from_audit_id: source.id,
          brand_kit_lite: source.brand_kit_lite ?? undefined,
          prompts: source.prompts ?? undefined,
          suggested_competitors: source.suggested_competitors ?? undefined,
          readiness_score: source.readiness_score,
          visibility_score: source.visibility_score,
          aeo_score: source.aeo_score,
          sub_scores: source.sub_scores ?? undefined,
          top_fixes: source.top_fixes ?? [],
          rubric_version: source.rubric_version,
          extraction_version: source.extraction_version,
          cost_usd: 0,
          started_at: now,
          finished_at: now,
        },
      });
      return done.count === 1;
    },

    /** The Brand Kit (lite), the five questions and the competitors we suggest. Replaces an earlier attempt's. */
    async saveSetup(auditId, { brandKitLite, prompts, suggestedCompetitors }) {
      await prisma.audits.update({
        where: { id: auditId },
        data: {
          brand_kit_lite: brandKitLite,
          prompts,
          suggested_competitors: suggestedCompetitors ?? [],
        },
      });
    },

    /**
     * The audit's result. `status` is complete, or partial when an engine could not answer. Scores that could not
     * be worked out are null, never 0. A finished audit is not rewritten (a duplicate job).
     */
    async finish(auditId, result) {
      const done = await prisma.audits.updateMany({
        where: { id: auditId, status: { in: ACTIVE } },
        data: {
          status: result.status,
          readiness_score: result.readinessScore ?? null,
          visibility_score: result.visibilityScore ?? null,
          aeo_score: result.aeoScore ?? null,
          sub_scores: result.subScores ?? null,
          top_fixes: result.topFixes ?? [],
          rubric_version: result.rubricVersion ?? null,
          extraction_version: result.extractionVersion ?? null,
          cost_usd: result.costUsd ?? 0,
          finished_at: new Date(),
        },
      });
      return done.count === 1;
    },

    /** The report email went out. The first time stays; false means it had already been recorded. */
    async markReportEmailed(auditId, at = new Date()) {
      const result = await prisma.audits.updateMany({
        where: { id: auditId, report_emailed_at: null },
        data: { report_emailed_at: at },
      });
      return result.count === 1;
    },

    /**
     * Give up: every attempt failed. A finished audit stays as it is. `reason` is a short code for the team and
     * the report page ("site_unreadable"), kept with the sub-scores since a failed audit has none.
     */
    async fail(auditId, reason = null) {
      const result = await prisma.audits.updateMany({
        where: { id: auditId, status: { in: ACTIVE } },
        data: {
          status: 'failed',
          finished_at: new Date(),
          ...(reason ? { sub_scores: { failure: String(reason).slice(0, 100) } } : {}),
        },
      });
      return result.count === 1;
    },

    /**
     * The answers an audit shows. An audit served from an earlier one (`completeFromCache`) shows that audit's: it
     * asked nothing itself.
     */
    async answers(auditId) {
      return prisma.audit_answers.findMany({
        where: { audit_id: await sourceOf(auditId) },
        orderBy: [{ prompt_idx: 'asc' }, { engine_code: 'asc' }],
      });
    },

    /**
     * Save one engine's answer to one question. The cell (audit, question, engine) is unique, so a retried job
     * replaces its earlier row instead of adding a second.
     */
    async saveAnswer(auditId, a) {
      const data = {
        provider_code: a.providerCode,
        method: a.method,
        status: a.status,
        model_version: clip(a.modelVersion, 64),
        raw_uri: clip(a.rawUri, 512),
        text_excerpt: clip(a.textExcerpt, 1000),
        brand_present: a.brandPresent ?? null,
        brand_rank: a.brandRank ?? null,
        brand_stance: a.brandStance ?? null,
        entities: a.entities ?? null,
        citations: a.citations ?? null,
        cost_usd: a.costUsd ?? 0,
        collected_at: toDate(a.collectedAt) ?? (a.status === 'pending' ? null : new Date()),
      };
      const existing = await prisma.audit_answers.findFirst({
        where: { audit_id: auditId, prompt_idx: a.promptIdx, engine_code: a.engineCode },
        select: { id: true },
      });
      if (existing) {
        await prisma.audit_answers.update({ where: { id: existing.id }, data });
        return existing.id;
      }
      const row = await prisma.audit_answers.create({
        data: { audit_id: auditId, prompt_idx: a.promptIdx, engine_code: a.engineCode, ...data },
      });
      return row.id;
    },
  };

  const scans = {
    /** Queue the readiness scan of an audit's domain. A retried job gets the scan it already made. */
    async start({ auditId, rubricVersion }) {
      const audit = await prisma.audits.findUnique({
        where: { id: auditId },
        select: { id: true },
      });
      if (!audit) throw new DomainError('NOT_FOUND');
      const earlier = await prisma.site_scans.findFirst({
        where: { audit_id: auditId, org_id: null },
        orderBy: { id: 'desc' },
      });
      if (earlier && earlier.status !== 'failed') return earlier;
      return prisma.site_scans.create({
        data: {
          audit_id: auditId,
          trigger_type: 'audit',
          rubric_version: rubricVersion,
          status: 'running',
          started_at: new Date(),
        },
      });
    },

    /** Save a scan's outcome: the scan row, its pages and every check. All or nothing; safe to repeat. */
    async finish(scanId, result) {
      const scan = await prisma.site_scans.findFirst({
        where: { id: scanId, org_id: null, audit_id: { not: null } },
        select: { id: true },
      });
      if (!scan) throw new DomainError('NOT_FOUND');
      const finishedAt = toDate(result.finishedAt) ?? new Date();
      return transaction(prisma, (tx) =>
        writeScanResult(tx, { scan, orgId: null, result, finishedAt }),
      );
    },

    async forAudit(auditId) {
      return prisma.site_scans.findFirst({
        where: { audit_id: await sourceOf(auditId), org_id: null },
        orderBy: { id: 'desc' },
      });
    },

    async checks(scanId) {
      return prisma.scan_checks.findMany({
        where: { scan_id: scanId, org_id: null },
        orderBy: { check_code: 'asc' },
      });
    },
  };

  /**
   * What an audit costs, in the same ledger as everything else but with no organization on the row (the schema
   * allows `org_id` NULL for exactly this). A retried job writes the same key and nothing is counted twice.
   */
  const ledger = {
    async record(auditId, entry) {
      const costMicros = toMicros(entry.costUsd);
      if (costMicros < 0) throw new DomainError('INVALID', 'A cost cannot be negative.');
      const audit = await prisma.audits.findUnique({
        where: { id: auditId },
        select: { id: true },
      });
      if (!audit) throw new DomainError('NOT_FOUND');
      const data = {
        org_id: null,
        audit_id: auditId,
        meter: entry.meter,
        provider_code: entry.providerCode,
        model: entry.model ?? null,
        quantity: entry.quantity ?? 1,
        unit: entry.unit,
        tokens_in: entry.tokensIn ?? null,
        tokens_out: entry.tokensOut ?? null,
        tokens_cached: entry.tokensCached ?? null,
        cost_usd: String(entry.costUsd),
        ref_type: 'audit',
        ref_id: auditId,
        idempotency_key: entry.idempotencyKey,
        ...(entry.occurredAt ? { occurred_at: entry.occurredAt } : {}),
      };
      try {
        return { recorded: true, entry: await prisma.usage_ledger.create({ data }) };
      } catch (err) {
        if (!isUniqueViolation(err, 'uq_usage_ledger_idem')) throw err;
        const existing = await prisma.usage_ledger.findFirst({
          where: { idempotency_key: entry.idempotencyKey, audit_id: auditId, org_id: null },
        });
        if (!existing) throw new DomainError('KEY_IN_USE');
        return { recorded: false, entry: existing };
      }
    },

    /** All free audits' spend since `since`, in micro-dollars: what the daily audit budget is measured against. */
    async spentSinceMicros(since) {
      const { _sum } = await prisma.usage_ledger.aggregate({
        where: { org_id: null, audit_id: { not: null }, occurred_at: { gte: since } },
        _sum: { cost_usd: true },
      });
      return toMicros(_sum.cost_usd?.toString() ?? '0');
    },

    /** One audit's cost so far, in micro-dollars (written to `audits.cost_usd` when it finishes). */
    async costMicros(auditId) {
      const { _sum } = await prisma.usage_ledger.aggregate({
        where: { org_id: null, audit_id: auditId },
        _sum: { cost_usd: true },
      });
      return toMicros(_sum.cost_usd?.toString() ?? '0');
    },
  };

  return { ...audits, scans, ledger };
}
