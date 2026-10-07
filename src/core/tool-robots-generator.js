import { AI_CRAWLERS } from './ai-crawlers.js';

/**
 * The free robots.txt generator (Milestone 17, task 17.09). Pure: from the visitor's choices to the text of a robots.txt
 * and the findings that explain it. It writes only what was chosen.
 *
 * The crawlers come from `AI_CRAWLERS`, in three groups the visitor decides on:
 *   answer    fetch pages so an AI engine can answer a question (OpenAI, Anthropic and Perplexity's search and user bots)
 *   training  collect pages to train models (a business choice)
 *   other     various
 * Googlebot, Bingbot and Applebot are search engines first, and this generator never offers to block them: a visitor who
 * blocks "AI answer crawlers" must not find themselves out of ordinary search. A test fails if a crawler is added to the
 * list without being placed in a group.
 *
 * How the file is built: the rules for every crawler (`User-agent: *`) carry the paths the visitor wants kept out; a crawler
 * that is allowed has no group of its own, so it follows those rules; a crawler that is blocked gets `Disallow: /`. A
 * crawler with its own group ignores the `*` group, which is why an allowed crawler never gets one.
 */

export const SEARCH_ENGINES = Object.freeze(['Googlebot', 'Bingbot', 'Applebot']);

const agentsWhere = (guidance) =>
  AI_CRAWLERS.filter((c) => c.guidance === guidance && !SEARCH_ENGINES.includes(c.agent)).map(
    (c) => c.agent,
  );

export const CRAWLER_GROUPS = Object.freeze([
  {
    key: 'answer',
    label: 'AI answer crawlers',
    agents: Object.freeze(agentsWhere('allow')),
    blockWarning:
      'These fetch pages so an AI engine can answer a question. Blocking them can keep your pages out of those answers.',
  },
  {
    key: 'training',
    label: 'AI training crawlers',
    agents: Object.freeze(agentsWhere('business_choice')),
    blockWarning: null,
  },
  {
    key: 'other',
    label: 'Other AI crawlers',
    agents: Object.freeze(agentsWhere('case_by_case')),
    blockWarning: null,
  },
]);

export const MAX_DISALLOW_PATHS = 30;
const MAX_PATH_CHARS = 200;

/** The paths one per line: `{ paths }`, or `{ error }` naming the first line that cannot be used. */
export function parseDisallowPaths(text) {
  const paths = [];
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line === '/')
      return {
        error: `Line ${i + 1}: a path of just / would keep every crawler out of your whole site, search engines included. Block single crawlers above instead.`,
      };
    if (!/^\/[^\s#]*$/.test(line) || line.length > MAX_PATH_CHARS)
      return {
        error: `Line ${i + 1}: start each path with / and use no spaces, such as /admin/ (at most ${MAX_PATH_CHARS} characters).`,
      };
    if (!paths.includes(line)) paths.push(line);
    if (paths.length > MAX_DISALLOW_PATHS)
      return {
        error: `Use at most ${MAX_DISALLOW_PATHS} paths. Shorter patterns such as /private* cover more.`,
      };
  }
  return { paths };
}

/**
 * @param {{ answer: 'allow'|'block', training: 'allow'|'block', other: 'allow'|'block', sitemap?: string|null, paths?: string[] }} choices
 * @returns {{ text: string, blocked: string[], allowed: string[] }}  the crawlers (of the three groups) by the file's verdict
 */
export function generateRobots({ answer, training, other, sitemap = null, paths = [] }) {
  const choice = { answer, training, other };
  const lines = [
    '# robots.txt, made with the free robots.txt generator from AEO Corner.',
    '# Save it as robots.txt at the top level of your website.',
    '',
    'User-agent: *',
    ...(paths.length ? paths.map((p) => `Disallow: ${p}`) : ['Allow: /']),
  ];
  const blocked = [];
  const allowed = [];
  for (const group of CRAWLER_GROUPS) {
    if (choice[group.key] === 'block') {
      lines.push(
        '',
        `# ${group.label}: blocked`,
        ...group.agents.map((a) => `User-agent: ${a}`),
        'Disallow: /',
      );
      blocked.push(...group.agents);
    } else {
      allowed.push(...group.agents);
    }
  }
  if (sitemap) lines.push('', `Sitemap: ${sitemap}`);
  return { text: `${lines.join('\n')}\n`, blocked, allowed };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortList = (agents) =>
  agents.length > 6
    ? `${agents.slice(0, 6).join(', ')} and ${agents.length - 6} more`
    : agents.join(', ');

/** The findings page for a generated file (not yet through `normalizeFindings`). */
export function robotsGeneratorFindings({ choices, paths = [], sitemap = null, text, blocked }) {
  const blockedGroups = CRAWLER_GROUPS.filter((g) => choices[g.key] === 'block');
  const headline = blockedGroups.length
    ? `Your robots.txt blocks ${plural(blocked.length, 'AI crawler')} and allows everything else`
    : paths.length
      ? 'Your robots.txt allows every crawler, and keeps them out of the paths you listed'
      : 'Your robots.txt allows every crawler';

  const rows = CRAWLER_GROUPS.map((g) => {
    const blockIt = choices[g.key] === 'block';
    return {
      label: g.label,
      state: blockIt ? (g.blockWarning ? 'warn' : 'neutral') : 'good',
      value: blockIt ? 'Blocked' : 'Allowed',
      detail: `${shortList(g.agents)}.${blockIt && g.blockWarning ? ` ${g.blockWarning}` : ''}`,
    };
  });
  rows.push({
    label: 'Search engines',
    state: 'good',
    value: 'Allowed',
    detail: `${SEARCH_ENGINES.join(', ')}. This file never blocks them, so you stay in ordinary search.`,
  });
  rows.push({
    label: 'Paths kept out for everyone',
    state: 'neutral',
    value: String(paths.length),
    detail: paths.length ? shortList(paths) : 'None.',
  });
  rows.push({
    label: 'Sitemap line',
    state: 'neutral',
    value: sitemap ? 'Added' : 'None',
    detail: sitemap ?? 'You did not enter a sitemap address.',
  });

  return {
    headline,
    sections: [{ heading: 'What your file does', rows }],
    output: { filename: 'robots.txt', text },
    notes: [
      'Save the text as robots.txt at the top level of your site, so it opens at yourcompany.com/robots.txt.',
      'This replaces your whole file, so compare it with the one you have first and keep any rules you still need.',
      'robots.txt is a request that well-behaved crawlers follow. It is not a lock, and it cannot make an AI engine mention you.',
      'Check the result with our robots.txt checker once it is on your site.',
    ],
  };
}
