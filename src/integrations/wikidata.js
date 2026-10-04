import { CRAWLER_USER_AGENT } from '../crawler/safe-fetch.js';

/**
 * Wikidata's public API (Milestone 12, task 12.03): is there an item for this business, and does it point at the
 * customer's website? Read-only, no key, no account. Checked against the API documentation (`wbsearchentities`,
 * `wbgetentities`, `wbgetclaims`) on 2026-10-04. Wikimedia asks every client to identify itself, so the requests carry the
 * crawler's user agent, which links to the page that says who we are.
 *
 * What goes out is the brand's own public name (and the item number the customer typed): nothing else about the
 * customer or the project. The host is a subprocessor entry (`src/core/subprocessors.js`).
 *
 * This is not a crawl of a customer's site, so it does not use the safe fetcher; the address is fixed here, never taken
 * from the customer, and the response is parsed as JSON and used as data only. Errors never carry the response body.
 */

const WIKIDATA_URL = 'https://www.wikidata.org/w/api.php';
const TIMEOUT_MS = 15_000;
/** Names we search for, candidates kept per search, and candidates read in full: a small, polite number of calls. */
export const LIMITS = Object.freeze({ names: 3, perSearch: 7, candidates: 10 });

/** `code`: `unreachable`, `quota` (told to slow down), `http`, or `bad_response`. */
export class WikidataError extends Error {
  constructor(message, { code = 'http', status = null } = {}) {
    super(message);
    this.name = 'WikidataError';
    this.code = code;
    this.status = status;
  }
}

export function createWikidata({
  baseUrl = WIKIDATA_URL,
  fetchImpl = globalThis.fetch,
  userAgent = CRAWLER_USER_AGENT,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  async function call(params) {
    const url = new URL(baseUrl);
    for (const [k, v] of Object.entries({ format: 'json', formatversion: '2', ...params })) {
      url.searchParams.set(k, String(v));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'user-agent': userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new WikidataError('Wikidata could not be reached.', { code: 'unreachable' });
    }
    if (response.status === 429) {
      throw new WikidataError('Wikidata asked us to slow down.', { code: 'quota', status: 429 });
    }
    if (!response.ok) {
      throw new WikidataError(`Wikidata answered with status ${response.status}.`, {
        code: 'http',
        status: response.status,
      });
    }
    let json;
    try {
      json = await response.json();
    } catch {
      throw new WikidataError('Wikidata answered in a way we could not read.', {
        code: 'bad_response',
      });
    }
    if (!json || typeof json !== 'object') {
      throw new WikidataError('Wikidata answered in a way we could not read.', {
        code: 'bad_response',
      });
    }
    if (json.error) {
      const err = new WikidataError('Wikidata answered in a way we could not read.', {
        code: 'bad_response',
      });
      // "No such item" is an answer (the number a customer typed does not exist), not a failure.
      err.apiCode = typeof json.error.code === 'string' ? json.error.code : null;
      throw err;
    }
    return json;
  }

  /** Items whose name or alias starts like `name`: `[{ id }]`. */
  async function search(name) {
    const json = await call({
      action: 'wbsearchentities',
      search: String(name).slice(0, 200),
      language: 'en',
      uselang: 'en',
      type: 'item',
      limit: LIMITS.perSearch,
    });
    if (!Array.isArray(json.search)) {
      throw new WikidataError('Wikidata answered in a way we could not read.', {
        code: 'bad_response',
      });
    }
    return json.search.filter((r) => /^Q\d+$/.test(r?.id ?? '')).map((r) => ({ id: r.id }));
  }

  /** The labels, aliases and descriptions (English) of up to 50 items, by id. A missing item has `missing` set. */
  async function entities(ids) {
    if (ids.length === 0) return [];
    let json;
    try {
      json = await call({
        action: 'wbgetentities',
        ids: ids.join('|'),
        props: 'labels|aliases|descriptions',
        languages: 'en',
      });
    } catch (err) {
      if (err.apiCode === 'no-such-entity') return ids.map((id) => ({ id, missing: true }));
      throw err;
    }
    if (!json.entities || typeof json.entities !== 'object') {
      throw new WikidataError('Wikidata answered in a way we could not read.', {
        code: 'bad_response',
      });
    }
    return ids.map((id) => json.entities[id] ?? { id, missing: '' });
  }

  /** An item's "official website" statements only (P856), so a large item does not bring its whole record. */
  async function websiteClaims(id) {
    const json = await call({ action: 'wbgetclaims', entity: id, property: 'P856' });
    return json.claims && typeof json.claims === 'object' ? json.claims : {};
  }

  /**
   * The items to judge: the one the customer named, or the candidates found by searching their names. Each comes with its
   * official-website statements.
   * @returns {Promise<object[]>} items as `judgeWikidata` reads them
   */
  async function lookup({ names, givenId = '' }) {
    let ids;
    if (givenId) {
      ids = [givenId];
    } else {
      const found = new Set();
      for (const name of names.slice(0, LIMITS.names)) {
        for (const r of await search(name)) found.add(r.id);
      }
      ids = [...found].slice(0, LIMITS.candidates);
    }
    const items = await entities(ids);
    for (const item of items) {
      if (item.missing === undefined) item.claims = await websiteClaims(item.id);
    }
    return items;
  }

  return { search, entities, websiteClaims, lookup };
}
