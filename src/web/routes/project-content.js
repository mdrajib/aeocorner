import { randomBytes } from 'node:crypto';
import { buildRegistry, usableFacts } from '../../core/content-facts.js';
import { analyzeBody, sanitizeBody } from '../../core/content-html.js';
import { contentStartFor } from '../../core/content-start.js';
import {
  pipelineSteps,
  RUNNING,
  STATUS_LABELS,
  STATUS_TONES,
} from '../../core/content-lifecycle.js';
import {
  boardColumns,
  exportHtml,
  exportMarkdown,
  liveDraftHtml,
  KIND_LABELS,
  publishPanel,
  qcView,
  researchView,
} from '../../core/content-studio.js';
import { FORMAT_LABELS, FORMATS } from '../../core/evidence-pack.js';
import { problemLines, validateJsonLd } from '../../core/jsonld.js';
import { DomainError } from '../../db/index.js';
import {
  createWordPressClient,
  normalizeSiteUrl,
  WordPressError,
} from '../../integrations/wordpress.js';
import { contentJobId, publishJobId, slotOf, wordpressTestJobId } from '../../lib/job-ids.js';
import { briefSchema, checkBrief, SCHEMA_TYPES } from '../../llm/brief.js';
import { liveKey } from '../../worker/handlers/content.js';
import { createZip } from '../../lib/zip.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { notFound } from '../middleware/errors.js';
import {
  dateLabel,
  idFrom,
  lines,
  requireCollect,
  rowsOf,
  text,
  toArray,
  withNotice,
} from './project-helpers.js';

/**
 * The Content Studio and the WordPress connection of one project (Milestone 7, UI_DESIGN D5 and D6). Registers on the
 * project router.
 *
 *   GET  /projects/:pid/content                    the board, and "write a page about…"
 *   POST /projects/:pid/content                    start an item from a question or a topic
 *   POST /projects/:pid/actions/:rid/content       start an item from a recommendation
 *   GET  /projects/:pid/content/:cid               one item: steps, draft and editor, check, plan, research, publish
 *   GET  /projects/:pid/content/:cid/events        the draft as it is written (server-sent events)
 *   POST …/content/:cid/save | brief | redraft | approve | unapprove | publish | retry | archive
 *   GET  …/content/:cid/export.html | export.md    for a site that is not on WordPress (after approval)
 *   GET  /projects/:pid/integrations/wordpress     D6: connect, test, disconnect, the plugin
 *   POST …/integrations/wordpress | /test | /disconnect;  GET …/plugin.zip
 *
 * Reading is for anyone who can see the project. Writing needs `content.create` (owner, admin, editor); approving and
 * publishing need `site.approve`; connecting WordPress needs `integrations.manage` (owner, admin). Nothing here decides
 * a status: every move goes through the repository, which asks the lifecycle table (src/core/content-lifecycle.js).
 */

const PLUGIN_DIR = fileURLToPath(
  new URL('../../../wordpress-plugin/aeo-corner-connector', import.meta.url),
);
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const STREAMS_PER_USER = 3;
const STREAM_EVERY_MS = 1_200;
const STREAM_MAX_MS = 12 * 60_000;

let pluginZip = null;
function pluginZipBytes() {
  if (pluginZip) return pluginZip;
  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
      else
        entries.push({ name: `aeo-corner-connector/${prefix}${name}`, data: readFileSync(full) });
    }
  };
  walk(PLUGIN_DIR, '');
  pluginZip = createZip(entries);
  return pluginZip;
}

