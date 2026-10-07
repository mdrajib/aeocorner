import { z } from 'zod';
import {
  generateRobots,
  parseDisallowPaths,
  robotsGeneratorFindings,
} from '../../core/tool-robots-generator.js';
import { normalizeWebsite } from '../../lib/url.js';

/**
 * Robots.txt generator for AI crawlers (Milestone 17, task 17.09). It runs our own code on what was typed: no request
 * leaves us, so it is a `generate` run (no bot check, the cheaper limit). The file is built by
 * `src/core/tool-robots-generator.js`, which never offers to block a search engine.
 */

const choice = z.enum(['allow', 'block'], { error: 'Choose allow or block.' }).default('allow');
const CHOICES = [
  { value: 'allow', label: 'Allow' },
  { value: 'block', label: 'Block' },
];

const schema = z
  .object({
    answer: choice,
    training: choice,
    other: choice,
    sitemap: z.string().max(2048, { error: 'That address is too long.' }).optional(),
    disallow: z
      .string()
      .max(10_000, { error: 'That is too long. Use at most 30 short paths.' })
      .optional(),
  })
  .transform((body, ctx) => {
    let sitemap = null;
    const typed = body.sitemap?.trim();
    if (typed) {
      const site = normalizeWebsite(typed);
      if (!site.ok) {
        ctx.addIssue({
          code: 'custom',
          path: ['sitemap'],
          message: 'Enter the full address of your sitemap, such as yourcompany.com/sitemap.xml.',
        });
        return z.NEVER;
      }
      sitemap = site.url;
    }
    const parsed = parseDisallowPaths(body.disallow);
    if (parsed.error) {
      ctx.addIssue({ code: 'custom', path: ['disallow'], message: parsed.error });
      return z.NEVER;
    }
    return {
      answer: body.answer,
      training: body.training,
      other: body.other,
      sitemap,
      paths: parsed.paths,
    };
  });

export const robotsTxtGenerator = {
  slug: 'robots-txt-generator',
  kind: 'generate',
  download: true,
  name: 'Robots.txt generator for AI crawlers',
  crumb: 'Robots.txt generator',
  title: 'Robots.txt generator for AI crawlers (free) | AEO Corner',
  description:
    'Free robots.txt generator: choose which AI crawlers to allow or block, add your sitemap, and copy or download the file. It never blocks Google or Bing.',
  lastmod: '2026-10-06',
  lead: 'Choose which AI crawlers may read your site, add your sitemap, and copy or download a robots.txt that does exactly that.',
  cannotSee:
    'This tool writes a robots.txt from your choices. It does not edit your site or replace your current file, so compare it with the one you have. robots.txt is a request that well-behaved crawlers follow, not a lock, and it cannot make an AI engine mention you.',
  faq: [
    {
      q: 'Which crawlers does this generator block?',
      a: 'Only the AI crawlers you choose to block, in three groups: answer crawlers, training crawlers and others. It never blocks Googlebot, Bingbot or Applebot, so blocking AI crawlers here does not take you out of ordinary search.',
    },
    {
      q: 'Should I block AI answer crawlers?',
      a: 'Usually not. They fetch pages so an AI engine can answer a question, so blocking them can keep your pages out of those answers. Training crawlers collect pages to train models, and blocking them is a business choice.',
    },
    {
      q: 'Where do I put the file?',
      a: 'Save it as robots.txt in the top folder of your website, so it opens at yourcompany.com/robots.txt. If you already have one, compare the two first, because this file replaces everything in it. Then check it with the robots.txt checker.',
    },
    {
      q: 'What are the paths for?',
      a: 'A path such as /admin/ asks every crawler to stay out of that part of your site. List one per line, starting with a slash. A path of just a slash is refused, because it would block your whole site.',
    },
  ],
  submitLabel: 'Make my robots.txt',
  fields: [
    {
      name: 'answer',
      label: 'AI answer crawlers (ChatGPT search, Claude, Perplexity)',
      type: 'select',
      options: CHOICES,
      default: 'allow',
      hint: 'These fetch pages so an AI engine can answer a question. Blocking them can keep you out of those answers.',
    },
    {
      name: 'training',
      label: 'AI training crawlers (GPTBot, ClaudeBot, Google-Extended and others)',
      type: 'select',
      options: CHOICES,
      default: 'allow',
      hint: 'These collect pages to train models. Allowing or blocking them is your choice.',
    },
    {
      name: 'other',
      label: 'Other AI crawlers (Amazonbot, DuckAssistBot, Bytespider and others)',
      type: 'select',
      options: CHOICES,
      default: 'allow',
    },
    {
      name: 'disallow',
      label: 'Paths to keep every crawler out of',
      type: 'textarea',
      rows: 4,
      required: false,
      placeholder: '/admin/\n/cart',
      hint: 'One per line, starting with a slash. Leave it empty to allow every path.',
    },
    {
      name: 'sitemap',
      label: 'Sitemap address',
      type: 'text',
      inputmode: 'url',
      required: false,
      placeholder: 'yourcompany.com/sitemap.xml',
      hint: 'Adds a Sitemap line so crawlers can find it.',
    },
  ],
  schema,

  async run(ctx, input) {
    const made = generateRobots(input);
    return robotsGeneratorFindings({
      choices: { answer: input.answer, training: input.training, other: input.other },
      paths: input.paths,
      sitemap: input.sitemap,
      ...made,
    });
  },
};
