-- Entity checks (Milestone 12, tasks 12.02 and 12.03). One row per thing we look at for a project's entity: each profile
-- address the customer listed in the Brand Kit (kind 'profile', subject = the address) and the Wikidata lookup (kind
-- 'wikidata', subject = 'wikidata'). A check is repeated, so a row holds only the LATEST attempt and is replaced by the
-- next one.
--
-- status says what the attempt found: 'passed', 'failed', or 'error' (we could not look: a platform that blocks us, a
-- sign-in page, a timed-out lookup). 'error' is never read as 'failed' anywhere: it opens no recommendation. `finding`
-- names the reason in a word the code can branch on (src/core/entity-checks.js).
--
-- The table is new, so there is nothing to rebuild. It also adds one content format for the About page that Content
-- Studio can now write (12.08): the new value goes at the END of the ENUM, as every enum change here does.

CREATE TABLE entity_checks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id      BIGINT UNSIGNED NOT NULL,
  project_id  BIGINT UNSIGNED NOT NULL,
  kind        ENUM('profile','wikidata') NOT NULL,
  subject     VARCHAR(500)    NOT NULL COMMENT 'the profile address, or "wikidata"',
  platform    VARCHAR(32)     NULL COMMENT 'for a profile: linkedin, google_business, ...',
  status      ENUM('passed','failed','error') NOT NULL,
  finding     VARCHAR(32)     NOT NULL,
  http_status SMALLINT UNSIGNED NULL,
  details     JSON            NULL COMMENT 'reachable, names the brand, links back; for Wikidata the item found',
  checked_at  DATETIME(3)     NOT NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_entity_checks_subject (project_id, kind, subject),
  KEY ix_entity_checks_project (project_id, org_id),
  CONSTRAINT fk_entity_checks_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Latest entity check per profile address and for Wikidata (Milestone 12)';

ALTER TABLE content_items
  MODIFY COLUMN format ENUM('comparison','best_of','how_to','faq','glossary','facts_page','other','about_page') NOT NULL;
