import { contentFormatFor, PAGE_FORMAT_LABELS } from './citation-format.js';
import { classifyDomain, normalizeDomain, SOURCE_TYPE_LABELS } from './citation-types.js';

/**
 * Citation opportunities (Milestone 13, tasks 13.02, 13.04 and the outreach note of 13.05): where AI engines look for an
 * answer and the brand is not, and which of the brand's own pages they do and do not cite. Pure: the repository reads the
 * `citations` rows, this ranks them. The same input always gives the same order (every sort ends on the name).
 *
 * "Did not name the brand" counts only answers that cited the site and left the brand out. A source cited in answers that
 * also named the brand is not a gap.
 */

export const CITATION_LIMITS = Object.freeze({
  /** A site must be cited in at least this many answers that left the brand out before it is an opportunity. */
  minAnswers: 2,
  /** Opportunities raised as recommendations, and uncited own pages raised: more is noise. */
  gaps: 3,
  uncitedPages: 3,
  /** The own site must have been cited this many times in the window before "this page is never cited" means anything. */
  minOwnCitations: 10,
  /** Pages shown per site, and sites shown per question. */
  topPages: 3,
  sitesPerQuestion: 5,
});

const byCount = (a, b) => b.n - a.n || a.key.localeCompare(b.key);

/**
 * The brand's own pages that engines cited.
 *
 * @param rows  `[{ url, title, engineCode, timesCited, answersCiting }]`: one per page and engine
 * @returns `[{ url, title, timesCited, answersCiting, engines }]`, most cited first; `engines` is every engine that cited it
 */
export function ownPageRows(rows) {
  const by = new Map();
  for (const r of rows) {
    const page = by.get(r.url) ?? {
      url: r.url,
      title: r.title ?? null,
      timesCited: 0,
      answersCiting: 0,
      engines: [],
    };
    page.timesCited += Number(r.timesCited);
    page.answersCiting += Number(r.answersCiting);
    if (r.engineCode && !page.engines.includes(r.engineCode)) page.engines.push(r.engineCode);
    page.title = page.title ?? r.title ?? null;
    by.set(r.url, page);
  }
  return [...by.values()]
    .map((p) => ({ ...p, engines: p.engines.sort() }))
    .sort((a, b) => b.timesCited - a.timesCited || a.url.localeCompare(b.url));
}

const sameUrl = (a, b) => {
  const strip = (u) =>
    String(u)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/(?:www\.)?/, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
  return strip(a) === strip(b);
};

/**
 * Key pages of the brand's site that no engine cited in the window.
 *
 * Judged only when the site was cited enough for "never" to mean something (`minOwnCitations`), and never the home page:
 * a home page is rarely the answer to a question. A page the latest scan could not fetch is not a key page here.
 *
 * @param keyPages   `[{ url }]` from the latest scan, in the scan's order (the most important first)
 * @param cited      rows from `ownPageRows`
 * @param ownCitations how many citations of the brand's own site there were in the window
 * @param homeUrl    the site's home address
 */
export function uncitedKeyPages({ keyPages, cited, ownCitations, homeUrl = null }) {
  if (ownCitations < CITATION_LIMITS.minOwnCitations) return [];
  const out = [];
  for (const page of keyPages) {
    if (homeUrl && sameUrl(page.url, homeUrl)) continue;
    try {
      if (new URL(page.url).pathname.replace(/\/+$/, '') === '') continue;
    } catch {
      continue;
    }
    if (cited.some((c) => sameUrl(c.url, page.url))) continue;
    if (out.some((o) => sameUrl(o.url, page.url))) continue;
    out.push({ url: page.url });
  }
  return out;
}

/** The format most of a site's cited pages are in (ties broken by name); 'other' ones only count if nothing else is known. */
export function dominantFormat(pages) {
  const counts = new Map();
  for (const p of pages) {
    if (!p.format) continue;
    counts.set(p.format, (counts.get(p.format) ?? 0) + Math.max(1, Number(p.timesCited ?? 1)));
  }
  const ranked = [...counts].map(([key, n]) => ({ key, n })).sort(byCount);
  const known = ranked.filter((r) => r.key !== 'other');
  return (known[0] ?? ranked[0])?.key ?? null;
}

/**
 * Rank the sources cited for each question that did not name the brand.
 *
 * @param rows  one per question and site: `{ promptId, text, domain, timesCited, answersCiting, answersWithBrand,
 *              answersInQuestion, pages: [{ url, title, timesCited, format }] }`; `answersInQuestion` is the readable
 *              answers to that question
 * @param context `{ ownDomains, rivalDomains }`
 * @returns `{ byQuestion, bySite }`
 *   byQuestion  `[{ promptId, text, answers, sites: [{ domain, type, typeLabel, format, formatLabel, timesCited,
 *               answersWithoutBrand, share }] }]`, the questions with the most missed answers first
 *   bySite      `[{ domain, type, typeLabel, format, formatLabel, timesCited, answersCiting, answersWithoutBrand,
 *               promptIds, questions, pages, path, contentFormat }]`, most missed first; the input of `citation.gap`
 *
 * `path` is "content" when the site is a competitor's and its pages are in a format we write, "guidance" otherwise: you
 * cannot ask a competitor to list you, but you can write the page they wrote.
 */
