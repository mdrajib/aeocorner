// Page registry for the accessibility and responsive sweeps (BUILD_PLAN §2, UI rule).
// Every phase that adds a screen registers it here, so the sweeps cover it with no extra work.
// Public pages come straight from src/web/pages.js, so a new public page is covered automatically.
import { publicPages } from '../../src/web/pages.js';

/** @type {{ name: string, path: string, status?: number, audience: 'public' | 'dev' }[]} */
export const pages = [
  ...publicPages.map((p) => ({ name: p.view, path: p.path, audience: 'public' })),
  { name: 'not-found', path: '/this-page-does-not-exist', status: 404, audience: 'public' },
  { name: 'styleguide', path: '/_styleguide', audience: 'dev' },
  { name: 'app-shell', path: '/_styleguide/app-shell', audience: 'dev' },
];

export const publicSitePages = pages.filter((p) => p.audience === 'public');

export const viewportWidths = [375, 768, 1280];
