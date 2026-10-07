import { z } from 'zod';
import { detectBotBlock } from '../../crawler/bot-block.js';
import { decodeBody } from '../../crawler/decode.js';
import { PAGE_BODY_TYPES } from '../../crawler/gather.js';
import { readJsonLdBlocks } from '../../crawler/html.js';
import { FetchError } from '../../crawler/safe-fetch.js';
import { structuredDataFindings } from '../../core/tool-structured-data.js';
import { normalizeWebsite } from '../../lib/url.js';
import { CouldntCheck, plainReason } from '../../lib/tool-runner.js';

/**
 * Structured data validator (Milestone 17, task 17.07). Two ways in, and they cost us different things:
 *
 *   code  the visitor pastes JSON-LD (or the HTML around it). No request leaves us: it is a `generate` run, with no bot
 *         check and the cheaper limit.
 *   page  the visitor gives a page address. We read that one page through the safe fetcher, obeying robots.txt as
 *         AEOCornerBot, and check the JSON-LD in its HTML. It is a `fetch` run: bot check and the stricter limits.
 *
 * `kindFor` tells the route which one a submission is, after the form has been read. The judging is
 * `src/core/tool-structured-data.js`. A page we could not read is "couldn't check": a 404, a firewall, a page that is not
 * HTML or one that is nested too deeply is never "no structured data".
 */

const MAX_PASTE = 200_000;

const ROBOTS_REASONS = {
  robots:
    'The site’s robots.txt asks our crawler (AEOCornerBot) to stay away from that page, so we did not read it.',
  blocked: 'The site turned our request for robots.txt away, so we did not read the page.',
  unavailable: 'The site’s robots.txt could not be read right now, so we did not read the page.',
  fetch_failed: 'We could not read the site’s robots.txt, so we did not read the page.',
};

const clean = (v) => (typeof v === 'string' ? v.trim() : undefined);

const schema = z
  .object({
    url: z
      .string({ error: 'Enter a page address.' })
      .max(2048, { error: 'That address is too long.' })
      .optional(),
    code: z
      .string({ error: 'Paste your structured data.' })
      .max(MAX_PASTE, { error: 'That is too long to check here. Paste one block at a time.' })
      .optional(),
  })
  .transform((body, ctx) => {
    const url = clean(body.url) || undefined;
    const code = clean(body.code) || undefined;
    if (!url && !code) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Enter a page address, or paste your structured data below.',
      });
      return z.NEVER;
    }
    if (url && code) {
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message: 'Use one or the other: a page address, or pasted structured data.',
      });
      return z.NEVER;
    }
    if (code) return { mode: 'code', code };
    const site = normalizeWebsite(url);
    if (!site.ok) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: site.message });
      return z.NEVER;
    }
    return {
      mode: 'page',
      page: { url: site.url, origin: new URL(site.url).origin, domain: site.domain },
    };
  });

/** Pasted text to blocks: HTML is read for its JSON-LD scripts, anything else is one JSON document. */
export function blocksFromPaste(text) {
  if (/^\s*</.test(text)) {
    const read = readJsonLdBlocks(text);
    if (read.tooDeep) throw new CouldntCheck('That HTML is nested too deeply to read safely.');
    return [
      ...read.docs.map((d) => ({ block: d.block, data: d.data })),
      ...read.problems.map((p) => ({ block: p.block, problem: p.problem })),
    ].sort((a, b) => a.block - b.block);
  }
  try {
    return [{ block: 1, data: JSON.parse(text) }];
  } catch {
    return [{ block: 1, problem: 'invalid_json' }];
  }
}

