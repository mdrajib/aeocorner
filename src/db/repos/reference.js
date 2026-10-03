/**
 * Reference data every organization shares (DATABASE_SCHEMA §2): the measured engines and their provider
 * routing. Not tenant data, so it lives outside `forOrg()`. Seeded by migration 0002 and changed by staff only.
 */
export function referenceRepos(prisma) {
  const engines = {
    /** One engine and its routing (primary and fallback provider and method), or null. */
    async get(code) {
      const row = await prisma.engines.findUnique({ where: { code } });
      if (!row) return null;
      return {
        code: row.code,
        name: row.name,
        status: row.status,
        queryField: row.query_field,
        defaultSamples: row.default_samples,
        primaryProviderCode: row.primary_provider_code,
        primaryMethod: row.primary_method,
        fallbackProviderCode: row.fallback_provider_code,
        fallbackMethod: row.fallback_method,
      };
    },
  };
  return { engines };
}
