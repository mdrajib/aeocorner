-- Milestone 8 (billing, traffic, digest and admin).
--
-- 1. quota_usage gets a fourth meter, `drafts_billed`: how many of a month's drafts above the plan's allowance have
--    already been reported to Stripe's usage meter, so the hourly report sends only what is new. The table is tiny (one row per
--    organization, month and meter), so the default rebuild is instant in practice. (The column is part of the primary
--    key, which MySQL does not allow ALGORITHM=INSTANT for.)
-- 2. feature_flags and feature_flag_overrides: the admin console's switches (ADMIN_OPERATIONS module 10). A flag has
--    a default; a staff member can override it for one organization (a beta for a design partner). Reading a flag is
--    one query on two small tables, and every change is written to admin_audit_log by the console.

ALTER TABLE quota_usage
  MODIFY COLUMN meter ENUM('drafts','runs_now','audits','drafts_billed') NOT NULL;

CREATE TABLE feature_flags (
  flag_key          VARCHAR(64)   NOT NULL,
  description       VARCHAR(255)  NOT NULL,
  enabled_default   BOOLEAN       NOT NULL DEFAULT FALSE,
  updated_by_staff_id BIGINT UNSIGNED NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (flag_key),
  CONSTRAINT fk_feature_flags_staff FOREIGN KEY (updated_by_staff_id) REFERENCES staff_users (id),
  CONSTRAINT ck_feature_flags_key CHECK (flag_key REGEXP '^[a-z][a-z0-9_.]*$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Feature switches set from the admin console';

CREATE TABLE feature_flag_overrides (
  flag_key          VARCHAR(64)   NOT NULL,
  org_id            BIGINT UNSIGNED NOT NULL,
  enabled           BOOLEAN       NOT NULL,
  set_by_staff_id   BIGINT UNSIGNED NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (flag_key, org_id),
  KEY ix_feature_flag_overrides_org (org_id),
  CONSTRAINT fk_feature_flag_overrides_flag  FOREIGN KEY (flag_key)        REFERENCES feature_flags (flag_key) ON DELETE CASCADE,
  CONSTRAINT fk_feature_flag_overrides_org   FOREIGN KEY (org_id)          REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_feature_flag_overrides_staff FOREIGN KEY (set_by_staff_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='A flag turned on or off for one organization';
