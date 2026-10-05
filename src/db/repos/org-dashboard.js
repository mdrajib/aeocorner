import { DomainError } from '../errors.js';
import { Prisma } from '../generated/client/client.ts';

/**
 * What the dashboard screens read (Milestone 5, MVP F5): the question matrix, one question's history and answers, who
 * is named for each question, the sources cited, and the customer's "that's not us" / "misread" feedback. Merged into
 * `forOrg(orgId)`; the organization is bound once and no function takes an `org_id` from its arguments.
 *
 * The daily figures themselves come from `metrics.range` (org-tracking.js); this file reads the finer grain under them.
 * Every query names the organization and the project, and the fact tables (no foreign keys) are also read by date, so
 * the date in their keys keeps the index in use. A project that is not this organization's is "not found", never an
 * empty answer: a leak test calls each function as another organization.
 *
 * Nothing here turns a missing answer into a number. A cell or an answer that could not be read keeps its status so
 * the screen can say "Couldn’t check"; the pure rules for that are in `src/core/dashboard.js`.
 */

export const REPORT_KINDS = ['not_us', 'misread', 'missed', 'other'];

const dayStart = (value) => new Date(`${new Date(value).toISOString().slice(0, 10)}T00:00:00Z`);
const toNumber = (value) => (value == null ? 0 : Number(value));

