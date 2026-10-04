import { createHash } from 'node:crypto';
import { describeChange } from './dashboard.js';

/**
 * Which things are worth an email (Milestone 8, task 8.14; ADMIN_OPERATIONS §6 `alerts.evaluate`): a significant DROP in
 * how often or how prominently the brand is named, a competitor that is significantly rising, and a negative claim an AI
 * made about the brand. Pure: the events and claims come in, a short list of alerts goes out.
 *
 * What is NOT alerted: a rise (the weekly digest celebrates those), a change that did not pass the significance test
 * (`change_events` only keeps ones that did, and this checks again), and anything that has already been alerted.
 */

const DROP_KINDS = new Set(['mention_rate_change', 'sov_change', 'citation_share_change']);
const MAX_ITEMS = 5;
const MAX_CLAIM_CHARS = 240;

const MEASURE_LABELS = {
  mention_rate_change: 'How often AI answers name you',
  sov_change: 'Your share of voice',
  citation_share_change: 'Your share of cited sources',
};

/** A stable short key for a claim, so the same claim is told about once. */
export function claimKey(claim) {
  const norm = `${claim.attribute}\n${String(claim.value).trim().toLowerCase()}`;
  return `claim.${createHash('sha256').update(norm).digest('hex').slice(0, 20)}`;
}

/**
 * @param {object} input
 * @param {object[]} input.events   `change_events` rows (snake_case) not yet alerted
 * @param {object[]} input.claims   negative claims about the brand: `{ attribute, value, count, engineCodes }`
 * @param {object} [input.engineNames]  engine code → label
 * @param {object} [input.entityNames]  entity id → name (a competitor's surge names it)
 * @returns {{ items: object[], eventIds: bigint[] }} `items` are `{ key, kind, tone, title, text }`, worst first;
 *   `eventIds` are the events they cover (to be marked alerted once the emails are sent)
 */
export function selectAlerts({ events = [], claims = [], engineNames = {}, entityNames = {} }) {
  const significant = events.filter((e) => e.is_significant);
  const items = [];
  const covered = [];

  // Drops: one alert per measure. The all-engines event says it best; per-engine events are only used when no
  // all-engines one exists, and are folded into the same alert's text.
  for (const kind of DROP_KINDS) {
    const drops = significant.filter((e) => e.kind === kind && e.direction === 'down');
    if (drops.length === 0) continue;
    const overall = drops.find((e) => e.engine_code === null);
    const chosen = overall ? [overall] : drops.slice(0, 3);
    const described = chosen.map((e) => describeChange(e, { engineNames }));
    const engines = overall
      ? drops
          .filter((e) => e.engine_code !== null)
          .map((e) => engineNames[e.engine_code] ?? e.engine_code)
      : [];
    items.push({
      key: `drop.${chosen.map((e) => e.id).join('-')}`,
      kind: 'drop',
      tone: 'danger',
      title: described[0].title,
      text:
        described.map((d) => d.text).join(' ') +
        (engines.length ? ` The fall shows on ${engines.join(', ')}.` : ''),
      measure: MEASURE_LABELS[kind],
    });
    covered.push(...drops.map((e) => e.id));
  }

  // A competitor that is significantly rising.
  const surges = significant.filter((e) => e.kind === 'competitor_surge' && e.direction === 'up');
  const byEntity = new Map();
  for (const e of surges) {
    const current = byEntity.get(String(e.entity_id));
    if (!current || (e.engine_code === null && current.engine_code !== null)) {
      byEntity.set(String(e.entity_id), e);
    }
  }
  for (const e of byEntity.values()) {
    const name = entityNames[String(e.entity_id)] ?? 'A competitor';
    const d = describeChange(e, { entityName: name, engineNames });
    items.push({
      key: `surge.${e.id}`,
      kind: 'surge',
      tone: 'warning',
      title: d.title,
      text: d.text,
    });
  }
  covered.push(...surges.map((e) => e.id));

  // What an AI said about the brand that is negative, in its own words (the page escapes them).
  for (const c of claims) {
    const said = String(c.value).replace(/\s+/g, ' ').trim().slice(0, MAX_CLAIM_CHARS);
    if (!said) continue;
    const places = c.count === 1 ? '1 answer' : `${c.count} answers`;
    const where = c.engineCodes?.length
      ? ` on ${c.engineCodes.map((code) => engineNames[code] ?? code).join(', ')}`
      : '';
    items.push({
      key: claimKey(c),
      kind: 'claim',
      tone: 'danger',
      title: `An AI answer said something negative about your ${c.attribute}`,
      text: `“${said}” appeared in ${places}${where}. We repeat it as the answer said it: we have not checked whether it is true.`,
    });
  }

  return { items: items.slice(0, MAX_ITEMS), eventIds: [...new Set(covered)] };
}

/** The subject line for a set of alerts about one project. */
export function alertSubject(items, projectName) {
  if (items.length === 1) return `${items[0].title}: ${projectName}`;
  return `${items.length} things changed for ${projectName}`;
}
