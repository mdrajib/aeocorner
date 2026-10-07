import { z } from 'zod';
import { fetchRobots } from '../../crawler/gather.js';
import { robotsFindings } from '../../core/tool-robots.js';
import { CouldntCheck, plainReason } from '../../lib/tool-runner.js';
import { FetchError } from '../../crawler/safe-fetch.js';
import { siteInput } from './shared.js';

/**
 * Robots.txt checker for AI crawlers (Milestone 17, task 17.06). Reads one file, `/robots.txt`, through the safe
 * fetcher and says what it asks of each AI crawler. The judging is `src/core/tool-robots.js`; this is the fetch and the
 * words. A file we could not read is "couldn't check": a server error, a firewall page or a failed connection is never
 * "no robots.txt" and never "blocked".
 */
export const robotsTxtChecker = {
  slug: 'robots-txt-checker',
  kind: 'fetch',
  name: 'Robots.txt checker for AI crawlers',
  crumb: 'Robots.txt checker',
  title: 'Robots.txt checker for AI crawlers (free) | AEO Corner',
  description:
    'Free robots.txt checker: see which AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google, Bing) your site allows or blocks. No account needed.',
  lastmod: '2026-10-06',
  lead: 'Enter your website address and see which AI crawlers your robots.txt allows or blocks, from OpenAI, Anthropic, Perplexity, Google, Microsoft and Apple.',
  cannotSee:
    'robots.txt is a request, not a lock. This tool reads the file and says what it asks of each AI crawler. It cannot tell you whether a firewall turns a crawler away, whether an AI engine has read your pages, or whether any engine names your brand. The free audit checks the firewall and asks the engines.',
  faq: [
    {
      q: 'Which AI crawlers does this check?',
      a: 'The answer and search crawlers of OpenAI, Anthropic, Perplexity, Google, Microsoft and Apple, plus the training crawlers of Google, Apple, Meta and Common Crawl, and a few others. Each one is judged by the rules that name it, or by the rules for every crawler if none does.',
    },
    {
      q: 'Should I block GPTBot or ClaudeBot?',
      a: 'That is your choice. Training crawlers collect pages to train models, and search and answer crawlers fetch pages to answer a question. You can allow one kind and block the other. Blocking the search and answer crawlers can keep your pages out of those engines’ answers.',
    },
    {
      q: 'What if my site has no robots.txt?',
      a: 'Then every crawler may read everything, and that is not an error. Crawlers treat a missing robots.txt as no restrictions. You only need one if you want to ask some crawlers to stay away or to point them to your sitemap.',
    },
    {
      q: 'Does “allowed” mean AI will mention my brand?',
      a: 'No. Allowed means robots.txt does not ask the crawler to stay away. Whether an engine names you depends on what it finds and trusts. The free audit asks ChatGPT, Perplexity, Gemini and Google AI Overviews and shows you the real answers.',
    },
  ],
  submitLabel: 'Check my robots.txt',
  fields: [
    {
      name: 'url',
      label: 'Website to check',
      type: 'text',
      inputmode: 'url',
      autocomplete: 'url',
      placeholder: 'yourcompany.com',
      hint: 'Just the address. We read its robots.txt file.',
    },
  ],
  schema: z.object({ url: siteInput }),
  domain: (input) => input.url.domain,

  async run(ctx, input) {
    const robots = await fetchRobots(ctx.get, input.url.origin);
    if (robots.status === 'unreachable') {
      if (robots.blocked)
        throw new CouldntCheck(
          'The site turned the request away (a firewall or a rate limit) instead of sending robots.txt, so we could not read the file.',
        );
      if (robots.httpStatus)
        throw new CouldntCheck(
          `The site answered with an error (HTTP ${robots.httpStatus}) when we asked for robots.txt.`,
        );
      throw new CouldntCheck(plainReason(new FetchError(robots.error ?? 'network_error', '')));
    }
    return robotsFindings(robots);
  },
};
