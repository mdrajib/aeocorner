/**
 * A rule of the data model that a caller broke, as opposed to a database failure.
 * `code` is stable and safe to branch on; `message` is for logs, not for customers.
 */
export class DomainError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** Prisma reports a duplicate key as P2002 and names the index in `meta` (MySQL via the mariadb adapter). */
export function isUniqueViolation(err, indexName) {
  if (err?.code !== 'P2002') return false;
  if (!indexName) return true;
  return err.meta?.driverAdapterError?.cause?.constraint?.index === indexName;
}

/** A foreign key refused the row (P2003), e.g. a project that belongs to another organization. */
export function isForeignKeyViolation(err) {
  return err?.code === 'P2003';
}
