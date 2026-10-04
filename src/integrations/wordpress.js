import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { FetchError, isGuardError } from '../crawler/safe-fetch.js';

/**
 * The WordPress connector (MVP F9): two layers, both reached only through the safe fetcher (ADR-0005, extended for
 * writes in ADR-0011).
 *
 *   1. WordPress's own REST API with an application password (Basic auth): read who we are, create and update posts.
 *      No plugin needed. The customer makes the application password in their profile; we keep it encrypted
 *      (src/lib/secrets.js) and never show it again.
 *   2. The "AEO Corner Connector" plugin's REST routes (`/wp-json/aeocorner/v1/...`): server-side JSON-LD, title and
 *      meta overrides, finding a post from its address, IndexNow, and a one-click disconnect. Every call after the
 *      handshake is signed with a per-site secret:
 *
 *        X-AEO-Timestamp  seconds since 1970
 *        X-AEO-Nonce      16 random bytes, hex; each nonce is accepted once
 *        X-AEO-Signature  hex HMAC-SHA256 of  AEO1 \n timestamp \n nonce \n METHOD \n route \n sha256hex(body)
 *
 *      `route` is the REST route (`/aeocorner/v1/schema`), not the whole address, so a WordPress in a sub-folder or with
 *      "plain" permalinks signs the same thing. The plugin refuses a timestamp more than five minutes off, a repeated
 *      nonce, and any change to the method, route or body.
 *
 * Errors are `WordPressError`s with a `code` to branch on and a `retryable` flag. A message never contains a response
 * body, the application password or the signing secret.
 */

export const SIGNATURE_WINDOW_SECONDS = 300;
export const PLUGIN_NAMESPACE = 'aeocorner/v1';

export class WordPressError extends Error {
  constructor(code, message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = 'WordPressError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

/** The string that is signed: everything an attacker could change. */
export const canonicalRequest = ({ timestamp, nonce, method, route, body }) =>
  [
    'AEO1',
    String(timestamp),
    nonce,
    String(method).toUpperCase(),
    route,
    sha256hex(body ?? ''),
  ].join('\n');

export function signRequest({
  secret,
  method,
  route,
  body = '',
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomBytes(16).toString('hex'),
}) {
  const signature = createHmac('sha256', secret)
    .update(canonicalRequest({ timestamp, nonce, method, route, body }))
    .digest('hex');
  return {
    'x-aeo-timestamp': String(timestamp),
    'x-aeo-nonce': nonce,
    'x-aeo-signature': signature,
  };
}

/**
 * The plugin's check, in JavaScript, so the stand-in used in tests and the PHP plugin verify the same thing.
 * @returns {{ ok: true } | { ok: false, reason: 'missing'|'stale'|'bad_nonce'|'replayed'|'bad_signature' }}
 */
export function verifySignature({
  secret,
  headers,
  method,
  route,
  body = '',
  now = Math.floor(Date.now() / 1000),
  seenNonces,
}) {
  const timestamp = headers['x-aeo-timestamp'];
  const nonce = headers['x-aeo-nonce'];
  const signature = headers['x-aeo-signature'];
  if (!timestamp || !nonce || !signature) return { ok: false, reason: 'missing' };
  if (!/^\d{9,11}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS)
    return { ok: false, reason: 'stale' };
  if (!/^[0-9a-f]{16,64}$/.test(nonce)) return { ok: false, reason: 'bad_nonce' };
  const expected = createHmac('sha256', secret)
    .update(canonicalRequest({ timestamp, nonce, method, route, body }))
    .digest();
  const given = /^[0-9a-f]{64}$/.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'bad_signature' };
  if (seenNonces) {
    if (seenNonces.has(nonce)) return { ok: false, reason: 'replayed' };
    seenNonces.add(nonce);
  }
  return { ok: true };
}

/** A site address as typed: "example.com", "https://example.com/blog/" → "https://example.com/blog". */
export function normalizeSiteUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new WordPressError('bad_site_url', 'Enter the address of your WordPress site.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) {
    throw new WordPressError('bad_site_url', 'Use a web address that starts with https://.');
  }
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new WordPressError('bad_site_url', 'That is not a web address.');
  }
  if (url.username || url.password)
    throw new WordPressError(
      'bad_site_url',
      'Leave the user name and password out of the address.',
    );
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

