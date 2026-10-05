-- Visibility recovery cases (Milestone 14, task 14.01).
--
-- A case is opened when a decline has LASTED: the 28-vs-28 comparison says the brand's figure fell significantly and the
-- latest 14 days are still lower (src/core/recovery.js). It records what was measured when it opened (the baseline and the
-- fall, as counts, never rates), the diagnosis the code made (causes with the facts behind each, or "can't tell"), the
-- repairs it points at (existing Action Center rules and fixes), and how it ended.
--
-- status: 'diagnosing' (open, no cause named yet) -> 'repairing' (a cause is named and its repairs are linked) ->
-- 'recovered' (the figure is back inside its earlier range and a repair was done), 'closed_noise' (it came back with
-- nothing done), 'closed_unknown' (it stayed down for the set time). Only the system moves a case.
--
-- open_key is `<metric>:<engine or all>` while the case is open and NULL once it is closed, and (project_id, open_key) is
-- unique: a decline opens exactly one case however many times the job runs. Closed cases keep their rows.
--
-- recovery_events is the case's timeline, appended to and never edited.

CREATE TABLE recovery_cases (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id        CHAR(26)        NOT NULL,
  org_id           BIGINT UNSIGNED NOT NULL,
  project_id       BIGINT UNSIGNED NOT NULL,
  metric           ENUM('mention_rate','share_of_voice','citation_share') NOT NULL,
  engine_code      VARCHAR(32)     NULL COMMENT 'NULL = all engines',
  status           ENUM('diagnosing','repairing','recovered','closed_noise','closed_unknown') NOT NULL DEFAULT 'diagnosing',
  open_key         VARCHAR(64)     NULL COMMENT 'metric:engine while open; NULL once closed',
  trigger_event_id BIGINT UNSIGNED NULL COMMENT 'the change event that showed the decline, if one was stored',
  baseline_start   DATE            NOT NULL,
  baseline_end     DATE            NOT NULL,
  baseline_n       INT UNSIGNED    NOT NULL,
  baseline_k       INT UNSIGNED    NOT NULL,
  decline_start    DATE            NOT NULL,
  decline_end      DATE            NOT NULL,
  decline_n        INT UNSIGNED    NOT NULL,
  decline_k        INT UNSIGNED    NOT NULL,
  recent_n         INT UNSIGNED    NOT NULL,
  recent_k         INT UNSIGNED    NOT NULL,
  p_value          DECIMAL(9,8)    NULL,
  onset_date       DATE            NULL COMMENT 'our estimate of when the fall began',
  opened_at        DATETIME(3)     NOT NULL,
  recheck          JSON            NULL COMMENT 'the fresh scan and the live check of each earlier fix, taken when the case opened',
  recheck_done_at  DATETIME(3)     NULL,
  diagnosis        JSON            NULL COMMENT 'outcome named | cant_tell, the causes with their facts',
  diagnosed_at     DATETIME(3)     NULL,
  repairs          JSON            NULL COMMENT 'the existing rules and fixes the diagnosis points at',
  closed_at        DATETIME(3)     NULL,
  close_details    JSON            NULL COMMENT 'the counts the closing judged on',
  alerted_at       DATETIME(3)     NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_recovery_cases_public (public_id),
  UNIQUE KEY uq_recovery_cases_open (project_id, open_key),
  KEY ix_recovery_cases_project (project_id, org_id, status),
  KEY ix_recovery_cases_trigger (trigger_event_id),
  CONSTRAINT fk_recovery_cases_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id),
  CONSTRAINT fk_recovery_cases_event FOREIGN KEY (trigger_event_id) REFERENCES change_events (id) ON DELETE SET NULL,
  CONSTRAINT ck_recovery_cases_open_key CHECK ((status IN ('diagnosing','repairing')) = (open_key IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='A lasting decline in visibility, its diagnosis and how it ended (Milestone 14)';

CREATE TABLE recovery_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id      BIGINT UNSIGNED NOT NULL,
  project_id  BIGINT UNSIGNED NOT NULL,
  case_id     BIGINT UNSIGNED NOT NULL,
  kind        ENUM('opened','rechecked','diagnosed','repairs_linked','recovered','closed_noise','closed_unknown','alerted') NOT NULL,
  details     JSON            NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_recovery_events_case (case_id, id),
  KEY ix_recovery_events_project (project_id, org_id),
  CONSTRAINT fk_recovery_events_case FOREIGN KEY (case_id) REFERENCES recovery_cases (id),
  CONSTRAINT fk_recovery_events_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='The timeline of a recovery case (Milestone 14)';
