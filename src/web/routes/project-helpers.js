/**
 * Small helpers the project screens share (project home, Brand Kit, Prompt Manager, setup). Form bodies arrive from
 * `express.urlencoded({ extended: false })`: a field sent once is a string, sent several times an array, never sent
 * undefined, so lists of rows are read as parallel arrays.
 */

export const text = (value, max = 200) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** A field as an array, whether it came once, many times or not at all. */
export const toArray = (value) =>
  Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

/** One item per non-empty line of a textarea (or of several), each tidied and cut to `max` characters. */
export const lines = (value, max = 200) =>
  toArray(value)
    .flatMap((s) => s.split('\n'))
    .map((s) => text(s, max))
    .filter(Boolean);

/** "Oct 3, 2026" (UTC, so a page reads the same wherever it is opened). */
export const dateLabel = (value) =>
  new Date(value).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

export const idFrom = (value) => (/^\d{1,18}$/.test(String(value)) ? BigInt(value) : null);

/**
 * Rows of a repeated group of fields ("offering_name", "offering_url", ...) as objects, dropping rows where every
 * field is empty. `fields` maps the object key to the form field name and its length limit.
 */
export function rowsOf(body, fields) {
  const columns = Object.entries(fields).map(([key, [name, max]]) => [
    key,
    toArray(body[name]),
    max,
  ]);
  const count = Math.max(0, ...columns.map(([, values]) => values.length));
  const rows = [];
  for (let i = 0; i < Math.min(count, 100); i += 1) {
    const row = Object.fromEntries(
      columns.map(([key, values, max]) => [key, text(values[i], max)]),
    );
    if (Object.values(row).some(Boolean)) rows.push(row);
  }
  return rows;
}

/**
 * Where a form that can be used from more than one screen goes back to. Only these places, never an address from the
 * form: an open redirect would send a customer anywhere.
 */
export function returnPath(projectBase, where) {
  const places = {
    brand: `${projectBase}/brand?tab=competitors`,
    setup: `${projectBase}/setup/competitors`,
  };
  return places[where] ?? projectBase;
}

/** The same path with `?notice=…` (or `&notice=…`) added. */
export const withNotice = (path, notice) =>
  `${path}${path.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}`;
