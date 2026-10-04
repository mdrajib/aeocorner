/**
 * The JSON-LD validator (MVP F8 step 7, task 7.01): structured data is checked here before it is saved, before it is
 * approved and again before it is sent to a customer's site. Pure, no network.
 *
 * It checks against a vocabulary of schema.org for the types this product writes (Article, FAQPage, HowTo, Product,
 * Organization, LocalBusiness and what they contain), not all 800: a type or property outside the table is an error
 * ("we do not write this"), which is the point, because every template here is ours and a typo must not reach a
 * customer's site. The table is hand-copied from schema.org's type pages (checked 2026-10-04) and the "required" and
 * "recommended" lists follow Google's structured-data documentation for the same types. A new type is a new row, with a
 * passing and a failing fixture in `jsonld.test.js`.
 *
 * What it refuses, beyond the vocabulary:
 *   - text that could end the `<script>` block it is placed in (`</script`, `<!--`), see `scriptTag`
 *   - a value of the wrong kind (a date that is not ISO 8601, a URL that is not http(s), a number that is text)
 *   - a context other than schema.org, a node without a type, nesting deeper than 8, more than 300 nodes
 *   - a FAQPage whose questions have no answers, a HowTo with no steps: schema.org allows it, search engines ignore it
 *
 * Warnings are things worth fixing that do not make the markup wrong (a missing `dateModified`, no image).
 */

const MAX_DEPTH = 8;
const MAX_NODES = 300;
const MAX_TEXT = 20_000;

