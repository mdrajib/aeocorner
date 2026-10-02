import {
  homePage,
  hostOf,
  isQuestion,
  NO_PAGES,
  pct,
  readablePages,
  schemaTypes,
} from './helpers.js';

/**
 * E. Content answerability (25 points). Answer engines quote text that answers a question directly. These checks
 * look at the shape of the content: question headings, short direct answers, lists, FAQs, evidence, freshness.
 * They read `facts.blocks`, the page's content in reading order (headings, paragraphs, lists, tables, FAQ
 * `details`), so they never touch the DOM.
 */

/** The "question + answer" pairs on a page: a question heading (or FAQ summary) and the paragraph under it. */
export function questionPairs(blocks) {
  const pairs = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const isHeading = b.type === 'h2' || b.type === 'h3';
    const isFaqSummary = b.type === 'details';
    if (!(isHeading || isFaqSummary) || !b.text || !isQuestion(b.text)) continue;
    let answer = null;
    for (let j = i + 1; j < blocks.length; j += 1) {
      const next = blocks[j];
      if (next.type === 'p') {
        answer = next;
        break;
      }
      // The answer ends where the next heading or FAQ item starts. A list straight after counts as no paragraph.
      if (next.type === 'h2' || next.type === 'h3' || next.type === 'h4' || next.type === 'details')
        break;
    }
    pairs.push({ question: b.text, answerWords: answer?.words ?? 0, hasAnswer: Boolean(answer) });
  }
  return pairs;
}

const subheadings = (blocks) => blocks.filter((b) => b.type === 'h2' || b.type === 'h3');

/** E1 (5): headings written as the questions buyers ask. */
export function e1(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const all = pages.flatMap((p) => subheadings(p.facts.blocks));
  if (all.length === 0) {
    return {
      score: 0,
      summary:
        'The pages checked have no H2 or H3 subheadings, so there are no question-style headings.',
      evidence: { subheadings: 0, questions: 0 },
    };
  }
  const questions = all.filter((h) => isQuestion(h.text));
  const share = questions.length / all.length;
  return {
    score: Math.min(1, share / 0.3),
    summary: `${questions.length} of ${all.length} subheadings are questions (${pct(share)}); 30% or more earns full marks.${questions[0] ? ` For example: "${questions[0].text}".` : ''}`,
    evidence: {
      subheadings: all.length,
      questions: questions.length,
      examples: questions.slice(0, 5).map((q) => q.text),
    },
  };
}

const MAX_DIRECT_ANSWER_WORDS = 60;
const MIN_DIRECT_ANSWER_WORDS = 5;

/** E2 (6): a direct answer of 60 words or fewer sits right under each question. */
export function e2(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const pairs = pages.flatMap((p) =>
    questionPairs(p.facts.blocks).map((pair) => ({ ...pair, url: p.url })),
  );
  if (pairs.length === 0) {
    return {
      score: 0,
      summary:
        'There are no question headings, so there is no direct answer for an engine to quote.',
      evidence: { questions: 0 },
    };
  }
  const direct = pairs.filter(
    (q) =>
      q.hasAnswer &&
      q.answerWords >= MIN_DIRECT_ANSWER_WORDS &&
      q.answerWords <= MAX_DIRECT_ANSWER_WORDS,
  );
  const tooLong = pairs.filter((q) => q.answerWords > MAX_DIRECT_ANSWER_WORDS);
  const noAnswer = pairs.filter((q) => !q.hasAnswer);
  const worst = tooLong[0] ?? noAnswer[0];
  return {
    score: direct.length / pairs.length,
    summary:
      direct.length === pairs.length
        ? `All ${pairs.length} questions are followed by a direct answer of ${MAX_DIRECT_ANSWER_WORDS} words or fewer.`
        : `${direct.length} of ${pairs.length} questions have a direct answer of ${MAX_DIRECT_ANSWER_WORDS} words or fewer under them${worst ? `; "${worst.question}" does not` : ''}.`,
    evidence: {
      questions: pairs.length,
      direct: direct.length,
      tooLong: tooLong.length,
      noParagraph: noAnswer.length,
      examples: [...tooLong, ...noAnswer]
        .slice(0, 5)
        .map((q) => ({ question: q.question, url: q.url, words: q.answerWords })),
    },
  };
}

/** E3 (4): lists and tables, the shapes engines lift into answers. */
export function e3(ctx) {
  const readable = readablePages(ctx);
  if (readable.length === 0) return NO_PAGES;
  const pages = readable.filter((p) => p.facts.wordCount >= 150);
  if (pages.length === 0) {
    return {
      status: 'not_applicable',
      summary: 'No page checked has enough text (150 words) for lists and tables to matter.',
      evidence: {},
    };
  }
  const structured = pages.filter((p) =>
    p.facts.blocks.some(
      (b) => (b.type === 'list' && b.items >= 3) || (b.type === 'table' && b.rows >= 2),
    ),
  );
  const share = structured.length / pages.length;
  return {
    score: Math.min(1, share / 0.5),
    summary: `${structured.length} of ${pages.length} content pages use a list or table (${pct(share)}); half or more earns full marks.`,
    evidence: { pages: pages.length, withListsOrTables: structured.length },
  };
}

