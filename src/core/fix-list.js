import { CHECKS } from '../crawler/readiness/rubric.js';
import { AEO_WEIGHTS, presenceValue } from './visibility.js';

/**
 * The audit's "top fixes" (MVP F1: "Every fix links to its evidence: a failing check or specific answers"). Pure:
 * the readiness checks and the answers go in, a ranked list comes out, so the ranking can be checked by hand.
 *
 * Two kinds of fix:
 *   readiness    a check that failed or earned only part of its points, with guidance written for that check
 *   visibility   something the answers showed: no engine names the brand, a competitor is named where the brand is
 *                not, an engine hedges about it, or the same outside sites keep being cited
 *
 * Ranking is by `impact`: roughly how many points of the 0-100 AEO Score the fix could win back. It is a way to put
 * the biggest first, not a promise: readiness fixes count the points the check lost, scaled to the AEO Score; a
 * visibility fix counts what the brand would score if it were at least named in the answers it is missing from.
 * Checks that errored (we couldn't look) and informational checks (A2, F4) are never fixes: a "couldn't check" is not
 * a failure, and the first is a business choice.
 */

export const MAX_FIXES = 5;

/** What to do about each check, in the words a marketer would act on. One entry per rubric check. */
export const READINESS_GUIDANCE = Object.freeze({
  A1: {
    title: 'Let AI search crawlers read your site',
    how: 'Your robots.txt turns away crawlers that AI answer engines use to find sources (such as OAI-SearchBot, PerplexityBot or Claude-SearchBot). Allow them, so your pages can be quoted in answers.',
  },
  A3: {
    title: 'Stop your firewall blocking AI crawlers',
    how: 'A firewall or bot-protection rule is blocking or challenging requests from AI crawlers. Allow their published user agents (or addresses) in your CDN or firewall settings.',
  },
  A4: {
    title: 'Publish an XML sitemap and point robots.txt at it',
    how: 'Add a sitemap.xml listing your important pages and reference it in robots.txt with a Sitemap: line, so crawlers find every page you want known.',
  },
  B1: {
    title: 'Put your main content in the page itself',
    how: 'Most of your page text only appears after JavaScript runs, and many AI crawlers do not run it. Serve the main content in the HTML (server-side rendering or pre-rendering).',
  },
  B2: {
    title: 'Don’t hide key content behind clicks or iframes',
    how: 'Important text sits in tabs, accordions that load on click, or iframes that crawlers do not open. Move it into the page so it can be read without interaction.',
  },
  C1: {
    title: 'Add Organization schema with your name, logo and profiles',
    how: 'Add Organization (or LocalBusiness) structured data to your home page: name, logo, URL and sameAs links to your official profiles. It tells engines which entity your site speaks for.',
  },
  C2: {
    title: 'Add schema that matches each key page',
    how: 'Mark up your key pages with the type that fits them: Product, Service, Article, FAQPage or HowTo. Most SEO plugins can add these.',
  },
  C3: {
    title: 'Fix your structured data so it is valid and in the HTML',
    how: 'Some JSON-LD on your site is invalid, or only appears after JavaScript runs. Validate it and make sure it is in the HTML the server sends.',
  },
  C4: {
    title: 'Add WebSite and BreadcrumbList schema',
    how: 'Add WebSite schema to your home page and BreadcrumbList to inner pages, so engines understand how your site is organised.',
  },
  D1: {
    title: 'Use one consistent brand name everywhere',
    how: 'Your page title, og:site_name and schema give different versions of your name. Pick one and use it in all three, so engines treat it as one brand.',
  },
  D2: {
    title: 'Write an About page that says who you are and what you do',
    how: 'Open your About page with a plain definition: who you are, what you do, where, and for whom. Engines lift these sentences when they describe you.',
  },
  D3: {
    title: 'Link to your authoritative profiles',
    how: 'Add sameAs links in your schema to profiles such as LinkedIn, Wikipedia or Wikidata, Crunchbase, G2 and your Google Business Profile.',
  },
  D4: {
    title: 'Make your name, address and phone number consistent',
    how: 'Your business details differ between pages or listings. Use exactly the same name, address and phone number everywhere they appear.',
  },
  E1: {
    title: 'Use headings that are the questions buyers ask',
    how: 'Write H2 and H3 headings as the questions your customers type (for example “How much does X cost?”), so your pages match the questions engines are asked.',
  },
  E2: {
    title: 'Answer each question in the first sentences under its heading',
    how: 'Put a direct answer of 60 words or fewer right under each question heading, then add detail. Engines quote short, direct answers.',
  },
  E3: {
    title: 'Add lists and comparison tables',
    how: 'Use bullet lists and tables for steps, features and comparisons. Engines pick up structured content more readily than long paragraphs.',
  },
  E4: {
    title: 'Add FAQ sections to your key pages',
    how: 'Add a short FAQ to your main product, service and pricing pages, with FAQPage schema.',
  },
  E5: {
    title: 'Back claims with sources, statistics and named authors',
    how: 'Cite sources for your numbers, link out to them, and put a named author with credentials on articles. Evidence makes a page safer to quote.',
  },
  E6: {
    title: 'Show when pages were last updated',
    how: 'Add a visible “Updated” date to your key pages and keep the information current. Engines prefer fresh sources.',
  },
  F1: {
    title: 'Make sure your key pages can be indexed',
    how: 'A key page has a noindex tag or a wrong canonical link. Remove the noindex and point each canonical at the page itself.',
  },
  F2: {
    title: 'Serve your pages over HTTPS with no redirect chains',
    how: 'Some pages redirect more than once, or are not served over HTTPS. Link straight to the final HTTPS address.',
  },
  F3: {
    title: 'Give every page a unique title and meta description',
    how: 'Some pages have no title or description, or share one. Write a distinct title and description for each page.',
  },
});

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The points a check lost, as AEO Score points. Readiness is 60% of the AEO Score, and the readiness score is
 * earned/possible over the checks that could be evaluated, so `possibleTotal` is that denominator.
 */