export function rankOpportunities(rows, { ownDomains = [], rivalDomains = [] } = {}) {
  const context = { ownDomains, rivalDomains };
  const decorated = [];
  for (const r of rows) {
    const domain = normalizeDomain(r.domain);
    if (!domain) continue;
    const type = classifyDomain(domain, context);
    if (type === 'own') continue;
    const withoutBrand = Number(r.answersCiting) - Number(r.answersWithBrand);
    if (withoutBrand <= 0) continue;
    const pages = (r.pages ?? [])
      .slice()
      .sort((a, b) => Number(b.timesCited) - Number(a.timesCited) || a.url.localeCompare(b.url))
      .slice(0, CITATION_LIMITS.topPages);
    decorated.push({ ...r, domain, type, withoutBrand, pages });
  }

  const asSite = (d, format) => ({
    domain: d.domain,
    type: d.type,
    typeLabel: SOURCE_TYPE_LABELS[d.type],
    format,
    formatLabel: format ? PAGE_FORMAT_LABELS[format] : null,
  });

  const questions = new Map();
  for (const d of decorated) {
    const q = questions.get(d.promptId) ?? {
      promptId: String(d.promptId),
      text: d.text,
      answers: Number(d.answersInQuestion ?? 0),
      missed: 0,
      sites: [],
    };
    q.missed += d.withoutBrand;
    q.sites.push({
      ...asSite(d, dominantFormat(d.pages)),
      timesCited: Number(d.timesCited),
      answersWithoutBrand: d.withoutBrand,
      share: q.answers > 0 ? Math.min(1, d.withoutBrand / q.answers) : null,
    });
    questions.set(d.promptId, q);
  }
  const byQuestion = [...questions.values()]
    .map((q) => ({
      promptId: q.promptId,
      text: q.text,
      answers: q.answers,
      missed: q.missed,
      sites: q.sites
        .sort(
          (a, b) =>
            b.answersWithoutBrand - a.answersWithoutBrand ||
            b.timesCited - a.timesCited ||
            a.domain.localeCompare(b.domain),
        )
        .slice(0, CITATION_LIMITS.sitesPerQuestion),
    }))
    .sort(
      (a, b) =>
        b.missed - a.missed ||
        String(a.promptId).localeCompare(String(b.promptId), 'en', { numeric: true }),
    );

  const sites = new Map();
  for (const d of decorated) {
    const s = sites.get(d.domain) ?? {
      domain: d.domain,
      type: d.type,
      timesCited: 0,
      answersCiting: 0,
      answersWithoutBrand: 0,
      promptIds: [],
      questions: [],
      pages: new Map(),
    };
    s.timesCited += Number(d.timesCited);
    s.answersCiting += Number(d.answersCiting);
    s.answersWithoutBrand += d.withoutBrand;
    s.promptIds.push(String(d.promptId));
    s.questions.push({
      promptId: String(d.promptId),
      text: d.text,
      answersWithoutBrand: d.withoutBrand,
    });
    for (const p of d.pages) {
      const page = s.pages.get(p.url) ?? {
        url: p.url,
        title: p.title ?? null,
        timesCited: 0,
        format: p.format ?? null,
      };
      page.timesCited += Number(p.timesCited);
      page.format = page.format ?? p.format ?? null;
      s.pages.set(p.url, page);
    }
    sites.set(d.domain, s);
  }
  const bySite = [...sites.values()]
    .map((s) => {
      const pages = [...s.pages.values()]
        .sort((a, b) => b.timesCited - a.timesCited || a.url.localeCompare(b.url))
        .slice(0, CITATION_LIMITS.topPages);
      const format = dominantFormat(pages);
      const contentFormat = s.type === 'competitor' ? contentFormatFor(format) : null;
      return {
        ...asSite(s, format),
        timesCited: s.timesCited,
        answersCiting: s.answersCiting,
        answersWithoutBrand: s.answersWithoutBrand,
        promptIds: s.promptIds.sort((a, b) => Number(a) - Number(b)),
        questions: s.questions.sort(
          (a, b) =>
            b.answersWithoutBrand - a.answersWithoutBrand ||
            String(a.promptId).localeCompare(String(b.promptId), 'en', { numeric: true }),
        ),
        pages,
        path: contentFormat ? 'content' : 'guidance',
        contentFormat,
      };
    })
    .filter((s) => s.answersWithoutBrand >= CITATION_LIMITS.minAnswers)
    .sort(
      (a, b) =>
        b.answersWithoutBrand - a.answersWithoutBrand ||
        b.timesCited - a.timesCited ||
        a.domain.localeCompare(b.domain),
    );
  return { byQuestion, bySite };
}

