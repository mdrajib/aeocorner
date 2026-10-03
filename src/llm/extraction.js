import { EXTRACTION_JSON_SCHEMA, extractionSchema } from './extraction-schema.js';
import {
  answerBlock,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  trackedEntitiesBlock,
} from './extraction-prompt.js';
import { normalizeDomain, normalizeName } from './names.js';

/**
 * Answer extraction, as pure functions (MVP §6.4). No database, no network: the worker jobs, the free audit and
 * the golden-set eval all use these, so what the eval measures is exactly what production runs.
 *
 *   trackedEntities(rows)          the project's brand and competitors, numbered E1..En (the order is stable, so
 *                                  the prompt's entity block is the same for every answer of a run and is cached)
 *   buildExtractionRequest(...)    one Messages API request for one answer (also the `params` of a batch item)
 *   readReply(message)             Claude's reply checked strictly: the reading, or why there is none
 *   mergeReading(...)              the pre-pass and Claude's reading combined into what is stored, plus every
 *                                  tracked brand the two disagree about (for the review queue)
 *   extractionVersion(profile)     the label every derived row carries, so history can be re-extracted (§6.4 step 5)
 */

/** Answers longer than this are not sent (the providers' answers are a few thousand characters). */
export const MAX_ANSWER_CHARS = 100_000;

/** "x1.opus55": the prompt version and the model. Fits `extraction_version VARCHAR(16)`. */
export const extractionVersion = (profile) => `${PROMPT_VERSION}.${profile.tag}`;

/**
 * Number the tracked entities: the brand first, then competitors in a stable order. Each row is
 * `{ id, kind, name, aliases: [], domains: [], excludes: [] }`.
 */
export function trackedEntities(rows) {
  const order = { brand: 0, competitor: 1 };
  return [...rows]
    .filter((r) => r.kind in order)
    .sort((a, b) => order[a.kind] - order[b.kind] || compareIds(a.id, b.id))
    .map((r, i) => ({
      ...r,
      ref: `E${i + 1}`,
      aliases: unique(r.aliases ?? []),
      domains: unique((r.domains ?? []).map(normalizeDomain).filter(Boolean)),
      excludes: unique(r.excludes ?? []),
    }));
}

const compareIds = (a, b) => {
  const [x, y] = [BigInt(a), BigInt(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};
const unique = (list) => [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];

/**
 * The batch item ID for one answer: `s<snapshot id>_<run date as yyyymmdd>`, which is what locates the row
 * (`answer_snapshots` is keyed by both). Matches the API's `^[a-zA-Z0-9_-]{1,64}$`.
 */
export function customIdFor(snapshotId, runDate) {
  const date = (runDate instanceof Date ? runDate.toISOString() : String(runDate)).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`Not a run date: ${runDate}`);
  return `s${BigInt(snapshotId)}_${date.replaceAll('-', '')}`;
}

export function parseCustomId(customId) {
  const match = /^s([1-9]\d{0,19})_(\d{4})(\d{2})(\d{2})$/.exec(String(customId));
  if (!match) return null;
  return { snapshotId: BigInt(match[1]), runDate: `${match[2]}-${match[3]}-${match[4]}` };
}

/**
 * One Messages API request for one answer.
 *
 * @param {object} args
 * @param {object} args.profile     a model profile (models.js)
 * @param {Array}  args.entities    trackedEntities(...)
 * @param {string} args.question    what was asked (the prompt's text, or its search query for AI Overviews)
 * @param {string} args.engine      engine code
 * @param {string} args.text        the answer as the engine gave it
 * @param {Array}  args.citations   the pre-pass's numbered sources
 */
export function buildExtractionRequest({ profile, entities, question, engine, text, citations }) {
  if (String(text ?? '').length > MAX_ANSWER_CHARS) {
    throw new RangeError(`The answer is longer than ${MAX_ANSWER_CHARS} characters`);
  }
  return {
    model: profile.id,
    max_tokens: profile.maxTokens,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: trackedEntitiesBlock(entities),
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: answerBlock({ question, engine, text, citations }) },
        ],
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: EXTRACTION_JSON_SCHEMA },
      ...(profile.effort ? { effort: profile.effort } : {}),
    },
  };
}

/**
 * Claude's reply, checked. `{ ok: true, reading }`, or `{ ok: false, reason, detail }` where reason is one of
 *   refusal        the model declined (stop_reason "refusal")
 *   max_tokens     the reply was cut off: it can't be trusted, even if what arrived parses
 *   no_text        no text block at all
 *   invalid_json   the text isn't JSON
 *   invalid_shape  JSON, but not the extraction shape
 * A reply that isn't ok writes nothing: the answer's extraction is marked failed and its old rows stay.
 */
export function readReply(message) {
  if (message?.stop_reason === 'refusal') {
    return { ok: false, reason: 'refusal', detail: message.stop_details?.category ?? null };
  }
  if (message?.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
  const text = (message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) return { ok: false, reason: 'no_text' };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const parsed = extractionSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_shape', detail: parsed.error.issues[0]?.message ?? null };
  }
  return { ok: true, reading: parsed.data };
}

// ---------------------------------------------------------------------------------------------------------------
// Merging

/** Resolve a name Claude read to a tracked entity: its name, an alias, or its domain. */
function resolverFor(entities) {
  const byName = new Map();
  const byDomain = new Map();
  for (const e of entities) {
    for (const n of [e.name, ...e.aliases]) {
      const key = normalizeName(n);
      if (key && !byName.has(key)) byName.set(key, e);
    }
    for (const d of e.domains) if (!byDomain.has(d)) byDomain.set(d, e);
  }
  const byRef = new Map(entities.map((e) => [e.ref, e]));
  const isExcluded = (entity, name) => {
    const key = normalizeName(name);
    return entity.excludes.some((x) => {
      const phrase = normalizeName(x);
      return phrase && (key === phrase || key.includes(phrase));
    });
  };
  return {
    byRef: (ref) => byRef.get(ref) ?? null,
    byName(name) {
      const key = normalizeName(name);
      if (!key) return null;
      return byName.get(key) ?? byDomain.get(normalizeDomain(key)) ?? null;
    },
    isExcluded,
  };
}

