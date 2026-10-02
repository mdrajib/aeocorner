// Copies the self-hosted front-end assets (htmx, Alpine.js CSP build, Inter font) from node_modules
// into src/web/public. The copies are committed, so the app has no third-party CDN at runtime
// and a fresh clone works without a build step for them. Re-run after bumping those packages:
//   npm run vendor
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => join(root, 'node_modules', ...p);
const pub = (...p) => join(root, 'src', 'web', 'public', ...p);

const files = [
  [nm('htmx.org', 'dist', 'htmx.min.js'), pub('vendor', 'htmx.min.js')],
  [nm('@alpinejs', 'csp', 'dist', 'cdn.min.js'), pub('vendor', 'alpine-csp.min.js')],
  [
    nm('@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2'),
    pub('fonts', 'inter-latin-wght-normal.woff2'),
  ],
  [
    nm('@fontsource-variable', 'inter', 'files', 'inter-latin-ext-wght-normal.woff2'),
    pub('fonts', 'inter-latin-ext-wght-normal.woff2'),
  ],
];

for (const [from, to] of files) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

const version = (pkg) =>
  JSON.parse(readFileSync(nm(...pkg.split('/'), 'package.json'), 'utf8')).version;
console.log(
  `Vendored htmx ${version('htmx.org')}, Alpine.js CSP build ${version('@alpinejs/csp')}, Inter ${version('@fontsource-variable/inter')}`,
);
