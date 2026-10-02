import { words } from './readiness.js';

/**
 * Small websites for the crawler's integration tests, each a table of routes. They stand in for the kinds of site
 * the Phase 4 exit criteria name: a WordPress-style site that does things right, a single-page app that only
 * exists after JavaScript runs, and sites that block bots. Bodies are exact bytes the test can compare with what
 * the crawler stored.
 */

export const route = (
  body,
  { status = 200, type = 'text/html; charset=utf-8', headers = {} } = {},
) => ({
  status,
  headers: { 'content-type': type, ...headers },
  body: Buffer.from(body),
});

/** A request handler that serves a table of routes (or a function for a route that needs the request). */
export function serveRoutes(routes, { onRequest } = {}) {
  return (req, res) => {
    onRequest?.(req);
    const path = req.url.split('?')[0];
    const entry = typeof routes === 'function' ? routes(req) : routes[path];
    const answer =
      typeof entry === 'function'
        ? entry(req)
        : (entry ?? route('<html><body>Not found</body></html>', { status: 404 }));
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  };
}

const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

/** The web of a company that does nearly everything right, in the style of a WordPress site. */
export function goodSite(origin, { redirectHomeTo } = {}) {
  const org = {
    '@type': 'Organization',
    name: 'Acme Widgets',
    url: `${origin}/`,
    logo: `${origin}/wp-content/uploads/logo.png`,
    sameAs: [
      'https://www.linkedin.com/company/acme-widgets',
      'https://www.crunchbase.com/organization/acme-widgets',
      'https://www.wikidata.org/wiki/Q42',
    ],
  };
  const page = ({ path, title, description, body, schema = [] }) =>
    route(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title><meta name="description" content="${description}">
<meta name="generator" content="WordPress 6.6.1"><link rel="canonical" href="${origin}${path}">
<meta property="og:site_name" content="Acme Widgets">
<link rel="stylesheet" href="/wp-content/themes/acme/style.css">
${ld({ '@context': 'https://schema.org', '@graph': schema })}
</head><body class="wp-site">
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/pricing">Pricing</a> <a href="/faq">FAQ</a>
<a href="/products/widget-pro">Widget Pro</a> <a href="/contact">Contact</a> <a href="/careers">Careers</a>
<a href="/wp-login.php">Log in</a> <a href="/cart">Cart</a></nav></header>
<main>${body}</main>
<footer><a href="https://www.linkedin.com/company/acme-widgets">LinkedIn</a></footer></body></html>`);

  const crumbs = { '@type': 'BreadcrumbList', itemListElement: [] };
  const routes = {
    '/': page({
      path: '/',
      title: 'Acme Widgets | Industrial widgets for small factories',
      description: 'Acme Widgets builds durable industrial widgets for small factories.',
      schema: [org, { '@type': 'WebSite', name: 'Acme Widgets', url: `${origin}/` }],
      body: `<h1>Acme Widgets</h1>
<p>Acme Widgets is a manufacturer of industrial widgets based in Columbus, Ohio, serving small factories since 1998. ${words(25)}</p>
<h2>What does Acme Widgets make?</h2>
<p>We make durable industrial widgets in three sizes, each tested for ten thousand hours of continuous use.</p>
<h2>How much do widgets cost?</h2>
<p>Widgets start at forty dollars each, with discounts for orders of one hundred or more units, 30% off at volume.</p>
<ul><li>Small</li><li>Medium</li><li>Large</li></ul>
<p>Last updated September 15, 2026. Defects fell 45% in 2025, according to <a href="https://industry.example.org/report">the industry report</a> and <a href="https://stats.example.net/widgets">official statistics</a>.</p>
<p class="byline">By Jo Writer</p>`,
    }),
    '/about': page({
      path: '/about',
      title: 'About Acme Widgets',
      description: 'Who we are and who we serve.',
      schema: [{ '@type': 'AboutPage' }, crumbs],
      body: `<h1>About us</h1><p>Acme Widgets is a family-owned manufacturer of industrial widgets, headquartered in Columbus, Ohio, and serving small factories across the Midwest since 1998. ${words(30)}</p>`,
    }),
    '/pricing': page({
      path: '/pricing',
      title: 'Widget pricing | Acme Widgets',
      description: 'Simple widget prices.',
      schema: [
        { '@type': 'Product', name: 'Widget', offers: { '@type': 'Offer', price: '40' } },
        crumbs,
      ],
      body: `<h1>Pricing</h1><p>${words(160)}</p><table><tr><td>Small</td><td>$40</td></tr><tr><td>Large</td><td>$90</td></tr></table>`,
    }),
    '/faq': page({
      path: '/faq',
      title: 'Widget FAQ | Acme Widgets',
      description: 'Answers to common widget questions.',
      schema: [{ '@type': 'FAQPage', mainEntity: [] }, crumbs],
      body: `<h1>Frequently asked questions</h1>
<h2>Is a widget safe?</h2><p>Yes, every widget is tested for ten thousand hours before it ships to you.</p>
<h2>How long is the warranty?</h2><p>Every widget comes with a five year warranty from the day you buy it.</p>`,
    }),
    '/products/widget-pro': page({
      path: '/products/widget-pro',
      title: 'Widget Pro | Acme Widgets',
      description: 'Our best widget.',
      schema: [{ '@type': 'Product', name: 'Widget Pro' }, crumbs],
      body: `<h1>Widget Pro</h1><p>${words(120)}</p>`,
    }),
    '/contact': page({
      path: '/contact',
      title: 'Contact Acme Widgets',
      description: 'How to reach us.',
      schema: [{ '@type': 'ContactPage' }, crumbs],
      body: '<h1>Contact</h1><p>Write to hello@acme.example or call us.</p>',
    }),
    '/careers': page({
      path: '/careers',
      title: 'Careers at Acme Widgets',
      description: 'Join us.',
      body: '<h1>Careers</h1><p>We are hiring widget engineers.</p>',
    }),
    '/robots.txt': route(
      `User-agent: *\nDisallow: /wp-admin/\nDisallow: /cart\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${origin}/sitemap.xml\n`,
      {
        type: 'text/plain',
      },
    ),
    '/sitemap.xml': route(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[
        '/',
        '/about',
        '/pricing',
        '/faq',
        '/products/widget-pro',
        '/contact',
        '/careers',
      ]
        .map((p) => `<url><loc>${origin}${p}</loc><lastmod>2026-09-20</lastmod></url>`)
        .join('')}</urlset>`,
      { type: 'application/xml' },
    ),
    '/llms.txt': route(
      '# Acme Widgets\n\n> Industrial widgets for small factories.\n\n- [Pricing](/pricing)\n',
      { type: 'text/plain' },
    ),
  };
  if (redirectHomeTo) {
    routes['/'] = {
      status: 301,
      headers: { location: `${redirectHomeTo}/` },
      body: Buffer.alloc(0),
    };
  }
  return routes;
}

