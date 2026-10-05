import { randomBytes } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { buildRegistry, factTexts, sourceList, usableFacts } from '../../core/content-facts.js';
import { analyzeBody, sanitizeBody } from '../../core/content-html.js';
import { citableChecks, scoreDraft } from '../../core/content-qc.js';
import { buildJsonLd } from '../../core/content-schema.js';
import { buildCheckPack, buildEvidencePack, packUrls } from '../../core/evidence-pack.js';
import { scriptTag, validateJsonLd } from '../../core/jsonld.js';
import { fromMicros } from '../../core/spend.js';
import { ProviderError } from '../../engines/contract.js';
import { createWordPressClient, WordPressError } from '../../integrations/wordpress.js';
import { contentJobId, fixVerifyJobId, slotOf } from '../../lib/job-ids.js';
import { readBriefReply, buildBriefRequest, BRIEF_VERSION } from '../../llm/brief.js';
import { buildDraftRequest, readDraftReply } from '../../llm/draft.js';
import { costMicros, modelProfile } from '../../llm/models.js';
import {
  buildResearchRequest,
  continueResearch,
  MAX_CONTINUATIONS,
  readResearchReply,
  RESEARCH_VERSION,
  SEARCH_MICROS,
} from '../../llm/research.js';
import { Deferral } from '../deferral.js';
import { ledgerKey } from '../provider-call.js';

/**
 * The Content Studio's pipeline and publishing (Milestone 7, MVP F8 and F9). One job per stage, each queuing the next:
 *
 *   content.research   build the evidence pack from our own tracking data, then have Claude search and read the web for
 *                      facts. Only facts whose page the tools really returned, with a quotation found on it, are used.
 *   content.brief      plan the page: format, question headings with direct answers, entities, links, schema type
 *   content.draft      write the page, streamed (the text so far is kept in Redis for the customer's screen)
 *   content.qc         score the draft against the rubric and build its JSON-LD (free: no model is called)
 *   content.publish    send the approved revision to the customer's WordPress, then mark the recommendation done, which
 *                      saves the baseline and starts the live-page check (task 7.12)
 *   wordpress.test     check a project's connection
 *
 * Every stage only does its work if the item is in the status that stage owns, so a repeated or late job does nothing,
 * and a stage that fails for good moves the item to `failed` with a reason in plain words, never an error message.
 * Paid calls go through `callProvider` as the organization (provider `anthropic`, meter `llm_content`); the research
 * step's web searches are priced in ($10 per 1,000).
 */

export const liveKey = (prefix, itemId) => `${prefix}:content:live:${itemId}`;

function configured(ctx) {
  if (!ctx.content?.claude) {
    throw new UnrecoverableError('Claude is not configured on this worker (ANTHROPIC_API_KEY)');
  }
  return { claude: ctx.content.claude, profile: modelProfile(ctx.content.model ?? 'opus55') };
}

const usageOf = (profile, usage, { itemId, searches = 0 }) => ({
  meter: 'llm_content',
  unit: 'request',
  quantity: 1,
  model: profile.id,
  tokensIn: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  tokensOut: usage.output_tokens ?? 0,
  tokensCached: usage.cache_read_input_tokens ?? 0,
  costUsd: fromMicros(costMicros(profile, usage) + searches * SEARCH_MICROS),
  refType: 'content',
  refId: itemId,
});
const dollars = (profile, usage, searches = 0) =>
  (costMicros(profile, usage) + searches * SEARCH_MICROS) / 1_000_000;

const unusableReply = (what, read) =>
  new ProviderError(`Claude's reply for ${what} was not usable: ${read.reason}`, {
    status: `unusable_${read.reason}`,
    retryable: read.reason !== 'refusal',
    countsAgainstProvider: false,
  });

