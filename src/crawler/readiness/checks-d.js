import {
  homePage,
  hostOf,
  isLocalBusinessNode,
  NO_PAGES,
  namesAgree,
  organizationNodes,
  readablePages,
  stringsOf,
  wordsIn,
} from './helpers.js';

/**
 * D. Entity clarity (15 points). Can an engine tell WHO this business is, consistently, from the site alone?
 * These are heuristics on the page text and schema; the LLM-based Brand Kit extraction (Phase 6) goes deeper.
 */

/** D1 (4): the brand name is the same in the page title, og:site_name and the schema. */
export function d1(ctx) {
  const home = homePage(ctx);
  if (!home) return NO_PAGES;
  const { facts } = home;
  const org = organizationNodes(facts)[0];
  const webSite = facts.jsonLd.nodes.find((n) => [n['@type']].flat().includes('WebSite'));
  const schemaName = stringsOf(org?.name)[0] ?? stringsOf(webSite?.name)[0] ?? '';
  const ogName = facts.ogSiteName;

  const evidence = { schemaName, ogSiteName: ogName, title: facts.title };
  const known = [schemaName, ogName].filter(Boolean);

  if (schemaName && ogName && !namesAgree(schemaName, ogName)) {
    return {
      score: 0,
      summary: `The schema calls the business "${schemaName}" but og:site_name says "${ogName}". Engines see two different names.`,
      evidence,
    };
  }
  const reference = known[0];
  const titleAgrees = reference ? facts.titleSegments.some((s) => namesAgree(s, reference)) : false;
  const agreeing = known.length + (titleAgrees ? 1 : 0);
  if (known.length === 0) {
    return {
      score: facts.title ? 0.25 : 0,
      summary:
        'Neither the schema nor og:site_name states the business name, so there is nothing to cross-check the title against.',
      evidence,
    };
  }
  const score = { 1: 0.25, 2: 0.75, 3: 1 }[agreeing] ?? 0.25;
  return {
    score,
    summary:
      agreeing === 3
        ? `"${reference}" is used consistently in the title, og:site_name and schema.`
        : titleAgrees
          ? `The name "${reference}" matches the title, but only one other place states it (${schemaName ? 'schema' : 'og:site_name'}).`
          : `The page title does not contain the name "${reference}" that the ${schemaName ? 'schema' : 'og:site_name'} gives.`,
    evidence: { ...evidence, titleAgrees },
  };
}

const DEFINES =
  /\b(is an?|are an?|we are|we help|we build|we make|we provide|we offer|we design|we create|we serve|our mission|specializ(?:e|es|ing) in|provides?|offers?)\b/i;
const PLACE_OR_AUDIENCE =
  /\b(based in|headquartered|located in|located at|founded in|since\s+\d{4}|serving|serves|for (?:small|medium|mid-size|enterprise|businesses|teams|companies|customers|clients|families|students|brands|agencies|organizations|professionals|owners))\b/i;

/** D2 (4): an About page that says who, what, where and for whom. */
export function d2(ctx) {
  if (readablePages(ctx).length === 0) return NO_PAGES;
  const about = ctx.pages.find((p) => p.pageType === 'about');
  if (!about) {
    return {
      score: 0,
      summary:
        'No About page was found among the key pages, so engines have no page that says who you are.',
      evidence: { found: false },
    };
  }
  if (!about.facts || about.facts.skipped || about.status < 200 || about.status >= 300) {
    return {
      status: 'error',
      summary: `The About page (${about.url}) could not be read.`,
      evidence: { url: about.url, status: about.status ?? null, error: about.error ?? null },
    };
  }
  const paragraphs = about.facts.blocks.filter((b) => b.type === 'p');
  const lead = paragraphs.slice(0, 4);
  const leadText = lead.map((b) => b.text).join(' ');
  const checks = {
    pageExists: true,
    substantialParagraph: lead.some((b) => b.words >= 40),
    saysWhatItIs: DEFINES.test(leadText),
    saysWhereOrForWhom: PLACE_OR_AUDIENCE.test(leadText),
  };
  const earned = Object.values(checks).filter(Boolean).length;
  const missing = [];
  if (!checks.substantialParagraph) missing.push('a clear opening paragraph of a few sentences');
  if (!checks.saysWhatItIs) missing.push('a sentence saying what the business is or does');
  if (!checks.saysWhereOrForWhom) missing.push('where it is based or who it serves');
  return {
    score: earned / 4,
    summary: missing.length
      ? `The About page (${about.url}) is missing ${missing.join(', ')}.`
      : `The About page (${about.url}) says what the business is, where, and for whom.`,
    evidence: { url: about.url, ...checks, words: lead.reduce((sum, b) => sum + b.words, 0) },
  };
}

