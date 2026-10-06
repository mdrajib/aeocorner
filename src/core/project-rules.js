import { createHash } from 'node:crypto';
import { DATAFORSEO_LOCATION_CODES } from '../engines/locations.js';

/**
 * Rules for a project that don't need the database (DATABASE_SCHEMA §3 "projects"): which slot of the week it is
 * tracked in, and what the setup form may contain. Pure, so the repository and the screens share one answer.
 */

/** Countries a question can be asked from today (the engine adapters' location table). */
export const COUNTRIES = Object.freeze({
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  NZ: 'New Zealand',
  IE: 'Ireland',
  IN: 'India',
  SG: 'Singapore',
  ZA: 'South Africa',
  AE: 'United Arab Emirates',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NL: 'Netherlands',
  SE: 'Sweden',
  BR: 'Brazil',
  MX: 'Mexico',
  JP: 'Japan',
  PH: 'Philippines',
  BD: 'Bangladesh',
  SA: 'Saudi Arabia',
  QA: 'Qatar',
  KW: 'Kuwait',
  BH: 'Bahrain',
  OM: 'Oman',
  JO: 'Jordan',
  LB: 'Lebanon',
  IQ: 'Iraq',
  IL: 'Israel',
  EG: 'Egypt',
  MA: 'Morocco',
  DZ: 'Algeria',
  TN: 'Tunisia',
  TR: 'Türkiye',
  PK: 'Pakistan',
  LK: 'Sri Lanka',
  NP: 'Nepal',
  ID: 'Indonesia',
  MY: 'Malaysia',
  TH: 'Thailand',
  VN: 'Vietnam',
  KR: 'South Korea',
  NG: 'Nigeria',
  KE: 'Kenya',
  GH: 'Ghana',
  PL: 'Poland',
  PT: 'Portugal',
  CH: 'Switzerland',
  AT: 'Austria',
  BE: 'Belgium',
  DK: 'Denmark',
  NO: 'Norway',
  FI: 'Finland',
  CZ: 'Czechia',
  GR: 'Greece',
  UA: 'Ukraine',
  AR: 'Argentina',
  CL: 'Chile',
  CO: 'Colombia',
  PE: 'Peru',
});
export const LANGUAGES = Object.freeze({
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  sv: 'Swedish',
  pt: 'Portuguese',
  ja: 'Japanese',
  // Each of these is a language code that both the ChatGPT and the Gemini LLM Scraper accept (checked 2026-10-06).
  ar: 'Arabic',
  bn: 'Bengali',
  hi: 'Hindi',
  ur: 'Urdu',
  fa: 'Persian',
  he: 'Hebrew',
  tr: 'Turkish',
  id: 'Indonesian',
  ms: 'Malay',
  th: 'Thai',
  vi: 'Vietnamese',
  ko: 'Korean',
  pl: 'Polish',
  cs: 'Czech',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  el: 'Greek',
  uk: 'Ukrainian',
  ne: 'Nepali',
  ta: 'Tamil',
});

export const CADENCES = ['weekly', 'daily'];
export const HOURS_IN_WEEK = 168;

/**
 * The hour of the week (0-167) a project's weekly run is scheduled in. A hash of its public ID, so projects
 * spread evenly over the week (provider load stays flat) and a project's slot never changes.
 */
export function weeklySlotHour(publicId) {
  const digest = createHash('sha256').update(String(publicId)).digest();
  return digest.readUInt32BE(0) % HOURS_IN_WEEK;
}

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/**
 * Check and tidy the fields of a new or edited project. Returns `{ ok: true, value }` or `{ ok: false, errors }`
 * where `errors` is `{ field: message }` in words a customer can act on. A field that isn't in `input` is left
 * out of `value` (so an edit can change one thing).
 */
export function checkProjectFields(input, { partial = false } = {}) {
  const errors = {};
  const value = {};
  const has = (key) => input[key] !== undefined;

  if (!partial || has('name')) {
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 128) errors.name = 'Use between 2 and 128 characters.';
    else value.name = name;
  }
  if (!partial || has('country')) {
    const country = typeof input.country === 'string' ? input.country.trim() : '';
    if (!Object.hasOwn(DATAFORSEO_LOCATION_CODES, country.toUpperCase()))
      errors.country = 'Choose a country.';
    else value.country = country.toUpperCase();
  }
  if (!partial || has('language')) {
    const language = typeof input.language === 'string' ? input.language.trim() : '';
    if (!LANGUAGE.test(language)) errors.language = 'Choose a language.';
    else value.language = language.toLowerCase();
  }
  if (has('city')) {
    const city = typeof input.city === 'string' ? input.city.trim() : '';
    if (city.length > 128) errors.city = 'Use 128 characters or fewer.';
    else value.city = city;
  }
  if (has('cadence')) {
    if (!CADENCES.includes(input.cadence)) errors.cadence = 'Choose weekly or daily.';
    else value.cadence = input.cadence;
  }
  if (has('timezone')) {
    const tz = typeof input.timezone === 'string' ? input.timezone.trim() : '';
    let valid = tz.length > 0 && tz.length <= 64;
    if (valid) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
      } catch {
        valid = false;
      }
    }
    if (!valid) errors.timezone = 'Choose a time zone.';
    else value.timezone = tz;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** A name compared without case, accents, punctuation or spacing: "Acme, Inc." and "ACME Inc" are the same. */
export function normalizeEntityName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
