/**
 * robots.txt, read the way RFC 9309 says crawlers must (and the way Google does where the RFC is silent).
 *
 * A file is a list of groups. A group starts with one or more `User-agent` lines and holds the `Allow` and
 * `Disallow` rules that follow. A crawler obeys the group that names it; only if none does, the `*` group.
 * Within a group the MOST SPECIFIC (longest) matching rule wins, and when an Allow and a Disallow match equally,
 * Allow wins. `*` inside a pattern matches any run of characters and a trailing `$` means "ends here".
 *
 * Used twice: to decide whether OUR crawler may fetch a page, and by the readiness checks to see which AI
 * crawlers the site lets in (MVP §6.6 A1/A2).
 */

/** Crawlers must read at least 500 KiB (RFC 9309 §2.5); anything past that is ignored. */
export const ROBOTS_MAX_BYTES = 500 * 1024;

/** @returns {{ groups: {agents: string[], rules: {allow: boolean, pattern: string}[], crawlDelay: number|null}[], sitemaps: string[] }} */
export function parseRobots(input) {
  const text = String(input)
    .replace(/^\uFEFF/, '')
    .slice(0, ROBOTS_MAX_BYTES);
  const groups = [];
  const sitemaps = [];
  let current = null;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group; a User-agent line after rules starts a new one.
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      // "GPTBot/1.1" and "GPTBot" are the same product token.
      current.agents.push(value.toLowerCase().split(/[\s/]/)[0]);
      collectingAgents = true;
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) continue; // rules before any User-agent line belong to nobody
      collectingAgents = false;
      current.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'crawl-delay') {
      if (!current) continue;
      collectingAgents = false;
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    } else if (field === 'sitemap') {
      if (/^https?:\/\//i.test(value)) sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

/** A robots pattern as a regular expression, anchored at the start of the path. */
function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*+/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Compile each rule's pattern the first time it is needed and keep it with the rule. */
const compiled = new WeakMap();
function matcherFor(rule) {
  let re = compiled.get(rule);
  if (!re) {
    re = patternToRegExp(rule.pattern);
    compiled.set(rule, re);
  }
  return re;
}

/**
 * May the crawler called `agent` fetch `path` (the URL path plus query, like `/pricing?plan=pro`)?
 * @returns {{ allowed: boolean, matchedAgent: string|null, rule: string|null }}
 *   `matchedAgent` is the group that applied ("*" if it fell back, null if the file has no group for us) and
 *   `rule` is the winning line, so a report can quote it.
 */
export function evaluateRobots(parsed, agent, path = '/') {
  const token = String(agent).toLowerCase().split(/[\s/]/)[0];
  let groups = parsed.groups.filter((g) => g.agents.includes(token));
  let matchedAgent = token;
  if (groups.length === 0) {
    groups = parsed.groups.filter((g) => g.agents.includes('*'));
    matchedAgent = '*';
  }
  if (groups.length === 0) return { allowed: true, matchedAgent: null, rule: null };

  let best = null;
  for (const rule of groups.flatMap((g) => g.rules)) {
    // An empty Disallow means "nothing is off limits"; a pattern must start at the root or with a wildcard.
    if (rule.pattern === '' || !/^[/*]/.test(rule.pattern)) continue;
    if (!matcherFor(rule).test(path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { ...rule, length };
    }
  }
  if (!best) return { allowed: true, matchedAgent, rule: null };
  return {
    allowed: best.allow,
    matchedAgent,
    rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}`,
  };
}

/** True if the file names this crawler itself (not just the `*` group): the site made a deliberate choice. */
export const namesAgent = (parsed, agent) =>
  parsed.groups.some((g) => g.agents.includes(String(agent).toLowerCase().split(/[\s/]/)[0]));