const readinessImpact = (lost, possibleTotal) =>
  possibleTotal > 0 ? (lost / possibleTotal) * 100 * AEO_WEIGHTS.readiness : 0;

/** Readiness fixes from the scan's checks, biggest first. */
function readinessFixes(checks) {
  const evaluated = checks.filter((c) => c.status !== 'error' && c.status !== 'not_applicable');
  const possibleTotal = evaluated.reduce((sum, c) => sum + c.possible, 0);
  const fixes = [];
  for (const c of evaluated) {
    const def = CHECKS[c.code];
    const guidance = READINESS_GUIDANCE[c.code];
    if (!def || !guidance || def.informational) continue;
    if (c.status !== 'fail' && c.status !== 'partial') continue;
    const lost = c.possible - c.points;
    fixes.push({
      kind: 'readiness',
      id: `check-${c.code}`,
      title: guidance.title,
      how: guidance.how,
      impact: round1(readinessImpact(lost, possibleTotal)),
      evidence: {
        type: 'check',
        checkCode: c.code,
        status: c.status,
        summary: c.summary ?? '',
        points: c.points,
        possible: c.possible,
      },
    });
  }
  return fixes;
}

const readable = (a) => a.status === 'ok' && typeof a.brandPresent === 'boolean';
const ref = (a) => ({ promptIdx: a.promptIdx, engineCode: a.engineCode });