/** type -> { parent, props: { name: 'kinds' }, required, recommended }; a kind is Text, URL, Date, Number, Boolean or a type. */
const VOCAB = {
  Thing: {
    props: {
      name: 'Text',
      description: 'Text',
      url: 'URL',
      image: 'URL ImageObject',
      sameAs: 'URL',
      alternateName: 'Text',
      identifier: 'Text URL',
      mainEntityOfPage: 'URL WebPage',
    },
  },
  CreativeWork: {
    parent: 'Thing',
    props: {
      author: 'Person Organization',
      publisher: 'Person Organization',
      datePublished: 'Date',
      dateModified: 'Date',
      dateCreated: 'Date',
      headline: 'Text',
      inLanguage: 'Text',
      keywords: 'Text',
      about: 'Thing',
      mentions: 'Thing',
      isPartOf: 'URL CreativeWork',
      license: 'URL',
      text: 'Text',
      wordCount: 'Number',
      thumbnailUrl: 'URL',
      citation: 'Text URL CreativeWork',
      abstract: 'Text',
    },
  },
  Article: {
    parent: 'CreativeWork',
    props: { articleBody: 'Text', articleSection: 'Text', speakable: 'Text' },
    required: ['headline'],
    recommended: ['author', 'datePublished', 'dateModified', 'image', 'publisher'],
  },
  BlogPosting: { parent: 'Article' },
  WebPage: {
    parent: 'CreativeWork',
    props: {
      breadcrumb: 'BreadcrumbList',
      lastReviewed: 'Date',
      primaryImageOfPage: 'ImageObject',
    },
  },
  // The site's own WebSite block (src/web/meta.js). The customer templates never write it; the marketing site's
  // validation test (tests/routes/marketing-pages.test.js) does.
  WebSite: {
    parent: 'CreativeWork',
    props: { publisher: 'Organization Person' },
    required: ['name', 'url'],
  },
  FAQPage: {
    parent: 'WebPage',
    props: { mainEntity: 'Question' },
    required: ['mainEntity'],
  },
  Question: {
    parent: 'CreativeWork',
    props: { acceptedAnswer: 'Answer', suggestedAnswer: 'Answer', answerCount: 'Number' },
    required: ['name', 'acceptedAnswer'],
  },
  Answer: {
    parent: 'CreativeWork',
    props: { upvoteCount: 'Number' },
    required: ['text'],
  },
  HowTo: {
    parent: 'CreativeWork',
    props: {
      step: 'HowToStep',
      totalTime: 'Text',
      supply: 'HowToSupply',
      tool: 'HowToTool',
      estimatedCost: 'Text',
      yield: 'Text',
    },
    required: ['name', 'step'],
    recommended: ['description', 'image'],
  },
  HowToStep: {
    parent: 'CreativeWork',
    props: { position: 'Number', itemListElement: 'HowToDirection' },
    required: ['text'],
  },
  HowToDirection: { parent: 'CreativeWork' },
  HowToSupply: { parent: 'Thing' },
  HowToTool: { parent: 'Thing' },
  Product: {
    parent: 'Thing',
    props: {
      brand: 'Brand Organization',
      offers: 'Offer',
      sku: 'Text',
      gtin: 'Text',
      mpn: 'Text',
      aggregateRating: 'AggregateRating',
      review: 'Review',
      category: 'Text',
      manufacturer: 'Organization',
      model: 'Text',
      color: 'Text',
      material: 'Text',
    },
    required: ['name'],
    recommended: ['image', 'description', 'offers'],
  },
  Service: {
    parent: 'Thing',
    props: {
      provider: 'Organization Person',
      areaServed: 'Text',
      serviceType: 'Text',
      offers: 'Offer',
      brand: 'Brand Organization',
    },
    required: ['name'],
    recommended: ['provider', 'description'],
  },
  Brand: { parent: 'Thing', props: { logo: 'URL ImageObject' } },
  Offer: {
    parent: 'Thing',
    props: {
      price: 'Number Text',
      priceCurrency: 'Text',
      availability: 'URL Text',
      priceValidUntil: 'Date',
      seller: 'Organization Person',
      itemCondition: 'URL Text',
    },
    recommended: ['price', 'priceCurrency'],
  },
  AggregateRating: {
    parent: 'Thing',
    props: {
      ratingValue: 'Number Text',
      reviewCount: 'Number',
      ratingCount: 'Number',
      bestRating: 'Number Text',
      worstRating: 'Number Text',
      itemReviewed: 'Thing',
    },
    required: ['ratingValue'],
  },
  Review: {
    parent: 'CreativeWork',
    props: { reviewRating: 'Rating', reviewBody: 'Text', itemReviewed: 'Thing' },
    required: ['author'],
  },
  Rating: {
    parent: 'Thing',
    props: { ratingValue: 'Number Text', bestRating: 'Number Text', worstRating: 'Number Text' },
  },
  Organization: {
    parent: 'Thing',
    props: {
      legalName: 'Text',
      logo: 'URL ImageObject',
      email: 'Text',
      telephone: 'Text',
      address: 'PostalAddress Text',
      contactPoint: 'ContactPoint',
      foundingDate: 'Date',
      founder: 'Person',
      areaServed: 'Text',
      slogan: 'Text',
      brand: 'Brand Organization',
      parentOrganization: 'Organization',
      knowsAbout: 'Text',
    },
    required: ['name'],
    recommended: ['url', 'logo', 'sameAs'],
  },
  LocalBusiness: {
    parent: 'Organization',
    props: {
      openingHours: 'Text',
      priceRange: 'Text',
      geo: 'GeoCoordinates',
      paymentAccepted: 'Text',
    },
    recommended: ['address', 'telephone'],
  },
  Person: {
    parent: 'Thing',
    props: {
      jobTitle: 'Text',
      worksFor: 'Organization',
      email: 'Text',
      telephone: 'Text',
      knowsAbout: 'Text',
      alumniOf: 'Organization Text',
      honorificPrefix: 'Text',
    },
    required: ['name'],
  },
  PostalAddress: {
    parent: 'Thing',
    props: {
      streetAddress: 'Text',
      addressLocality: 'Text',
      addressRegion: 'Text',
      postalCode: 'Text',
      addressCountry: 'Text',
    },
  },
  ContactPoint: {
    parent: 'Thing',
    props: {
      contactType: 'Text',
      telephone: 'Text',
      email: 'Text',
      areaServed: 'Text',
      availableLanguage: 'Text',
    },
  },
  GeoCoordinates: { parent: 'Thing', props: { latitude: 'Number', longitude: 'Number' } },
  ImageObject: {
    parent: 'CreativeWork',
    props: { contentUrl: 'URL', width: 'Number Text', height: 'Number Text', caption: 'Text' },
  },
  BreadcrumbList: {
    parent: 'Thing',
    props: { itemListElement: 'ListItem', numberOfItems: 'Number' },
    required: ['itemListElement'],
  },
  ListItem: {
    parent: 'Thing',
    props: { position: 'Number', item: 'URL Thing' },
    required: ['position'],
  },
};

/** The types this product writes, for the screens and the tests. */
export const SUPPORTED_TYPES = Object.freeze(Object.keys(VOCAB));

const LINEAGE = new Map();
function lineageOf(type) {
  if (LINEAGE.has(type)) return LINEAGE.get(type);
  const chain = [];
  for (let t = type; t; t = VOCAB[t]?.parent) chain.push(t);
  LINEAGE.set(type, chain);
  return chain;
}

