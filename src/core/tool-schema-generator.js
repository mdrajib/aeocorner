import { scriptTag, validateJsonLd } from './jsonld.js';

/**
 * The free schema markup generator (Milestone 17, task 17.10). Pure: from what the visitor typed to a JSON-LD document and
 * the findings that explain it. It writes only what was typed: an empty field is left out, never filled in, and nothing is
 * guessed. The result goes through `validateJsonLd` (strict, the same check our own markup passes) and the
 * `<script>` text comes only from `scriptTag`, which refuses a document that does not validate.
 *
 * Four types: Organization, LocalBusiness, FAQPage and Article. Each uses some of the fields; a field typed for another
 * type is left out and said so.
 */

export const SCHEMA_TYPES = Object.freeze(['Organization', 'LocalBusiness', 'FAQPage', 'Article']);

/** Which form fields each type uses. */
export const TYPE_FIELDS = Object.freeze({
  Organization: [
    'name',
    'url',
    'description',
    'logo',
    'email',
    'telephone',
    'sameAs',
    'foundingYear',
    'street',
    'city',
    'region',
    'postcode',
    'country',
  ],
  LocalBusiness: [
    'name',
    'url',
    'description',
    'logo',
    'email',
    'telephone',
    'sameAs',
    'street',
    'city',
    'region',
    'postcode',
    'country',
    'hours',
    'priceRange',
  ],
  FAQPage: ['faq', 'url'],
  Article: [
    'headline',
    'description',
    'url',
    'image',
    'author',
    'published',
    'modified',
    'publisher',
  ],
});

/** Words for the findings. */
export const FIELD_LABELS = Object.freeze({
  name: 'Name',
  url: 'Web address',
  description: 'Description',
  logo: 'Logo',
  email: 'Email',
  telephone: 'Phone',
  sameAs: 'Profile links',
  foundingYear: 'Founding year',
  street: 'Street',
  city: 'Town or city',
  region: 'Region',
  postcode: 'Postcode',
  country: 'Country',
  hours: 'Opening hours',
  priceRange: 'Price range',
  faq: 'Questions and answers',
  headline: 'Headline',
  image: 'Image',
  author: 'Author',
  published: 'Date published',
  modified: 'Date modified',
  publisher: 'Publisher',
});

export const MAX_FAQ_PAIRS = 20;
export const MAX_SAME_AS = 10;

/** Text that cannot go into a `<script>` block as it stands: the validator refuses it too. */
export const hasMarkup = (text) => /<\/script|<!--|<script/i.test(text);

/**
 * Questions and answers from a box of text: a blank line between pairs, the question on the first line and the answer on
 * the lines below it. `{ pairs }` or `{ error }` naming the pair.
 */
export function parseFaqPairs(text) {
  const blocks = String(text ?? '')
    .split(/\r?\n[ \t]*\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const pairs = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const [first, ...rest] = blocks[i]
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const question = first.replace(/^q\s*[:.)-]\s*/i, '').trim();
    const answer = rest
      .join(' ')
      .replace(/^a\s*[:.)-]\s*/i, '')
      .trim();
    if (!question || !answer)
      return {
        error: `Pair ${i + 1}: put the question on the first line and the answer on the lines below it, with a blank line between pairs.`,
      };
    if (question.length > 300)
      return { error: `Pair ${i + 1}: the question is longer than 300 characters.` };
    if (answer.length > 2000)
      return { error: `Pair ${i + 1}: the answer is longer than 2,000 characters.` };
    if (hasMarkup(question) || hasMarkup(answer))
      return {
        error: `Pair ${i + 1}: remove the markup, such as <script>, which cannot go in structured data.`,
      };
    pairs.push({ question, answer });
    if (pairs.length > MAX_FAQ_PAIRS) return { error: `Use at most ${MAX_FAQ_PAIRS} questions.` };
  }
  return { pairs };
}

const put = (node, key, value) => {
  if (value !== undefined && value !== null && value !== '') node[key] = value;
};

/**
 * @param {string} type  one of SCHEMA_TYPES
 * @param {object} f     the typed fields, already cleaned: a missing or empty field is undefined
 * @returns {{ doc: object, used: string[], ignored: string[] }}
 */
