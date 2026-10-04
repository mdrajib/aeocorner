// Bundles the Content Studio's editor (TipTap on ProseMirror, src/web/editor/entry.js) into one self-hosted file,
// src/web/public/vendor/editor.js. The bundle is committed like the other vendored assets, so a fresh clone needs no
// build step for it. Re-run after bumping the @tiptap packages:  npm run build:editor
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'web', 'public', 'vendor', 'editor.js');

await build({
  entryPoints: [join(root, 'src', 'web', 'editor', 'entry.js')],
  outfile: out,
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
});

const version = (pkg) =>
  JSON.parse(readFileSync(join(root, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8'))
    .version;
console.log(
  `Built the editor (TipTap ${version('@tiptap/core')}): ${Math.round(statSync(out).size / 1024)} KB`,
);