/**
 * Combine the pre-pass and Claude's reading into the rows to store.
 *
 * Tracked brands: a brand counts as mentioned when either reader found it (`detected_by` says which). Where only
 * one did, the answer goes to the review queue. Claude's fields (rank, stance…) are kept when Claude found it;
 * a brand only the pre-pass found has them empty, never guessed.
 *
 * Other brands Claude names are "discovered": returned by name; the repository finds or creates their entity.
 *
 * @returns {{ answerType, mentions, citations, disagreements }}
 */
export function mergeReading({ entities, prepass, reading, text }) {
  const resolve = resolverFor(entities);
  const hay = String(text ?? '').toLowerCase();
  const prepassByEntity = new Map(prepass.mentions.map((m) => [m.entity.ref, m]));

  // 1. Claude's entities, each resolved to a tracked entity or kept as a discovered name. Duplicates (two
  //    entries for one brand) keep the first.
  const fromLlm = new Map();
  reading.entities.forEach((item, index) => {
    let entity = item.tracked_ref ? resolve.byRef(item.tracked_ref) : null;
    entity ??= resolve.byName(item.name);
    if (entity && resolve.isExcluded(entity, item.name)) entity = null;
    const key = entity ? `t:${entity.ref}` : `d:${normalizeName(item.name)}`;
    if (key === 'd:' || fromLlm.has(key)) return;
    fromLlm.set(key, { item, entity, index });
  });

  // 2. One mention per brand, from either reader.
  const mentions = [];
  for (const [key, { item, entity, index }] of fromLlm) {
    const pre = entity ? prepassByEntity.get(entity.ref) : null;
    mentions.push({
      entityId: entity ? entity.id : null,
      entityRef: entity ? entity.ref : null,
      entityKind: entity ? entity.kind : 'discovered',
      discoveredName: entity ? null : item.name,
      nameAsWritten: (pre?.nameAsWritten ?? item.name).slice(0, 255),
      listRank: item.list_rank,
      prominence: item.prominence,
      stance: item.stance,
      sentiment: item.sentiment,
      excerpt: entity ? item.excerpt || pre?.excerpt || null : null,
      detectedBy: pre ? 'both' : 'llm',
      claims: entity ? item.claims : [],
      firstAt: pre?.firstIndex ?? firstIndexOf(hay, item.name),
      llmIndex: index,
      key,
    });
  }
  for (const pre of prepass.mentions) {
    if (fromLlm.has(`t:${pre.entity.ref}`)) continue;
    mentions.push({
      entityId: pre.entity.id,
      entityRef: pre.entity.ref,
      entityKind: pre.entity.kind,
      discoveredName: null,
      nameAsWritten: pre.nameAsWritten.slice(0, 255),
      listRank: null,
      prominence: null,
      stance: null,
      sentiment: null,
      excerpt: pre.excerpt,
      detectedBy: 'prepass',
      claims: [],
      firstAt: pre.firstIndex,
      llmIndex: Infinity,
      key: `t:${pre.entity.ref}`,
    });
  }

  // 3. The order brands are first named in: where the text shows it, else Claude's order.
  mentions.sort((a, b) => a.firstAt - b.firstAt || a.llmIndex - b.llmIndex);
  mentions.forEach((m, i) => {
    m.mentionOrder = Math.min(255, i + 1);
  });

  // 4. Disagreements about tracked brands.
  const disagreements = mentions
    .filter((m) => m.entityId !== null && m.detectedBy !== 'both')
    .map((m) => ({
      entityId: m.entityId,
      prepass: m.detectedBy === 'prepass',
      llm: m.detectedBy === 'llm',
      nameAsWritten: m.nameAsWritten,
      excerpt: m.excerpt,
    }));

  // 5. Citations: the pre-pass's numbered sources, with the brands Claude says each one backs.
  const supports = new Map();
  for (const c of reading.citations) {
    const list = supports.get(c.source) ?? [];
    for (const value of c.supports) {
      const entity = resolve.byRef(value) ?? resolve.byName(value);
      if (entity) list.push({ entityId: entity.id });
      else if (normalizeName(value) && fromLlm.has(`d:${normalizeName(value)}`)) {
        list.push({ discoveredName: fromLlm.get(`d:${normalizeName(value)}`).item.name });
      }
    }
    supports.set(c.source, list);
  }
  const citations = prepass.citations.map((c) => {
    const backed = supports.get(c.position) ?? [];
    return {
      position: c.position,
      url: c.url,
      domain: c.domain,
      title: c.title,
      ownerEntityId: c.owner ? c.owner.id : null,
      isOwn: c.owner?.kind === 'brand',
      supportsEntityIds: uniqueIds(backed.filter((s) => s.entityId != null).map((s) => s.entityId)),
      supportsDiscovered: unique(
        backed.filter((s) => s.discoveredName).map((s) => s.discoveredName),
      ),
    };
  });

  return {
    answerType: reading.answer_type,
    mentions: mentions.map(({ firstAt: _f, llmIndex: _l, key: _k, ...m }) => m),
    citations,
    disagreements,
  };
}

const firstIndexOf = (hay, name) => {
  const at = hay.indexOf(String(name ?? '').toLowerCase());
  return at === -1 ? Infinity : at;
};

const uniqueIds = (ids) => {
  const seen = new Set();
  return ids.filter((id) => {
    const key = String(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
