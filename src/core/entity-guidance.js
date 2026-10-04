import { platformLabel } from './entity-profiles.js';

/**
 * Fill-in-the-blank guidance for the profiles AEO Corner cannot touch (Milestone 12, task 12.07): the steps to take and
 * the exact text to paste, taken from the customer's Brand Kit. Pure. We create no account and post nothing: this is a
 * checklist the customer carries out themselves.
 *
 * Every piece of text comes from something the customer typed; where they have not typed it, the field is listed in
 * `missing` with where to add it, never invented. Platform limits were checked on 2026-10-04 against secondary
 * sources (the platforms' own help pages are behind sign-in): Google Business Profile descriptions 750 characters, no links, no
 * prices or promotions; LinkedIn tagline 120 characters and "About" 200 to 2,000; Wikidata keeps an item only if it has a
 * Wikipedia article, is needed by another item, or has identifiers and serious public sources. Platforms change; each
 * checklist says to follow the platform's own screen where it differs.
 */

export const CHECKLIST_PLATFORMS = Object.freeze([
  'google_business',
  'linkedin',
  'crunchbase',
  'wikidata',
  'directory',
]);

export const GUIDANCE_CHECKED_ON = '2026-10-04';

/** Cut at a word boundary, with an ellipsis only when something was cut. Never longer than `max`. */
export function clipWords(text, max) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

const websiteOf = (domain) => `https://${String(domain).replace(/^www\./, '')}/`;

/** What the Brand Kit says, as the fields a profile asks for. Each is `''` when the customer has not said. */
export function profileFacts(kit, { domain }) {
  const id = kit?.identity ?? {};
  const en = kit?.entity ?? {};
  return {
    name: id.brandName ?? '',
    legalName: id.legalName ?? '',
    description: id.definition ?? '',
    category: id.category ?? '',
    founded: en.foundingYear ?? '',
    location: en.headquarters || id.geography || '',
    website: domain ? websiteOf(domain) : '',
  };
}

const field = (label, value, { hint = null } = {}) => ({ label, value, hint });

function common(facts) {
  const missing = [];
  if (!facts.description) missing.push({ what: 'a one-line description', where: 'Identity' });
  if (!facts.category) missing.push({ what: 'a category', where: 'Identity' });
  if (!facts.founded) missing.push({ what: 'the year you were founded', where: 'Entity' });
  if (!facts.location) missing.push({ what: 'where you are based', where: 'Entity' });
  return missing;
}