const basic = (username, password) =>
  `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

function fromFetchError(err) {
  if (err instanceof WordPressError) return err;
  if (isGuardError(err)) {
    return new WordPressError(
      'site_not_allowed',
      'That address cannot be used: it is not a public website.',
    );
  }
  if (err instanceof FetchError) {
    const known = {
      dns_failed: ['site_unreachable', 'We could not find that website.', true],
      timeout: ['site_unreachable', 'The website took too long to answer.', true],
      tls_failed: ['tls_failed', "The website's security certificate was not accepted.", false],
      too_large: ['bad_response', 'The website sent back too much data.', false],
    }[err.code];
    if (known) return new WordPressError(known[0], known[1], { retryable: known[2] });
    return new WordPressError('site_unreachable', 'We could not reach the website.', {
      retryable: true,
    });
  }
  return new WordPressError('site_unreachable', 'We could not reach the website.', {
    retryable: true,
  });
}

const text = (s, max) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * @param {object} options
 * @param {{fetch: Function}} options.fetcher  a safe fetcher (src/crawler/safe-fetch.js)
 * @param {string} options.siteUrl
 * @param {string} [options.username]
 * @param {string} [options.appPassword]
 * @param {string} [options.hmacSecret]  the per-site plugin secret
 * @param {() => number} [options.nowSeconds]
 */
export function createWordPressClient({
  fetcher,
  siteUrl,
  username = null,
  appPassword = null,
  hmacSecret = null,
  nowSeconds = () => Math.floor(Date.now() / 1000),
}) {
  const site = normalizeSiteUrl(siteUrl);
  let restBase = null; // "https://x/wp-json" or "https://x/?rest_route="

  const restUrl = (route, query = null) => {
    const q = query ? new URLSearchParams(query).toString() : '';
    if (restBase?.includes('?rest_route=')) return `${restBase}${route}${q ? `&${q}` : ''}`;
    return `${restBase ?? `${site}/wp-json`}${route}${q ? `?${q}` : ''}`;
  };

  async function send(url, { method = 'GET', body = null, headers = {} } = {}) {
    let res;
    try {
      res = await fetcher.fetch(url, {
        method,
        body,
        headers: { 'content-type': 'application/json', ...headers },
        accept: ['application/json'],
        bodyTypes: [/json/i],
        timeoutMs: 20_000,
      });
    } catch (err) {
      throw fromFetchError(err);
    }
    let json = null;
    if (res.body?.length) {
      try {
        json = JSON.parse(res.body.toString('utf8'));
      } catch {
        json = null;
      }
    }
    return { status: res.status, json, headers: res.headers };
  }

  const failFor = (res, what) => {
    const s = res.status;
    if (s === 401)
      return new WordPressError(
        'auth_failed',
        'WordPress did not accept that user name and application password.',
        { status: s },
      );
    if (s === 403)
      return new WordPressError('forbidden', `That WordPress user is not allowed to ${what}.`, {
        status: s,
      });
    if (s === 404)
      return new WordPressError('not_found', `WordPress could not find what ${what} needed.`, {
        status: s,
      });
    if (s === 429)
      return new WordPressError('rate_limited', 'WordPress is asking us to slow down.', {
        status: s,
        retryable: true,
      });
    if (s >= 500)
      return new WordPressError('server_error', 'WordPress had an error.', {
        status: s,
        retryable: true,
      });
    if (s >= 300 && s < 400)
      return new WordPressError(
        'redirected',
        'The address redirects somewhere else: use the final address of the site.',
        { status: s },
      );
    return new WordPressError('bad_response', `WordPress refused the request (${s}).`, {
      status: s,
    });
  };

  const basicHeader = () => {
    if (!username || !appPassword)
      throw new WordPressError('no_credentials', 'No application password is saved.');
    return { authorization: basic(username, appPassword) };
  };

  const signed = (method, route, body) => {
    if (!hmacSecret) throw new WordPressError('no_credentials', 'The plugin is not connected yet.');
    return signRequest({
      secret: hmacSecret,
      method,
      route: `/${PLUGIN_NAMESPACE}${route}`,
      body: body ?? '',
      timestamp: nowSeconds(),
    });
  };

  const pluginCall = async (method, route, payload, what) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = signed(method, route, body);
    const res = await send(restUrl(`/${PLUGIN_NAMESPACE}${route}`), {
      method,
      body: body || null,
      headers,
    });
    if (res.status === 401 && res.json?.code === 'aeo_bad_signature') {
      throw new WordPressError(
        'bad_signature',
        'The plugin rejected our signature: reconnect the plugin.',
        { status: 401 },
      );
    }
    if (res.status === 401 && res.json?.code === 'aeo_not_connected') {
      throw new WordPressError(
        'plugin_not_connected',
        'The plugin on your site is not connected to AEO Corner (it was disconnected there). Connect it again.',
        { status: 401 },
      );
    }
    if (res.status === 404 && res.json?.code === 'rest_no_route') {
      throw new WordPressError(
        'plugin_missing',
        'The AEO Corner plugin is not installed or not active.',
        { status: 404 },
      );
    }
    if (res.status >= 400 || res.status < 200) throw failFor(res, what);
    return res.json;
  };

  return {
    siteUrl: site,

    /**
     * Is this WordPress, can we use its REST API, and is the plugin there? No credentials needed.
     * @returns {{ name, url, wpNamespaces: string[], pluginInstalled: boolean, restBase: string }}
     */
    async probe() {
      let res = await send(`${site}/wp-json/`);
      if (res.status !== 200 || !res.json?.namespaces) {
        const alt = await send(`${site}/?rest_route=/`);
        if (alt.status === 200 && alt.json?.namespaces) {
          res = alt;
          restBase = `${site}/?rest_route=`;
        } else if (res.status === 404 || alt.status === 404 || res.status === 200) {
          throw new WordPressError(
            'not_wordpress',
            'That does not look like a WordPress site with its REST API turned on.',
            { status: res.status },
          );
        } else throw failFor(res, 'read the site');
      } else restBase = `${site}/wp-json`;
      const namespaces = res.json.namespaces.filter((n) => typeof n === 'string').slice(0, 50);
      if (!namespaces.includes('wp/v2'))
        throw new WordPressError(
          'not_wordpress',
          'The REST API is there but posts are not available.',
        );
      return {
        name: text(res.json.name, 120),
        url: text(res.json.url, 300),
        wpNamespaces: namespaces,
        pluginInstalled: namespaces.includes(PLUGIN_NAMESPACE),
        restBase,
      };
    },

    /** Who the application password belongs to and whether they may write posts. */
    async whoAmI() {
      const res = await send(restUrl('/wp/v2/users/me', { context: 'edit' }), {
        headers: basicHeader(),
      });
      if (res.status !== 200) throw failFor(res, 'read your account');
      const caps = res.json?.capabilities ?? {};
      return {
        id: Number(res.json?.id) || null,
        name: text(res.json?.name, 120),
        canPublish: Boolean(caps.publish_posts),
        canEdit: Boolean(caps.edit_posts),
        canManage: Boolean(caps.manage_options),
      };
    },

    async createPost({ title, content, status = 'draft', slug, excerpt, date }) {
      const payload = {
        title: text(title, 255),
        content,
        status,
        ...(slug ? { slug } : {}),
        ...(excerpt ? { excerpt: text(excerpt, 300) } : {}),
        ...(date ? { date } : {}),
      };
      const res = await send(restUrl('/wp/v2/posts'), {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: basicHeader(),
      });
      if (res.status !== 201 && res.status !== 200) throw failFor(res, 'create posts');
      return postOf(res.json);
    },

    /** `type` is what `plugin.resolve` said the address is: a post or a page (other kinds are not supported). */
    async updatePost(id, { title, content, status, slug, excerpt, date }, { type = 'post' } = {}) {
      if (!['post', 'page'].includes(type)) {
        throw new WordPressError(
          'unsupported_type',
          'That address is a kind of page we cannot update (only posts and pages).',
        );
      }
      const payload = {
        ...(title !== undefined ? { title: text(title, 255) } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(status ? { status } : {}),
        ...(slug ? { slug } : {}),
        ...(excerpt !== undefined ? { excerpt: text(excerpt, 300) } : {}),
        ...(date ? { date } : {}),
      };
      const res = await send(
        restUrl(`/wp/v2/${type === 'page' ? 'pages' : 'posts'}/${Number(id)}`),
        {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: basicHeader(),
        },
      );
      if (res.status !== 200) throw failFor(res, 'update that post');
      return postOf(res.json);
    },

    async getPost(id) {
      const res = await send(restUrl(`/wp/v2/posts/${Number(id)}`, { context: 'edit' }), {
        headers: basicHeader(),
      });
      if (res.status !== 200) throw failFor(res, 'read that post');
      return postOf(res.json);
    },

    plugin: {
      /** The handshake: authenticated with the application password (an administrator), it hands the plugin the signing secret. */
      async connect({ secret, indexNowKey = null }) {
        const res = await send(restUrl(`/${PLUGIN_NAMESPACE}/connect`), {
          method: 'POST',
          body: JSON.stringify({ secret, ...(indexNowKey ? { indexnow_key: indexNowKey } : {}) }),
          headers: basicHeader(),
        });
        if (res.status === 404 && res.json?.code === 'rest_no_route') {
          throw new WordPressError(
            'plugin_missing',
            'The AEO Corner plugin is not installed or not active.',
            { status: 404 },
          );
        }
        if (res.status !== 200)
          throw failFor(res, 'connect the plugin (it needs an administrator)');
        return statusOf(res.json);
      },
      async status() {
        return statusOf(await pluginCall('GET', '/status', undefined, 'read the plugin status'));
      },
      /** Server-side JSON-LD for one page, by its address. */
      async setSchema({ url, jsonld }) {
        return pluginCall('PUT', '/schema', { url, jsonld }, 'save structured data');
      },
      async removeSchema({ url }) {
        return pluginCall('DELETE', '/schema', { url }, 'remove structured data');
      },
      async setMeta({ url, title = null, description = null }) {
        return pluginCall(
          'PUT',
          '/meta',
          { url, title, description },
          'save the title and description',
        );
      },
      /** The post behind an address: `{ found, id?, type?, link? }`. */
      async resolve(url) {
        return pluginCall('POST', '/resolve', { url }, 'look the page up');
      },
      async indexNow(urls) {
        return pluginCall('POST', '/indexnow', { urls: urls.slice(0, 100) }, 'ping IndexNow');
      },
      async disconnect() {
        return pluginCall('POST', '/disconnect', {}, 'disconnect');
      },
    },
  };
}

function postOf(json) {
  if (!json || typeof json.id !== 'number')
    throw new WordPressError(
      'bad_response',
      'WordPress answered with something we could not read.',
    );
  return {
    id: json.id,
    link: typeof json.link === 'string' ? json.link : null,
    status: String(json.status ?? ''),
    slug: text(json.slug, 200),
    modified: json.modified_gmt ?? json.modified ?? null,
  };
}

function statusOf(json) {
  if (!json || typeof json !== 'object')
    throw new WordPressError(
      'bad_response',
      'The plugin answered with something we could not read.',
    );
  return {
    pluginVersion: text(json.version, 20),
    wpVersion: text(json.wp, 20),
    seoPlugin: json.seo_plugin ? text(json.seo_plugin, 30) : null,
    indexNow: Boolean(json.indexnow),
    phpVersion: text(json.php, 20),
  };
}