const FAQ_HEADING =
  /\b(faqs?|frequently asked|common questions|questions (and|&) answers|q ?& ?a)\b/i;

/** E4 (4): a FAQ section on a key page, ideally with FAQPage schema. */
export function e4(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const withSection = pages.filter(
    (p) =>
      p.facts.headings.some((h) => FAQ_HEADING.test(h.text)) ||
      p.facts.blocks.filter(
        (b) =>
          (b.type === 'h2' || b.type === 'h3' || b.type === 'details') && isQuestion(b.text ?? ''),
      ).length >= 3,
  );
  const withSchema = pages.filter((p) => schemaTypes(p.facts).has('FAQPage'));
  const section = withSection.length > 0;
  const schema = withSchema.length > 0;
  return {
    score: section && schema ? 1 : section || schema ? 0.5 : 0,
    summary:
      section && schema
        ? `A FAQ section with FAQPage schema is on ${withSection[0].url}.`
        : section
          ? `A FAQ section is on ${withSection[0].url} but it has no FAQPage schema.`
          : schema
            ? `FAQPage schema is on ${withSchema[0].url} but no visible FAQ section was found (the schema must match what visitors can see).`
            : 'No FAQ section was found on the pages checked.',
    evidence: { sectionOn: withSection.map((p) => p.url), schemaOn: withSchema.map((p) => p.url) },
  };
}

const SOCIAL_HOSTS =
  /(^|\.)(facebook|twitter|x|instagram|linkedin|youtube|tiktok|pinterest|t)\.(com|co)$/;

/** E5 (3): evidence behind the claims: named authors, outside sources, and numbers. */
export function e5(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const siteHost = hostOf(pages[0].url).replace(/^www\./, '');
  const author = pages.some((p) => Object.values(p.facts.authorSignals).some(Boolean));
  const outbound = new Set(
    pages
      .flatMap((p) => p.facts.links.filter((l) => l.area === 'body'))
      .map((l) => hostOf(l.href))
      .filter((h) => h && h.replace(/^www\./, '') !== siteHost && !SOCIAL_HOSTS.test(h)),
  );
  const stats = pages.reduce((sum, p) => sum + p.facts.statMentions, 0);
  const signals = { namedAuthor: author, outsideSources: outbound.size >= 2, numbers: stats >= 2 };
  const earned = Object.values(signals).filter(Boolean).length;
  const missing = [];
  if (!signals.namedAuthor) missing.push('a named author or byline');
  if (!signals.outsideSources) missing.push('links to outside sources');
  if (!signals.numbers) missing.push('specific figures');
  return {
    score: earned / 3,
    summary: missing.length
      ? `The content lacks ${missing.join(', ')}.`
      : 'The content names its authors, cites outside sources and uses specific figures.',
    evidence: { ...signals, outsideHosts: [...outbound].slice(0, 10), figures: stats },
  };
}

const YEAR_MS = 365 * 86_400_000;

/** E6 (3): visible dates, and recent ones. */
export function e6(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const now = ctx.now.getTime();
  const dates = pages.flatMap((p) => {
    const d = p.facts.dates;
    return [
      ...d.timeElements,
      d.metaModified,
      d.metaPublished,
      d.jsonLdModified,
      d.jsonLdPublished,
      d.updatedTextDate,
    ]
      .filter(Boolean)
      .map((v) => new Date(v))
      .filter((v) => !Number.isNaN(v.getTime()) && v.getTime() <= now + 86_400_000);
  });
  const visible = pages.some((p) => {
    const d = p.facts.dates;
    return d.updatedText || d.timeElements.length > 0 || d.metaModified || d.jsonLdModified;
  });
  const newest = dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
  const recent = newest ? now - newest.getTime() <= YEAR_MS : false;

  const lastmods = ctx.sitemaps.lastmods ?? [];
  const homeHeader = homePage(ctx)?.headers?.['last-modified'];
  const headerDate = homeHeader ? new Date(homeHeader) : null;
  const recentShare = lastmods.length
    ? lastmods.filter((d) => now - d.getTime() <= YEAR_MS).length / lastmods.length
    : null;
  const serverSaysFresh =
    (recentShare !== null && recentShare >= 0.5) ||
    (headerDate && now - headerDate.getTime() <= YEAR_MS);

  const signals = {
    datesShown: visible,
    updatedWithinAYear: recent,
    sitemapOrHeaderFresh: Boolean(serverSaysFresh),
  };
  const earned = Object.values(signals).filter(Boolean).length;
  const missing = [];
  if (!signals.datesShown) missing.push('visible "updated" dates');
  if (!signals.updatedWithinAYear) missing.push('anything dated in the last 12 months');
  return {
    score: earned / 3,
    summary: missing.length
      ? `The content shows ${missing.length === 2 ? 'neither' : 'no'} ${missing.join(' nor ')}.`
      : 'Dates are shown on the pages and something was updated within the last year.',
    evidence: { ...signals, newest: newest?.toISOString() ?? null, datedItems: dates.length },
  };
}
