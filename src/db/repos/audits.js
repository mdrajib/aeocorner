import { ulid } from '../../lib/ulid.js';
import { DomainError } from '../errors.js';
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

    /** Give up: every attempt failed. A finished audit stays as it is. */
    async fail(auditId) {
      const result = await prisma.audits.updateMany({
        where: { id: auditId, status: { in: ACTIVE } },
        data: { status: 'failed', finished_at: new Date() },
      });
      return result.count === 1;
    },

    /** What the five questions cost so far, from the answers: the audit's own total is written at `finish`. */
    async answers(auditId) {
      return prisma.audit_answers.findMany({
        where: { audit_id: auditId },
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
        where: { audit_id: auditId, org_id: null },
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

  return { ...audits, scans };
}
