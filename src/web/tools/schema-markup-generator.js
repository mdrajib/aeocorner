import { z } from 'zod';
import {
  buildSchemaDocument,
  hasMarkup,
  MAX_SAME_AS,
  parseFaqPairs,
  SCHEMA_TYPES,
  schemaGeneratorFindings,
  TYPE_FIELDS,
} from '../../core/tool-schema-generator.js';

/**
 * Schema markup generator (Milestone 17, task 17.10). It runs our own code on what was typed: no request leaves us, so it
 * is a `generate` run. Every field is checked here, for the fields the chosen type uses, with a message by the field; the
 * document is built and checked again by `src/core/tool-schema-generator.js`, and no markup comes out of anything that does
 * not validate. Only what was typed is written.
 */

const MARKUP = 'Remove the markup, such as <script>, which cannot go in structured data.';
const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** A full web address: a missing https:// is added, and it must look like a real host. */
function address(raw) {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(text);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password)
      return null;
    if (!u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}
const ADDRESS_MESSAGE = 'Enter a full web address, such as https://yourcompany.com.';

const text = (max) => (raw) => {
  if (raw.length > max) return { error: `Keep this under ${max} characters.` };
  if (hasMarkup(raw)) return { error: MARKUP };
  return { value: raw };
};
const web = (raw) => {
  const value = address(raw);
  return value ? { value } : { error: ADDRESS_MESSAGE };
};
const date = (raw) => {
  const ok =
    /^\d{4}-\d{2}-\d{2}$/.test(raw) &&
    new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw;
  return ok ? { value: raw } : { error: 'Use a date like 2026-10-06.' };
};

/** How each field is read. A field returns `{ value }` or `{ error }`. */
const READERS = {
  name: text(200),
  url: web,
  description: text(500),
  logo: web,
  email: (raw) =>
    raw.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw)
      ? { value: raw }
      : { error: 'Enter an email address, like you@yourcompany.com.' },
  telephone: text(40),
  sameAs: (raw) => {
    const lines = raw
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > MAX_SAME_AS) return { error: `Use at most ${MAX_SAME_AS} links.` };
    const out = [];
    for (let i = 0; i < lines.length; i += 1) {
      const value = address(lines[i]);
      if (!value) return { error: `Line ${i + 1}: ${ADDRESS_MESSAGE}` };
      if (!out.includes(value)) out.push(value);
    }
    return { value: out };
  },
  foundingYear: (raw) =>
    /^(1[89]|20)\d{2}$/.test(raw)
      ? { value: raw }
      : { error: 'Use a four-digit year, such as 2014.' },
  street: text(200),
  city: text(100),
  region: text(100),
  postcode: text(20),
  country: text(100),
  hours: text(200),
  priceRange: text(40),
  faq: (raw) => {
    const parsed = parseFaqPairs(raw);
    return parsed.error ? { error: parsed.error } : { value: parsed.pairs };
  },
  headline: text(160),
  image: web,
  author: text(200),
  published: date,
  modified: date,
  publisher: text(200),
};

const REQUIRED = {
  Organization: { name: 'Enter the name of the business.' },
  LocalBusiness: { name: 'Enter the name of the business.' },
  FAQPage: { faq: 'Add at least one question and its answer.' },
  Article: { headline: 'Enter the headline of the article.' },
};

const SHAPE = Object.fromEntries(
  Object.keys(READERS).map((k) => [
    k,
    z.string().max(60_000, { error: 'That is too long.' }).optional(),
  ]),
);

const schema = z
  .object({ type: z.enum(SCHEMA_TYPES, { error: 'Choose a type of markup.' }), ...SHAPE })
  .transform((body, ctx) => {
    const fields = {};
    const issue = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
    for (const key of Object.keys(READERS)) {
      const raw = clean(body[key]);
      if (!raw) continue;
      // A field this type does not use is not checked: it is left out, and the findings say so.
      if (!TYPE_FIELDS[body.type].includes(key)) {
        fields[key] = raw;
        continue;
      }
      const read = READERS[key](raw);
      if (read.error) issue(key, read.error);
      else fields[key] = read.value;
    }
    for (const [key, message] of Object.entries(REQUIRED[body.type])) {
      if (!fields[key] && !(ctx.issues ?? []).some((i) => i.path[0] === key)) issue(key, message);
    }
    return { type: body.type, fields };
  });

const GROUPS = {
  type: 'What do you want to mark up?',
  business: 'About the business (Organization and LocalBusiness)',
  address: 'Address (Organization and LocalBusiness)',
  faq: 'Questions and answers (FAQPage)',
  article: 'The article (Article)',
};

