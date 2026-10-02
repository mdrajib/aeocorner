import { ANSWER_BOTS, TRAINING_BOTS } from '../../core/ai-crawlers.js';
import { evaluateRobots, namesAgent } from '../robots.js';
import { pathOf, plural } from './helpers.js';

/**
 * A. AI crawler access (20 points). Can the engines' crawlers reach the site at all? If not, nothing else matters.
 *
 * robots.txt is judged from `ctx.robots`: `status` is 'ok' (a real file), 'missing' (404 or a web page served
 * in its place: nothing is blocked) or 'unreachable' (the server failed: crawlers must assume the worst, and we
 * can't say what the file says).
 */

const KEY_PATH_LIMIT = 20;

/** A1 (8): answer and search crawlers are allowed. */
export function a1(ctx) {
  if (ctx.robots.status === 'unreachable') {
    return {
      status: 'error',
      summary: 'robots.txt could not be fetched (the server failed), so crawler access is unknown.',
      evidence: { robotsStatus: ctx.robots.httpStatus ?? null },
    };
  }
  if (ctx.robots.status === 'missing') {
    return {
      score: 1,
      summary:
        'There is no robots.txt, so nothing is blocked: every answer and search crawler may read the site.',
      evidence: {
        robotsFile: false,
        bots: ANSWER_BOTS.map((agent) => ({ agent, verdict: 'allowed' })),
      },
    };
  }

  // The home page and the key pages we selected are the paths that matter.
  const paths = [
    '/',
    ...ctx.pages
      .filter((p) => p.isKey && p.pageType !== 'home')
      .map((p) => pathOf(p.url))
      .slice(0, KEY_PATH_LIMIT),
  ];
  const bots = ANSWER_BOTS.map((agent) => {
    const verdicts = paths.map((path) => ({
      path,
      ...evaluateRobots(ctx.robots.parsed, agent, path),
    }));
    const blockedPaths = verdicts.filter((v) => !v.allowed).map((v) => v.path);
    const verdict =
      blockedPaths.length === 0
        ? 'allowed'
        : blockedPaths.length === verdicts.length
          ? 'blocked'
          : 'partly';
    const deciding = verdicts.find((v) => !v.allowed) ?? verdicts[0];
    return {
      agent,
      verdict,
      blockedPaths: blockedPaths.slice(0, 5),
      rule: deciding.rule,
      groupAgent: deciding.matchedAgent,
    };
  });
  const score =
    bots.reduce(
      (sum, b) => sum + (b.verdict === 'allowed' ? 1 : b.verdict === 'partly' ? 0.5 : 0),
      0,
    ) / bots.length;
  const blocked = bots.filter((b) => b.verdict === 'blocked').map((b) => b.agent);
  const partly = bots.filter((b) => b.verdict === 'partly').map((b) => b.agent);

  let summary = `All ${bots.length} answer and search crawlers may read the site.`;
  if (blocked.length) summary = `robots.txt blocks ${blocked.join(', ')} from the whole site.`;
  if (partly.length) summary += ` ${partly.join(', ')} can read only part of it.`;
  return {
    score,
    summary,
    evidence: { robotsFile: true, robotsKey: ctx.robots.key ?? null, bots },
  };
}

/** A2 (2): the site states a policy on training crawlers. Informational: whether to allow them is a business choice. */
export function a2(ctx) {
  if (ctx.robots.status === 'unreachable') {
    return {
      status: 'error',
      summary: 'robots.txt could not be fetched, so the training-crawler policy is unknown.',
      evidence: { robotsStatus: ctx.robots.httpStatus ?? null },
    };
  }
  if (ctx.robots.status === 'missing') {
    return {
      score: 0,
      summary:
        'There is no robots.txt, so no policy on AI training crawlers is stated. Their default is to crawl.',
      evidence: { informational: true, robotsFile: false },
    };
  }
  const bots = TRAINING_BOTS.map((agent) => ({
    agent,
    named: namesAgent(ctx.robots.parsed, agent),
    allowed: evaluateRobots(ctx.robots.parsed, agent, '/').allowed,
  }));
  const named = bots.filter((b) => b.named);
  const allowedCount = bots.filter((b) => b.allowed).length;
  const posture = `${allowedCount} of ${bots.length} training crawlers allowed`;
  return {
    score: named.length ? 1 : 0.5,
    summary: named.length
      ? `robots.txt states a policy for ${named.map((b) => b.agent).join(', ')} (${posture}).`
      : `robots.txt does not mention any training crawler by name, so the general rules apply (${posture}).`,
    evidence: { informational: true, robotsFile: true, robotsKey: ctx.robots.key ?? null, bots },
  };
}

