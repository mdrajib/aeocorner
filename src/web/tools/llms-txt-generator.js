import { z } from 'zod';
import {
  generateLlms,
  llmsGeneratorFindings,
  MAX_NAME,
  MAX_SUMMARY,
  parseLinks,
  plainLine,
} from '../../core/tool-llms-generator.js';

/**
 * llms.txt generator (Milestone 17, task 17.11). It runs our own code on what was typed: no request leaves us, so it is a
 * `generate` run. The page says plainly that no engine is known to need the file (founder decision G5).
 */

const schema = z
  .object({
    name: z.string().max(1000, { error: 'That is too long.' }).optional(),
    summary: z.string().max(5000, { error: 'That is too long.' }).optional(),
    links: z
      .string()
      .max(20_000, { error: 'That is too long. Use at most 10 short lines.' })
      .optional(),
  })
  .transform((body, ctx) => {
    const issue = (path, message) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
      return z.NEVER;
    };
    const name = plainLine(body.name, 'the name', MAX_NAME);
    if (name.error) return issue('name', name.error);
    if (!name.value) return issue('name', 'Enter the name of your business or site.');
    const summary = plainLine(body.summary, 'the summary', MAX_SUMMARY);
    if (summary.error) return issue('summary', summary.error);
    const parsed = parseLinks(body.links);
    if (parsed.error) return issue('links', parsed.error);
    return { name: name.value, summary: summary.value, links: parsed.links };
  });

export const llmsTxtGenerator = {
  slug: 'llms-txt-generator',
  kind: 'generate',
  download: true,
  name: 'llms.txt generator',
  crumb: 'llms.txt generator',
  title: 'llms.txt generator (free) | AEO Corner',
  description:
    'Free llms.txt generator: add your name, a summary and your key pages, then copy or download the file. No engine is known to need one. No account needed.',
  lastmod: '2026-10-07',
  lead: 'Add your name, a one-line summary and up to ten key pages, and copy or download an llms.txt in the common format.',
  cannotSee:
    'This tool writes an llms.txt from what you type. No AI engine is known to need the file, and nobody has shown that it changes what an engine says about you. It cannot check that your links work. Adding it is harmless.',
  faq: [
    {
      q: 'What is an llms.txt file?',
      a: 'It is a short Markdown file at the top of your site that names your business and lists your key pages with a line about each. It was proposed as a way to point AI tools at the pages that matter.',
    },
    {
      q: 'Do AI engines use llms.txt?',
      a: 'No engine is known to need it. Some have not said whether they read it, and nobody has shown that it changes what an engine says about you. It is harmless to add, so treat it as a small extra.',
    },
    {
      q: 'Where do I put the file?',
      a: 'Save it as llms.txt in the top folder of your website, so it opens at yourcompany.com/llms.txt. Our free audit looks for it and reports it as information only, never as a failure.',
    },
    {
      q: 'What should I list in it?',
      a: 'Your best pages for a newcomer: what you do, pricing, a guide or two, and how to contact you. Keep it to ten at most. Every link needs a title, and a short note on what the page covers helps.',
    },
  ],
  submitLabel: 'Make my llms.txt',
  fields: [
    {
      name: 'name',
      label: 'Name',
      type: 'text',
      placeholder: 'Acme Dental',
      hint: 'Your business or site name. It becomes the title of the file.',
    },
    {
      name: 'summary',
      label: 'One-line summary',
      type: 'text',
      required: false,
      placeholder: 'A family dental clinic in Leeds offering checkups, crowns and whitening.',
      hint: 'What you do, in a sentence.',
    },
    {
      name: 'links',
      label: 'Key pages',
      type: 'textarea',
      rows: 8,
      required: false,
      placeholder:
        'Pricing | yourcompany.com/pricing | Plans and prices\nAbout us | yourcompany.com/about\nGuide to crowns | yourcompany.com/crowns | How crowns are made and what they cost',
      hint: 'One per line: a title, then |, then the address, then optionally | and a short note. Up to 10.',
    },
  ],
  schema,

  async run(ctx, input) {
    const made = generateLlms(input);
    return llmsGeneratorFindings({ ...input, ...made });
  },
};
