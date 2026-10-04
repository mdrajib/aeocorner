import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { validateJsonLd } from './jsonld.js';

/**
 * Auto-fix (UI_DESIGN D3, CUSTOMER_JOURNEY "Fix paths"): a recommendation whose fix is a block of structured data that
 * the AEO Corner plugin can put on the customer's home page. Pure: what a fix would write, how it is shown, and the
 * fingerprint that ties "what you previewed" to "what is sent".
 *
 * Only what the plugin can really do is offered: a JSON-LD block for one address. A recommendation whose rule is not
 * in `AUTOFIX_RULES` (robots.txt, sitemaps, page titles) keeps its steps and "Mark as done"; nothing here pretends otherwise.
 * Nothing is invented: a field we do not know (a logo, a profile link) is left out and said to be left out, never guessed.
 *
 * The plugin keeps ONE block per address, and writing it replaces the one before. So every home-page fix writes the
 * whole graph: the nodes already applied for this site plus its own, the same type replacing the same type.
 */

export const AUTOFIX_RULES = Object.freeze({
  'readiness.C1': {
    type: 'Organization',
    label: 'Organization schema',
    action: 'Add Organization schema to your home page',
  },
  'readiness.C4': {
    type: 'WebSite',
    label: 'WebSite schema',
    action: 'Add WebSite schema to your home page',
  },
});

export const isAutofixable = (ruleCode) => Object.hasOwn(AUTOFIX_RULES, ruleCode);

export const homeUrlOf = (domain) =>
  `https://${String(domain).trim().toLowerCase().replace(/\/+$/, '')}/`;

const withSlash = (url) => (String(url).endsWith('/') ? String(url) : `${url}/`);

const MAX_PROFILES = 10;

const httpsUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password
      ? u.toString()
      : null;
  } catch {
    return null;
  }
};

/**
 * The two things a customer can add on the screen: the address of a logo image, and profile links (one per line or
 * comma separated). Anything that is not a plain https address is refused with a message, never quietly dropped.
 */
export function parseExtras({ logoUrl = '', sameAs = '' } = {}) {
  const errors = {};
  const logo = String(logoUrl ?? '').trim();
  let logoOk = null;
  if (logo) {
    logoOk = httpsUrl(logo);
    if (!logoOk) errors.logoUrl = 'The logo must be a full https:// address of an image.';
  }
  const raw = String(sameAs ?? '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const profiles = [];
  for (const line of raw) {
    const ok = httpsUrl(line);
    if (!ok) {
      errors.sameAs = `“${line.slice(0, 60)}” is not a full https:// address.`;
      break;
    }
    if (!profiles.includes(ok)) profiles.push(ok);
  }
  if (profiles.length > MAX_PROFILES) errors.sameAs = `Add at most ${MAX_PROFILES} profile links.`;
  return Object.keys(errors).length
    ? { ok: false, errors }
    : { ok: true, logoUrl: logoOk, sameAs: profiles };
}

/** Key order does not matter: MySQL stores JSON with its own key order, and the hash must survive that. */
export const fingerprint = (jsonld) =>
  createHash('sha256').update(canonicalJson(jsonld)).digest('hex');

/**
 * Work out what a fix would write.
 *
 * @param {object} p
 * @param {string} p.ruleCode      `readiness.C1` or `readiness.C4`
 * @param {object} p.brand         `{ name, legalName?, definition? }` from the Brand Kit
 * @param {string} [p.homeUrl]     the home page as the plugin knows it (the connected WordPress site)
 * @param {string} [p.domain]      the project's domain, used when there is no `homeUrl`
 * @param {{logoUrl?: string|null, sameAs?: string[]}} [p.extras]  from `parseExtras`
 * @param {object[]} [p.existingNodes]  the nodes already applied to the home page
 * @returns {{ ok: true, targetUrl, jsonld, node, hash, includes, notIncluded } | { ok: false, reason }}
 */
export function buildAutofix({
  ruleCode,
  brand,
  homeUrl = null,
  domain = null,
  extras = {},
  existingNodes = [],
}) {
  const rule = AUTOFIX_RULES[ruleCode];
  if (!rule) return { ok: false, reason: 'This recommendation cannot be fixed automatically.' };
  const name = String(brand?.name ?? '').trim();
  if (!name || !(homeUrl || domain)) {
    return { ok: false, reason: 'We need the brand name and the website address first.' };
  }
  const targetUrl = homeUrl ? withSlash(homeUrl) : homeUrlOf(domain);
  const includes = [`The name “${name}”`, `The address ${targetUrl}`];
  const notIncluded = [];
  const node = {
    '@type': rule.type,
    '@id': `${targetUrl}#${rule.type.toLowerCase()}`,
    name,
    url: targetUrl,
  };

  if (rule.type === 'Organization') {
    const legal = String(brand.legalName ?? '').trim();
    if (legal && legal !== name) {
      node.legalName = legal;
      includes.push(`The legal name “${legal}”`);
    }
    const about = String(brand.definition ?? '').trim();
    if (about) {
      node.description = about;
      includes.push('The description from your Brand Kit');
    }
    if (extras.logoUrl) {
      node.logo = extras.logoUrl;
      includes.push('Your logo');
    } else {
      notIncluded.push('A logo: add its address below to earn that part of the check.');
    }
    if (extras.sameAs?.length) {
      node.sameAs = extras.sameAs;
      includes.push(`${extras.sameAs.length} profile link${extras.sameAs.length === 1 ? '' : 's'}`);
    } else {
      notIncluded.push(
        'Profile links (LinkedIn, Crunchbase…): add them below to earn that part of the check.',
      );
    }
  }

  const kept = existingNodes.filter((n) => n && n['@type'] !== rule.type);
  const jsonld = { '@context': 'https://schema.org', '@graph': [...kept, node] };
  const valid = validateJsonLd(jsonld);
  if (!valid.ok) {
    return {
      ok: false,
      reason: `The structured data did not pass its check: ${valid.errors[0].message}`,
    };
  }
  return { ok: true, targetUrl, jsonld, node, hash: fingerprint(jsonld), includes, notIncluded };
}
