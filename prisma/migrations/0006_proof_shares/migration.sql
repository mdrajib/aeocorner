-- Share a proven win (UI_DESIGN D4). A customer can turn one proof card into a public, read-only page they can send to
-- a boss or a client. The page's address is `public_id` (a ULID, so unguessable). Only an outcome that passed the
-- significance test can be shared (the application checks `verdict = 'proven_win'`; the verdict cannot change once
-- written).
--
-- One row per outcome. Stopping a share sets `revoked_at`; sharing again gives the row a NEW `public_id` and clears
-- `revoked_at`, so a link that was stopped stays dead even if someone kept it.
-- The table is new (no existing rows), so there is nothing to rebuild.

CREATE TABLE proof_shares (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id             BIGINT UNSIGNED NOT NULL,
  project_id         BIGINT UNSIGNED NOT NULL,
  outcome_id         BIGINT UNSIGNED NOT NULL,
  public_id          CHAR(26)        NOT NULL COMMENT 'ULID: the address of the public page',
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  shared_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'when the current address was made',
  revoked_at         DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_proof_shares_public (public_id),
  UNIQUE KEY uq_proof_shares_outcome (outcome_id),
  KEY ix_proof_shares_project (project_id, org_id),
  CONSTRAINT fk_proof_shares_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id),
  CONSTRAINT fk_proof_shares_outcome FOREIGN KEY (outcome_id) REFERENCES action_outcomes (id) ON DELETE CASCADE,
  CONSTRAINT fk_proof_shares_user    FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='A proven win shared as a public read-only page (D4)';