/** What a person is told when a stage gives up. Never an error message: those can hold addresses and fragments of replies. */
export function plainReason(err, stage) {
  if (err instanceof WordPressError) return err.message;
  if (err instanceof ProviderError) {
    if (err.status === 'auth')
      return 'The writing service did not accept our key. We have been told; try again later.';
    if (err.status === 'unusable_refusal')
      return 'The writing service declined to write about this topic.';
    if (String(err.status).startsWith('unusable_'))
      return 'The writing service gave an answer we could not use, twice. Try again.';
    return 'The writing service was busy or unavailable. Try again in a few minutes.';
  }
  if (err instanceof UnrecoverableError)
    return 'This step is not set up on our side yet. We have been told.';
  return stage === 'publishing'
    ? 'Publishing failed. Nothing was made live; try again.'
    : 'Something went wrong on our side. Try again.';
}

/**
 * Run one stage's body; if it fails for good (an error that will not get better, or the last attempt) the item goes to
 * `failed` at that stage. Otherwise the error is thrown so the queue retries it.
 */
async function runStage(ctx, data, job, stage, body) {
  const scoped = ctx.db.forOrg(BigInt(data.orgId));
  const projectId = BigInt(data.projectId);
  const spent = { usd: 0 };
  try {
    return await body({ scoped, projectId, spent });
  } catch (err) {
    if (err instanceof Deferral) throw err;
    const last = job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
    const permanent =
      err instanceof UnrecoverableError ||
      (err instanceof ProviderError && err.retryable === false) ||
      (err instanceof WordPressError && !err.retryable);
    if (!permanent && !last) throw err;
    const reason = plainReason(err, stage);
    ctx.logger.warn(
      { itemId: data.itemId, stage, err: err.message },
      'Content stage failed for good',
    );
    await scoped.content.fail(projectId, data.itemId, { stage, reason, costUsd: spent.usd });
    return { failed: true, stage, reason };
  }
}

async function worldOf(ctx, scoped, projectId) {
  const project = await scoped.projects.get(projectId);
  if (!project || project.status === 'archived')
    throw new UnrecoverableError('The project is gone');
  const row = await scoped.brandKits.current(projectId);
  const kit = row?.data ?? {
    identity: { brandName: project.name },
    offerings: { items: [], differentiators: [] },
    facts: [],
    voice: {},
  };
  const known = await scoped.scans.knownPages(projectId);
  const domain = String(project.domain).toLowerCase();
  const internalUrls = [
    ...new Set(
      known
        .map((p) => p.final_url ?? p.url)
        .filter((u) => {
          try {
            const host = new URL(u).hostname.toLowerCase();
            return /^https?:/i.test(u) && (host === domain || host.endsWith(`.${domain}`));
          } catch {
            return false;
          }
        }),
    ),
  ].slice(0, 40);
  return { project, kit, brandName: kit.identity?.brandName || project.name, internalUrls };
}

/** What we know about the target before research: the answers engines give today, or the failing check, or just a title. */
async function packFor(scoped, projectId, item, world) {
  const rec = item.recommendationId
    ? await scoped.recommendations.load(item.recommendationId)
    : null;
  const promptId = item.promptIds[0] ?? rec?.evidence?.promptId ?? null;
  if (promptId) {
    const prompts = await scoped.prompts.list(projectId);
    const prompt = prompts.find((p) => String(p.id) === String(promptId));
    const detail = await scoped.dashboard.answers(projectId, BigInt(promptId));
    return buildEvidencePack({
      question: prompt?.text ?? rec?.evidence?.question ?? item.title,
      brandName: world.brandName,
      brandDomains: [world.project.domain, ...(world.kit.identity?.domains ?? [])],
      snapshots: detail?.snapshots ?? [],
      competitors: rec?.evidence?.competitors ?? [],
    });
  }
  if (rec) {
    return buildCheckPack({
      ruleCode: rec.ruleCode,
      title: rec.title,
      evidence: rec.evidence,
      targetUrls: item.targetUrl ? [item.targetUrl, ...rec.affectedUrls] : rec.affectedUrls,
      brandName: world.brandName,
    });
  }
  return {
    question: item.title,
    brandName: world.brandName,
    engines: [],
    sources: [],
    competitors: [],
    answersRead: 0,
    answersThatNamedBrand: 0,
    ownPagesCited: [],
    format: { recommended: 'faq', basis: 'the way the question is asked', counts: {} },
  };
}

async function queueNext(ctx, name, data, item, round) {
  await ctx.jobs.add(
    name,
    { orgId: data.orgId, projectId: data.projectId, itemId: String(item.id) },
    { jobId: contentJobId(name.split('.')[1], item.id, round) },
  );
}

