import { AI_CRAWLERS } from './ai-crawlers.js';
import { evaluateRobots } from '../crawler/robots.js';

/**
 * What a robots.txt says to each AI crawler, as findings for the free checker (Milestone 17, task 17.06). Pure: it takes
 * what `fetchRobots` read and returns the findings shape of `tool-findings.js`. The file's three states stay apart:
 *
 *   ok       a real file: each crawler is judged by the group that names it, else by `*`
 *   missing  no file (404, or a web page where it should be): nothing is off limits, which is not a fault
 *   (unreachable is not here: the tool says "couldn't check" and never calls this)
 *
 * The home page path (`/`) decides allowed or blocked, as in readiness check A1; Disallow lines for other paths are
 * listed as "some pages", never guessed at. A training crawler is a choice, so blocking one is never drawn as a fault.
 */

const SECTIONS = [
  {
    guidance: 'allow',
    heading: 'Answer and search crawlers',
    note: 'These fetch pages so an AI engine can answer a question or show a result. Blocking one can keep you out of that engine’s answers.',
  },
  {
    guidance: 'business_choice',
    heading: 'Training crawlers (your choice)',
    note: 'These collect pages to train models. Allowing or blocking them is a business decision, and neither is a fault.',
  },
  {
    guidance: 'case_by_case',
    heading: 'Other AI crawlers',
    note: 'These do various things, so there is no single right answer.',
  },
];

const groupsFor = (parsed, agent) => {
  const token = agent.toLowerCase();
  const own = parsed.groups.filter((g) => g.agents.includes(token));
  return own.length ? own : parsed.groups.filter((g) => g.agents.includes('*'));
};

/** The Disallow patterns that apply to this crawler (the group that names it, else `*`), without the empty ones. */
export function disallowedPatterns(parsed, agent) {
  const seen = new Set();
  for (const group of groupsFor(parsed, agent)) {
    for (const rule of group.rules) {
      if (!rule.allow && rule.pattern.startsWith('/')) seen.add(rule.pattern);
    }
  }
  return [...seen];
}

/** One crawler's verdict on the whole site: `{ verdict: 'allowed' | 'blocked', rule, group, partial }`. */
export function judgeCrawler(parsed, agent) {
  if (!parsed) return { verdict: 'allowed', rule: null, group: null, partial: [] };
  const home = evaluateRobots(parsed, agent, '/');
  const partial = home.allowed ? disallowedPatterns(parsed, agent).filter((p) => p !== '/') : [];
  return {
    verdict: home.allowed ? 'allowed' : 'blocked',
    rule: home.rule,
    group: home.matchedAgent,
    partial,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {{ status: 'ok' | 'missing', parsed: object | null, httpStatus: number | null }} robots
 * @returns the findings (not yet through `normalizeFindings`)
 */
export function robotsFindings(robots) {
  const parsed = robots.status === 'ok' ? robots.parsed : null;
  const judged = AI_CRAWLERS.map((c) => ({ ...c, ...judgeCrawler(parsed, c.agent) }));

  const answer = judged.filter((c) => c.guidance === 'allow');
  const blockedAnswer = answer.filter((c) => c.verdict === 'blocked');
  const partlyAnswer = answer.filter((c) => c.verdict === 'allowed' && c.partial.length);

  let headline;
  if (!parsed) {
    headline = `There is no robots.txt, so every AI crawler is allowed`;
  } else if (blockedAnswer.length === answer.length) {
    headline = `robots.txt blocks all ${answer.length} answer and search crawlers from your site`;
  } else if (blockedAnswer.length) {
    headline = `robots.txt blocks ${blockedAnswer.length} of ${answer.length} answer and search crawlers: ${blockedAnswer
      .map((c) => c.agent)
      .join(', ')}`;
  } else {
    headline = `All ${answer.length} answer and search crawlers are allowed`;
  }

  const sections = [
    {
      heading: 'Your robots.txt',
      rows: [
        parsed
          ? {
              label: 'robots.txt',
              state: 'good',
              value: 'Found',
              detail: `${plural(parsed.groups.length, 'group')} of rules${robots.httpStatus ? ` (HTTP ${robots.httpStatus})` : ''}.`,
            }
          : {
              label: 'robots.txt',
              state: 'neutral',
              value: 'None',
              detail:
                'A site with no robots.txt is not doing anything wrong: crawlers read that as “everything is allowed”.',
            },
        {
          label: 'Sitemap lines',
          state: 'neutral',
          value: parsed ? String(parsed.sitemaps.length) : '0',
          detail: parsed?.sitemaps.length
            ? 'robots.txt tells crawlers where your sitemap is.'
            : 'robots.txt does not point to a sitemap. That is optional, but it helps crawlers find your pages.',
        },
      ],
    },
  ];

  for (const s of SECTIONS) {
    const rows = judged
      .filter((c) => c.guidance === s.guidance)
      .map((c) => {
        const purpose = `${c.vendor}: ${c.purpose}.`;
        const named = c.group && c.group !== '*' ? ' It is named in your file.' : '';
        if (c.verdict === 'blocked') {
          return {
            label: c.agent,
            state: s.guidance === 'allow' ? 'bad' : 'neutral',
            value: 'Blocked',
            detail: `${purpose} Blocked by “${c.rule}”${c.group === '*' ? ' in the rules for every crawler' : ''}.`,
          };
        }
        const some = c.partial.length
          ? ` Some pages are off limits (${c.partial.slice(0, 3).join(', ')}${c.partial.length > 3 ? ` and ${c.partial.length - 3} more` : ''}).`
          : '';
        return {
          label: c.agent,
          state: s.guidance === 'allow' ? (c.partial.length ? 'warn' : 'good') : 'neutral',
          value: 'Allowed',
          detail: `${purpose}${parsed ? named : ''}${some}`.trim(),
        };
      });
    sections.push({ heading: s.heading, note: s.note, rows });
  }

  // The lines that decided the blocks, so the visitor can find them in their own file.
  const deciding = [
    ...new Set(
      judged
        .filter((c) => c.verdict === 'blocked')
        .map((c) => `User-agent: ${c.group === '*' ? '*' : c.agent}  →  ${c.rule}`),
    ),
  ];

  const notes = [
    'We tested the home page address (/). Rules for other parts of your site are listed as “some pages” and not tested one by one.',
    'Allowed in robots.txt does not mean a firewall lets the crawler in. The free audit tests that as well.',
    'robots.txt is a request that well-behaved crawlers follow. It is not a lock.',
  ];
  if (partlyAnswer.length) notes.unshift('Some answer crawlers can read only part of your site.');

  return {
    headline,
    sections,
    ...(deciding.length
      ? { lines: { heading: 'The rules that block a crawler', items: deciding } }
      : {}),
    notes,
  };
}