// --- The outreach note ---------------------------------------------------------------------------------------

const clip = (text, max) => {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/**
 * A note the customer can copy to ask to be listed. It is built from facts and nothing else: the brand's name and address,
 * the one-line description the customer wrote in their Brand Kit (if any), the site, up to two pages we saw cited and up
 * to two questions they were cited for. It states no number, no result and no claim about the brand beyond its own
 * description. **We never send it**: the screen says so, and no code path here or elsewhere mails it.
 *
 * @param facts `{ brandName, brandDomain, summary?, site: { domain, pages: [{ url, title }], questions: [string] } }`
 * @returns `{ subject, body }`
 */
export function buildOutreachNote({ brandName, brandDomain, summary = '', site }) {
  const questions = (site.questions ?? []).slice(0, 2).map((q) => clip(q, 160));
  const pages = (site.pages ?? []).slice(0, 2);
  const lines = [`Hello,`, ''];
  lines.push(
    `I am writing on behalf of ${brandName} (${brandDomain}).${summary ? ` ${clip(summary, 240).replace(/[.\s]*$/, '.')}` : ''}`,
  );
  lines.push('');
  lines.push(
    questions.length
      ? `${site.domain} is one of the sites AI assistants draw on when people ask questions such as ${questions
          .map((q) => `“${q}”`)
          .join(' or ')}.`
      : `${site.domain} is one of the sites AI assistants draw on when people ask about our field.`,
  );
  if (pages.length) {
    lines.push(
      `For example: ${pages.map((p) => (p.title ? `“${clip(p.title, 100)}” (${p.url})` : p.url)).join('; ')}.`,
    );
  }
  lines.push('');
  lines.push(
    `${brandName} is not mentioned there at the moment. If it fits your editorial standards, we would be glad to be considered, and can send accurate details and a link to our site.`,
  );
  lines.push('', 'Thank you for your time.');
  return { subject: `Could ${brandName} be included on ${site.domain}?`, body: lines.join('\n') };
}

/**
 * The check on an outreach note: every address and quoted phrase in it must come from the facts it was built from.
 * Returns the offending pieces; empty means the note is clean.
 */
export function findUnsupportedInNote(note, { brandName, brandDomain, summary = '', site }) {
  const allowed = [
    brandName,
    brandDomain,
    summary,
    site.domain,
    ...(site.questions ?? []),
    ...(site.pages ?? []).flatMap((p) => [p.url, p.title ?? '']),
  ]
    .map((s) => String(s))
    .filter(Boolean);
  const known = (piece) => allowed.some((a) => a.includes(piece) || piece.includes(clip(a, 160)));
  const text = `${note.subject}\n${note.body}`;
  const bad = [];
  for (const m of text.match(/https?:\/\/[^\s)]+/g) ?? []) if (!known(m)) bad.push(m);
  for (const m of text.match(/“[^”]+”/g) ?? [])
    if (!known(m.slice(1, -1).replace(/…$/, ''))) bad.push(m);
  for (const m of text.match(/\d+/g) ?? []) if (!allowed.some((a) => a.includes(m))) bad.push(m);
  return bad;
}

// --- Citation share over time ---------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The Monday (UTC) of the week a day falls in, as `YYYY-MM-DD`. */
export function weekStart(dateText) {
  const d = new Date(`${String(dateText).slice(0, 10)}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The brand's citation share per week: of the sources cited, how many were the brand's own site. Sums are added first and
 * divided once, at the end. A week with no citation has no share (`null`: a gap in the chart, "Couldn't check" in its
 * table), never 0%.
 *
 * @param daily  `[{ date, own, total }]`
 * @param range  `{ from, to }` as `YYYY-MM-DD`, so empty weeks inside the period are shown as gaps
 * @returns `{ labels, values, own, total }`; `values` are whole percents or null; `own`/`total` are the period's sums
 */
export function weeklyCitationShare(daily, { from, to }) {
  const sums = new Map();
  for (const d of daily) {
    const key = weekStart(d.date);
    const w = sums.get(key) ?? { own: 0, total: 0 };
    w.own += Number(d.own);
    w.total += Number(d.total);
    sums.set(key, w);
  }
  const labels = [];
  const values = [];
  for (
    let t = new Date(`${weekStart(from)}T00:00:00Z`).getTime();
    t <= new Date(`${String(to).slice(0, 10)}T00:00:00Z`).getTime();
    t += 7 * DAY_MS
  ) {
    const key = new Date(t).toISOString().slice(0, 10);
    const w = sums.get(key);
    labels.push(key);
    values.push(w && w.total > 0 ? Math.round((w.own / w.total) * 100) : null);
  }
  return {
    labels,
    values,
    own: daily.reduce((n, d) => n + Number(d.own), 0),
    total: daily.reduce((n, d) => n + Number(d.total), 0),
  };
}
