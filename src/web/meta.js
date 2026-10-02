const DEFAULT_DESCRIPTION =
  'AEO Corner shows how often AI answer engines mention, recommend and cite your brand, then helps you fix the gaps and prove it worked.';

/** '/methodology/' -> '/methodology', '' -> '/'. Query strings are never part of a canonical URL. */
export function normalizePath(path) {
  const clean = String(path || '/')
    .split('?')[0]
    .split('#')[0];
  const trimmed = clean.length > 1 ? clean.replace(/\/+$/, '') : clean;
  return trimmed.startsWith('/') ? trimmed || '/' : `/${trimmed}`;
}

export function organizationLd(config) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'AEO Corner',
    url: config.baseUrl,
    logo: `${config.baseUrl}/favicon.svg`,
    slogan: 'Corner your market in AI answers.',
  };
}

export function websiteLd(config) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'AEO Corner',
    url: config.baseUrl,
  };
}

/**
 * Build the <head> metadata for a page. Only the production environment is indexable; staging and
 * development always send noindex (see robots.js, security.js), and a page can opt out with `noindex`.
 */
export function buildMeta({ config, path, meta = {} }) {
  const noindex = !config.indexable || Boolean(meta.noindex);
  return {
    title: meta.title ?? 'AEO Corner',
    description: meta.description ?? DEFAULT_DESCRIPTION,
    canonical: `${config.baseUrl}${normalizePath(meta.path ?? path)}`,
    robots: noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large',
    noindex,
    ogType: meta.ogType ?? 'website',
    ogImage: `${config.baseUrl}/img/og.png`,
    jsonLd: [organizationLd(config), websiteLd(config), ...(meta.jsonLd ?? [])],
  };
}
