import { isRobotsLines } from '../../src/core/autofix-fixes.js';
import { scriptTag } from '../../src/core/jsonld.js';
import { verifySignature, PLUGIN_NAMESPACE } from '../../src/integrations/wordpress.js';
import { startServer } from './http-fixture.js';

/**
 * A WordPress stand-in for tests (ADR-0011: the test instance). It speaks the part of WordPress's REST API the
 * connector uses (users/me, posts) and the plugin's routes with the same signature rule the PHP plugin implements
 * (`verifySignature`), and it serves the pages it holds with the stored JSON-LD in the head, as the plugin does with
 * `wp_head`. It is not WordPress: the contract against real WordPress and the real plugin is
 * `tests/wordpress/contract.test.js`, which runs the plugin's PHP in WordPress Playground.
 *
 * Everything it receives is recorded in `calls`, so a test can say what was NOT sent.
 */
export async function startWordPressStub({
  username = 'editor',
  appPassword = 'abcd efgh ijkl mnop',
  capabilities = { edit_posts: true, publish_posts: true, manage_options: true },
  pluginInstalled = true,
  restPlain = false,
  /** '1.0.0' has no /state or /robots routes, as the first release did. */
  pluginVersion = '1.1.0',
  /** The site has a real robots.txt file, so WordPress builds none. */
  robotsFile = false,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const state = {
    posts: new Map(),
    nextId: 100,
    secret: null,
    seen: new Set(),
    schemas: new Map(),
    meta: new Map(),
    robots: null,
    rejectSchemaFor: new Set(),
    indexNowPings: [],
    failNext: null,
    calls: [],
  };
  let origin = '';

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const slugOf = (title) =>
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'post';
  const basicOk = (req) =>
    req.headers.authorization ===
    `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
  const pathOf = (u) => u.replace(origin, '').split('?')[0].replace(/\/+$/, '') || '/';
  const postView = (p) => ({
    id: p.id,
    link: `${origin}/${p.slug}/`,
    status: p.status,
    slug: p.slug,
    modified_gmt: p.modified,
    title: { raw: p.title },
    content: { raw: p.content },
  });

  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        })()
      : {};
    const route =
      url.searchParams.get('rest_route') ??
      (url.pathname.startsWith('/wp-json') ? url.pathname.slice('/wp-json'.length) || '/' : null);
    state.calls.push({
      method: req.method,
      route,
      path: url.pathname,
      headers: req.headers,
      body: raw,
    });

    if (state.failNext) {
      const { status, body: failBody } = state.failNext;
      state.failNext = null;
      return json(res, status, failBody ?? { code: 'fail' });
    }

    if (route === null && url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      const base = robotsFile
        ? 'User-agent: *\nDisallow: /\n'
        : 'User-agent: *\nDisallow: /wp-admin/\n';
      return res.end(!robotsFile && state.robots ? `${base.trimEnd()}\n\n${state.robots}\n` : base);
    }
    if (route === null) {
      // The public site: a post by its slug, with the JSON-LD the plugin would put in the head.
      const slug = url.pathname.replace(/^\/|\/$/g, '');
      const post = [...state.posts.values()].find((p) => p.slug === slug && p.status === 'publish');
      if (!post) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('<html><body>Not found</body></html>');
      }
      const pageUrl = `${origin}/${post.slug}/`;
      const stored = state.schemas.get(pageUrl);
      const meta = state.meta.get(pageUrl);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(
        `<!doctype html><html><head><title>${meta?.title ?? post.title}</title>${meta?.description ? `<meta name="description" content="${meta.description}">` : ''}${stored ? scriptTag(stored) : ''}</head><body><h1>${post.title}</h1>${post.content}</body></html>`,
      );
    }
    if (restPlain && !url.searchParams.has('rest_route'))
      return json(res, 404, { code: 'rest_no_route' });

    if (req.method === 'GET' && route === '/') {
      return json(res, 200, {
        name: 'Stub Site',
        url: origin,
        namespaces: ['oembed/1.0', 'wp/v2', ...(pluginInstalled ? [PLUGIN_NAMESPACE] : [])],
      });
    }
    if (route.startsWith('/wp/v2/')) {
      if (!basicOk(req)) return json(res, 401, { code: 'rest_forbidden' });
      if (route === '/wp/v2/users/me')
        return json(res, 200, { id: 2, name: 'Edie Editor', capabilities });
      if (route === '/wp/v2/posts' && req.method === 'POST') {
        if (!capabilities.edit_posts) return json(res, 403, { code: 'rest_cannot_create' });
        if (body.status === 'publish' && !capabilities.publish_posts)
          return json(res, 403, { code: 'rest_cannot_publish' });
        const id = state.nextId++;
        const post = {
          id,
          title: body.title ?? '',
          content: body.content ?? '',
          status: body.status ?? 'draft',
          slug: body.slug || slugOf(body.title),
          modified: new Date(now() * 1000).toISOString(),
        };
        state.posts.set(id, post);
        return json(res, 201, postView(post));
      }
      const m = route.match(/^\/wp\/v2\/(posts|pages)\/(\d+)$/);
      if (m) {
        const post = state.posts.get(Number(m[2]));
        // Posts and pages are different routes in WordPress: a page is not found under /posts/.
        if (!post || (post.type ?? 'post') !== (m[1] === 'pages' ? 'page' : 'post'))
          return json(res, 404, { code: 'rest_post_invalid_id' });
        if (req.method === 'POST') {
          if (body.status === 'publish' && !capabilities.publish_posts)
            return json(res, 403, { code: 'rest_cannot_publish' });
          for (const k of ['title', 'content', 'status', 'slug'])
            if (body[k] !== undefined) post[k] = body[k];
          post.modified = new Date(now() * 1000).toISOString();
        }
        return json(res, 200, postView(post));
      }
      return json(res, 404, { code: 'rest_no_route' });
    }

    if (route.startsWith(`/${PLUGIN_NAMESPACE}/`)) {
      if (!pluginInstalled) return json(res, 404, { code: 'rest_no_route' });
      const sub = route.slice(PLUGIN_NAMESPACE.length + 1);
      const status = () => ({
        version: pluginVersion,
        wp: '6.8',
        php: '8.3',
        seo_plugin: 'yoast',
        indexnow: Boolean(state.indexNowKey),
        ...(pluginVersion === '1.0.0' ? {} : { features: ['schema', 'meta', 'state', 'robots'] }),
      });
      if (sub === '/connect' && req.method === 'POST') {
        if (!basicOk(req)) return json(res, 401, { code: 'rest_forbidden' });
        if (!capabilities.manage_options) return json(res, 403, { code: 'rest_forbidden' });
        if (typeof body?.secret !== 'string' || body.secret.length < 32)
          return json(res, 400, { code: 'aeo_bad_secret' });
        state.secret = body.secret;
        state.seen.clear();
        if (body.indexnow_key) state.indexNowKey = body.indexnow_key;
        return json(res, 200, status());
      }
      if (!state.secret) return json(res, 401, { code: 'aeo_not_connected' });
      const verdict = verifySignature({
        secret: state.secret,
        headers: req.headers,
        method: req.method,
        route: `/${PLUGIN_NAMESPACE}${sub}`,
        body: raw,
        now: now(),
        seenNonces: state.seen,
      });
      if (!verdict.ok) return json(res, 401, { code: 'aeo_bad_signature', reason: verdict.reason });
      const sameSite = (u) => typeof u === 'string' && u.startsWith(`${origin}/`);
      if (sub === '/status' && req.method === 'GET') return json(res, 200, status());
      if (sub === '/schema' && req.method === 'PUT') {
        if (!sameSite(body?.url)) return json(res, 400, { code: 'aeo_wrong_site' });
        // A test can make the plugin refuse one page's structured data (a write that fails part-way through).
        if (state.rejectSchemaFor.has(body.url)) return json(res, 400, { code: 'aeo_bad_jsonld' });
        state.schemas.set(body.url, body.jsonld);
        return json(res, 200, { saved: true });
      }
      if (sub === '/schema' && req.method === 'DELETE') {
        return json(res, 200, { removed: state.schemas.delete(body?.url) });
      }
      if (sub === '/meta' && req.method === 'PUT') {
        if (!sameSite(body?.url)) return json(res, 400, { code: 'aeo_wrong_site' });
        // Both empty means "forget them", as the plugin does.
        if (!body.title && !body.description) {
          state.meta.delete(body.url);
          return json(res, 200, { saved: true, removed: true });
        }
        state.meta.set(body.url, { title: body.title ?? '', description: body.description ?? '' });
        return json(res, 200, { saved: true });
      }
      if (pluginVersion !== '1.0.0' && sub === '/state' && req.method === 'POST') {
        if (body?.url !== undefined && !sameSite(body.url))
          return json(res, 400, { code: 'aeo_wrong_site' });
        const meta = body?.url ? state.meta.get(body.url) : null;
        return json(res, 200, {
          schema: body?.url ? (state.schemas.get(body.url) ?? null) : null,
          title: meta?.title || null,
          description: meta?.description || null,
          robots: { lines: state.robots, virtual: !robotsFile },
        });
      }
      if (pluginVersion !== '1.0.0' && sub === '/robots' && req.method === 'PUT') {
        if (!isRobotsLines(body?.lines)) return json(res, 400, { code: 'aeo_bad_robots' });
        if (robotsFile) return json(res, 409, { code: 'aeo_robots_file' });
        state.robots = body.lines;
        return json(res, 200, { saved: true });
      }
      if (pluginVersion !== '1.0.0' && sub === '/robots' && req.method === 'DELETE') {
        const had = state.robots !== null;
        state.robots = null;
        return json(res, 200, { removed: had });
      }
      if (sub === '/resolve' && req.method === 'POST') {
        const hit = [...state.posts.values()].find(
          (p) => `${origin}/${p.slug}/` === body?.url || `${origin}/${p.slug}` === body?.url,
        );
        return json(
          res,
          200,
          hit
            ? { found: true, id: hit.id, type: hit.type ?? 'post', link: `${origin}/${hit.slug}/` }
            : { found: false },
        );
      }
      if (sub === '/indexnow' && req.method === 'POST') {
        state.indexNowPings.push(...(body?.urls ?? []));
        return json(res, 200, { pinged: (body?.urls ?? []).length });
      }
      if (sub === '/disconnect' && req.method === 'POST') {
        state.secret = null;
        state.schemas.clear();
        state.meta.clear();
        state.robots = null;
        return json(res, 200, { disconnected: true });
      }
      return json(res, 404, { code: 'rest_no_route' });
    }
    return json(res, 404, { code: 'rest_no_route' });
  });
  origin = server.origin();

  return {
    ...server,
    state,
    username,
    appPassword,
    /** The site's address as the connector would be given it. */
    siteUrl: origin,
    /** Make the next request answer with this status (a server error, a rate limit). */
    failNext(status, body = null) {
      state.failNext = { status, body };
    },
    pathOf,
    /** A page that already exists on the site (for a refresh to find and replace). Returns its id and address. */
    addPage({ title, slug, content = '<p>The old page.</p>', type = 'page' }) {
      const id = state.nextId++;
      state.posts.set(id, {
        id,
        type,
        title,
        content,
        status: 'publish',
        slug,
        modified: new Date(now() * 1000).toISOString(),
      });
      return { id, link: `${origin}/${slug}/` };
    },
  };
}