/** A3 (6): a firewall or CDN doesn't turn AI crawlers away. Uses the probes the pipeline sent. */
export function a3(ctx) {
  const probes = ctx.botProbes;
  if (!probes) {
    return {
      status: 'error',
      summary: 'The AI crawler look-alike requests were not sent, so firewall blocking is unknown.',
      evidence: { reason: 'not_probed' },
    };
  }
  const usable = probes.bots.filter((b) => b.blocked !== null);
  if (usable.length === 0) {
    return {
      status: 'error',
      summary: 'None of the test requests got an answer, so firewall blocking is unknown.',
      evidence: { reason: 'no_answers', probes },
    };
  }
  const blocked = usable.filter((b) => b.blocked);
  const caveat =
    'This sends requests that look like each crawler. Some firewalls admit the real crawler by its network address ' +
    'and still turn away a look-alike, so a block here is a strong hint, not proof.';
  const evidence = { control: probes.control, bots: probes.bots, caveat };

  if (blocked.length === 0) {
    return {
      score: 1,
      summary: `No firewall or challenge page turned away any of ${plural(usable.length, 'AI crawler identity', 'AI crawler identities')}.`,
      evidence,
    };
  }
  const vendors = [...new Set(blocked.map((b) => b.vendor).filter(Boolean))];
  const by = vendors.length ? ` (${vendors.join(', ')})` : '';
  if (probes.control?.blocked) {
    return {
      score: 0,
      summary: `The site turns away automated requests of every kind${by}, including our own crawler.`,
      evidence: { ...evidence, scope: 'all_automated' },
    };
  }
  return {
    score: 1 - blocked.length / usable.length,
    summary: `A firewall${by} turned away ${blocked.map((b) => b.agent).join(', ')} while a normal request got through.`,
    evidence: { ...evidence, scope: 'ai_crawlers' },
  };
}

/** A4 (4): an XML sitemap exists and robots.txt points to it. */
export function a4(ctx) {
  const { found, referenced } = ctx.sitemaps;
  const robotsKnown = ctx.robots.status !== 'unreachable';
  if (ctx.sitemaps.blocked && found.length === 0) {
    return {
      status: 'error',
      summary:
        'A firewall turned our crawler away from the sitemap, so its existence could not be checked.',
      evidence: { blockedByFirewall: true },
    };
  }
  if (!robotsKnown && found.length === 0) {
    return {
      status: 'error',
      summary: 'robots.txt could not be fetched and no sitemap was found at the usual addresses.',
      evidence: { robotsStatus: ctx.robots.httpStatus ?? null },
    };
  }
  const evidence = {
    found: found.map((s) => ({ url: s.url, kind: s.kind, urls: s.urlCount, key: s.key ?? null })),
    referencedInRobots: referenced,
  };
  if (found.length && referenced.length) {
    return {
      score: 1,
      summary: `A sitemap exists (${found[0].url}) and robots.txt points to it.`,
      evidence,
    };
  }
  if (found.length) {
    return {
      score: 0.5,
      summary: `A sitemap exists (${found[0].url}) but robots.txt does not point to it. Add a "Sitemap:" line.`,
      evidence,
    };
  }
  if (referenced.length) {
    return {
      score: 0.25,
      summary:
        'robots.txt points to a sitemap, but it could not be read or is not a valid sitemap.',
      evidence,
    };
  }
  return {
    score: 0,
    summary: 'No sitemap was found, and robots.txt does not point to one.',
    evidence,
  };
}