export function contentRoutes(
  router,
  { appPage, act, approve, manage, jobs: appJobs, logger, content = null },
) {
  // The queue the web process adds to; a deployment (or a browser test) can give the Content Studio its own.
  const jobs = content?.jobs ?? appJobs;
  const streams = new Map();
  const base = (res) => res.locals.projectBase;
  const itemBase = (res, publicId) => `${base(res)}/content/${publicId}`;
  const meta = (req, title) => ({
    title: `${title} · ${req.project.name} | AEO Corner`,
    description: `${title} for ${req.project.name}.`,
  });
  const tabs = (req, res, current = 'content') => ({
    orgBase: res.locals.orgBase,
    projectBase: res.locals.projectBase,
    projectName: req.project.name,
    domain: req.project.domain ?? '',
    current,
  });

  /** Queue a stage. A queue that is down must not leave an item "working" for ever: the item is failed, plainly. */
  async function queue(req, item, name, round) {
    try {
      await jobs.add(
        name,
        { orgId: String(req.org.id), projectId: String(req.project.id), itemId: String(item.id) },
        { jobId: contentJobId(name.split('.')[1], item.id, round) },
      );
      return true;
    } catch (err) {
      logger.error({ err, itemId: String(item.id), name }, 'Could not queue a content stage');
      await req.orgDb.content
        .fail(req.project.id, item.id, {
          stage: name === 'content.draft' ? 'drafting' : 'researching',
          reason: 'We could not start this just now. Try again in a minute.',
        })
        .catch(() => {});
      return false;
    }
  }

  async function brandKit(req) {
    const row = await req.orgDb.brandKits.current(req.project.id);
    return (
      row?.data ?? {
        identity: { brandName: req.project.name },
        offerings: { items: [], differentiators: [] },
        facts: [],
        voice: {},
      }
    );
  }

  async function briefContext(req, item) {
    const [kit, known] = await Promise.all([
      brandKit(req),
      req.orgDb.scans.knownPages(req.project.id),
    ]);
    const registry = buildRegistry({ kit, research: item.research?.facts ?? [] });
    const domain = String(req.project.domain).toLowerCase();
    const internalUrls = known
      .map((p) => p.final_url ?? p.url)
      .filter((u) => {
        try {
          const host = new URL(u).hostname.toLowerCase();
          return host === domain || host.endsWith(`.${domain}`);
        } catch {
          return false;
        }
      });
    return {
      kit,
      registry,
      factIds: usableFacts(registry).map((f) => f.id),
      internalUrls: [...new Set(internalUrls)],
    };
  }

  // --- the board ---------------------------------------------------------------------------------------
  router.get('/projects/:pid/content', async (req, res, next) => {
    try {
      const [items, prompts, quota, wordpress] = await Promise.all([
        req.orgDb.content.list(req.project.id),
        req.orgDb.prompts.list(req.project.id, { status: 'active' }),
        req.orgDb.draftQuota.draftsUsed(),
        req.orgDb.integrations.wordpress(req.project.id),
      ]);
      if (items.some((i) => RUNNING.includes(i.status))) res.locals.refreshSeconds = 10;
      return appPage(res, 'content', {
        ...tabs(req, res),
        columns: boardColumns(items, { projectBase: base(res) }),
        total: items.length,
        prompts: prompts.map((p) => ({ id: String(p.id), text: p.text })),
        quota,
        wordpress: wordpress
          ? {
              status: wordpress.status,
              siteName: wordpress.config?.siteName ?? wordpress.config?.siteUrl ?? '',
            }
          : null,
        canAct: res.locals.can('content.create'),
        meta: meta(req, 'Content Studio'),
      });
    } catch (err) {
      return next(err);
    }
  });

  async function startItem(req, res, params) {
    const made = await req.orgDb.content.create(req.project.id, { ...params, userId: req.user.id });
    if (made.blocked === 'quota')
      return { redirect: withNotice(`${base(res)}/content`, 'content-quota') };
    const queued = await queue(req, made, 'content.research', slotOf(new Date()));
    return {
      redirect: withNotice(
        itemBase(res, made.publicId),
        queued ? 'content-started' : 'content-queue-failed',
      ),
    };
  }

  router.post('/projects/:pid/content', act, requireCollect, async (req, res, next) => {
    try {
      const promptId = idFrom(req.body.promptId);
      let title = text(req.body.title, 200);
      if (promptId) {
        const prompts = await req.orgDb.prompts.list(req.project.id);
        const prompt = prompts.find((p) => p.id === promptId);
        if (!prompt)
          return res.redirect(303, withNotice(`${base(res)}/content`, 'content-needs-topic'));
        title = title || prompt.text;
      }
      if (!title)
        return res.redirect(303, withNotice(`${base(res)}/content`, 'content-needs-topic'));
      const result = await startItem(req, res, {
        title,
        promptIds: promptId ? [promptId] : [],
        kind: 'new',
      });
      return res.redirect(303, result.redirect);
    } catch (err) {
      return next(err);
    }
  });

  router.post(
    '/projects/:pid/actions/:rid/content',
    act,
    requireCollect,
    async (req, res, next) => {
      try {
        const rid = idFrom(req.params.rid);
        const detail = rid ? await req.orgDb.recommendations.get(req.project.id, rid) : null;
        if (!detail) return notFound(req, res);
        const rec = detail.recommendation;
        if (rec.fixPath !== 'content' || !['open', 'in_progress'].includes(rec.status)) {
          return res.redirect(303, withNotice(`${base(res)}/actions/${rid}`, 'action-stale'));
        }
        // The same draft Autopilot would start for this recommendation (src/core/content-start.js).
        const start = contentStartFor(rec);
        try {
          const result = await startItem(req, res, {
            recommendationId: rid,
            ...start,
          });
          return res.redirect(303, result.redirect);
        } catch (err) {
          if (err instanceof DomainError && err.code === 'CONTENT_ALREADY_OPEN') {
            return res.redirect(303, itemBase(res, err.message));
          }
          throw err;
        }
      } catch (err) {
        return next(err);
      }
    },
  );

  // --- one item ----------------------------------------------------------------------------------------
  async function loadItem(req) {
    if (!ULID.test(req.params.cid)) return null;
    const item = await req.orgDb.content.get(req.project.id, req.params.cid);
    return item;
  }

  async function renderItem(req, res, item, extra = {}) {
    const [wordpress, siteChanges, ctx] = await Promise.all([
      req.orgDb.integrations.wordpress(req.project.id),
      req.orgDb.content.siteChanges(req.project.id, item.id),
      briefContext(req, item),
    ]);
    const running = RUNNING.includes(item.status);
    if (running) res.locals.refreshSeconds = item.status === 'drafting' ? 20 : 8;
    const panel = publishPanel({
      item,
      integration: wordpress,
      canApprove: res.locals.can('site.approve'),
      canEdit: res.locals.can('content.create'),
    });
    const qc = qcView(item.qc, {
      revisionIsCurrent: item.qc?.revisionId
        ? String(item.currentRevisionId) === item.qc.revisionId
        : false,
    });
    const validation = item.jsonld ? validateJsonLd(item.jsonld) : null;
    let recommendation = null;
    if (item.recommendationId) {
      const rec = await req.orgDb.recommendations.load(item.recommendationId);
      if (rec)
        recommendation = {
          id: String(rec.id),
          title: rec.title,
          status: rec.status,
          href: `${base(res)}/actions/${rec.id}`,
        };
    }
    const brief = item.brief
      ? {
          title: item.brief.title,
          metaDescription: item.brief.metaDescription,
          audience: item.brief.audience,
          format: item.brief.format,
          schemaType: item.brief.schemaType,
          entities: (item.brief.entities ?? []).join('\n'),
          outline: (item.brief.outline ?? []).map((s) => ({
            heading: s.heading,
            directAnswer: s.directAnswer,
            points: (s.points ?? []).join('\n'),
            factIds: (s.factIds ?? []).join(', '),
          })),
          internalLinks: item.brief.internalLinks ?? [],
        }
      : null;
    return appPage(
      res,
      'content-item',
      {
        ...tabs(req, res),
        editor: panel.canEdit && !running,
        itemBase: itemBase(res, item.publicId),
        boardHref: `${base(res)}/content`,
        item: {
          publicId: item.publicId,
          title: item.title,
          status: item.status,
          badge: { text: STATUS_LABELS[item.status], tone: STATUS_TONES[item.status] },
          format: FORMAT_LABELS[item.format] ?? FORMAT_LABELS.other,
          kind: KIND_LABELS[item.kind] ?? item.kind,
          isRefresh: item.kind === 'refresh',
          targetUrl: item.targetUrl,
          running,
          failed:
            item.status === 'failed'
              ? { stage: item.failedStage, reason: item.failureReason }
              : null,
          words: item.current?.wordCount ?? 0,
          revision: item.current?.revision ?? 0,
          revisionId: item.currentRevisionId == null ? '' : String(item.currentRevisionId),
          bodyHtml: sanitizeBody(item.current?.bodyHtml ?? '').html,
          revisions: item.revisions.map((r) => ({
            revision: r.revision,
            source: {
              ai_draft: 'Written by AEO Corner',
              ai_revision: 'Rewritten by AEO Corner',
              user_edit: 'Edited by you',
            }[r.source],
            words: r.wordCount,
            when: dateLabel(r.createdAt),
          })),
          approvedAt: item.approvedAt ? dateLabel(item.approvedAt) : null,
          publishedAt: item.publishedAt ? dateLabel(item.publishedAt) : null,
          costUsd: item.llmCostUsd,
        },
        steps: pipelineSteps(item.status, { failedAt: item.failedStage }),
        panel,
        qc,
        research: researchView(item.research),
        brief,
        briefErrors: extra.briefErrors ?? [],
        formats: FORMATS.map((f) => ({ value: f, label: FORMAT_LABELS[f] })),
        schemaTypes: SCHEMA_TYPES,
        jsonld: item.jsonld
          ? {
              text: JSON.stringify(item.jsonld, null, 2),
              ok: validation.ok,
              problems: problemLines(validation),
              warnings: validation.warnings.map((w) => w.message),
            }
          : null,
        changes: siteChanges.slice(0, 5).map((c) => ({
          kind:
            { post_create: 'Created the post', post_update: 'Updated the post' }[c.kind] ?? c.kind,
          status: c.status,
          mode: c.payload?.mode === 'draft' ? 'as a draft' : 'live',
          when: dateLabel(c.createdAt),
          error: c.lastError,
        })),
        recommendation,
        factCount: ctx.factIds.length,
        canAct: res.locals.can('content.create'),
        canApprove: res.locals.can('site.approve'),
        canManage: res.locals.can('integrations.manage'),
        wordpressBase: `${base(res)}/integrations/wordpress`,
        meta: meta(req, item.title),
      },
      extra.status ? { status: extra.status } : undefined,
    );
  }

  router.get('/projects/:pid/content/:cid', async (req, res, next) => {
    try {
      const item = await loadItem(req);
      if (!item || item.status === 'archived') return notFound(req, res);
      return renderItem(req, res, item);
    } catch (err) {
      return next(err);
    }
  });

  // The draft as it is written. The text so far is in Redis (the worker writes it while Claude streams); it is
  // sanitized here before it leaves, because it is model output.
  router.get('/projects/:pid/content/:cid/events', async (req, res, next) => {
    try {
      const item = await loadItem(req);
      if (!item || !content?.redis) return notFound(req, res);
      const who = String(req.user.id);
      if ((streams.get(who) ?? 0) >= STREAMS_PER_USER) return res.status(429).end();
      streams.set(who, (streams.get(who) ?? 0) + 1);
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      res.write('retry: 5000\n\n');
      let closed = false;
      let timer = null;
      let lastText = null;
      const started = Date.now();
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        const left = (streams.get(who) ?? 1) - 1;
        if (left > 0) streams.set(who, left);
        else streams.delete(who);
      };
      req.on('close', finish);
      const tick = async () => {
        if (closed) return;
        try {
          const fresh = await req.orgDb.content.get(req.project.id, item.publicId);
          if (!fresh || fresh.status !== item.status) {
            res.write(
              `event: status\ndata: ${JSON.stringify({ status: fresh?.status ?? 'gone' })}\n\n`,
            );
            finish();
            return res.end();
          }
          const raw = await content.redis.get(liveKey(content.prefix, fresh.id));
          let partial = null;
          try {
            partial = raw ? JSON.parse(raw) : null;
          } catch {
            partial = null;
          }
          if (partial && partial.text !== lastText) {
            lastText = partial.text;
            res.write(
              `event: draft\ndata: ${JSON.stringify({ html: liveDraftHtml(partial.text), words: analyzeBody(liveDraftHtml(partial.text)).words })}\n\n`,
            );
          } else res.write(': keep-alive\n\n');
        } catch (err) {
          logger.warn({ err: err.message }, 'Content stream error');
          res.write(': error\n\n');
        }
        if (Date.now() - started > STREAM_MAX_MS) {
          finish();
          return res.end();
        }
        timer = setTimeout(tick, STREAM_EVERY_MS);
      };
      tick();
      return undefined;
    } catch (err) {
      return next(err);
    }
  });

  // --- a person's moves --------------------------------------------------------------------------------
  const back = (res, item, notice) =>
    res.redirect(303, withNotice(itemBase(res, item.publicId), notice));

  /** The move was refused because the item changed under the person: say so, never a 500. */
  function refused(err, req, res, item) {
    if (err instanceof DomainError) {
      if (err.code === 'CONTENT_NOT_FOUND') return notFound(req, res);
      if (err.code === 'STALE_REVISION') return back(res, item, 'content-stale-text');
      if (
        ['INVALID_TRANSITION', 'STALE_STATUS', 'NOT_APPROVED', 'NO_BRIEF', 'BAD_MODE'].includes(
          err.code,
        )
      )
        return back(res, item, 'content-stale');
      if (err.code === 'WORDPRESS_NOT_CONNECTED') return back(res, item, 'content-no-wordpress');
      logger.warn({ code: err.code }, 'Content move refused');
      return back(res, item, 'content-stale');
    }
    throw err;
  }

  router.post('/projects/:pid/content/:cid/save', act, async (req, res, next) => {
    try {
      const item = await loadItem(req);
      if (!item) return notFound(req, res);
      const html = sanitizeBody(typeof req.body.html === 'string' ? req.body.html : '').html;
      if (analyzeBody(html).words === 0) return back(res, item, 'content-empty');
      try {
        const saved = await req.orgDb.content.saveEdit(req.project.id, item.id, {
          html,
          expectedRevision: Number(req.body.revision) || null,
          userId: req.user.id,
        });
        if (saved.unchanged) return back(res, item, 'content-unchanged');
        await queue(req, item, 'content.qc', saved.revision);
        return back(res, item, 'content-saved');
      } catch (err) {
        return refused(err, req, res, item);
      }
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/content/:cid/brief', act, async (req, res, next) => {
    try {
      const item = await loadItem(req);
      if (!item) return notFound(req, res);
      if (item.status !== 'ready' || !item.brief) return back(res, item, 'content-stale');
      const ctx = await briefContext(req, item);
      const outline = rowsOf(req.body, {
        heading: ['outline_heading', 160],
        directAnswer: ['outline_answer', 600],
      }).map((row, i) => ({
        ...row,
        points: lines(toArray(req.body.outline_points)[i] ?? '', 200),
        factIds: text(toArray(req.body.outline_facts)[i] ?? '', 100)
          .split(/[\s,]+/)
          .filter(Boolean),
      }));
      const draft = {
        format: text(req.body.format, 20),
        title: text(req.body.title, 120),
        metaDescription: text(req.body.metaDescription, 200),
        audience: text(req.body.audience, 120),
        outline,
        entities: lines(req.body.entities, 80),
        internalLinks: item.brief.internalLinks ?? [],
        schemaType: text(req.body.schemaType, 20),
      };
      const parsed = briefSchema.safeParse(draft);
      const errors = parsed.success
        ? checkBrief(parsed.data, { factIds: ctx.factIds, internalUrls: ctx.internalUrls })
        : parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(' › ')}: ${i.message}`);
      if (errors.length > 0) {
        res.status(422);
        return renderItem(req, res, item, { briefErrors: errors, status: 422 });
      }
      try {
        await req.orgDb.content.editBrief(req.project.id, item.id, {
          brief: { ...parsed.data, version: item.brief.version },
          userId: req.user.id,
        });
        if (req.body.then === 'redraft') {
          await req.orgDb.content.redraft(req.project.id, item.id);
          await queue(req, item, 'content.draft', item.revisions.length + 1);
          return back(res, item, 'content-redrafting');
        }
        return back(res, item, 'content-brief-saved');
      } catch (err) {
        return refused(err, req, res, item);
      }
    } catch (err) {
      return next(err);
    }
  });

  router.post(
    '/projects/:pid/content/:cid/redraft',
    act,
    requireCollect,
    async (req, res, next) => {
      try {
        const item = await loadItem(req);
        if (!item) return notFound(req, res);
        try {
          await req.orgDb.content.redraft(req.project.id, item.id);
          await queue(req, item, 'content.draft', item.revisions.length + 1);
          return back(res, item, 'content-redrafting');
        } catch (err) {
          return refused(err, req, res, item);
        }
      } catch (err) {
        return next(err);
      }
    },
  );

  router.post('/projects/:pid/content/:cid/approve', approve, async (req, res, next) => {
    try {
      const item = await loadItem(req);
      if (!item) return notFound(req, res);
      // The revision the person was looking at: if the text changed since, nothing is approved.
      const revisionId = idFrom(req.body.revisionId);
      if (!revisionId) return back(res, item, 'content-stale-text');
      try {
        const result = await req.orgDb.content.approve(req.project.id, item.id, {
          userId: req.user.id,
          revisionId,
        });
        return back(res, item, result.approved ? 'content-approved' : 'content-blocked');
      } catch (err) {
        return refused(err, req, res, item);
      }
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/content/:cid/unapprove', act, async (req, res, next) => {
    try {
      const item = await loadItem(req);
      if (!item) return notFound(req, res);
      try {
        await req.orgDb.content.unapprove(req.project.id, item.id);
        return back(res, item, 'content-unapproved');
      } catch (err) {
        return refused(err, req, res, item);
      }
    } catch (err) {
      return next(err);
    }
  });

  router.post(
    '/projects/:pid/content/:cid/publish',
    approve,
    requireCollect,
    async (req, res, next) => {
      try {
        const item = await loadItem(req);
        if (!item) return notFound(req, res);
        try {
          const mode = req.body.mode === 'draft' ? 'draft' : 'publish';
          const begun = await req.orgDb.content.beginPublish(req.project.id, item.id, {
            userId: req.user.id,
            mode,
          });
          try {
            await jobs.add(
              'content.publish',
              {
                orgId: String(req.org.id),
                projectId: String(req.project.id),
                itemId: String(item.id),
                siteChangeId: String(begun.siteChangeId),
              },
              { jobId: publishJobId(begun.siteChangeId) },
            );
          } catch (err) {
            logger.error({ err, itemId: String(item.id) }, 'Could not queue publishing');
            await req.orgDb.content.finishPublish(req.project.id, item.id, {
              siteChangeId: begun.siteChangeId,
              outcome: 'failed',
              error: 'We could not start publishing just now. Nothing was changed on your site.',
            });
            return back(res, item, 'content-queue-failed');
          }
          return back(
            res,
            item,
            mode === 'draft' ? 'content-publishing-draft' : 'content-publishing',
          );
        } catch (err) {
          return refused(err, req, res, item);
        }
      } catch (err) {
        return next(err);
      }
    },
  );

  router.post('/projects/:pid/content/:cid/retry', act, requireCollect, async (req, res, next) => {
    try {
      const item = await loadItem(req);
      if (!item) return notFound(req, res);
      try {
        const result = await req.orgDb.content.retry(req.project.id, item.id);
        if (result.blocked) return back(res, item, 'content-quota');
        if (result.to === 'researching')
          await queue(req, item, 'content.research', slotOf(new Date()));
        if (result.to === 'drafting')
          await queue(req, item, 'content.draft', item.revisions.length + 1);
        return back(res, item, 'content-retried');
      } catch (err) {
        return refused(err, req, res, item);
      }
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/content/:cid/archive', act, async (req, res, next) => {
    try {
      const item = await loadItem(req);
      if (!item) return notFound(req, res);
      try {
        await req.orgDb.content.archive(req.project.id, item.id);
        return res.redirect(303, withNotice(`${base(res)}/content`, 'content-archived'));
      } catch (err) {
        return refused(err, req, res, item);
      }
    } catch (err) {
      return next(err);
    }
  });

  // --- the way out for a site that is not on WordPress: only what a person approved ----------------------
  for (const [ext, make, type] of [
    [
      'html',
      (item) => exportHtml({ title: item.title, bodyHtml: item.approvedHtml, jsonld: item.jsonld }),
      'text/html; charset=utf-8',
    ],
    ['md', (item) => exportMarkdown(item.approvedHtml), 'text/markdown; charset=utf-8'],
  ]) {
    router.get(`/projects/:pid/content/:cid/export.${ext}`, async (req, res, next) => {
      try {
        const item = await loadItem(req);
        if (!item || !['approved', 'publishing', 'published'].includes(item.status))
          return notFound(req, res);
        // The exact revision a person approved, never a later edit.
        const pinned = item.revisions.find((r) => r.id === item.approvedRevisionId);
        const approved = pinned
          ? await req.orgDb.content.revision(req.project.id, item.id, pinned.revision)
          : null;
        if (!approved) return notFound(req, res);
        const slug =
          item.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 60) || 'page';
        // Structured data that does not validate is never written out, even into a download.
        let body;
        try {
          body = make({ ...item, approvedHtml: approved.bodyHtml });
        } catch (err) {
          if (!(err instanceof RangeError)) throw err;
          return res
            .status(409)
            .type('text/plain')
            .send(
              'The structured data for this page did not pass its check, so nothing was exported. Edit the page and approve it again.',
            );
        }
        res.set({
          'Content-Type': type,
          'Content-Disposition': `attachment; filename="${slug}.${ext}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.send(body);
      } catch (err) {
        return next(err);
      }
    });
  }

  // --- D6 WordPress -------------------------------------------------------------------------------------
  const wpBase = (res) => `${base(res)}/integrations/wordpress`;

  async function renderWordPress(req, res, { error = null, form = {}, status } = {}) {
    const wordpress = await req.orgDb.integrations.wordpress(req.project.id);
    return appPage(
      res,
      'wordpress',
      {
        ...tabs(req, res, 'content'),
        wordpress:
          wordpress && wordpress.status !== 'disconnected'
            ? {
                status: wordpress.status,
                siteUrl: wordpress.config?.siteUrl ?? '',
                siteName: wordpress.config?.siteName ?? '',
                username: wordpress.config?.username ?? '',
                canPublish: wordpress.config?.canPublish !== false,
                pluginInstalled: Boolean(wordpress.config?.pluginInstalled),
                pluginConnected: Boolean(wordpress.config?.pluginConnected),
                pluginVersion: wordpress.config?.pluginVersion ?? null,
                seoPlugin: wordpress.config?.seoPlugin ?? null,
                lastError: wordpress.lastError,
                checkedAt: wordpress.config?.checkedAt
                  ? dateLabel(wordpress.config.checkedAt)
                  : null,
              }
            : null,
        error,
        form: { siteUrl: form.siteUrl ?? '', username: form.username ?? '' },
        configured: Boolean(content?.secrets),
        canManage: res.locals.can('integrations.manage'),
        wpBase: wpBase(res),
        boardHref: `${base(res)}/content`,
        meta: meta(req, 'WordPress'),
      },
      status ? { status } : undefined,
    );
  }

  router.get('/projects/:pid/integrations/wordpress', async (req, res, next) => {
    try {
      const wordpress = await req.orgDb.integrations.wordpress(req.project.id);
      if (wordpress?.status === 'connected' && !wordpress.config?.checkedAt)
        res.locals.refreshSeconds = 8;
      return await renderWordPress(req, res);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/projects/:pid/integrations/wordpress/plugin.zip', manage, (req, res) => {
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="aeo-corner-connector.zip"',
      'Cache-Control': 'no-store',
    });
    res.send(pluginZipBytes());
  });

  router.post('/projects/:pid/integrations/wordpress', manage, async (req, res, next) => {
    try {
      if (!content?.secrets || !content?.fetcher) {
        return res.redirect(303, withNotice(wpBase(res), 'wp-not-configured'));
      }
      const form = { siteUrl: text(req.body.siteUrl, 300), username: text(req.body.username, 120) };
      const appPassword =
        typeof req.body.appPassword === 'string'
          ? req.body.appPassword.replace(/\s+/g, ' ').trim().slice(0, 200)
          : '';
      const fail = (message) => {
        res.status(422);
        return renderWordPress(req, res, { error: message, form, status: 422 });
      };
      if (!form.siteUrl || !form.username || !appPassword)
        return fail('Fill in the site address, the user name and the application password.');
      let client;
      try {
        client = createWordPressClient({
          fetcher: content.fetcher,
          siteUrl: normalizeSiteUrl(form.siteUrl),
          username: form.username,
          appPassword,
        });
        const site = await client.probe();
        const me = await client.whoAmI();
        if (!me.canEdit)
          return fail('That WordPress user cannot create posts. Use an editor or administrator.');
        let hmacSecret = null;
        let plugin = null;
        if (site.pluginInstalled && me.canManage) {
          hmacSecret = randomBytes(32).toString('hex');
          plugin = await client.plugin.connect({
            secret: hmacSecret,
            indexNowKey: randomBytes(16).toString('hex'),
          });
        }
        const secret = content.secrets.encrypt(
          { appPassword, hmacSecret },
          `wordpress:${req.org.id}:${req.project.id}`,
        );
        await req.orgDb.integrations.saveWordpress(req.project.id, {
          config: {
            siteUrl: client.siteUrl,
            username: form.username,
            siteName: site.name,
            canPublish: me.canPublish,
            pluginInstalled: site.pluginInstalled,
            pluginConnected: Boolean(plugin),
            pluginVersion: plugin?.pluginVersion ?? null,
            seoPlugin: plugin?.seoPlugin ?? null,
            checkedAt: new Date().toISOString(),
          },
          secret,
          userId: req.user.id,
        });
        return res.redirect(
          303,
          withNotice(wpBase(res), plugin ? 'wp-connected' : 'wp-connected-no-plugin'),
        );
      } catch (err) {
        if (err instanceof WordPressError) return fail(err.message);
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/integrations/wordpress/test', manage, async (req, res, next) => {
    try {
      try {
        await jobs.add(
          'wordpress.test',
          { orgId: String(req.org.id), projectId: String(req.project.id) },
          { jobId: wordpressTestJobId(req.project.id, slotOf(new Date())) },
        );
      } catch (err) {
        logger.error({ err }, 'Could not queue the WordPress test');
        return res.redirect(303, withNotice(wpBase(res), 'content-queue-failed'));
      }
      return res.redirect(303, withNotice(wpBase(res), 'wp-testing'));
    } catch (err) {
      return next(err);
    }
  });

  router.post(
    '/projects/:pid/integrations/wordpress/disconnect',
    manage,
    async (req, res, next) => {
      try {
        await req.orgDb.integrations.disconnectWordpress(req.project.id);
        return res.redirect(303, withNotice(wpBase(res), 'wp-disconnected'));
      } catch (err) {
        return next(err);
      }
    },
  );
}
