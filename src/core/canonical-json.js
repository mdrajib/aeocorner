/**
 * JSON with its keys in order, so two readings of the same value compare equal whatever order their keys came in
 * (MySQL stores a JSON column's keys in its own order, which is not the order our code built them in).
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
