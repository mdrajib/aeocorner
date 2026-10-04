// The web half of the staging load test (Milestone 10, task 10.05): the public site and the free-audit pages under load.
//
//   k6 run -e BASE_URL=https://staging.aeocorner.com -e PEAK_VUS=100 tests/load/web.k6.js
//
// STAGING ONLY. Never point this at production: it would skew the real traffic numbers and trip the abuse limits. It
// only reads (GET) pages that are open to everyone; it never submits the audit form (that needs a Turnstile token, and the
// audit pipeline is driven by `npm run load:audits` instead). See tests/load/README.md for what "2× target" means here
// and what a pass looks like.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL;
if (!BASE || /^https:\/\/(www\.)?aeocorner\.com/.test(BASE)) {
  throw new Error('Set BASE_URL to the staging site. Refusing to load-test production.');
}
const PEAK = Number(__ENV.PEAK_VUS || 100);

export const options = {
  stages: [
    { duration: '2m', target: Math.round(PEAK / 4) },
    { duration: '3m', target: PEAK },
    { duration: '5m', target: PEAK },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    // The launch bar: nearly every request succeeds, and a page is quick for almost everyone.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<800', 'p(99)<2000'],
    'http_req_duration{kind:page}': ['p(95)<600'],
    checks: ['rate>0.99'],
  },
};

// The pages a visitor reads, weighted by how often they are (the home page and pricing dominate).
const PAGES = [
  ['/', 40],
  ['/pricing', 15],
  ['/methodology', 10],
  ['/product/measure', 8],
  ['/product/diagnose', 5],
  ['/product/fix', 5],
  ['/product/prove', 5],
  ['/agencies', 5],
  ['/privacy', 2],
  ['/terms', 2],
  ['/subprocessors', 1],
  ['/dpa', 1],
  ['/sitemap.xml', 1],
];
const total = PAGES.reduce((n, [, w]) => n + w, 0);
const pick = () => {
  let r = Math.random() * total;
  for (const [path, w] of PAGES) {
    r -= w;
    if (r <= 0) return path;
  }
  return '/';
};

export default function () {
  const path = pick();
  const res = http.get(`${BASE}${path}`, { tags: { kind: 'page', page: path } });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has a body': (r) => r.body && r.body.length > 200,
  });
  // The page's own assets are first-party and cached; fetch the CSS once per visit as a browser would.
  if (path === '/') http.get(`${BASE}/build/app.css`, { tags: { kind: 'asset' } });
  // A report address that does not exist must be a fast, plain 404 (and never touch the database for long).
  if (Math.random() < 0.05) {
    const miss = http.get(`${BASE}/r/01AAAAAAAAAAAAAAAAAAAAAAAA`, {
      tags: { kind: 'page', page: '/r/:id' },
    });
    check(miss, { 'an unknown report is a 404': (r) => r.status === 404 });
  }
  sleep(1 + Math.random() * 3);
}