export const schemaMarkupGenerator = {
  slug: 'schema-markup-generator',
  kind: 'generate',
  download: true,
  name: 'Schema markup generator (JSON-LD)',
  crumb: 'Schema markup generator',
  title: 'Schema markup generator for JSON-LD (free) | AEO Corner',
  description:
    'Free schema markup generator: make valid JSON-LD for an organization, a local business, an FAQ or an article, and copy or download it. No account needed.',
  lastmod: '2026-10-06',
  lead: 'Choose a type, fill in what you know, and copy valid JSON-LD structured data for your page. It writes only what you type.',
  cannotSee:
    'This tool writes structured data from what you type and checks that it is valid. It cannot check that it is true, or that it matches your page, which it must. It cannot promise a rich result in search or a mention in an AI answer. Leave a field empty and it is left out.',
  faq: [
    {
      q: 'What is schema markup?',
      a: 'Schema markup is a block of structured data in your page, usually JSON-LD, that says in a form software can read who you are or what the page is. Search engines and AI crawlers read it.',
    },
    {
      q: 'Does this tool make anything up?',
      a: 'No. It writes only what you type, and leaves empty fields out. It checks the result with the same validator as our structured data validator, and it will not give you markup that fails that check.',
    },
    {
      q: 'Where do I paste the markup?',
      a: 'Paste the whole block into the HTML of the page it describes, inside the head or the body. Put Organization markup on your home page once, and put Article markup on the article’s own page.',
    },
    {
      q: 'Will schema markup get me into AI answers?',
      a: 'We cannot promise that, and nobody can. Markup helps crawlers read your page correctly. Whether an AI engine names you depends on much more. The free audit asks the engines and shows you the real answers.',
    },
  ],
  submitLabel: 'Make my markup',
  fields: [
    {
      name: 'type',
      group: GROUPS.type,
      label: 'Type of markup',
      type: 'select',
      default: 'Organization',
      options: [
        { value: 'Organization', label: 'Organization (a company, charity or brand)' },
        { value: 'LocalBusiness', label: 'Local business (a shop, clinic or office)' },
        { value: 'FAQPage', label: 'FAQ page (questions and answers)' },
        { value: 'Article', label: 'Article (a blog post or news article)' },
      ],
    },
    {
      name: 'name',
      group: GROUPS.business,
      label: 'Name',
      type: 'text',
      required: false,
      hint: 'Required for an Organization or a local business.',
    },
    {
      name: 'url',
      group: GROUPS.business,
      label: 'Web address',
      type: 'text',
      inputmode: 'url',
      required: false,
      placeholder: 'https://yourcompany.com',
      hint: 'Your site for an Organization, or the page itself for an FAQ page or an article.',
    },
    {
      name: 'description',
      group: GROUPS.business,
      label: 'Description',
      type: 'textarea',
      rows: 3,
      required: false,
      hint: 'One or two sentences. Also used for an article.',
    },
    {
      name: 'logo',
      group: GROUPS.business,
      label: 'Logo address',
      type: 'text',
      inputmode: 'url',
      required: false,
      placeholder: 'https://yourcompany.com/logo.png',
    },
    {
      name: 'email',
      group: GROUPS.business,
      label: 'Email',
      type: 'text',
      inputmode: 'email',
      required: false,
    },
    {
      name: 'telephone',
      group: GROUPS.business,
      label: 'Phone',
      type: 'text',
      inputmode: 'tel',
      required: false,
    },
    {
      name: 'sameAs',
      group: GROUPS.business,
      label: 'Profile links',
      type: 'textarea',
      rows: 3,
      required: false,
      hint: 'Your LinkedIn, Facebook or other profile addresses, one per line.',
    },
    {
      name: 'foundingYear',
      group: GROUPS.business,
      label: 'Founding year',
      type: 'text',
      inputmode: 'numeric',
      required: false,
      placeholder: '2014',
      hint: 'Organization only.',
    },
    {
      name: 'hours',
      group: GROUPS.business,
      label: 'Opening hours',
      type: 'text',
      required: false,
      placeholder: 'Mo-Fr 09:00-17:00',
      hint: 'Local business only.',
    },
    {
      name: 'priceRange',
      group: GROUPS.business,
      label: 'Price range',
      type: 'text',
      required: false,
      placeholder: '$$',
      hint: 'Local business only.',
    },
    { name: 'street', group: GROUPS.address, label: 'Street', type: 'text', required: false },
    { name: 'city', group: GROUPS.address, label: 'Town or city', type: 'text', required: false },
    {
      name: 'region',
      group: GROUPS.address,
      label: 'Region or state',
      type: 'text',
      required: false,
    },
    { name: 'postcode', group: GROUPS.address, label: 'Postcode', type: 'text', required: false },
    { name: 'country', group: GROUPS.address, label: 'Country', type: 'text', required: false },
    {
      name: 'faq',
      group: GROUPS.faq,
      label: 'Questions and answers',
      type: 'textarea',
      rows: 8,
      required: false,
      placeholder:
        'How long does a visit take?\nAbout 45 minutes.\n\nDo you take walk-ins?\nYes, until 4pm.',
      hint: 'The question on the first line, the answer below it, and a blank line between pairs. They must be the ones your page shows.',
    },
    {
      name: 'headline',
      group: GROUPS.article,
      label: 'Headline',
      type: 'text',
      required: false,
      hint: 'Required for an article.',
    },
    { name: 'author', group: GROUPS.article, label: 'Author name', type: 'text', required: false },
    {
      name: 'published',
      group: GROUPS.article,
      label: 'Date published',
      type: 'text',
      required: false,
      placeholder: '2026-10-06',
    },
    {
      name: 'modified',
      group: GROUPS.article,
      label: 'Date last changed',
      type: 'text',
      required: false,
      placeholder: '2026-10-06',
    },
    {
      name: 'image',
      group: GROUPS.article,
      label: 'Image address',
      type: 'text',
      inputmode: 'url',
      required: false,
    },
    {
      name: 'publisher',
      group: GROUPS.article,
      label: 'Publisher name',
      type: 'text',
      required: false,
    },
  ],
  schema,

  async run(ctx, input) {
    const { doc, used, ignored } = buildSchemaDocument(input.type, input.fields);
    return schemaGeneratorFindings({ type: input.type, doc, used, ignored }).findings;
  },
};