/** A single-page app: the HTML that is sent is an empty shell, and a script builds everything. */
export function spaSite() {
  return {
    '/': route(
      '<!doctype html><html><head><title>Acme App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    ),
    '/app.js': route(
      `const root = document.getElementById('root');
root.innerHTML = '<nav><a href="/about">About</a><a href="/pricing">Pricing</a></nav><main><h1>Acme App</h1><h2>What is Acme App?</h2><p>${words(120)}</p></main>';`,
      { type: 'text/javascript' },
    ),
  };
}

const CHALLENGE =
  '<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

/**
 * A site behind a firewall that turns away AI crawlers by name (and nobody else), the way a Cloudflare rule
 * does. `blockEverything` turns away every automated request, including ours.
 */
export function firewalledSite(origin, { blockEverything = false, blockRobots = false } = {}) {
  const good = goodSite(origin);
  const blocksUa = (ua) =>
    blockEverything
      ? /bot|crawler|spider/i.test(ua)
      : /OAI-SearchBot|ChatGPT-User|PerplexityBot|Claude-SearchBot|ClaudeBot|GPTBot/i.test(ua);
  return (req) => {
    const path = req.url.split('?')[0];
    if (
      blocksUa(String(req.headers['user-agent'] ?? '')) &&
      (blockRobots || path !== '/robots.txt')
    ) {
      return () => ({
        status: 403,
        headers: {
          'content-type': 'text/html',
          server: 'cloudflare',
          'cf-ray': 'abc-FRA',
          'cf-mitigated': 'challenge',
        },
        body: Buffer.from(CHALLENGE),
      });
    }
    return good[path];
  };
}

/** A site whose robots.txt keeps every crawler out. */
export function closedSite(origin) {
  return {
    ...goodSite(origin),
    '/robots.txt': route('User-agent: *\nDisallow: /\n', { type: 'text/plain' }),
  };
}

/**
 * A site that is out to make a crawler touch its own network: links, a sitemap and a robots.txt that all point at
 * private addresses and at a service on this machine.
 */
export function hostileSite(origin, secretOrigin) {
  const targets = [
    `${secretOrigin}/admin`,
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://[::1]/x',
    'http://localhost/y',
  ];
  return {
    '/': route(`<!doctype html><html><head><title>Hostile</title></head><body><nav>${targets
      .map((t, i) => `<a href="${t}">link ${i}</a>`)
      .join('')}<a href="/about">About</a></nav><main><h1>Hostile</h1><p>${words(60)}</p>
<img src="${secretOrigin}/pixel.png"><script>fetch('${secretOrigin}/from-page-script')</script></main></body></html>`),
    '/about': route(
      `<!doctype html><html><head><title>About</title></head><body><main><h1>About</h1><p>${words(60)}</p></main></body></html>`,
    ),
    '/robots.txt': route(
      `User-agent: *\nDisallow:\nSitemap: ${secretOrigin}/sitemap.xml\nSitemap: ${origin}/sitemap.xml\nSitemap: http://169.254.169.254/sitemap.xml\n`,
      {
        type: 'text/plain',
      },
    ),
    '/sitemap.xml': route(
      `<?xml version="1.0"?><urlset>${[...targets, `${origin}/about`].map((t) => `<url><loc>${t}</loc></url>`).join('')}</urlset>`,
      { type: 'application/xml' },
    ),
  };
}
