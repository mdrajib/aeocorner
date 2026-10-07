/**
 * The purge of a closed organization (docs/DATABASE_SCHEMA.md §8): every row it owns is deleted, children before
 * parents, so no foreign key is ever violated. The order is worked out from the database's own foreign keys, so a
 * table added later is purged without anyone remembering to list it.
 */

/**
 * Tables that carry `org_id` but are deliberately NOT purged, each with the reason. They hold no customer content: a
 * numeric organization ID, a staff action or a cost. They are the proof that the purge happened and the cost record.
 * The application's database user can't delete from the two logs at all (append-only grants).
 */
export const KEPT_AFTER_PURGE = {
  admin_audit_log: 'staff actions: kept as proof, append-only, no customer content',
  data_requests: 'export and deletion requests: kept as proof that the purge happened',
  org_activity_log:
    'customer activity log: append-only for the application; keeps only the numeric organization ID',
  usage_ledger:
    'what each provider call cost: kept for the 25-month cost record, no customer content',
};

/** How long a webhook delivery keeps its payload (the `webhook_events.payload` column's own comment says 30 days). */
export const WEBHOOK_PAYLOAD_DAYS = 30;
/** And how long the row itself stays, to recognise a delivery sent again (docs/DATABASE_SCHEMA.md §8). */
export const WEBHOOK_ROW_DAYS = 90;

/**
 * Put `tables` in a deletion order: a table comes after every table that has a foreign key pointing at it.
 * `edges` are `{ child, parent }` pairs; a pair that names a table outside `tables`, or a table pointing at
 * itself, is ignored (a self-reference is `SET NULL` in the schema, so rows in one table can go in any order).
 * Ties keep alphabetical order, so the result is stable. Tables left in a cycle (there are none today) are
 * appended in alphabetical order rather than dropped, and the database refuses the delete if that was wrong.
 */
export function purgeOrder(tables, edges) {
  const names = [...new Set(tables)].sort();
  const set = new Set(names);
  const parentsOf = new Map(names.map((t) => [t, new Set()]));
  const childrenOf = new Map(names.map((t) => [t, new Set()]));
  for (const { child, parent } of edges) {
    if (child === parent || !set.has(child) || !set.has(parent)) continue;
    parentsOf.get(parent).add(child); // `parent` waits for every child that references it
    childrenOf.get(child).add(parent);
  }

  const waiting = new Map(names.map((t) => [t, parentsOf.get(t).size]));
  const order = [];
  let ready = names.filter((t) => waiting.get(t) === 0);
  while (ready.length > 0) {
    const next = ready.shift();
    order.push(next);
    for (const parent of childrenOf.get(next)) {
      waiting.set(parent, waiting.get(parent) - 1);
      if (waiting.get(parent) === 0) ready.push(parent);
    }
    ready.sort();
  }
  const done = new Set(order);
  return [...order, ...names.filter((t) => !done.has(t))];
}
