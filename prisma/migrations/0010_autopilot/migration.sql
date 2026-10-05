-- Autopilot (Milestone 15, task 15.02; ADR-0016).
--
-- Autopilot PREPARES fixes and drafts each week and a person approves them in one inbox. It never writes to a customer's
-- site and never publishes: an item is `ready` until a person approves it through the Action Center's own approve route
-- (which carries the fingerprint or the revision that was shown), or rejects it with a reason.
--
-- autopilot_settings: one row per project, written by an owner or admin. Off by default. `paused_at` is the project-level
-- pause: set, nothing is prepared; the settings stay. last_tick / last_tick_at say what the weekly tick did, for the screen
-- and the staff console.
--
-- autopilot_items: what was prepared. Its identity is (project, recommendation, basis): `basis_hash` is a hash of what the
-- recommendation rested on (its rule, its key, the pages it names), so a second tick finds the item already there and a
-- rejected item is not prepared again without new evidence. status: 'ready' -> 'approved' | 'rejected' (a person) or
-- 'withdrawn' (the system: the fix is no longer needed, was done by hand, or what was prepared no longer matches).
-- An 'auto_fix' item keeps the fingerprint of the change it would write; a 'content' item points at its Content Studio item.

CREATE TABLE autopilot_settings (
  id                 BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  org_id             BIGINT UNSIGNED  NOT NULL,
  project_id         BIGINT UNSIGNED  NOT NULL,
  enabled            TINYINT(1)       NOT NULL DEFAULT 0,
  allow_auto_fix     TINYINT(1)       NOT NULL DEFAULT 1 COMMENT 'may prepare fixes the plugin can write',
  allow_content      TINYINT(1)       NOT NULL DEFAULT 1 COMMENT 'may start content drafts',
  weekly_drafts      TINYINT UNSIGNED NOT NULL DEFAULT 2 COMMENT 'most content drafts started in one week',
  paused_at          DATETIME(3)      NULL COMMENT 'project-level pause: nothing is prepared while set',
  paused_by_user_id  BIGINT UNSIGNED  NULL,
  updated_by_user_id BIGINT UNSIGNED  NULL,
  last_tick_at       DATETIME(3)      NULL,
  last_tick          JSON             NULL COMMENT 'what the latest tick prepared or why it did not',
  created_at         DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_autopilot_settings_project (project_id, org_id),
  KEY ix_autopilot_settings_org (org_id, enabled),
  CONSTRAINT fk_autopilot_settings_project   FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id),
  CONSTRAINT fk_autopilot_settings_paused_by FOREIGN KEY (paused_by_user_id)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_autopilot_settings_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_autopilot_settings_drafts CHECK (weekly_drafts <= 10)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Autopilot switches for one project (Milestone 15)';

CREATE TABLE autopilot_items (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id          CHAR(26)        NOT NULL,
  org_id             BIGINT UNSIGNED NOT NULL,
  project_id         BIGINT UNSIGNED NOT NULL,
  recommendation_id  BIGINT UNSIGNED NOT NULL,
  kind               ENUM('auto_fix','content') NOT NULL,
  status             ENUM('ready','approved','rejected','withdrawn') NOT NULL DEFAULT 'ready',
  week_key           VARCHAR(10)     NOT NULL COMMENT 'the ISO week it was prepared in, e.g. 2026-W41',
  basis_hash         CHAR(64)        NOT NULL COMMENT 'what the recommendation rested on; new evidence is a new hash',
  title              VARCHAR(255)    NOT NULL,
  summary            VARCHAR(500)    NULL,
  prepared_hash      CHAR(64)        NULL COMMENT 'auto_fix: the fingerprint of the change that was prepared',
  prepared           JSON            NULL COMMENT 'auto_fix: the kind, the place and how many pages; never the secret',
  content_item_id    BIGINT UNSIGNED NULL,
  reject_reason      ENUM('not_useful','wrong_content','not_now','other') NULL,
  reject_note        VARCHAR(500)    NULL,
  withdrawn_reason   VARCHAR(100)    NULL,
  decided_by_user_id BIGINT UNSIGNED NULL,
  decided_at         DATETIME(3)     NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_autopilot_items_public (public_id),
  UNIQUE KEY uq_autopilot_items_basis (project_id, recommendation_id, basis_hash),
  KEY ix_autopilot_items_project (project_id, org_id, status),
  KEY ix_autopilot_items_rec (recommendation_id),
  KEY ix_autopilot_items_content (content_item_id),
  CONSTRAINT fk_autopilot_items_project    FOREIGN KEY (project_id, org_id)  REFERENCES projects (id, org_id),
  CONSTRAINT fk_autopilot_items_rec        FOREIGN KEY (recommendation_id)   REFERENCES recommendations (id),
  CONSTRAINT fk_autopilot_items_content    FOREIGN KEY (content_item_id)     REFERENCES content_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_autopilot_items_decided_by FOREIGN KEY (decided_by_user_id)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_autopilot_items_decided   CHECK ((status IN ('approved','rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT ck_autopilot_items_rejected  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CONSTRAINT ck_autopilot_items_withdrawn CHECK ((status = 'withdrawn') = (withdrawn_reason IS NOT NULL)),
  CONSTRAINT ck_autopilot_items_fix       CHECK ((kind = 'auto_fix') = (prepared_hash IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='What Autopilot prepared for a person to approve (Milestone 15)';

-- The plan feature (founder decision F3, a suggestion: the top two plans). A plan without it is shown what Autopilot would do.
UPDATE plans SET features = JSON_SET(features, '$.autopilot', FALSE) WHERE code = 'starter';
UPDATE plans SET features = JSON_SET(features, '$.autopilot', TRUE)  WHERE code IN ('growth','agency');