const specOf = (type, prop) => {
  for (const t of lineageOf(type)) {
    const kinds = VOCAB[t]?.props?.[prop];
    if (kinds) return kinds.split(' ');
  }
  return null;
};
const listOf = (type, key) => [...new Set(lineageOf(type).flatMap((t) => VOCAB[t]?.[key] ?? []))];
const isSubtype = (type, ofType) => lineageOf(type).includes(ofType);

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const isDate = (s) => {
  if (!ISO_DATE.test(s)) return false;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) return false;
  // A date like 2026-02-31 parses in some engines by rolling over; the first ten characters must survive.
  const day = new Date(t).toISOString().slice(0, 10);
  return s.length > 10 || day === s;
};
const isHttpUrl = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};
const DANGEROUS = /<\/script|<!--|<script/i;

/**
 * Check one JSON-LD document (an object, an array of objects, or an object with `@graph`).
 *
 * @param {unknown} input  parsed JSON, or a JSON string
 * @returns {{ ok: boolean, errors: {path,message}[], warnings: {path,message}[], types: string[], nodes: number }}
 */
export function validateJsonLd(input) {
  const errors = [];
  const warnings = [];
  const types = [];
  let nodes = 0;
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  let doc = input;
  if (typeof input === 'string') {
    if (input.length > 500_000) {
      err('$', 'The structured data is too large.');
      return { ok: false, errors, warnings, types, nodes };
    }
    try {
      doc = JSON.parse(input);
    } catch {
      err('$', 'The structured data is not valid JSON.');
      return { ok: false, errors, warnings, types, nodes };
    }
  }

  const checkContext = (ctx, path) => {
    const okCtx = (c) => typeof c === 'string' && /^https?:\/\/schema\.org\/?$/i.test(c);
    if (!(okCtx(ctx) || (Array.isArray(ctx) && ctx.length === 1 && okCtx(ctx[0])))) {
      err(path, 'The @context must be "https://schema.org".');
    }
  };

  const checkText = (value, path) => {
    if (value.length > MAX_TEXT) err(path, 'This text is too long.');
    if (DANGEROUS.test(value))
      err(path, 'This text contains markup that is not allowed in structured data.');
  };

  const checkValue = (value, kinds, path, depth, ownerType, prop) => {
    if (Array.isArray(value)) {
      if (value.length === 0) err(path, `${prop} is an empty list.`);
      value.forEach((item, i) => {
        if (Array.isArray(item)) err(`${path}[${i}]`, 'Lists inside lists are not allowed.');
        else checkValue(item, kinds, `${path}[${i}]`, depth, ownerType, prop);
      });
      return;
    }
    if (value && typeof value === 'object') {
      const nodeKinds = kinds.filter((k) => VOCAB[k]);
      if (nodeKinds.length === 0) {
        err(path, `${prop} must be ${describeKinds(kinds)}, not an object.`);
        return;
      }
      const type = checkNode(value, path, depth + 1, { expected: nodeKinds });
      if (type && !nodeKinds.some((k) => isSubtype(type, k))) {
        err(path, `${prop} on a ${ownerType} must be ${describeKinds(kinds)}, not a ${type}.`);
      }
      return;
    }
    if (typeof value === 'string') {
      checkText(value, path);
      if (value.trim() === '') return err(path, `${prop} is empty.`);
      const accepts = (k) =>
        k === 'Text' ||
        (k === 'URL' && isHttpUrl(value)) ||
        (k === 'Date' && isDate(value)) ||
        (k === 'Number' && /^-?\d+(\.\d+)?$/.test(value) && kinds.includes('Text'));
      if (kinds.includes('Text')) return;
      if (kinds.some(accepts)) return;
      if (kinds.includes('Date'))
        return err(path, `${prop} must be an ISO 8601 date such as 2026-10-04.`);
      if (kinds.includes('URL'))
        return err(path, `${prop} must be a full web address starting with https://.`);
      return err(path, `${prop} must be ${describeKinds(kinds)}, not text.`);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return err(path, `${prop} is not a finite number.`);
      if (!kinds.includes('Number'))
        err(path, `${prop} must be ${describeKinds(kinds)}, not a number.`);
      return;
    }
    err(
      path,
      `${prop} has a value that is not allowed (${value === null ? 'null' : typeof value}).`,
    );
  };

  const describeKinds = (kinds) => {
    const words = kinds.map(
      (k) =>
        ({ Text: 'text', URL: 'a web address', Date: 'a date', Number: 'a number' })[k] ?? `a ${k}`,
    );
    return words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
  };

  /** Returns the node's type (its first known one) so the caller can check it is the kind the property accepts. */
  function checkNode(node, path, depth, { top = false, expected = null } = {}) {
    nodes += 1;
    if (nodes > MAX_NODES) {
      if (nodes === MAX_NODES + 1) err(path, 'The structured data has too many parts.');
      return null;
    }
    if (depth > MAX_DEPTH) {
      err(path, 'The structured data is nested too deeply.');
      return null;
    }
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      err(path, 'This must be an object.');
      return null;
    }
    if (top && '@context' in node) checkContext(node['@context'], `${path}.@context`);
    else if (top && !('@graph' in node)) err(path, 'The @context is missing.');
    else if (!top && '@context' in node)
      err(`${path}.@context`, 'Only the top level carries an @context.');

    let rawType = node['@type'];
    if (Array.isArray(rawType)) {
      if (rawType.length !== 1) {
        err(`${path}.@type`, 'Use one type per node.');
        rawType = rawType[0];
      } else rawType = rawType[0];
    }
    if (rawType === undefined && expected?.length === 1) rawType = expected[0];
    if (typeof rawType !== 'string' || !rawType) {
      err(path, 'This part has no @type.');
      return null;
    }
    const type = rawType.replace(/^(?:https?:\/\/schema\.org\/|schema:)/, '');
    if (!VOCAB[type]) {
      err(`${path}.@type`, `"${type}" is not a type we write.`);
      return null;
    }
    types.push(type);

    for (const [prop, value] of Object.entries(node)) {
      if (prop === '@type' || prop === '@context') continue;
      if (prop === '@id') {
        if (typeof value !== 'string' || !value) err(`${path}.@id`, '@id must be text.');
        else checkText(value, `${path}.@id`);
        continue;
      }
      if (prop.startsWith('@')) {
        err(`${path}.${prop}`, `${prop} is not allowed here.`);
        continue;
      }
      const kinds = specOf(type, prop);
      if (!kinds) {
        err(`${path}.${prop}`, `"${prop}" is not a property of ${type}.`);
        continue;
      }
      checkValue(value, kinds, `${path}.${prop}`, depth, type, prop);
    }

    const present = (p) => {
      const v = node[p];
      if (v === undefined || v === null) return false;
      if (typeof v === 'string') return v.trim() !== '';
      if (Array.isArray(v)) return v.length > 0;
      return true;
    };
    for (const prop of listOf(type, 'required')) {
      if (!present(prop)) err(`${path}.${prop}`, `A ${type} needs ${prop}.`);
    }
    for (const prop of listOf(type, 'recommended')) {
      if (!present(prop)) warn(`${path}.${prop}`, `A ${type} is better with ${prop}.`);
    }
    if (type === 'Offer' && present('price') && !present('priceCurrency')) {
      err(`${path}.priceCurrency`, 'An offer with a price needs a currency such as "USD".');
    }
    if (type === 'Question' && node.acceptedAnswer && node.suggestedAnswer) {
      warn(path, 'A question usually has an accepted answer or suggested ones, not both.');
    }
    return type;
  }

  if (doc === null || typeof doc !== 'object') {
    err('$', 'The structured data must be an object.');
    return { ok: false, errors, warnings, types, nodes };
  }
  if (Array.isArray(doc)) {
    if (doc.length === 0) err('$', 'The structured data is empty.');
    doc.forEach((node, i) => checkNode(node, `$[${i}]`, 0, { top: true }));
  } else if ('@graph' in doc) {
    checkContext(doc['@context'], '$.@context');
    for (const key of Object.keys(doc)) {
      if (key !== '@context' && key !== '@graph')
        err(`$.${key}`, `${key} is not allowed next to @graph.`);
    }
    if (!Array.isArray(doc['@graph']) || doc['@graph'].length === 0) {
      err('$.@graph', 'The @graph must be a list of objects.');
    } else {
      doc['@graph'].forEach((node, i) => {
        const copy = node && typeof node === 'object' && !Array.isArray(node) ? { ...node } : node;
        checkNode(copy, `$.@graph[${i}]`, 0, { top: false });
      });
    }
  } else {
    checkNode(doc, '$', 0, { top: true });
  }

  return { ok: errors.length === 0, errors, warnings, types: [...new Set(types)], nodes };
}

/**
 * The `<script type="application/ld+json">` block for a document that passed `validateJsonLd`. `<`, `>`, `&` and the
 * two line separators are written as escapes, so no string in it can close the script or start a comment. Throws on a
 * document that does not validate: markup is never produced from unchecked data.
 */
export function scriptTag(doc) {
  const result = validateJsonLd(doc);
  if (!result.ok) throw new RangeError(`Invalid JSON-LD: ${result.errors[0].message}`);
  const json = JSON.stringify(doc)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  return `<script type="application/ld+json">${json}</script>`;
}

/** One line per problem, for a screen or a log: "Article.headline: A Article needs headline." */
export const problemLines = (result) => [...result.errors.map((e) => `${e.path}: ${e.message}`)];
