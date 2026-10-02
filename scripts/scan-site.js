#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { createHostPacer, RENDER_PACING } from '../src/crawler/pacer.js';
import { classifyIp } from '../src/crawler/ip-guard.js';
import { createRenderer } from '../src/crawler/render.js';
import { createSafeFetcher } from '../src/crawler/safe-fetch.js';
import { runSiteScan } from '../src/crawler/scan.js';
import { createObjectStore } from '../src/integrations/spaces.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';

/**
 * Scan a website from the command line and print what the crawler found:
 *
 *   npm run scan -- example.com
 *   npm run scan -- example.com --no-render --json scan.json
 *
 * It uses the same code as the worker (safe fetcher, robots.txt, headless browser, readiness checks) but needs no
 * database or Redis. Raw pages go to Spaces if DO_SPACES_* is set, otherwise to .data/spaces on this machine. Use it
 * to try the crawler on real sites, and to check our own site once it exists (BUILD_PLAN Phase 12).
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const domain = args.find((a) => !a.startsWith('--') && a !== valueOf('--json'));

if (!domain || flag('--help')) {
  console.log('Usage: npm run scan -- <domain> [--no-render] [--ignore-robots] [--json <file>]');
  process.exit(flag('--help') ? 0 : 1);
}

const config = loadConfig();
const logger = createLogger(config);
const store = createObjectStore(config, { logger });
const fetcher = createSafeFetcher({ pacer: createHostPacer() });
const renderer = flag('--no-render')
  ? null
  : createRenderer({ fetcher: createSafeFetcher({ pacer: createHostPacer(RENDER_PACING) }) });

const started = Date.now();
let result;
try {
  result = await runSiteScan(domain, {
    fetcher,
    renderer,
    store,
    // Only for a site you own: the free audit never does this.
    respectRobots: !flag('--ignore-robots'),
    log: flag('--timing')
      ? (event, d) =>
          event === 'phase' &&
          console.log(`  [timing] ${d.phase.padEnd(10)} ${(d.ms / 1000).toFixed(1)} s`)
      : undefined,
  });
} finally {
  await renderer?.close();
  store.close();
}

const pad = (text, n) => String(text).padEnd(n);
const line = '-'.repeat(78);
console.log(
  `\n${line}\nAEO readiness scan: ${result.site.domain}   (${((Date.now() - started) / 1000).toFixed(1)} s)`,
);
console.log(line);
console.log(`Status      ${result.status}`);
console.log(
  `Score       ${result.readinessScore ?? "couldn't check"}   (rubric ${result.rubricVersion}, ${Math.round(result.coverage * 100)}% of the rubric could be evaluated)`,
);
console.log(`Platform    ${result.site.platform ?? 'unknown'}`);
console.log(
  `robots.txt  ${result.robots.status}${result.robots.httpStatus ? ` (HTTP ${result.robots.httpStatus})` : ''}`,
);
console.log(`Sitemaps    ${result.sitemaps.found.length} found, ${result.sitemaps.urlCount} URLs`);
for (const note of result.notes) console.log(`Note        ${note}`);

console.log(`\nCategories`);
for (const [letter, c] of Object.entries(result.categoryScores)) {
  console.log(
    `  ${letter}  ${pad(c.name, 26)} ${c.score === null ? "couldn't check" : `${c.score}%`.padEnd(6)}  ${c.earned}/${c.possible} points`,
  );
}

console.log(`\nChecks`);
const mark = {
  pass: 'PASS   ',
  partial: 'PARTIAL',
  fail: 'FAIL   ',
  not_applicable: 'n/a    ',
  error: 'ERROR  ',
};
for (const c of result.checks) {
  console.log(
    `  ${c.code}  ${mark[c.status]}  ${String(c.points).padStart(4)}/${pad(c.possible, 3)} ${c.summary}`,
  );
}

console.log(`\nPages (${result.pagesFetched} of ${result.pagesPlanned} read)`);
for (const p of result.pages) {
  const rendered =
    p.renderedTextChars === null
      ? ''
      : `  raw ${p.rawTextChars} / rendered ${p.renderedTextChars} chars`;
  console.log(
    `  ${pad(p.pageType, 8)} ${pad(p.status ?? '-', 4)} ${p.error ? `[${p.error}] ` : ''}${p.url}${rendered}`,
  );
}

// The exit criterion: no private address was ever touched. Checked again here, independently of the fetcher.
const addresses = [...new Set(result.connections.map((c) => c.address))];
const bad = addresses.filter((a) => !classifyIp(a).allowed);
console.log(
  `\nNetwork     ${result.connections.length} connections to ${addresses.length} addresses: ${addresses.join(', ') || 'none'}`,
);
console.log(
  bad.length
    ? `PRIVATE ADDRESS TOUCHED: ${bad.join(', ')}`
    : 'No private, loopback or metadata address was contacted.',
);
console.log(
  `Stored      raw pages in ${store.kind === 'file' ? store.root : `Spaces bucket ${store.bucket}`}`,
);

if (valueOf('--json')) {
  await writeFile(valueOf('--json'), JSON.stringify(result, null, 2));
  console.log(`Full result written to ${valueOf('--json')}`);
}
process.exit(bad.length ? 2 : 0);
