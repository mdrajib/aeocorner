import { randomBytes } from 'node:crypto';

/** "Acme Dental, Inc." -> "acme-dental-inc". Lowercase letters, digits and single hyphens only. */
export function slugify(name, maxLength = 48) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents: "Café" -> "Cafe"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'org';
}

/** A short random suffix to make a taken slug unique: "acme" -> "acme-k3f9". */
export function withSuffix(slug) {
  return `${slug.slice(0, 55)}-${randomBytes(3).toString('hex').slice(0, 4)}`;
}