async function readPage(ctx, page) {
  const gate = await ctx.robots.allow(page.url);
  if (!gate.allowed)
    throw new CouldntCheck(ROBOTS_REASONS[gate.finding] ?? ROBOTS_REASONS.fetch_failed);

  const res = await ctx.get(page.url, { bodyTypes: PAGE_BODY_TYPES });
  if (!res.ok) throw new CouldntCheck(plainReason(new FetchError(res.error.code, '')));
  // A redirect to another site is that site's page, and that site's robots.txt speaks for it.
  const final = new URL(res.url);
  if (final.origin !== page.origin) {
    const again = await ctx.robots.allow(res.url);
    if (!again.allowed)
      throw new CouldntCheck(ROBOTS_REASONS[again.finding] ?? ROBOTS_REASONS.fetch_failed);
  }
  if (detectBotBlock(res).blocked)
    throw new CouldntCheck(
      'The site turned the request away (a firewall or a rate limit), so we could not read the page.',
    );
  if (res.status === 404 || res.status === 410)
    throw new CouldntCheck(
      `The page answered “not found” (HTTP ${res.status}), so there is nothing to check.`,
    );
  if (res.status < 200 || res.status >= 300)
    throw new CouldntCheck(
      `The page answered with an error (HTTP ${res.status}), so we could not read it.`,
    );
  if (res.bodySkipped || !/html/i.test(res.contentType))
    throw new CouldntCheck('That address is not a web page we can read: it did not send HTML.');

  const read = readJsonLdBlocks(decodeBody(res.body, res.contentType).text);
  if (read.tooDeep) throw new CouldntCheck('The page is nested too deeply for us to read safely.');
  const items = [
    ...read.docs.map((d) => ({ block: d.block, data: d.data })),
    ...read.problems.map((p) => ({ block: p.block, problem: p.problem })),
  ].sort((a, b) => a.block - b.block);
  return { items, pageUrl: res.url, httpStatus: res.status };
}

export const structuredDataValidator = {
  slug: 'structured-data-validator',
  kind: 'fetch',
  /** A pasted block never leaves us, so it is the cheaper kind of run. */
  kindFor: (input) => (input.mode === 'code' ? 'generate' : 'fetch'),
  badge: 'Checks a page or your code',
  name: 'Structured data validator (JSON-LD)',
  crumb: 'Structured data validator',
  title: 'Structured data validator for JSON-LD (free) | AEO Corner',
  description:
    'Free JSON-LD validator: paste your structured data or give a page address and see what is wrong, with plain explanations. No account needed.',
  lastmod: '2026-10-06',
  lead: 'Give a page address, or paste your JSON-LD, and see whether it is valid structured data, what is wrong and where.',
  cannotSee:
    'This tool checks the structure and values of structured data in a page’s HTML, or in what you paste. It cannot tell you whether a search or AI engine will use it. It does not run JavaScript, so data a script adds after the page loads is not seen.',
  faq: [
    {
      q: 'What is JSON-LD?',
      a: 'JSON-LD is a block of data in a web page that says what the page is about in a form software can read: who the business is, what an article is, what the questions and answers are. Search engines and AI crawlers read it.',
    },
    {
      q: 'Which types does this validator check?',
      a: 'It checks the types listed at the bottom of each result in detail: the structure, the @context, dates, web addresses and the properties it knows. Any other type or property is read for syntax only, and listed as not checked, because we cannot say it is wrong.',
    },
    {
      q: 'Why does it say it found no structured data on my page?',
      a: 'Either the page has none, or a script adds it after the page loads. This tool reads the HTML the server sends, as a crawler that does not run JavaScript would. If your structured data comes from a script, put it in the server’s HTML instead.',
    },
    {
      q: 'Is my pasted code saved?',
      a: 'No. We read it, show you the result, and keep nothing. A pasted block never leaves our server, and we make no request to any other site for it.',
    },
  ],
  submitLabel: 'Check my structured data',
  fields: [
    {
      name: 'url',
      label: 'Page address',
      type: 'text',
      inputmode: 'url',
      autocomplete: 'url',
      placeholder: 'yourcompany.com/about',
      required: false,
      hint: 'We read this one page. Leave it empty if you are pasting code.',
    },
    {
      name: 'code',
      label: 'Or paste your JSON-LD',
      type: 'textarea',
      rows: 8,
      required: false,
      placeholder: '{ "@context": "https://schema.org", "@type": "Organization", … }',
      hint: 'Paste the JSON, or the whole <script type="application/ld+json"> block. Leave it empty if you gave an address.',
    },
  ],
  schema,
  domain: (input) => input.page.domain,

  async run(ctx, input) {
    if (input.mode === 'code') {
      return structuredDataFindings({ source: 'paste', items: blocksFromPaste(input.code) });
    }
    const { items, pageUrl, httpStatus } = await readPage(ctx, input.page);
    return structuredDataFindings({ source: 'page', items, pageUrl, httpStatus });
  },
};