export function buildSchemaDocument(type, f) {
  if (!SCHEMA_TYPES.includes(type)) throw new RangeError(`Unknown schema type "${type}"`);
  const node = { '@context': 'https://schema.org', '@type': type };
  const wanted = TYPE_FIELDS[type];
  const typed = Object.keys(FIELD_LABELS).filter(
    (k) =>
      f[k] !== undefined &&
      f[k] !== null &&
      f[k] !== '' &&
      !(Array.isArray(f[k]) && f[k].length === 0),
  );
  const used = typed.filter((k) => wanted.includes(k));
  const ignored = typed.filter((k) => !wanted.includes(k));

  if (type === 'Organization' || type === 'LocalBusiness') {
    put(node, 'name', f.name);
    put(node, 'url', f.url);
    put(node, 'description', f.description);
    put(node, 'logo', f.logo);
    put(node, 'email', f.email);
    put(node, 'telephone', f.telephone);
    if (f.sameAs?.length) node.sameAs = f.sameAs;
    if (type === 'Organization') put(node, 'foundingDate', f.foundingYear);
    const address = {};
    put(address, 'streetAddress', f.street);
    put(address, 'addressLocality', f.city);
    put(address, 'addressRegion', f.region);
    put(address, 'postalCode', f.postcode);
    put(address, 'addressCountry', f.country);
    if (Object.keys(address).length) node.address = { '@type': 'PostalAddress', ...address };
    if (type === 'LocalBusiness') {
      put(node, 'openingHours', f.hours);
      put(node, 'priceRange', f.priceRange);
    }
  } else if (type === 'FAQPage') {
    put(node, 'url', f.url);
    node.mainEntity = (f.faq ?? []).map((p) => ({
      '@type': 'Question',
      name: p.question,
      acceptedAnswer: { '@type': 'Answer', text: p.answer },
    }));
  } else if (type === 'Article') {
    put(node, 'headline', f.headline);
    put(node, 'description', f.description);
    if (f.url) {
      node.url = f.url;
      node.mainEntityOfPage = f.url;
    }
    put(node, 'image', f.image);
    if (f.author) node.author = { '@type': 'Person', name: f.author };
    put(node, 'datePublished', f.published);
    put(node, 'dateModified', f.modified);
    if (f.publisher) node.publisher = { '@type': 'Organization', name: f.publisher };
  }
  return { doc: node, used, ignored };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (keys) => keys.map((k) => FIELD_LABELS[k]).join(', ');
const propOf = (path) =>
  String(path)
    .split('.')
    .pop()
    .replace(/\[\d+\]$/, '');

/**
 * Validate the document and write the findings. If it does not validate, no markup is produced: the problems are the
 * answer. `{ findings, ok }`.
 */
export function schemaGeneratorFindings({ type, doc, used, ignored }) {
  const validation = validateJsonLd(doc);
  let script = null;
  // Written out over several lines, so a person can read it and see what it says. The escaping is the same.
  if (validation.ok) script = scriptTag(doc, { pretty: true });

  const rows = [
    { label: 'Type', state: 'neutral', value: type },
    {
      label: 'What it says',
      state: 'neutral',
      value: String(used.length),
      detail: used.length ? names(used) : 'Nothing: no field was filled in.',
    },
  ];
  if (ignored.length)
    rows.push({
      label: 'Left out',
      state: 'neutral',
      value: String(ignored.length),
      detail: `${names(ignored)}: ${plural(ignored.length, 'field')} you filled in that a ${type} does not use.`,
    });
  rows.push(
    validation.ok
      ? {
          label: 'Checked',
          state: 'good',
          value: 'No errors',
          detail: 'It passes the same check as our structured data validator.',
        }
      : { label: 'Checked', state: 'bad', value: plural(validation.errors.length, 'problem') },
  );
  for (const e of validation.errors.slice(0, 10))
    rows.push({ label: propOf(e.path), state: 'bad', detail: e.message });
  for (const w of validation.warnings.slice(0, 10))
    rows.push({
      label: propOf(w.path),
      state: 'warn',
      detail: `${w.message} Add it above if it applies.`,
    });

  const placement = {
    Organization: 'Organization markup belongs on your home page, once.',
    LocalBusiness: 'Business markup belongs on your home page or the page for that location, once.',
    FAQPage: 'Only put FAQ markup on a page that shows these same questions and answers.',
    Article:
      'Article markup belongs on that article’s own page, and must match what the page says.',
  }[type];

  const headline = validation.ok
    ? `Your ${type} markup is ready, with no errors found`
    : `Your ${type} markup has ${plural(validation.errors.length, 'problem')}, so no markup was made`;

  return {
    ok: validation.ok,
    findings: {
      headline,
      sections: [{ heading: 'Your markup', rows }],
      ...(script ? { output: { filename: 'structured-data.html', text: `${script}\n` } } : {}),
      notes: [
        ...(script
          ? [
              'Paste the block into the HTML of the page it describes, inside the head or the body.',
              placement,
              'The markup must say only what the page says. Check it with our structured data validator once it is live.',
            ]
          : [
              'Fix the problems and make it again. We never produce markup that does not validate.',
            ]),
        'Structured data helps crawlers read your page. It does not promise a search result or a mention in an AI answer.',
      ],
    },
  };
}
