import { normalizePageUrl, sameSite } from '../select-pages.js';

/**
 * Small helpers the readiness checks share. A check receives a "scan context" (see index.js) and reads page
 * facts out of it; nothing here touches the network or the DOM.
 */

/** Pages whose HTML we read successfully (a 2xx response, parsed). */
export const readablePages = (ctx) =>
  ctx.pages.filter((p) => p.facts && !p.facts.skipped && p.status >= 200 && p.status < 300);

export const homePage = (ctx) => readablePages(ctx).find((p) => p.pageType === 'home') ?? null;

/** The answer for a check that needs pages when none could be read. */
export const NO_PAGES = {
  status: 'error',
  summary: 'No page of the site could be read, so this could not be checked.',
  evidence: { reason: 'no_readable_pages' },
};

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export const pathOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return '/';
  }
};

export const pct = (n) => `${Math.round(n * 100)}%`;
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Types of every JSON-LD node on a page. */
export const schemaTypes = (facts) => new Set(facts?.jsonLd?.types ?? []);

const ORG_TYPES = new Set([
  'Organization',
  'Corporation',
  'NGO',
  'LocalBusiness',
  'OnlineBusiness',
  'OnlineStore',
  'Store',
  'Restaurant',
  'ProfessionalService',
  'LegalService',
  'Attorney',
  'Dentist',
  'Physician',
  'MedicalBusiness',
  'MedicalOrganization',
  'FinancialService',
  'RealEstateAgent',
  'EducationalOrganization',
  'SportsOrganization',
  'GovernmentOrganization',
  'Hotel',
  'LodgingBusiness',
  'FoodEstablishment',
  'TravelAgency',
  'EmploymentAgency',
  'SoftwareCompany',
  'Library',
  'School',
  'CollegeOrUniversity',
  'Hospital',
  'PlaceOfWorship',
]);
const LOCAL_TYPES = new Set([
  'LocalBusiness',
  'Store',
  'Restaurant',
  'ProfessionalService',
  'LegalService',
  'Attorney',
  'Dentist',
  'Physician',
  'MedicalBusiness',
  'RealEstateAgent',
  'Hotel',
  'LodgingBusiness',
  'FoodEstablishment',
  'AutomotiveBusiness',
  'HomeAndConstructionBusiness',
  'HealthAndBeautyBusiness',
  'TravelAgency',
]);

const typesOf = (node) =>
  [node['@type']].flat().map((t) => String(t).replace(/^https?:\/\/schema\.org\//i, ''));

export const isOrganizationNode = (node) =>
  typesOf(node).some((t) => ORG_TYPES.has(t) || /(Business|Organization)$/.test(t));
export const isLocalBusinessNode = (node) =>
  typesOf(node).some((t) => LOCAL_TYPES.has(t) || /Business$/.test(t));

export const organizationNodes = (facts) => (facts?.jsonLd?.nodes ?? []).filter(isOrganizationNode);

/** A schema value that may be a string, an object with `url`, or a list of either -> list of non-empty strings. */
export function stringsOf(value) {
  return [value]
    .flat()
    .map((v) => (typeof v === 'string' ? v : (v?.url ?? v?.['@id'] ?? v?.contentUrl ?? '')))
    .map((v) => String(v).trim())
    .filter(Boolean);
}

/** A name stripped to what identifies it, so "Acme, Inc." and "ACME" compare equal. */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pty|sa|srl|bv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Two names agree if one contains the other ("Acme" and "Acme Widgets"), once both are normalised. */
export function namesAgree(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x.length < 2 || y.length < 2) return false;
  return x === y || x.includes(y) || y.includes(x);
}

const QUESTION_START =
  /^(who|what|why|how|when|where|which|can|could|does|do|did|is|are|should|will|would|may|am)\b/i;
export const isQuestion = (text) => /\?\s*$/.test(text) || QUESTION_START.test(text.trim());

export const wordsIn = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

/** Is this page's own address the same as the canonical it names? */
export function sameAddress(a, b) {
  const x = normalizePageUrl(a);
  const y = normalizePageUrl(b);
  return Boolean(x && y && x === y);
}

export { sameSite };
