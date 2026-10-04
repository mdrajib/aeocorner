-- =====================================================================
-- AEO Corner: schema guard-rail checks (run in CI after migrations)
-- Every query must return ZERO rows. Any row is a failed check.
-- Run against the migrated database: USE aeo_corner; SOURCE checks.sql;
-- =====================================================================

-- 1. Every table has a primary key (DO Managed MySQL requires it).
SELECT 'missing primary key' AS failed_check, t.table_name
FROM information_schema.tables t
LEFT JOIN information_schema.table_constraints c
  ON c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.constraint_type = 'PRIMARY KEY'
WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE' AND c.constraint_name IS NULL;

-- 2. Tenancy: a table without org_id must be on the reviewed global list.
--    Adding a table here is a deliberate, reviewed decision.
SELECT 'table without org_id is not on the global list' AS failed_check, t.table_name
FROM information_schema.tables t
WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
                  WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'org_id')
  AND t.table_name NOT IN (
    'plans','providers','engines','web_domains','web_urls',                    -- reference data
    'staff_users','staff_roles',                                               -- internal staff
    'users','organizations',                                                   -- identity (org is the tenant root)
    'leads','audit_answers','abuse_blocks',                                    -- anonymous audit funnel
    'email_suppressions','announcements','provider_health','webhook_events',   -- platform operations
    'feature_flags',                                                           -- staff switches (overrides carry org_id)
    '_prisma_migrations'                                                       -- Prisma Migrate history
  );

-- 3. Tenancy: org_id may be NULL only on the reviewed "mixed" tables.
SELECT 'nullable org_id outside the mixed list' AS failed_check, c.table_name
FROM information_schema.columns c
WHERE c.table_schema = DATABASE() AND c.column_name = 'org_id' AND c.is_nullable = 'YES'
  AND c.table_name NOT IN ('audits','site_scans','scan_pages','scan_checks','notifications',
                           'usage_ledger','admin_audit_log');

-- 4. Fact tables stay partition-ready: no foreign keys in or out.
SELECT 'fact table has a foreign key' AS failed_check, k.table_name, k.constraint_name
FROM information_schema.referential_constraints k
WHERE k.constraint_schema = DATABASE()
  AND (k.table_name IN ('answer_snapshots','mentions','citations','claims','cell_results','cell_entity_results')
       OR k.referenced_table_name IN ('answer_snapshots','mentions','citations','claims','cell_results','cell_entity_results'));

-- 5. Fact tables stay partition-ready: every PRIMARY/UNIQUE key includes run_date.
SELECT 'unique key without run_date on a fact table' AS failed_check, s.table_name, s.index_name
FROM information_schema.statistics s
WHERE s.table_schema = DATABASE()
  AND s.table_name IN ('answer_snapshots','mentions','citations','claims','cell_results','cell_entity_results')
  AND s.non_unique = 0
GROUP BY s.table_name, s.index_name
HAVING SUM(s.column_name = 'run_date') = 0;

-- 6. One character set and collation everywhere (joins on text columns stay index-friendly).
SELECT 'unexpected collation' AS failed_check, t.table_name, t.table_collation
FROM information_schema.tables t
WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
  AND t.table_collation <> 'utf8mb4_0900_ai_ci'
  AND t.table_name <> '_prisma_migrations';   -- Prisma creates its history table with utf8mb4_unicode_ci

-- 7. No FLOAT/DOUBLE columns (money and rates use DECIMAL).
SELECT 'floating-point column' AS failed_check, c.table_name, c.column_name
FROM information_schema.columns c
WHERE c.table_schema = DATABASE() AND c.data_type IN ('float','double');
