/**
 * Which trade and local directories to suggest for a business (Entity screen, the "A trade directory" checklist).
 * Pure. The list is reviewed by a person and dated: a model never picks a directory, and we never suggest one we have
 * not looked at (the same rule as the type of a cited source, `citation-types.js`). A country with no entry here still
 * gets worldwide ones, so the customer is never left with nothing. We make no account and post nothing: each entry
 * is a place the customer can apply to themselves, on the directory's own terms.
 *
 * Adding a country is a few entries below, each with a page that exists on its `checkedOn` date. Listing terms,
 * fees and review times belong to the directory, so we describe what we saw and tell the customer to read theirs.
 */

export const DIRECTORIES_CHECKED_ON = '2026-10-06';

/** How many are suggested at most. Local ones come first; worldwide ones fill what is left. */
export const MAX_DIRECTORIES = 3;

/**
 * `countries`: ISO codes it serves, or `null` for worldwide. `software`: only worth suggesting to a software or
 * online-service business. `kind`: trade_body, chamber, local or marketplace, only used for the label.
 */
export const DIRECTORIES = Object.freeze([
  // Bangladesh (checked 2026-10-06 on each site's own pages and press reports)
  {
    id: 'basis',
    name: 'BASIS (Bangladesh Association of Software and Information Services)',
    url: 'https://basis.org.bd',
    countries: ['BD'],
    software: true,
    kind: 'trade_body',
    about:
      'The national trade body for software and IT services companies, with over a thousand members. Press reports in 2019 said software firms must join; check its current rule.',
  },
  {
    id: 'khojkorun',
    name: 'KhojKorun',
    url: 'https://www.khojkorun.com',
    countries: ['BD'],
    software: false,
    kind: 'local',
    about:
      'A Bangladesh business directory that says listings are free. It already lists software companies among its categories.',
  },
  {
    id: 'bangladesh-com',
    name: 'Bangladesh.com Business Directory',
    url: 'https://www.bangladesh.com/add-my-business/',
    countries: ['BD'],
    software: false,
    kind: 'local',
    about:
      'An English-language directory for businesses with a connection to Bangladesh. Submissions go through an editorial review, which it says takes 5 to 7 business days.',
  },
  {
    id: 'dcci',
    name: 'Dhaka Chamber of Commerce & Industry (DCCI)',
    url: 'https://dhakachamber.com',
    countries: ['BD'],
    software: false,
    kind: 'chamber',
    about:
      'The largest business chamber in Bangladesh. Membership is applied for on its site; its member query page is an enquiry form, not a public list.',
  },

  // India
  {
    id: 'nasscom',
    name: 'NASSCOM',
    url: 'https://nasscom.in',
    countries: ['IN'],
    software: true,
    kind: 'trade_body',
    about:
      'The trade association of Indian software and IT services companies, with thousands of members. Membership is applied for with company details and checked by NASSCOM.',
  },
  {
    id: 'justdial',
    name: 'Justdial',
    url: 'https://www.justdial.com',
    countries: ['IN'],
    software: false,
    kind: 'local',
    about:
      'India’s best-known local business directory. It offers free listings next to paid ones.',
  },
  {
    id: 'indiamart',
    name: 'IndiaMART',
    url: 'https://seller.indiamart.com/',
    countries: ['IN'],
    software: false,
    kind: 'marketplace',
    about:
      'A large business-to-business marketplace in India. A free catalogue listing exists, with paid plans for more exposure.',
  },

  // Worldwide
  {
    id: 'g2',
    name: 'G2',
    url: 'https://sell.g2.com/create-a-profile',
    countries: null,
    software: true,
    kind: 'marketplace',
    about:
      'A software review site that buyers and engines read. A vendor can claim its profile for free; paid marketing is optional.',
  },
  {
    id: 'capterra',
    name: 'Capterra',
    url: 'https://www.capterra.com/vendors/',
    countries: null,
    software: true,
    kind: 'marketplace',
    about:
      'A software directory where vendors list their product. Read its vendor terms and costs before applying.',
  },
  {
    id: 'bing-places',
    name: 'Bing Places for Business',
    url: 'https://www.bingplaces.com/',
    countries: null,
    software: false,
    kind: 'local',
    about:
      'Microsoft’s business listing, which feeds Bing and the engines built on it. It needs a real place or service area.',
  },
]);

const SOFTWARE_WORDS =
  /\b(software|saas|app|apps|platform|tool|tools|tech|technology|digital|online|cloud|invoic\w*|account\w*|crm|erp)\b/i;

/** Whether what the customer told us about the business sounds like software or an online service. */
export function looksLikeSoftware(...texts) {
  return texts.some((t) => SOFTWARE_WORDS.test(String(t ?? '')));
}

const KIND_LABELS = Object.freeze({
  trade_body: 'Trade body',
  chamber: 'Chamber of commerce',
  local: 'Local directory',
  marketplace: 'Marketplace',
});

/**
 * Up to `MAX_DIRECTORIES` places to list the business, at least one. Local ones (the project's country) come first, a
 * trade body ahead of general ones for a software business; worldwide ones fill what is left. A software-only entry
 * is left out for a business that does not look like software. Never empty: there are always worldwide entries.
 * @returns {{ id, name, url, scope: 'local'|'worldwide', kindLabel, about }[]}
 */
export function suggestDirectories({ country, category = '', definition = '' } = {}) {
  const code = String(country ?? '')
    .trim()
    .toUpperCase();
  const software = looksLikeSoftware(category, definition);
  const fits = (d) => software || !d.software;
  const shape = (d, scope) => ({
    id: d.id,
    name: d.name,
    url: d.url,
    scope,
    kindLabel: KIND_LABELS[d.kind],
    about: d.about,
  });
  // Software businesses see trade bodies and software sites first; everyone else sees general ones first.
  const rank = (d) => (software && d.software ? 0 : 1);
  const byRank = (a, b) => rank(a) - rank(b);

  const local = DIRECTORIES.filter((d) => d.countries?.includes(code) && fits(d)).sort(byRank);
  const worldwide = DIRECTORIES.filter((d) => d.countries === null && fits(d)).sort(byRank);
  return [
    ...local.slice(0, MAX_DIRECTORIES).map((d) => shape(d, 'local')),
    ...worldwide.map((d) => shape(d, 'worldwide')),
  ].slice(0, MAX_DIRECTORIES);
}