const BUILDERS = {
  google_business(f) {
    const description = clipWords(f.description, 750);
    return {
      intro:
        'Your Google Business Profile is what Google shows beside your name in search and in Maps, and AI engines that use Google read it. It needs a place, a phone number or a service area, and Google checks that you are who you say you are.',
      start: 'https://business.google.com/',
      steps: [
        'Search for your business at business.google.com. If it is already listed, claim it instead of adding a second one.',
        'Fill in the fields below exactly as they are written. Keep the name, address and phone number identical to your website.',
        'Complete Google’s verification (it asks for a code by phone, email or video). The profile does not show until you do.',
        'Add your website address, your hours and a few photos.',
      ],
      fields: [
        f.name &&
          field('Business name', f.name, {
            hint: 'Exactly as on your website: no keywords added.',
          }),
        f.category &&
          field('Category', f.category, { hint: 'Pick the closest category Google offers.' }),
        f.website && field('Website', f.website),
        description &&
          field('Business description', description, {
            hint: 'Up to 750 characters. No links, no prices or promotions.',
          }),
        f.founded &&
          field('Opening date', f.founded, { hint: 'Google asks for the month and year.' }),
        f.location &&
          field('Where you are', f.location, {
            hint: 'Your street address goes in the address fields.',
          }),
      ],
      notes: [
        'Google does not allow links, prices or promotions in the description.',
        'Follow Google’s own screen where it differs from this list: platforms change.',
      ],
    };
  },

  linkedin(f) {
    return {
      intro:
        'A LinkedIn Page is one of the first places engines look to confirm a company is real, and it often links to your site.',
      start: 'https://www.linkedin.com/company/setup/new/',
      steps: [
        'Sign in with your own LinkedIn account and choose to create a Company page.',
        'Fill in the fields below exactly as they are written. Use the same name as your website.',
        'Add your website address and the year you were founded, then publish the page.',
        'Put the page’s address in your Brand Kit (Entity tab) so we can check it.',
      ],
      fields: [
        f.name && field('Page name', f.name),
        f.website && field('Website', f.website),
        f.description &&
          field('Tagline', clipWords(f.description, 120), { hint: 'Up to 120 characters.' }),
        f.description &&
          field('About', f.description, {
            hint: 'LinkedIn asks for at least 200 characters, so add to this if it is shorter.',
          }),
        f.category &&
          field('Industry', f.category, { hint: 'Pick the closest industry LinkedIn offers.' }),
        f.founded && field('Year founded', f.founded),
        f.location && field('Headquarters', f.location),
      ],
      notes: [
        'LinkedIn often shows only a sign-in page to our checker, so the check may say “couldn’t check”. That does not mean the page is wrong.',
      ],
    };
  },

  crunchbase(f) {
    return {
      intro:
        'Crunchbase is a company directory that many engines and databases copy from. A profile there, kept in line with your site, repeats your facts in another trusted place.',
      start: 'https://www.crunchbase.com/',
      steps: [
        'Search Crunchbase for your company. If it is there, use the page’s option to claim or request an edit rather than adding a duplicate.',
        'Fill in the fields below exactly as they are written.',
        'Add your website, so the profile links back to you, and put the profile’s address in your Brand Kit (Entity tab).',
      ],
      fields: [
        f.name && field('Organization name', f.name),
        f.legalName && field('Legal name', f.legalName),
        f.description && field('Short description', clipWords(f.description, 200)),
        f.website && field('Website', f.website),
        f.founded && field('Founded', f.founded),
        f.location && field('Headquarters', f.location),
        f.category && field('Industry', f.category),
      ],
      notes: [
        'Crunchbase decides what it accepts. Follow its own screen where it differs from this list.',
      ],
    };
  },

  wikidata(f) {
    return {
      intro:
        'Wikidata is the free database that search and answer engines use to tell businesses apart. It keeps an item only for things that independent sources have written about, so many small or new businesses do not qualify. We never write to Wikidata or to Google’s Knowledge Graph for you.',
      start: 'https://www.wikidata.org/',
      steps: [
        'Search Wikidata for your business first. If an item is yours, add its number (like Q12345) to your Brand Kit and stop here.',
        'Only if you can point to independent public sources (news articles, books, official registers) that describe your business, create an item with the fields below, and cite those sources on each statement.',
        'If you cannot, do not create one: items without such sources are deleted. Dismiss this task instead.',
        'Add the item’s number to your Brand Kit (Entity tab) so we can check it.',
      ],
      fields: [
        f.name && field('Label', f.name),
        f.description &&
          field('Description', clipWords(f.description, 250), {
            hint: 'A short, neutral phrase, like “dental practice in Austin”.',
          }),
        f.website && field('Official website (P856)', f.website),
        f.founded && field('Inception (P571)', f.founded),
        f.location && field('Headquarters location (P159)', f.location),
      ],
      notes: [
        'Wikipedia has stricter rules and discourages writing about your own business. Do not write your own article.',
      ],
    };
  },

  directory(f) {
    return {
      intro:
        'A trade or local directory that serves your industry repeats your name, address and website. The more places agree, the more sure an engine can be about who you are.',
      start: null,
      steps: [
        'Pick one or two directories people in your trade actually use (a professional body’s member list, a local chamber of commerce).',
        'Fill in the fields below exactly as they are written, so every listing matches your website.',
        'Put each listing’s address in your Brand Kit (Entity tab) so we can check it names you.',
      ],
      fields: [
        f.name && field('Business name', f.name),
        f.website && field('Website', f.website),
        f.description && field('Description', clipWords(f.description, 400)),
        f.location && field('Location', f.location),
        f.founded && field('Year founded', f.founded),
      ],
      notes: [],
    };
  },
};

/**
 * The checklist for one platform, from the Brand Kit.
 * @returns {{ platform, label, intro, start, steps, fields: {label,value,hint}[], notes, missing: {what, where}[], checkedOn }}
 */
export function checklistFor(platform, kit, { domain }) {
  const build = BUILDERS[platform];
  if (!build) throw new RangeError(`No checklist for ${platform}`);
  const facts = profileFacts(kit, { domain });
  const built = build(facts);
  return {
    platform,
    label: platform === 'directory' ? 'A trade directory' : platformLabel(platform),
    ...built,
    fields: built.fields.filter(Boolean),
    missing: common(facts),
    checkedOn: GUIDANCE_CHECKED_ON,
  };
}

/** Every checklist, marking the ones the customer already has a profile for (a listed address on that platform). */
export function checklists(kit, { domain }) {
  const have = new Set((kit?.entity?.profiles ?? []).map((p) => p.platform));
  return CHECKLIST_PLATFORMS.map((platform) => ({
    ...checklistFor(platform, kit, { domain }),
    listed: platform === 'wikidata' ? Boolean(kit?.entity?.wikidataId) : have.has(platform),
  }));
}