export function dashboardRepos(prisma, orgId) {
  async function ownProject(projectId) {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, org_id: orgId, deleted_at: null },
      select: { id: true },
    });
    if (!project) throw new DomainError('PROJECT_NOT_IN_ORG');
    return project;
  }

  async function brandOf(projectId) {
    const brand = await prisma.tracked_entities.findFirst({
      where: { project_id: projectId, org_id: orgId, kind: 'brand' },
      select: { id: true },
    });
    return brand?.id ?? null;
  }

  const range = ({ from, to }) => ({ gte: dayStart(from), lte: dayStart(to) });

  const dashboard = {
    /**
     * The question matrix: every active question, and for each engine its most recent cell in the period.
     *
     * @returns `{ prompts: [{ id, text, intent, priority }], cells: [{ promptId, engineCode, runId, runDate, status,
     *   nPlanned, nOk, nNoAnswer, nFailed, cellScore, kMentioned, kRecommended }] }`. A question or engine with no
     *   cell yet has no entry: the screen shows "not checked yet", never an empty or zero cell.
     */
    async matrix(projectId, { from, to }) {
      await ownProject(projectId);
      const brandId = await brandOf(projectId);
      const [prompts, cellRows] = await Promise.all([
        prisma.prompts.findMany({
          where: { project_id: projectId, org_id: orgId, status: 'active' },
          select: { id: true, text: true, intent: true, priority: true },
          orderBy: { id: 'asc' },
        }),
        prisma.cell_results.findMany({
          where: { project_id: projectId, org_id: orgId, run_date: range({ from, to }) },
          orderBy: [{ run_date: 'desc' }, { id: 'desc' }],
        }),
      ]);
      const latest = new Map();
      for (const c of cellRows) {
        const key = `${c.prompt_id}|${c.engine_code}`;
        if (!latest.has(key)) latest.set(key, c);
      }
      const chosen = [...latest.values()];
      const brandRows =
        brandId && chosen.length
          ? await prisma.cell_entity_results.findMany({
              where: {
                project_id: projectId,
                org_id: orgId,
                entity_id: brandId,
                run_date: range({ from, to }),
                run_id: { in: [...new Set(chosen.map((c) => c.run_id))] },
              },
              select: {
                run_id: true,
                prompt_id: true,
                engine_code: true,
                k_mentioned: true,
                k_recommended: true,
              },
            })
          : [];
      const brandBy = new Map(
        brandRows.map((r) => [`${r.run_id}|${r.prompt_id}|${r.engine_code}`, r]),
      );
      return {
        prompts: prompts.map((p) => ({
          id: p.id,
          text: p.text,
          intent: p.intent,
          priority: p.priority,
        })),
        cells: chosen.map((c) => {
          const brand = brandBy.get(`${c.run_id}|${c.prompt_id}|${c.engine_code}`);
          return {
            promptId: c.prompt_id,
            engineCode: c.engine_code,
            runId: c.run_id,
            runDate: c.run_date.toISOString().slice(0, 10),
            status: c.status,
            nPlanned: c.n_planned,
            nOk: c.n_ok,
            nNoAnswer: c.n_no_answer,
            nFailed: c.n_failed,
            cellScore: c.cell_score == null ? null : Number(c.cell_score),
            kMentioned: brand?.k_mentioned ?? 0,
            kRecommended: brand?.k_recommended ?? 0,
          };
        }),
      };
    },

    /**
     * One question across the period: its cells run by run, and how often each tracked brand was named for it.
     * Returns null when the question is not this project's.
     *
     * @returns `{ prompt, history: [{ runId, runDate, engineCode, status, nPlanned, nOk, nNoAnswer, nFailed,
     *   cellScore, kMentioned, kRecommended }], readable, named: [{ entityId, name, kind, k }] }`; `readable` is the
     *   answers that could be read, the denominator of every `k`.
     */
    async question(projectId, promptId, { from, to }) {
      await ownProject(projectId);
      const prompt = await prisma.prompts.findFirst({
        where: { id: promptId, project_id: projectId, org_id: orgId },
        select: { id: true, text: true, intent: true, priority: true, status: true },
      });
      if (!prompt) return null;
      const brandId = await brandOf(projectId);
      const where = {
        project_id: projectId,
        org_id: orgId,
        prompt_id: prompt.id,
        run_date: range({ from, to }),
      };
      const [cells, entityRows, entities] = await Promise.all([
        prisma.cell_results.findMany({ where, orderBy: [{ run_date: 'desc' }, { id: 'desc' }] }),
        prisma.cell_entity_results.findMany({ where }),
        prisma.tracked_entities.findMany({
          where: { project_id: projectId, org_id: orgId },
          select: { id: true, name: true, kind: true },
        }),
      ]);
      const brandBy = new Map(
        entityRows
          .filter((r) => brandId && r.entity_id === brandId)
          .map((r) => [`${r.run_id}|${r.engine_code}`, r]),
      );
      const totals = new Map();
      for (const r of entityRows)
        totals.set(r.entity_id, (totals.get(r.entity_id) ?? 0) + r.k_mentioned);
      const names = new Map(entities.map((e) => [e.id, e]));
      return {
        prompt,
        history: cells.map((c) => {
          const brand = brandBy.get(`${c.run_id}|${c.engine_code}`);
          return {
            runId: c.run_id,
            runDate: c.run_date.toISOString().slice(0, 10),
            engineCode: c.engine_code,
            status: c.status,
            nPlanned: c.n_planned,
            nOk: c.n_ok,
            nNoAnswer: c.n_no_answer,
            nFailed: c.n_failed,
            cellScore: c.cell_score == null ? null : Number(c.cell_score),
            kMentioned: brand?.k_mentioned ?? 0,
            kRecommended: brand?.k_recommended ?? 0,
          };
        }),
        readable: cells.reduce((n, c) => n + c.n_ok, 0),
        named: [...totals.entries()]
          .filter(([id]) => names.has(id))
          .map(([id, k]) => ({
            entityId: id,
            name: names.get(id).name,
            kind: names.get(id).kind,
            k,
          }))
          .sort((a, b) => b.k - a.k || a.name.localeCompare(b.name)),
      };
    },

    /**
     * The answers of the most recent check of one question: each sample with its excerpt, who it named and what it
     * cited. Null when the question has no answers yet. `textExcerpt` is the stored start of the answer; the full text
     * stays in storage.
     */
    async answers(projectId, promptId) {
      await ownProject(projectId);
      const newest = await prisma.answer_snapshots.findFirst({
        where: { project_id: projectId, org_id: orgId, prompt_id: promptId },
        orderBy: [{ run_date: 'desc' }, { id: 'desc' }],
        select: { run_id: true, run_date: true },
      });
      if (!newest) return null;
      const snapshots = await prisma.answer_snapshots.findMany({
        where: {
          project_id: projectId,
          org_id: orgId,
          prompt_id: promptId,
          run_id: newest.run_id,
          run_date: newest.run_date,
        },
        orderBy: [{ engine_code: 'asc' }, { sample_idx: 'asc' }],
      });
      const ids = snapshots.map((s) => s.id);
      const scope = {
        project_id: projectId,
        org_id: orgId,
        run_date: newest.run_date,
        snapshot_id: { in: ids },
      };
      const [mentions, citations, entities] = await Promise.all([
        prisma.mentions.findMany({
          where: { ...scope, is_excluded: false },
          orderBy: [{ mention_order: 'asc' }, { id: 'asc' }],
        }),
        prisma.citations.findMany({ where: scope, orderBy: { position: 'asc' } }),
        prisma.tracked_entities.findMany({
          where: { project_id: projectId, org_id: orgId },
          select: { id: true, name: true, kind: true },
        }),
      ]);
      const urlRows = citations.length
        ? await prisma.web_urls.findMany({
            where: { id: { in: [...new Set(citations.map((c) => c.url_id))] } },
            select: { id: true, url: true, title: true, page_format: true, citable_signals: true },
          })
        : [];
      const domainRows = citations.length
        ? await prisma.web_domains.findMany({
            where: { id: { in: [...new Set(citations.map((c) => c.domain_id))] } },
            select: { id: true, domain: true },
          })
        : [];
      const names = new Map(entities.map((e) => [e.id, e]));
      const urls = new Map(urlRows.map((u) => [u.id, u]));
      const domains = new Map(domainRows.map((d) => [d.id, d.domain]));
      return {
        runId: newest.run_id,
        runDate: newest.run_date.toISOString().slice(0, 10),
        snapshots: snapshots.map((s) => ({
          id: s.id,
          engineCode: s.engine_code,
          sampleIdx: s.sample_idx,
          status: s.status,
          // Read only if collected AND read: a collected but unread answer says nothing about the brand.
          read: s.status === 'ok' && s.extraction_status === 'done',
          method: s.method,
          collectedAt: s.collected_at,
          textExcerpt: s.text_excerpt,
          answerType: s.answer_type,
          failureReason: s.status === 'failed' ? s.failure_reason : null,
          mentions: mentions
            .filter((m) => m.snapshot_id === s.id)
            .map((m) => ({
              id: m.id,
              entityId: m.entity_id,
              name: names.get(m.entity_id)?.name ?? m.name_as_written,
              kind: names.get(m.entity_id)?.kind ?? 'discovered',
              nameAsWritten: m.name_as_written,
              listRank: m.list_rank,
              stance: m.stance,
              sentiment: m.sentiment,
              excerpt: m.excerpt,
            })),
          citations: citations
            .filter((c) => c.snapshot_id === s.id)
            .map((c) => ({
              position: c.position,
              url: urls.get(c.url_id)?.url ?? null,
              title: urls.get(c.url_id)?.title ?? null,
              // What reading the page showed (Milestone 13); null when it has not been read or could not be.
              readFormat: urls.get(c.url_id)?.page_format ?? null,
              signals: urls.get(c.url_id)?.citable_signals ?? null,
              domain: domains.get(c.domain_id) ?? null,
              isOwn: c.is_own,
              ownerEntityId: c.owner_entity_id,
            })),
        })),
      };
    },

    /**
     * Per question and tracked entity over the period, pooled across engines and runs: `{ promptId, entityId, k,
     * rankSum, rankN }`. The input of the win rate (core/dashboard.js `winRate`).
     */
    async competitorCells(projectId, { from, to }) {
      await ownProject(projectId);
      const grouped = await prisma.cell_entity_results.groupBy({
        by: ['prompt_id', 'entity_id'],
        where: { project_id: projectId, org_id: orgId, run_date: range({ from, to }) },
        _sum: { k_mentioned: true, rank_sum: true, rank_n: true },
      });
      return grouped.map((g) => ({
        promptId: String(g.prompt_id),
        entityId: String(g.entity_id),
        k: toNumber(g._sum.k_mentioned),
        rankSum: toNumber(g._sum.rank_sum),
        rankN: toNumber(g._sum.rank_n),
      }));
    },

    /**
     * The sources cited in the period.
     *
     * @returns `{ total, domains, urls }`. `total` is every citation; each domain has `{ domain, class, timesCited,
     *   answersCiting, answersWithBrand, own, ownerEntityIds }` and each URL `{ url, title, domain, timesCited,
     *   answersCiting, own }`, most cited first. `answersWithBrand` is how many of the answers citing the site also
     *   named the brand: the "gap" is the rest.
     */
    async citations(projectId, { from, to, limit = 25 }) {
      await ownProject(projectId);
      const brandId = await brandOf(projectId);
      const start = dayStart(from);
      const end = dayStart(to);
      const cap = Math.min(Math.max(1, Math.floor(limit)), 100);
      const brand = brandId ?? 0n;
      const [totalRows, domainRows, urlRows] = await Promise.all([
        prisma.$queryRaw`
          SELECT COUNT(*) AS n FROM citations
          WHERE org_id = ${orgId} AND project_id = ${projectId} AND run_date BETWEEN ${start} AND ${end}`,
        prisma.$queryRaw`
          SELECT d.domain AS domain, d.class AS class, COUNT(*) AS times_cited,
                 COUNT(DISTINCT c.snapshot_id) AS answers_citing,
                 COUNT(DISTINCT CASE WHEN m.id IS NOT NULL THEN c.snapshot_id END) AS answers_with_brand,
                 MAX(c.is_own) AS own,
                 GROUP_CONCAT(DISTINCT c.owner_entity_id) AS owners
          FROM citations c
          JOIN web_domains d ON d.id = c.domain_id
          LEFT JOIN mentions m ON m.snapshot_id = c.snapshot_id AND m.run_date = c.run_date
                              AND m.entity_id = ${brand} AND m.org_id = c.org_id AND m.is_excluded = 0
          WHERE c.org_id = ${orgId} AND c.project_id = ${projectId} AND c.run_date BETWEEN ${start} AND ${end}
          GROUP BY d.id, d.domain, d.class
          ORDER BY times_cited DESC, d.domain ASC
          LIMIT ${cap}`,
        prisma.$queryRaw`
          SELECT u.url AS url, u.title AS title, d.domain AS domain, COUNT(*) AS times_cited,
                 COUNT(DISTINCT c.snapshot_id) AS answers_citing, MAX(c.is_own) AS own
          FROM citations c
          JOIN web_urls u ON u.id = c.url_id
          JOIN web_domains d ON d.id = c.domain_id
          WHERE c.org_id = ${orgId} AND c.project_id = ${projectId} AND c.run_date BETWEEN ${start} AND ${end}
          GROUP BY u.id, u.url, u.title, d.domain
          ORDER BY times_cited DESC, u.url ASC
          LIMIT ${cap}`,
      ]);
      return {
        total: toNumber(totalRows[0]?.n),
        domains: domainRows.map((r) => ({
          domain: r.domain,
          class: r.class,
          timesCited: toNumber(r.times_cited),
          answersCiting: toNumber(r.answers_citing),
          answersWithBrand: toNumber(r.answers_with_brand),
          own: toNumber(r.own) === 1,
          ownerEntityIds: r.owners ? String(r.owners).split(',') : [],
        })),
        urls: urlRows.map((r) => ({
          url: r.url,
          title: r.title,
          domain: r.domain,
          timesCited: toNumber(r.times_cited),
          answersCiting: toNumber(r.answers_citing),
          own: toNumber(r.own) === 1,
        })),
      };
    },

    /**
     * What the citation screens need to know about who is who (Milestone 13): the brand's name and domains, and the
     * tracked competitors' domains, so a cited site can be told apart as "yours" or "a competitor's".
     *
     * @returns `{ brandName, ownDomains, rivalDomains, homeUrl }`
     */
    async citationContext(projectId) {
      await ownProject(projectId);
      const [project, brand, rivals] = await Promise.all([
        prisma.projects.findFirst({
          where: { id: projectId, org_id: orgId },
          select: { domain: true },
        }),
        prisma.tracked_entities.findFirst({
          where: { project_id: projectId, org_id: orgId, kind: 'brand' },
          select: { name: true, primary_domain: true },
        }),
        prisma.tracked_entities.findMany({
          where: {
            project_id: projectId,
            org_id: orgId,
            kind: 'competitor',
            status: 'active',
            primary_domain: { not: null },
          },
          select: { primary_domain: true },
          orderBy: { id: 'asc' },
        }),
      ]);
      const own = [...new Set([project?.domain, brand?.primary_domain].filter(Boolean))];
      return {
        brandName: brand?.name ?? project?.domain ?? '',
        ownDomains: own,
        rivalDomains: [...new Set(rivals.map((r) => r.primary_domain))],
        homeUrl: project?.domain ? `https://${project.domain}/` : null,
      };
    },

    /**
     * Per question and cited site over the period, for the opportunities table: how often the site was cited, in how many
     * answers, and in how many of those the brand was also named; the readable answers to the question; and the site's
     * most cited pages with the format we read for each (null = not read or could not look).
     *
     * @returns `[{ promptId, text, domain, timesCited, answersCiting, answersWithBrand, answersInQuestion,
     *   pages: [{ url, title, timesCited, format }] }]`, most cited first
     */
    async citationOpportunityRows(projectId, { from, to, limit = 300 }) {
      await ownProject(projectId);
      const brand = (await brandOf(projectId)) ?? 0n;
      const start = dayStart(from);
      const end = dayStart(to);
      const cap = Math.min(Math.max(1, Math.floor(limit)), 500);
      const [siteRows, pageRows, answerRows] = await Promise.all([
        prisma.$queryRaw`
          SELECT c.prompt_id AS prompt_id, p.text AS text, d.domain AS domain, COUNT(*) AS times_cited,
                 COUNT(DISTINCT c.snapshot_id) AS answers_citing,
                 COUNT(DISTINCT CASE WHEN m.id IS NOT NULL THEN c.snapshot_id END) AS answers_with_brand
          FROM citations c
          JOIN web_domains d ON d.id = c.domain_id
          JOIN prompts p ON p.id = c.prompt_id AND p.org_id = c.org_id
          LEFT JOIN mentions m ON m.snapshot_id = c.snapshot_id AND m.run_date = c.run_date
                              AND m.entity_id = ${brand} AND m.org_id = c.org_id AND m.is_excluded = 0
          WHERE c.org_id = ${orgId} AND c.project_id = ${projectId} AND c.run_date BETWEEN ${start} AND ${end}
          GROUP BY c.prompt_id, p.text, d.id, d.domain
          ORDER BY times_cited DESC, c.prompt_id ASC, d.domain ASC
          LIMIT ${cap}`,
        prisma.$queryRaw`
          SELECT c.prompt_id AS prompt_id, d.domain AS domain, u.url AS url, u.title AS title,
                 u.page_format AS page_format, COUNT(*) AS times_cited
          FROM citations c
          JOIN web_urls u ON u.id = c.url_id
          JOIN web_domains d ON d.id = c.domain_id
          WHERE c.org_id = ${orgId} AND c.project_id = ${projectId} AND c.run_date BETWEEN ${start} AND ${end}
          GROUP BY c.prompt_id, d.domain, u.id, u.url, u.title, u.page_format
          ORDER BY times_cited DESC, u.url ASC
          LIMIT ${cap * 4}`,
        prisma.$queryRaw`
          SELECT prompt_id, COUNT(*) AS n FROM answer_snapshots
          WHERE org_id = ${orgId} AND project_id = ${projectId} AND run_date BETWEEN ${start} AND ${end}
            AND status = 'ok' AND extraction_status = 'done'
          GROUP BY prompt_id`,
      ]);
      const answers = new Map(answerRows.map((r) => [String(r.prompt_id), toNumber(r.n)]));
      const pages = new Map();
      for (const r of pageRows) {
        const key = `${r.prompt_id}|${r.domain}`;
        const list = pages.get(key) ?? [];
        list.push({
          url: r.url,
          title: r.title,
          timesCited: toNumber(r.times_cited),
          format: r.page_format ?? null,
        });
        pages.set(key, list);
      }
      return siteRows.map((r) => ({
        promptId: String(r.prompt_id),
        text: r.text,
        domain: r.domain,
        timesCited: toNumber(r.times_cited),
        answersCiting: toNumber(r.answers_citing),
        answersWithBrand: toNumber(r.answers_with_brand),
        answersInQuestion: answers.get(String(r.prompt_id)) ?? 0,
        pages: pages.get(`${r.prompt_id}|${r.domain}`) ?? [],
      }));
    },

    /**
     * The brand's own pages that were cited in the period, one row per page and engine, and how many citations of the
     * brand's own site there were in all.
     *
     * @returns `{ ownCitations, pages: [{ url, title, engineCode, timesCited, answersCiting }] }`
     */
    async ownPageCitations(projectId, { from, to, limit = 200 }) {
      await ownProject(projectId);
      const start = dayStart(from);
      const end = dayStart(to);
      const cap = Math.min(Math.max(1, Math.floor(limit)), 500);
      const [totalRows, pageRows] = await Promise.all([
        prisma.$queryRaw`
          SELECT COUNT(*) AS n FROM citations
          WHERE org_id = ${orgId} AND project_id = ${projectId} AND run_date BETWEEN ${start} AND ${end}
            AND is_own = 1`,
        prisma.$queryRaw`
          SELECT u.url AS url, u.title AS title, c.engine_code AS engine_code, COUNT(*) AS times_cited,
                 COUNT(DISTINCT c.snapshot_id) AS answers_citing
          FROM citations c
          JOIN web_urls u ON u.id = c.url_id
          WHERE c.org_id = ${orgId} AND c.project_id = ${projectId} AND c.run_date BETWEEN ${start} AND ${end}
            AND c.is_own = 1
          GROUP BY u.id, u.url, u.title, c.engine_code
          ORDER BY times_cited DESC, u.url ASC
          LIMIT ${cap}`,
      ]);
      return {
        ownCitations: toNumber(totalRows[0]?.n),
        pages: pageRows.map((r) => ({
          url: r.url,
          title: r.title,
          engineCode: r.engine_code,
          timesCited: toNumber(r.times_cited),
          answersCiting: toNumber(r.answers_citing),
        })),
      };
    },

    /**
     * The key pages the latest finished scan fetched successfully, in the scan's order (the most important first):
     * `[{ url }]`. Empty before the first scan.
     */
    async keyPages(projectId, { limit = 30 } = {}) {
      await ownProject(projectId);
      const scan = await prisma.site_scans.findFirst({
        where: { project_id: projectId, org_id: orgId, status: { in: ['complete', 'partial'] } },
        orderBy: [{ finished_at: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (!scan) return [];
      const rows = await prisma.scan_pages.findMany({
        where: { scan_id: scan.id, org_id: orgId, is_key_page: true, http_status: 200 },
        orderBy: { id: 'asc' },
        take: Math.min(Math.max(1, Math.floor(limit)), 100),
        select: { url: true },
      });
      return rows.map((r) => ({ url: r.url }));
    },

    /**
     * Citations of the brand's own site against all citations, per day: `[{ date, own, total }]`. Failed cells have no
     * citations to count; a day with none is left out, and the screen shows a gap there, never 0%.
     */
    async citationShareDaily(projectId, { from, to }) {
      await ownProject(projectId);
      const grouped = await prisma.cell_results.groupBy({
        by: ['run_date'],
        where: {
          project_id: projectId,
          org_id: orgId,
          run_date: range({ from, to }),
          status: { in: ['complete', 'partial'] },
        },
        _sum: { citations_own: true, citations_total: true },
        orderBy: { run_date: 'asc' },
      });
      return grouped
        .map((g) => ({
          date: g.run_date.toISOString().slice(0, 10),
          own: toNumber(g._sum.citations_own),
          total: toNumber(g._sum.citations_total),
        }))
        .filter((g) => g.total > 0);
    },

    /**
     * Cited pages (not the brand's) whose format has not been read, or whose last read is old, most cited first:
     * `[{ id, url, timesCited }]`. A page that could not be read is tried again after a day; one that was read is read
     * again after 30 days. `id` is the dictionary row (a string).
     */
    async unreadCitedUrls(projectId, { from, to, limit = 10, now = new Date() }) {
      await ownProject(projectId);
      const start = dayStart(from);
      const end = dayStart(to);
      const cap = Math.min(Math.max(1, Math.floor(limit)), 50);
      const retryBefore = new Date(now.getTime() - 86_400_000);
      const staleBefore = new Date(now.getTime() - 30 * 86_400_000);
      const rows = await prisma.$queryRaw`
        SELECT u.id AS id, u.url AS url, COUNT(*) AS times_cited
        FROM citations c
        JOIN web_urls u ON u.id = c.url_id
        WHERE c.org_id = ${orgId} AND c.project_id = ${projectId} AND c.run_date BETWEEN ${start} AND ${end}
          AND c.is_own = 0
          AND (u.format_checked_at IS NULL
               OR (u.page_format IS NULL AND u.format_checked_at < ${retryBefore})
               OR u.format_checked_at < ${staleBefore})
        GROUP BY u.id, u.url
        ORDER BY times_cited DESC, u.id ASC
        LIMIT ${cap}`;
      return rows.map((r) => ({
        id: String(r.id),
        url: r.url,
        timesCited: toNumber(r.times_cited),
      }));
    },

    /**
     * Keep what reading a cited page showed. The dictionary is global, so the page must be one this organization's own
     * citations point at. A good read sets the format and the citable signals; a read that could not look sets only the
     * finding (and never a format).
     *
     * @returns `{ saved }`: false when the page is not cited by this project
     */
    async saveUrlFormat(
      projectId,
      urlId,
      { format = null, finding = null, signals = null, now = new Date() },
    ) {
      await ownProject(projectId);
      const cited = await prisma.citations.findFirst({
        where: { org_id: orgId, project_id: projectId, url_id: BigInt(urlId) },
        select: { id: true },
      });
      if (!cited) return { saved: false };
      await prisma.web_urls.update({
        where: { id: BigInt(urlId) },
        data: {
          page_format: format,
          format_finding: format ? null : String(finding ?? 'unreadable').slice(0, 32),
          citable_signals: format && signals ? signals : Prisma.DbNull,
          format_checked_at: now,
        },
      });
      return { saved: true };
    },

    /**
     * A customer says an answer was read wrongly ("That's not us", "This answer was misread"). It goes to the
     * extraction review queue as `customer_report`; the numbers do not change until staff review it. The same person
     * reporting the same answer for the same reason twice is one report.
     *
     * @returns `{ created, id }`.
     * @throws DomainError `SNAPSHOT_NOT_IN_PROJECT`, `INVALID_REPORT_KIND`, `ENTITY_NOT_IN_PROJECT`
     */
    async reportAnswer(projectId, { snapshotId, kind, entityId = null, comment = '', userId }) {
      await ownProject(projectId);
      if (!REPORT_KINDS.includes(kind)) throw new DomainError('INVALID_REPORT_KIND');
      const snapshot = await prisma.answer_snapshots.findFirst({
        where: { id: snapshotId, project_id: projectId, org_id: orgId },
        select: { id: true, run_date: true },
      });
      if (!snapshot) throw new DomainError('SNAPSHOT_NOT_IN_PROJECT');
      if (entityId != null) {
        const entity = await prisma.tracked_entities.findFirst({
          where: { id: entityId, project_id: projectId, org_id: orgId },
          select: { id: true },
        });
        if (!entity) throw new DomainError('ENTITY_NOT_IN_PROJECT');
      }
      const existing = await prisma.review_items.findFirst({
        where: {
          org_id: orgId,
          project_id: projectId,
          snapshot_id: snapshot.id,
          source: 'customer_report',
          report_kind: kind,
          reported_by_user_id: userId,
          status: { in: ['open', 'in_review'] },
        },
        select: { id: true },
      });
      if (existing) return { created: false, id: existing.id };
      const mention =
        entityId == null
          ? null
          : await prisma.mentions.findFirst({
              where: {
                org_id: orgId,
                project_id: projectId,
                snapshot_id: snapshot.id,
                run_date: snapshot.run_date,
                entity_id: entityId,
              },
              select: { id: true },
            });
      const created = await prisma.review_items.create({
        data: {
          org_id: orgId,
          project_id: projectId,
          source: 'customer_report',
          snapshot_id: snapshot.id,
          run_date: snapshot.run_date,
          mention_id: mention?.id ?? null,
          entity_id: entityId,
          reported_by_user_id: userId,
          report_kind: kind,
          report_comment:
            String(comment ?? '')
              .trim()
              .slice(0, 1000) || null,
        },
      });
      return { created: true, id: created.id };
    },

    /** The customer reports already made on these answers: `[{ snapshotId, kind, status }]`. */
    async reportsFor(projectId, snapshotIds) {
      await ownProject(projectId);
      if (!snapshotIds.length) return [];
      const rows = await prisma.review_items.findMany({
        where: {
          org_id: orgId,
          project_id: projectId,
          source: 'customer_report',
          snapshot_id: { in: snapshotIds },
        },
        select: { snapshot_id: true, report_kind: true, status: true },
      });
      return rows.map((r) => ({
        snapshotId: r.snapshot_id,
        kind: r.report_kind,
        status: r.status,
      }));
    },
  };

  return { dashboard };
}
