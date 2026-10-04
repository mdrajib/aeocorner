import { z } from 'zod';
import {
  MAX_PROFILES,
  PLATFORM_CODES,
  normalizeProfileUrl,
  parseWikidataId,
} from './entity-profiles.js';
import { normalizeEntityName } from './project-rules.js';

/**
 * The Brand Kit as a customer keeps it (MVP F2, "Brand Kit v1"): identity, offerings, facts and voice. Each save is a
 * new immutable version (`brand_profiles`), so an edit never overwrites history.
 *
 * Competitors are NOT in here: they live in `tracked_entities`, the one place every metric points to, so the
 * Competitors tab of the Brand Kit screen reads and writes that table.
 *
 * Pure: the repository validates with `parseBrandKit` before it writes, and the screens use `diffBrandKit` to say
 * what a version changed.
 */

/**
 * 1: identity, offerings, facts, voice. 2 (Milestone 12): adds `entity`. A version-1 kit reads as a version-2 kit with an
 * empty entity section, so nothing stored has to be rewritten.
 */
export const BRAND_KIT_SCHEMA_VERSION = 2;

/** Text from a form or a model: trimmed, whitespace collapsed, and cut rather than rejected when too long. */
const text = (max) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max))
    .default('');

const list = (max, itemMax) =>
  z
    .array(z.string().transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, itemMax)))
    .max(max)
    .transform((items) => [...new Set(items.filter(Boolean))])
    .default([]);

const offering = z.object({
  name: text(120).pipe(z.string().min(1)),
  url: text(300),
  description: text(400),
  price: text(80),
});

const fact = z.object({
  label: text(80).pipe(z.string().min(1)),
  value: text(300).pipe(z.string().min(1)),
});

const persona = z.object({
  name: text(80).pipe(z.string().min(1)),
  bio: text(400),
  credentials: text(200),
});

const profile = z.object({
  platform: z.enum(PLATFORM_CODES),
  url: z
    .string()
    .transform((s) => normalizeProfileUrl(s))
    .pipe(z.string({ error: 'Use a full https:// address.' })),
});

/**
 * What an engine needs to tell this business from a namesake, typed by the customer: the year it began, where it is
 * based, its public profiles and its Wikidata item. Every one of these is a statement of fact by the customer: we check
 * the profiles and the item, and we compare what the engines say against the year and the place, but we never fill
 * one in ourselves.
 */
const entity = z
  .object({
    foundingYear: z
      .string()
      .transform((s) => s.trim())
      .refine(
        (s) => s === '' || (/^\d{4}$/.test(s) && Number(s) >= 1800 && Number(s) <= 2100),
        'Use a four-digit year, like 2014.',
      )
      .default(''),
    headquarters: text(160),
    profiles: z
      .array(profile)
      .max(MAX_PROFILES)
      .transform((items) => [...new Map(items.map((p) => [p.url, p])).values()])
      .default([]),
    wikidataId: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => parseWikidataId(s) !== null, 'Use an item number like Q12345.')
      .transform((s) => parseWikidataId(s))
      .default(''),
  })
  .default({ foundingYear: '', headquarters: '', profiles: [], wikidataId: '' });

export const brandKitSchema = z.object({
  identity: z.object({
    brandName: text(120).pipe(z.string().min(1, 'The brand needs a name.')),
    aliases: list(20, 120),
    legalName: text(160),
    domains: list(10, 253),
    definition: text(400),
    category: text(120),
    geography: text(120),
  }),
  offerings: z
    .object({
      items: z.array(offering).max(30).default([]),
      audiences: list(10, 160),
      differentiators: list(10, 200),
    })
    .default({ items: [], audiences: [], differentiators: [] }),
  facts: z.array(fact).max(50).default([]),
  voice: z
    .object({
      tone: list(8, 40),
      readingLevel: text(60),
      use: list(30, 60),
      avoid: list(30, 60),
      personas: z.array(persona).max(5).default([]),
    })
    .default({ tone: [], readingLevel: '', use: [], avoid: [], personas: [] }),
  entity,
});

/**
 * Check and tidy a Brand Kit. `{ ok: true, kit }` with every field present, or `{ ok: false, errors }` where `errors`
 * maps a dotted path ("identity.brandName") to a message a customer can read.
 */
export function parseBrandKit(input) {
  const parsed = brandKitSchema.safeParse(input);
  if (parsed.success) return { ok: true, kit: parsed.data };
  const errors = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.') || 'kit';
    errors[path] ??=
      issue.message === 'Too small: expected string to have >=1 characters'
        ? 'This can’t be empty.'
        : issue.message;
  }
  return { ok: false, errors };
}

/** A starting kit for a project made without an audit: just the name and the site. */
export function emptyBrandKit({ name, domain }) {
  return parseBrandKit({ identity: { brandName: name, domains: domain ? [domain] : [] } }).kit;
}

/**
 * The kit the free audit read (`src/llm/brand-kit.js`, lite mode) as a version-1 kit. Competitors are not carried:
 * they become tracked entities.
 */
export function fromLiteKit(lite, { domain } = {}) {
  const parsed = parseBrandKit({
    identity: {
      brandName: lite?.brand_name ?? '',
      aliases: lite?.aliases ?? [],
      domains: domain ? [domain] : [],
      definition: lite?.definition ?? '',
      category: lite?.category ?? '',
      geography: lite?.geography ?? '',
    },
    offerings: {
      items: (lite?.offerings ?? []).map((name) => ({ name })),
      audiences: lite?.audience ? [lite.audience] : [],
    },
  });
  return parsed.ok ? parsed.kit : null;
}

/** The names a brand is found under: its own name, then its aliases, without repeats (same name written differently). */
export function brandNames(kit) {
  const seen = new Set();
  const names = [];
  for (const name of [kit.identity.brandName, ...kit.identity.aliases]) {
    const key = normalizeEntityName(name);
    if (key && !seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

export const SECTIONS = Object.freeze({
  identity: 'Identity',
  offerings: 'Offerings',
  facts: 'Facts',
  voice: 'Voice',
  entity: 'Entity',
});

/** A stored kit as the current schema reads it, so a version-1 kit has the empty sections a newer one has. */
const asCurrent = (kit) => (kit ? (parseBrandKit(kit).kit ?? kit) : null);

/** Which sections differ between two kits, as section keys in screen order. `before` may be null (a first version). */
export function changedSections(before, after) {
  const a = asCurrent(before);
  const b = asCurrent(after);
  return Object.keys(SECTIONS).filter(
    (key) => JSON.stringify(a?.[key] ?? null) !== JSON.stringify(b?.[key] ?? null),
  );
}
