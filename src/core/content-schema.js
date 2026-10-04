import { load } from 'cheerio';
import { analyzeBody, faqPairs } from './content-html.js';
import { validateJsonLd } from './jsonld.js';

/**
 * Structured data for a draft (MVP F8 step 7, task 7.01 + 7.06): typed templates filled from the draft itself, never
 * written by a model, so the markup can only say what the page says. Article always; FAQPage when the brief asked for
 * one and the page has at least two question-and-answer pairs; HowTo when it has steps. Every result goes through
 * `validateJsonLd`, and a template that does not validate (a FAQ with one question) falls back to the Article.
 *
 * Pure. The caller supplies dates and the published address, so the same draft always gives the same markup.
 */

const clip = (text, max) => {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

/** Steps of a how-to: the items of the first numbered list, else the question sections. */
export function howToSteps(bodyHtml) {
  const analysis = analyzeBody(bodyHtml);
  const list = analysis.blocks.find((b) => b.type === 'ol');
  if (list) {
    const $ = load(list.html, null, false);
    const items = $('li')
      .toArray()
      .map((li) => clip($(li).text(), 500))
      .filter(Boolean);
    if (items.length >= 2) return items.map((text) => ({ text }));
  }
  return analysis.headings
    .filter((h) => h.level === 2 && h.answer)
    .map((h) => ({ name: clip(h.text, 120), text: clip(h.answer, 500) }));
}

/**
 * @param {object} input
 * @param {'Article'|'FAQPage'|'HowTo'} input.schemaType
 * @param {string} input.title
 * @param {string} [input.metaDescription]
 * @param {string} input.bodyHtml  sanitized markup
 * @param {{name: string, domain?: string}} input.brand
 * @param {{name: string, jobTitle?: string}|null} [input.author]  a Brand Kit persona, or null to credit the brand
 * @param {Date|string} input.modifiedAt
 * @param {Date|string|null} [input.publishedAt]
 * @param {string|null} [input.url]  the page's address once it is known
 * @returns {{ jsonld: object, validation: object, types: string[], downgraded: string|null }}
 */
export function buildJsonLd({
  schemaType = 'Article',
  title,
  metaDescription = '',
  bodyHtml,
  brand,
  author = null,
  modifiedAt,
  publishedAt = null,
  url = null,
}) {
  const analysis = analyzeBody(bodyHtml);
  const site = brand.domain ? `https://${String(brand.domain).replace(/^https?:\/\//, '')}` : null;
  const publisher = {
    '@type': 'Organization',
    name: brand.name,
    ...(site ? { url: site } : {}),
  };
  const article = {
    '@type': 'Article',
    headline: clip(title, 110),
    ...(metaDescription ? { description: clip(metaDescription, 300) } : {}),
    author: author?.name
      ? {
          '@type': 'Person',
          name: author.name,
          ...(author.jobTitle ? { jobTitle: author.jobTitle } : {}),
        }
      : { '@type': 'Organization', name: brand.name, ...(site ? { url: site } : {}) },
    publisher,
    datePublished: isoDate(publishedAt ?? modifiedAt),
    dateModified: isoDate(modifiedAt),
    inLanguage: 'en',
    wordCount: analysis.words,
    ...(url ? { mainEntityOfPage: url, url } : {}),
  };

  const graphOf = (nodes) => ({ '@context': 'https://schema.org', '@graph': nodes });
  let downgraded = null;
  let nodes = [article];

  if (schemaType === 'FAQPage') {
    const pairs = faqPairs(analysis).slice(0, 20);
    if (pairs.length >= 2) {
      nodes = [
        {
          '@type': 'FAQPage',
          name: clip(title, 160),
          ...(url ? { url } : {}),
          mainEntity: pairs.map((p) => ({
            '@type': 'Question',
            name: clip(p.question, 300),
            acceptedAnswer: { '@type': 'Answer', text: clip(p.answer, 2000) },
          })),
        },
        article,
      ];
    } else
      downgraded =
        'The page has fewer than two question-and-answer pairs, so it is marked up as an article.';
  } else if (schemaType === 'HowTo') {
    const steps = howToSteps(bodyHtml);
    if (steps.length >= 2) {
      nodes = [
        {
          '@type': 'HowTo',
          name: clip(title, 160),
          ...(metaDescription ? { description: clip(metaDescription, 300) } : {}),
          step: steps.slice(0, 30).map((s, i) => ({
            '@type': 'HowToStep',
            position: i + 1,
            ...(s.name ? { name: s.name } : {}),
            text: s.text,
          })),
        },
        article,
      ];
    } else downgraded = 'The page has fewer than two steps, so it is marked up as an article.';
  }

  let jsonld = graphOf(nodes);
  let validation = validateJsonLd(jsonld);
  if (!validation.ok && nodes.length > 1) {
    // A template the page cannot support is dropped; the article stands on its own.
    downgraded =
      downgraded ?? 'The extra structured data did not validate, so only the article is marked up.';
    jsonld = graphOf([article]);
    validation = validateJsonLd(jsonld);
  }
  return { jsonld, validation, types: validation.types, downgraded };
}