// ---------------------------------------------------------------------------------------------------------------
// research

async function contentResearch(ctx, data, job) {
  return runStage(ctx, data, job, 'researching', async ({ scoped, projectId, spent }) => {
    const deps = configured(ctx);
    const item = await scoped.content.forPipeline(projectId, data.itemId);
    if (!item) throw new UnrecoverableError(`Content item ${data.itemId} was not found`);
    if (item.status !== 'researching') return { skipped: item.status, repeated: true };
    const world = await worldOf(ctx, scoped, projectId);
    const pack = await packFor(scoped, projectId, item, world);

    let request = buildResearchRequest({ profile: deps.profile, pack, knownPages: packUrls(pack) });
    const messages = [];
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn += 1) {
      const { value: message } = await ctx.callProvider(
        job,
        {
          orgId: data.orgId,
          projectId: data.projectId,
          provider: 'anthropic',
          scope: 'content',
          idempotencyKey: ledgerKey('content', job, `research${job.attemptsMade}-${turn}`),
        },
        async () => {
          const reply = await deps.claude.extract(request);
          const searches = reply.usage?.server_tool_use?.web_search_requests ?? 0;
          spent.usd += dollars(deps.profile, reply.usage ?? {}, searches);
          return {
            value: reply,
            usage: usageOf(deps.profile, reply.usage ?? {}, { itemId: item.id, searches }),
          };
        },
      );
      messages.push(message);
      if (message.stop_reason !== 'pause_turn') break;
      request = continueResearch(request, message);
    }

    const read = readResearchReply(messages);
    let facts = [];
    let warning = null;
    let meta = { searches: 0, fetches: 0, dropped: 0 };
    if (read.ok) {
      facts = read.facts;
      meta = { searches: read.searches, fetches: read.fetches, dropped: read.dropped.length };
      if (!facts.some((f) => f.verified))
        warning =
          'None of the facts we found could be checked against its page, so the draft uses only your Brand Kit.';
    } else if (read.reason === 'no_facts') {
      warning = 'We found no sources we could check, so the draft uses only your Brand Kit.';
    } else {
      throw unusableReply('the research', read);
    }
    const saved = await scoped.content.saveResearch(projectId, item.id, {
      research: {
        version: RESEARCH_VERSION,
        at: ctx.now().toISOString(),
        pack,
        facts,
        warning,
        ...meta,
      },
      costUsd: spent.usd,
    });
    if (!saved.skipped) await queueNext(ctx, 'content.brief', data, item, slotOf(ctx.now()));
    return {
      itemId: data.itemId,
      facts: facts.length,
      verified: facts.filter((f) => f.verified).length,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// brief

async function contentBrief(ctx, data, job) {
  return runStage(ctx, data, job, 'briefing', async ({ scoped, projectId, spent }) => {
    const deps = configured(ctx);
    const item = await scoped.content.forPipeline(projectId, data.itemId);
    if (!item) throw new UnrecoverableError(`Content item ${data.itemId} was not found`);
    if (item.status !== 'briefing') return { skipped: item.status, repeated: true };
    const world = await worldOf(ctx, scoped, projectId);
    const registry = buildRegistry({ kit: world.kit, research: item.research?.facts ?? [] });
    const facts = usableFacts(registry);
    const { value: message } = await ctx.callProvider(
      job,
      {
        orgId: data.orgId,
        projectId: data.projectId,
        provider: 'anthropic',
        scope: 'content',
        idempotencyKey: ledgerKey('content', job, `brief${job.attemptsMade}`),
      },
      async () => {
        const reply = await deps.claude.extract(
          buildBriefRequest({
            profile: deps.profile,
            pack: item.research?.pack ?? {
              brandName: world.brandName,
              format: { recommended: 'faq' },
              engines: [],
              sources: [],
              competitors: [],
            },
            facts,
            internalUrls: world.internalUrls,
            voice: world.kit.voice ?? {},
            kind: item.kind,
          }),
        );
        spent.usd += dollars(deps.profile, reply.usage ?? {});
        return {
          value: reply,
          usage: usageOf(deps.profile, reply.usage ?? {}, { itemId: item.id }),
        };
      },
    );
    const read = readBriefReply(message, {
      factIds: facts.map((f) => f.id),
      internalUrls: world.internalUrls,
    });
    if (!read.ok) throw unusableReply('the plan', read);
    const saved = await scoped.content.saveBrief(projectId, item.id, {
      brief: { ...read.brief, version: BRIEF_VERSION },
      costUsd: spent.usd,
    });
    if (!saved.skipped) await queueNext(ctx, 'content.draft', data, item, 1);
    return { itemId: data.itemId, sections: read.brief.outline.length };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// draft

async function contentDraft(ctx, data, job) {
  return runStage(ctx, data, job, 'drafting', async ({ scoped, projectId, spent }) => {
    const deps = configured(ctx);
    const item = await scoped.content.forPipeline(projectId, data.itemId);
    if (!item) throw new UnrecoverableError(`Content item ${data.itemId} was not found`);
    if (item.status !== 'drafting') return { skipped: item.status, repeated: true };
    if (!item.brief) throw new UnrecoverableError('The item has no plan to write from');
    const world = await worldOf(ctx, scoped, projectId);
    const registry = buildRegistry({ kit: world.kit, research: item.research?.facts ?? [] });
    const facts = usableFacts(registry);

    // The text so far, for the customer's screen: replaced every little while, gone when the stage ends.
    const key = liveKey(ctx.prefix, item.id);
    let lastWrite = 0;
    const onText = (_piece, soFar) => {
      const at = Date.now();
      if (at - lastWrite < 600) return;
      lastWrite = at;
      ctx.redis
        .set(key, JSON.stringify({ at, text: soFar.slice(-80_000) }), 'EX', 900)
        .catch(() => {});
    };
    await ctx.redis
      .set(key, JSON.stringify({ at: Date.now(), text: '' }), 'EX', 900)
      .catch(() => {});
    try {
      const { value: message } = await ctx.callProvider(
        job,
        {
          orgId: data.orgId,
          projectId: data.projectId,
          provider: 'anthropic',
          scope: 'content',
          idempotencyKey: ledgerKey('content', job, `draft${job.attemptsMade}`),
        },
        async () => {
          const reply = await deps.claude.stream(
            buildDraftRequest({
              profile: deps.profile,
              brief: item.brief,
              facts,
              brandName: world.brandName,
              voice: world.kit.voice ?? {},
              internalUrls: world.internalUrls,
              existingText: item.kind === 'refresh' ? (item.research?.existingText ?? '') : '',
            }),
            { onText },
          );
          spent.usd += dollars(deps.profile, reply.usage ?? {});
          return {
            value: reply,
            usage: usageOf(deps.profile, reply.usage ?? {}, { itemId: item.id }),
          };
        },
      );
      const allowedLinks = [
        ...sourceList(registry).map((s) => s.url),
        ...(item.brief.internalLinks ?? []).map((l) => l.url),
        ...world.internalUrls,
      ];
      const read = readDraftReply(message, { allowedLinks });
      if (!read.ok) throw unusableReply('the draft', read);
      const saved = await scoped.content.saveDraft(projectId, item.id, {
        html: read.html,
        costUsd: spent.usd,
        now: ctx.now(),
      });
      if (!saved.skipped) await queueNext(ctx, 'content.qc', data, item, saved.revision);
      return { itemId: data.itemId, revision: saved.revision, words: read.words };
    } finally {
      await ctx.redis.del(key).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// qc

/** The text of the site's own pages, for the "is this a copy of something we already have" check. */
async function existingPagesOf(ctx, scoped, projectId, item) {
  const store = ctx.crawler?.store;
  if (!store) return [];
  const [scan] = await scoped.scans.recent({ projectId, limit: 1 });
  if (!scan) return [];
  const pages = await scoped.scans.pages(scan.id);
  const out = [];
  for (const page of pages.slice(0, 20)) {
    const url = page.final_url ?? page.url;
    if (!page.raw_uri || (item.targetUrl && url === item.targetUrl)) continue;
    try {
      const stored = await store.get(page.raw_uri);
      if (!stored) continue;
      out.push({
        url,
        text: analyzeBody(sanitizeBody(stored.body.toString('utf8').slice(0, 400_000)).html).text,
      });
    } catch {
      // A page we cannot read is a page we cannot compare with.
    }
  }
  return out;
}

async function contentQc(ctx, data, job) {
  return runStage(ctx, data, job, 'qc', async ({ scoped, projectId }) => {
    const item = await scoped.content.forPipeline(projectId, data.itemId);
    if (!item) throw new UnrecoverableError(`Content item ${data.itemId} was not found`);
    if (item.status !== 'qc') return { skipped: item.status, repeated: true };
    if (!item.bodyHtml || !item.currentRevisionId)
      throw new UnrecoverableError('The item has no text to check');
    const world = await worldOf(ctx, scoped, projectId);
    const registry = buildRegistry({ kit: world.kit, research: item.research?.facts ?? [] });
    const persona = world.kit.voice?.personas?.[0] ?? null;
    const built = buildJsonLd({
      schemaType: item.brief?.schemaType ?? 'Article',
      title: item.title,
      metaDescription: item.brief?.metaDescription ?? '',
      bodyHtml: item.bodyHtml,
      brand: { name: world.brandName, domain: world.project.domain },
      author: persona?.name ? { name: persona.name } : null,
      modifiedAt: ctx.now(),
      publishedAt: item.publishedAt,
      url: item.publishedUrl,
    });
    const qc = scoreDraft({
      bodyHtml: item.bodyHtml,
      jsonld: built.jsonld,
      voice: world.kit.voice ?? {},
      facts: factTexts(registry),
      sources: sourceList(registry),
      existingPages: await existingPagesOf(ctx, scoped, projectId, item),
    });
    // A page written to win citations is also asked what makes a page easy to cite. Advisory: it is not in the score.
    const rec = item.recommendationId
      ? await scoped.recommendations.load(item.recommendationId)
      : null;
    const citable = String(rec?.ruleCode ?? '').startsWith('citation.')
      ? citableChecks({
          bodyHtml: item.bodyHtml,
          jsonld: built.jsonld,
          facts: factTexts(registry),
          ownDomain: world.project.domain,
        })
      : undefined;
    const saved = await scoped.content.saveQc(projectId, item.id, {
      revisionId: item.currentRevisionId,
      qc: { ...qc, schemaNote: built.downgraded, ...(citable ? { citable } : {}) },
      jsonld: built.jsonld,
    });
    return {
      itemId: data.itemId,
      score: qc.score,
      ready: qc.ready,
      ...(saved.skipped ? { skipped: true } : {}),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// WordPress

export function wordpressFor(ctx, orgId, projectId, integration) {
  if (!ctx.content?.secrets)
    throw new UnrecoverableError('Secrets are not configured on this worker (SECRETS_MASTER_KEY)');
  if (!ctx.crawler?.fetcher)
    throw new UnrecoverableError('The crawler is not configured on this worker');
  if (!integration?.secret)
    throw new WordPressError('no_credentials', 'WordPress is not connected.');
  const creds = ctx.content.secrets.decryptJson(
    integration.secret,
    `wordpress:${orgId}:${projectId}`,
  );
  return createWordPressClient({
    fetcher: ctx.crawler.fetcher,
    siteUrl: integration.config.siteUrl,
    username: integration.config.username,
    appPassword: creds.appPassword,
    hmacSecret: creds.hmacSecret ?? null,
  });
}

/** The recommendation behind a published item is done: baseline saved, and the live-page check starts. */
async function afterPublish(ctx, scoped, projectId, pub, post) {
  const recId = pub.item.recommendationId;
  if (!recId) return { recommendation: 'none' };
  const rec = await scoped.recommendations.load(recId);
  if (!rec || !['open', 'in_progress'].includes(rec.status))
    return { recommendation: 'left_alone', status: rec?.status ?? null };
  const userId = pub.item.approvedByUserId;
  if (rec.status === 'open')
    await scoped.recommendations.transition(projectId, recId, 'in_progress', {
      userId,
      now: ctx.now(),
    });
  const types = (pub.item.jsonld?.['@graph'] ?? []).map((n) => n['@type']).filter(Boolean);
  const done = await scoped.recommendations.markDone(projectId, recId, {
    userId,
    now: ctx.now(),
    verify: {
      method: 'url_live',
      targetUrl: post.link,
      expect: {
        headline: pub.item.title,
        types: pub.integration.config.pluginConnected ? [...new Set(types)].slice(0, 1) : [],
      },
    },
  });
  if (done.verifiable) {
    await ctx.jobs.add(
      'fix.verify',
      { orgId: String(scoped.orgId), recommendationId: String(recId), attempt: 1 },
      { jobId: fixVerifyJobId(recId, 1) },
    );
  }
  return { recommendation: 'done', verifiable: done.verifiable };
}

async function contentPublish(ctx, data, job) {
  return runStage(ctx, data, job, 'publishing', async ({ scoped, projectId }) => {
    const orgId = BigInt(data.orgId);
    const pub = await scoped.content.forPublish(projectId, data.itemId);
    if (!pub) throw new UnrecoverableError(`Content item ${data.itemId} was not found`);
    if (pub.item.status !== 'publishing') return { skipped: pub.item.status, repeated: true };
    if (!pub.siteChange || String(pub.siteChange.id) !== data.siteChangeId)
      return { skipped: 'other_change', repeated: true };
    if (!pub.bodyHtml || !pub.item.jsonld)
      throw new UnrecoverableError('The approved item has no text or structured data');
    // Structured data is validated before it is saved and again before it leaves.
    const valid = validateJsonLd(pub.item.jsonld);
    if (!valid.ok)
      throw new WordPressError(
        'invalid_jsonld',
        'The structured data did not pass its check, so nothing was sent. Edit the draft and approve it again.',
      );

    const mode = pub.siteChange.payload?.mode === 'draft' ? 'draft' : 'publish';
    const client = wordpressFor(ctx, orgId, projectId, pub.integration);
    const pluginConnected = Boolean(pub.integration.config.pluginConnected);
    await scoped.content.markApplying(projectId, pub.siteChange.id);

    // Without the plugin the structured data travels inside the post (WordPress may strip it for some users: the
    // live-page check after publishing says so if it did).
    const content = pluginConnected
      ? pub.bodyHtml
      : `${pub.bodyHtml}\n${scriptTag(pub.item.jsonld)}`;
    const fields = {
      title: pub.item.title,
      content,
      status: mode === 'publish' ? 'publish' : 'draft',
      excerpt: pub.item.brief?.metaDescription ?? '',
    };
    let post;
    try {
      // A refresh replaces a page that already exists: find it by its address (the plugin knows) and update it in place.
      let target = null;
      if (pub.item.kind === 'refresh') {
        // Resolved every time, not only the first: a retry must know whether the address is a post or a page.
        if (pluginConnected && pub.item.targetUrl) {
          const found = await client.plugin.resolve(pub.item.targetUrl);
          if (found.found) target = { id: found.id, type: found.type };
          else if (!pub.item.cmsRef) {
            throw new WordPressError(
              'refresh_target_not_found',
              'We could not find that page on your WordPress site, so nothing was changed. Check the address, or publish this as a new page.',
            );
          }
        } else if (!pub.item.cmsRef) {
          throw new WordPressError(
            'refresh_needs_plugin',
            'To update an existing page we need the AEO Corner plugin, which finds the page from its address. Connect the plugin, or publish this as a new page.',
          );
        }
      }
      if (pub.item.cmsRef || target) {
        post = await client.updatePost(target?.id ?? pub.item.cmsRef, fields, {
          type: target?.type ?? 'post',
        });
        if (target && String(target.id) !== String(pub.item.cmsRef)) {
          await scoped.content.rememberPost(projectId, pub.item.id, {
            cmsRef: post.id,
            url: post.link,
          });
        }
      } else {
        post = await client.createPost(fields);
        await scoped.content.rememberPost(projectId, pub.item.id, {
          cmsRef: post.id,
          url: post.link,
        });
      }
    } catch (err) {
      if (err instanceof WordPressError && ['auth_failed', 'forbidden'].includes(err.code)) {
        await scoped.integrations.wordpressResult(projectId, {
          ok: false,
          error: err.message,
          now: ctx.now(),
        });
      }
      throw err;
    }

    const warnings = [];
    if (pluginConnected && mode === 'publish' && post.link) {
      try {
        await client.plugin.setSchema({ url: post.link, jsonld: pub.item.jsonld });
        await client.plugin.setMeta({
          url: post.link,
          title: pub.item.title,
          description: pub.item.brief?.metaDescription ?? null,
        });
        await client.plugin.indexNow([post.link]);
      } catch (err) {
        warnings.push(
          err instanceof WordPressError ? err.message : 'The plugin could not be reached.',
        );
      }
    }
    await scoped.integrations.wordpressResult(projectId, { ok: true, now: ctx.now() });
    const outcome = mode === 'publish' ? 'published' : 'drafted';
    const finished = await scoped.content.finishPublish(projectId, pub.item.id, {
      siteChangeId: pub.siteChange.id,
      outcome,
      cmsRef: post.id,
      url: post.link,
      now: ctx.now(),
    });
    let recommendation = { recommendation: 'not_live' };
    if (outcome === 'published' && !finished.skipped)
      recommendation = await afterPublish(ctx, scoped, projectId, pub, post);
    return { itemId: data.itemId, outcome, url: post.link, warnings, ...recommendation };
  });
}

async function wordpressTest(ctx, data) {
  const orgId = BigInt(data.orgId);
  const projectId = BigInt(data.projectId);
  const scoped = ctx.db.forOrg(orgId);
  const stored = await scoped.integrations.wordpressSecret(projectId);
  if (!stored) return { skipped: 'not_connected' };
  try {
    const client = wordpressFor(ctx, orgId, projectId, {
      config: stored.config,
      secret: stored.secret,
    });
    const site = await client.probe();
    const me = await client.whoAmI();
    let plugin = null;
    if (site.pluginInstalled && stored.config.pluginConnected) {
      plugin = await client.plugin.status().catch(() => null);
    }
    // The plugin was installed after the site was connected (or was reset on the site): hand it a new secret now, the
    // same handshake the connect screen does. The new secret is saved encrypted, beside the login we already hold.
    let handshake = false;
    if (site.pluginInstalled && !plugin && me.canManage) {
      const context = `wordpress:${orgId}:${projectId}`;
      const creds = ctx.content.secrets.decryptJson(stored.secret, context);
      const hmacSecret = randomBytes(32).toString('hex');
      plugin = await client.plugin.connect({
        secret: hmacSecret,
        indexNowKey: randomBytes(16).toString('hex'),
      });
      await scoped.integrations.saveWordpress(projectId, {
        config: { ...stored.config, pluginConnected: true },
        secret: ctx.content.secrets.encrypt({ ...creds, hmacSecret }, context),
        now: ctx.now(),
      });
      handshake = true;
    }
    const problems = [];
    if (!me.canEdit) problems.push('That WordPress user cannot create posts.');
    await scoped.integrations.wordpressResult(projectId, {
      ok: problems.length === 0,
      error: problems[0],
      config: {
        siteName: site.name,
        canPublish: me.canPublish,
        pluginInstalled: site.pluginInstalled,
        pluginConnected: Boolean(plugin),
        pluginVersion: plugin?.pluginVersion ?? null,
        seoPlugin: plugin?.seoPlugin ?? null,
        checkedAt: ctx.now().toISOString(),
      },
      now: ctx.now(),
    });
    return {
      ok: problems.length === 0,
      pluginInstalled: site.pluginInstalled,
      canPublish: me.canPublish,
      pluginConnected: Boolean(plugin),
      handshake,
    };
  } catch (err) {
    if (err instanceof WordPressError) {
      await scoped.integrations.wordpressResult(projectId, {
        ok: false,
        error: err.message,
        now: ctx.now(),
      });
      return { ok: false, code: err.code };
    }
    throw err;
  }
}

export const contentHandlers = {
  'content.research': contentResearch,
  'content.brief': contentBrief,
  'content.draft': contentDraft,
  'content.qc': contentQc,
  'content.publish': contentPublish,
  'wordpress.test': wordpressTest,
};