/** Visibility fixes from what the answers showed. */
function visibilityFixes(answers, { brandName }) {
  const used = answers.filter(readable);
  if (used.length === 0) return [];
  const weight = (a) => a.priority ?? 1;
  const totalWeight = used.reduce((sum, a) => sum + weight(a), 0);
  // What winning back a missed answer is worth on the 0-100 visibility scale, as AEO Score points: being at least
  // named (0.5) in an answer that now scores `current`.
  const gain = (list) =>
    (list.reduce((sum, a) => sum + weight(a) * Math.max(0, 0.5 - presenceValue(a)), 0) /
      totalWeight) *
    100 *
    AEO_WEIGHTS.visibility;
  const fixes = [];

  const missing = used.filter((a) => !a.brandPresent);
  if (missing.length > 0) {
    const engines = [...new Set(missing.map((a) => a.engineCode))].sort();
    fixes.push({
      kind: 'visibility',
      id: 'not-named',
      title: `Get ${brandName} named in the answers buyers see`,
      how: `AI engines did not name ${brandName} in ${missing.length} of ${used.length} answers we could read. Answers draw on pages that state plainly what you do and who for, are marked up with schema, and are backed by outside mentions: strengthen those, starting with the fixes below.`,
      impact: round1(gain(missing)),
      evidence: { type: 'answers', answers: missing.map(ref), engines },
    });
  }

  // A competitor named where the brand is not.
  const rivalCounts = new Map();
  for (const a of missing) {
    for (const name of new Set(a.competitorsNamed ?? [])) {
      const entry = rivalCounts.get(name) ?? [];
      entry.push(a);
      rivalCounts.set(name, entry);
    }
  }
  const [rival, rivalAnswers] =
    [...rivalCounts].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))[0] ?? [];
  if (rival) {
    fixes.push({
      kind: 'visibility',
      id: 'competitor-ahead',
      title: `Compete with ${rival} where it is being recommended`,
      how: `${rival} is named in ${rivalAnswers.length} answer${rivalAnswers.length === 1 ? '' : 's'} where ${brandName} is not. Publish pages that compare you with ${rival} and answer the same questions, so engines have something of yours to quote.`,
      impact: round1(gain(rivalAnswers)),
      evidence: { type: 'answers', answers: rivalAnswers.map(ref), competitor: rival },
    });
  }

  // The same outside site cited again and again in answers that leave the brand out.
  const sites = new Map();
  for (const a of missing) {
    for (const domain of new Set(a.citedDomains ?? [])) {
      const entry = sites.get(domain) ?? [];
      entry.push(a);
      sites.set(domain, entry);
    }
  }
  const [site, siteAnswers] =
    [...sites]
      .filter(([, list]) => list.length >= 2)
      .sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))[0] ?? [];
  if (site) {
    fixes.push({
      kind: 'visibility',
      id: 'cited-source',
      title: `Get listed or mentioned on ${site}`,
      how: `${site} is cited in ${siteAnswers.length} answers that leave ${brandName} out. Engines trust it as a source: get a profile, review or mention there.`,
      impact: round1(gain(siteAnswers) * 0.5),
      evidence: { type: 'answers', answers: siteAnswers.map(ref), site },
    });
  }

  // Engines that name the brand but hedge.
  const hedged = used.filter(
    (a) => a.brandPresent && (a.brandStance === 'cautioned' || a.brandStance === 'not_recommended'),
  );
  if (hedged.length > 0) {
    const lost = hedged.reduce(
      (sum, a) => sum + weight(a) * presenceValue({ ...a, brandStance: null }) * 0.5,
      0,
    );
    fixes.push({
      kind: 'visibility',
      id: 'hedged',
      title: `Address why engines hold back on recommending ${brandName}`,
      how: `${hedged.length} answer${hedged.length === 1 ? '' : 's'} named ${brandName} but cautioned against it or did not recommend it. Read those answers, find the claim or gap they point to, and fix it on your site and in the places that describe you.`,
      impact: round1((lost / totalWeight) * 100 * AEO_WEIGHTS.visibility),
      evidence: { type: 'answers', answers: hedged.map(ref) },
    });
  }
  return fixes;
}

/**
 * The ranked fixes for an audit, at most `limit`.
 *
 * @param checks   the scan's checks: `{ code, status, points, possible, summary }`
 * @param answers  the five questions' answers, as the scorer takes them, plus `competitorsNamed` (names of
 *                 competitors the answer named) and `citedDomains` (the sites it cited, other than the brand's own)
 * @param brandName the brand as it should be written in a fix
 */
export function buildFixList({ checks = [], answers = [], brandName, limit = MAX_FIXES }) {
  return [...readinessFixes(checks), ...visibilityFixes(answers, { brandName })]
    .filter((fix) => fix.impact > 0)
    .sort((a, b) => b.impact - a.impact || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((fix, index) => ({ rank: index + 1, ...fix }));
}