// Profile sites a search or answer engine treats as proof that a business is who it says it is (MVP §6.6 D3).
const AUTHORITATIVE = [
  ['LinkedIn', /(^|\.)linkedin\.com$/],
  ['Wikipedia', /(^|\.)wikipedia\.org$/],
  ['Wikidata', /(^|\.)wikidata\.org$/],
  ['Crunchbase', /(^|\.)crunchbase\.com$/],
  ['G2', /(^|\.)g2\.com$/],
  ['Google Business Profile', /(^|\.)(g\.page|business\.google\.com|maps\.app\.goo\.gl)$/],
];
function authoritativeName(url) {
  const host = hostOf(url);
  if (host.endsWith('google.com') && /\/maps\//.test(url)) return 'Google Business Profile';
  return AUTHORITATIVE.find(([, re]) => re.test(host))?.[0] ?? null;
}

/** D3 (4): the Organization schema's sameAs links to authoritative profiles. Links only in the footer count half. */
export function d3(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const inSchema = new Set();
  for (const p of pages) {
    for (const node of organizationNodes(p.facts)) {
      for (const url of stringsOf(node.sameAs)) {
        const name = authoritativeName(url);
        if (name) inSchema.add(name);
      }
    }
  }
  const onPageOnly = new Set();
  for (const p of pages) {
    for (const link of p.facts.links) {
      const name = authoritativeName(link.href);
      if (name && !inSchema.has(name)) onPageOnly.add(name);
    }
  }
  const score = Math.min(1, (inSchema.size * 2 + onPageOnly.size) / 6);
  return {
    score,
    summary: inSchema.size
      ? `sameAs links to ${[...inSchema].join(', ')}${onPageOnly.size ? `; ${[...onPageOnly].join(', ')} are linked on the page but not in the schema` : ''}.`
      : onPageOnly.size
        ? `${[...onPageOnly].join(', ')} are linked on the page, but the schema's sameAs does not list them.`
        : 'No links to authoritative profiles (LinkedIn, Wikipedia, Wikidata, Crunchbase, G2, Google Business Profile) were found.',
    evidence: { inSchema: [...inSchema], onPageOnly: [...onPageOnly] },
  };
}

const digits = (text) => String(text).replace(/\D/g, '');

/** D4 (3): name, address and phone agree between the schema and the page. Only for local businesses. */
export function d4(ctx) {
  const pages = readablePages(ctx);
  if (pages.length === 0) return NO_PAGES;
  const local = pages.flatMap((p) => organizationNodes(p.facts)).find(isLocalBusinessNode);
  if (!local) {
    return {
      status: 'not_applicable',
      summary:
        'The site does not present itself as a local business, so address and phone consistency do not apply.',
      evidence: {},
    };
  }
  const schemaPhone = digits(stringsOf(local.telephone)[0] ?? '').slice(-9);
  const address = local.address && typeof local.address === 'object' ? local.address : {};
  const street = String(address.streetAddress ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const pageText = pages.map((p) => p.facts.text.toLowerCase().replace(/\s+/g, ' ')).join(' ');
  const visiblePhones = new Set(
    pages
      .flatMap((p) => [...p.facts.phoneNumbers, ...p.facts.telLinks])
      .map((n) => digits(n).slice(-9))
      .filter((n) => n.length >= 7),
  );

  const phoneShown = schemaPhone.length >= 7 && visiblePhones.has(schemaPhone);
  const addressShown = street.length >= 5 && pageText.includes(street);
  const consistent =
    visiblePhones.size <= 1 && (visiblePhones.size === 0 || phoneShown || schemaPhone.length < 7);
  const checks = {
    schemaHasPhone: schemaPhone.length >= 7,
    schemaHasAddress: street.length >= 5,
    phoneShown,
    addressShown,
    consistent,
  };

  const earned = [phoneShown, addressShown, consistent].filter(Boolean).length;
  const problems = [];
  if (!checks.schemaHasPhone) problems.push('the schema has no telephone');
  else if (!phoneShown) problems.push("the schema's phone number is not on the page");
  if (!checks.schemaHasAddress) problems.push('the schema has no street address');
  else if (!addressShown) problems.push("the schema's street address is not on the page");
  if (visiblePhones.size > 1) problems.push('more than one phone number appears on the site');
  return {
    score: earned / 3,
    summary: problems.length
      ? `Name, address and phone are not consistent: ${problems.join('; ')}.`
      : 'The address and phone number in the schema match what the page shows.',
    evidence: { ...checks, phonesOnPages: visiblePhones.size, words: wordsIn(street) },
  };
}
