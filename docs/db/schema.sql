-- =====================================================================
-- AEO Corner: database schema v1 (reference DDL)
-- ---------------------------------------------------------------------
-- Target  : MySQL 8.0.19+ (DigitalOcean Managed MySQL).
--           Tested on MySQL 8.4 with sql_require_primary_key=ON.
-- Design  : docs/DATABASE_SCHEMA.md (conventions, ERDs, query patterns,
--           retention, grants). Read that first.
-- Status  : Design artifact, 2026-09-28. Becomes the first Prisma migration
--           (prisma/migrations/0001_init/migration.sql). Since 2026-10-03 this file
--           is the readable snapshot of 0001_init plus every later migration
--           (0003 adds the domain-verification columns of projects, 0004 the
--           failure columns of content_items, 0005 a fourth quota meter and the
--           feature-flag tables). Migrations stay
--           hand-written SQL; schema.prisma is generated from the database
--           with `prisma db pull`, never edited by hand (§10.2).
-- Auth    : Clerk handles sign-in, sessions and MFA (identity only).
--           Organizations, roles and invitations live in these tables.
--
-- Conventions (full list in DATABASE_SCHEMA.md §1)
--   * BIGINT UNSIGNED AUTO_INCREMENT ids; public_id CHAR(26) ULIDs on rows
--     that appear in URLs.
--   * Every tenant-owned row carries org_id. Project-owned rows also carry
--     project_id, with FK (project_id, org_id) -> projects (id, org_id) so
--     the two can never disagree.
--   * High-volume fact tables have NO foreign keys and a primary key that
--     includes run_date, so monthly RANGE partitioning can be switched on
--     later without key changes.
--   * All DATETIME values are UTC. Money is DECIMAL; never FLOAT.
--   * Column names avoid MySQL reserved words (trigger, rank, lead, member).
-- =====================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- CREATE DATABASE aeo_corner CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
-- USE aeo_corner;


-- =====================================================================
-- 1. REFERENCE DATA (global, seeded; see seed_reference.sql)
-- =====================================================================

CREATE TABLE plans (
  code                 VARCHAR(32)   NOT NULL,
  name                 VARCHAR(64)   NOT NULL,
  price_usd_month      DECIMAL(10,2) NOT NULL,
  stripe_price_id      VARCHAR(64)   NULL,
  max_projects         INT UNSIGNED  NULL COMMENT 'NULL = not enforced',
  max_prompts          INT UNSIGNED  NULL,
  max_seats            INT UNSIGNED  NULL,
  drafts_per_month     DECIMAL(6,1)  NULL COMMENT 'refreshes count 0.5',
  runs_now_per_month   INT UNSIGNED  NULL,
  samples_per_engine   TINYINT UNSIGNED NOT NULL DEFAULT 3,
  features             JSON          NULL COMMENT 'feature switches, e.g. alerts, csv_export, client_seats',
  is_public            BOOLEAN       NOT NULL DEFAULT TRUE,
  sort_order           SMALLINT      NOT NULL DEFAULT 0,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Plan catalog and limits (pricing hypothesis, MVP 12.3)';

CREATE TABLE providers (
  code                 VARCHAR(32)   NOT NULL,
  name                 VARCHAR(64)   NOT NULL,
  kind                 ENUM('answer_data','llm') NOT NULL,
  status               ENUM('active','disabled') NOT NULL DEFAULT 'active',
  monthly_budget_usd   DECIMAL(10,2) NULL,
  api_key_rotated_at   DATETIME(3)   NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Data and LLM providers. Live breaker state is in Redis';

CREATE TABLE engines (
  code                    VARCHAR(32) NOT NULL,
  name                    VARCHAR(64) NOT NULL,
  status                  ENUM('active','beta','disabled') NOT NULL DEFAULT 'disabled',
  query_field             ENUM('text','search_query') NOT NULL DEFAULT 'text' COMMENT 'AI Overviews use the keyword form',
  default_samples         TINYINT UNSIGNED NOT NULL DEFAULT 3,
  primary_provider_code   VARCHAR(32) NULL,
  primary_method          ENUM('ui_capture','api_grounded','serp') NULL,
  fallback_provider_code  VARCHAR(32) NULL,
  fallback_method         ENUM('ui_capture','api_grounded','serp') NULL,
  sort_order              SMALLINT    NOT NULL DEFAULT 0,
  created_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  CONSTRAINT fk_engines_primary_provider  FOREIGN KEY (primary_provider_code)  REFERENCES providers (code),
  CONSTRAINT fk_engines_fallback_provider FOREIGN KEY (fallback_provider_code) REFERENCES providers (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Measured AI engines and their provider routing (config, not code)';


-- =====================================================================
-- 2. STAFF (internal admin identities; separate from customer users)
--    Sign-in: a separate Clerk application (MFA required) behind
--    Cloudflare Access. No staff passwords or second factors stored here.
-- =====================================================================

CREATE TABLE staff_users (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clerk_user_id        VARCHAR(64)   NULL COMMENT 'user id in the staff Clerk app; bound on first sign-in by verified email',
  email                VARCHAR(320)  NOT NULL,
  name                 VARCHAR(128)  NOT NULL,
  status               ENUM('active','suspended','removed') NOT NULL DEFAULT 'active',
  last_login_at        DATETIME(3)   NULL,
  last_login_ip        VARCHAR(45)   NULL,
  created_by_staff_id  BIGINT UNSIGNED NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_staff_users_clerk (clerk_user_id),
  UNIQUE KEY uq_staff_users_email (email),
  CONSTRAINT fk_staff_users_created_by FOREIGN KEY (created_by_staff_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Staff accounts and roles. Sign-in and MFA via the staff Clerk app';

CREATE TABLE staff_roles (
  staff_user_id        BIGINT UNSIGNED NOT NULL,
  role                 ENUM('super_admin','ops','support','reviewer','finance') NOT NULL,
  granted_by_staff_id  BIGINT UNSIGNED NULL,
  granted_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (staff_user_id, role),
  CONSTRAINT fk_staff_roles_staff      FOREIGN KEY (staff_user_id)       REFERENCES staff_users (id) ON DELETE CASCADE,
  CONSTRAINT fk_staff_roles_granted_by FOREIGN KEY (granted_by_staff_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='A staff member can hold several roles';


-- =====================================================================
-- 3. WEB DICTIONARY (global; public URLs and domains cited by AI answers)
-- =====================================================================

CREATE TABLE web_domains (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain                VARCHAR(253)  NOT NULL COMMENT 'registrable domain, lowercase, no www',
  class                 ENUM('unclassified','review_site','ugc','media','reference','directory','social',
                             'ecommerce','government','education','vendor','other') NOT NULL DEFAULT 'unclassified',
  class_source          ENUM('seed','llm','staff') NULL,
  class_confidence      DECIMAL(4,3)  NULL,
  reviewed_by_staff_id  BIGINT UNSIGNED NULL,
  classified_at         DATETIME(3)   NULL,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_web_domains_domain (domain),
  KEY ix_web_domains_class (class),
  CONSTRAINT fk_web_domains_reviewed_by FOREIGN KEY (reviewed_by_staff_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Global domain classification. Own/competitor is decided per project, not here';

CREATE TABLE web_urls (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  url_hash        BINARY(32)    NOT NULL COMMENT 'SHA-256 of the normalized URL',
  url             VARCHAR(2048) NOT NULL,
  domain_id       BIGINT UNSIGNED NOT NULL,
  title           VARCHAR(512)  NULL,
  first_seen_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_web_urls_hash (url_hash),
  KEY ix_web_urls_domain (domain_id),
  CONSTRAINT fk_web_urls_domain FOREIGN KEY (domain_id) REFERENCES web_domains (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='URL dictionary so citation rows stay small';


-- =====================================================================
-- 4. IDENTITY & TENANCY
--    Clerk owns sign-in, sessions, passwords, Google sign-in and MFA.
--    users is a local copy keyed by clerk_user_id (webhooks + a lookup on
--    first request). Organizations, memberships, roles and invitations are
--    ours: Clerk Organizations is not used (DATABASE_SCHEMA.md §10.1).
-- =====================================================================

CREATE TABLE users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  clerk_user_id     VARCHAR(64)   NOT NULL,
  email             VARCHAR(320)  NOT NULL COMMENT 'primary verified email, copied from Clerk',
  name              VARCHAR(128)  NOT NULL DEFAULT '',
  image_url         VARCHAR(1024) NULL,
  timezone          VARCHAR(64)   NOT NULL DEFAULT 'UTC',
  last_org_id       BIGINT UNSIGNED NULL COMMENT 'org to open after sign-in',
  last_login_at     DATETIME(3)   NULL,
  clerk_updated_at  DATETIME(3)   NULL COMMENT 'updated_at of the last applied Clerk event; older events are ignored',
  deleted_at        DATETIME(3)   NULL COMMENT 'set on user.deleted; the row is anonymized, not removed',
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_clerk (clerk_user_id),
  KEY ix_users_email (email) COMMENT 'not unique: Clerk enforces uniqueness and webhooks can arrive out of order'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Customer users: local copy of Clerk users, keyed by clerk_user_id';

CREATE TABLE organizations (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id                CHAR(26)      NOT NULL,
  name                     VARCHAR(128)  NOT NULL,
  slug                     VARCHAR(64)   NOT NULL,
  logo_url                 VARCHAR(1024) NULL,
  metadata                 JSON          NULL,
  kind                     ENUM('brand','agency') NOT NULL DEFAULT 'brand',
  plan_code                VARCHAR(32)   NULL,
  billing_status           ENUM('none','trialing','active','past_due','paused','canceled') NOT NULL DEFAULT 'none'
                           COMMENT 'mirror of subscriptions.status, updated by Stripe webhooks',
  stripe_customer_id       VARCHAR(64)   NULL,
  spend_cap_usd_daily      DECIMAL(10,2) NULL COMMENT 'NULL = plan default',
  collection_paused_until  DATETIME(3)   NULL COMMENT 'set by the spend guard',
  default_timezone         VARCHAR(64)   NOT NULL DEFAULT 'UTC',
  is_design_partner        BOOLEAN       NOT NULL DEFAULT FALSE,
  canceled_at              DATETIME(3)   NULL,
  retain_until             DATETIME(3)   NULL COMMENT 'cancelled accounts: read-only until this date (policy pending)',
  deleted_at               DATETIME(3)   NULL,
  purge_after              DATETIME(3)   NULL,
  created_at               DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_organizations_public_id (public_id),
  UNIQUE KEY uq_organizations_slug (slug),
  UNIQUE KEY uq_organizations_stripe_customer (stripe_customer_id),
  KEY ix_organizations_billing (billing_status),
  KEY ix_organizations_purge (purge_after),
  CONSTRAINT fk_organizations_plan FOREIGN KEY (plan_code) REFERENCES plans (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Tenant root';

ALTER TABLE users
  ADD CONSTRAINT fk_users_last_org FOREIGN KEY (last_org_id) REFERENCES organizations (id) ON DELETE SET NULL;

CREATE TABLE memberships (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  role             ENUM('owner','admin','editor','viewer') NOT NULL,
  project_access   ENUM('all','selected') NOT NULL DEFAULT 'all' COMMENT 'selected = only projects in membership_projects (agency client seats)',
  notify_prefs     JSON          NULL COMMENT 'digest on/off, alert types, per-project overrides',
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_memberships_org_user (org_id, user_id),
  KEY ix_memberships_user (user_id),
  CONSTRAINT fk_memberships_org  FOREIGN KEY (org_id)  REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_memberships_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='User roles per organization';

CREATE TABLE invitations (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           BIGINT UNSIGNED NOT NULL,
  email            VARCHAR(320)  NOT NULL,
  role             ENUM('owner','admin','editor','viewer') NOT NULL,
  project_access   ENUM('all','selected') NOT NULL DEFAULT 'all',
  project_ids      JSON          NULL,
  status           ENUM('pending','accepted','rejected','canceled','expired') NOT NULL DEFAULT 'pending',
  token_hash       BINARY(32)    NULL COMMENT 'serial ids are guessable; the emailed link carries a random token',
  inviter_user_id  BIGINT UNSIGNED NULL,
  expires_at       DATETIME(3)   NOT NULL,
  accepted_at      DATETIME(3)   NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitations_token (token_hash),
  KEY ix_invitations_org_status (org_id, status),
  KEY ix_invitations_email (email),
  CONSTRAINT fk_invitations_org     FOREIGN KEY (org_id)          REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_invitations_inviter FOREIGN KEY (inviter_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Pending team invitations';

CREATE TABLE org_activity_log (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           BIGINT UNSIGNED NOT NULL,
  project_id       BIGINT UNSIGNED NULL,
  actor_type       ENUM('user','staff','system') NOT NULL,
  actor_user_id    BIGINT UNSIGNED NULL,
  actor_staff_id   BIGINT UNSIGNED NULL,
  action           VARCHAR(64)   NOT NULL,
  target_type      VARCHAR(48)   NULL,
  target_id        BIGINT UNSIGNED NULL,
  summary          VARCHAR(500)  NOT NULL,
  metadata         JSON          NULL,
  ip               VARCHAR(45)   NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_org_activity_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Customer-visible activity log, incl. support access. Append-only';


-- =====================================================================
-- 5. BILLING & ENTITLEMENTS (Stripe is the source of truth for money)
-- =====================================================================

CREATE TABLE subscriptions (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                   BIGINT UNSIGNED NOT NULL,
  stripe_subscription_id   VARCHAR(64)   NOT NULL,
  plan_code                VARCHAR(32)   NOT NULL,
  status                   ENUM('incomplete','incomplete_expired','trialing','active','past_due','unpaid','canceled','paused') NOT NULL,
  trial_ends_at            DATETIME(3)   NULL,
  current_period_start     DATETIME(3)   NULL,
  current_period_end       DATETIME(3)   NULL,
  cancel_at_period_end     BOOLEAN       NOT NULL DEFAULT FALSE,
  canceled_at              DATETIME(3)   NULL,
  grace_until              DATETIME(3)   NULL COMMENT 'failed payment: tracking pauses after this',
  first_paid_at            DATETIME(3)   NULL,
  money_back_until         DATETIME(3)   NULL COMMENT 'D9: 30-day money-back window on the first paid month',
  created_at               DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at               DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscriptions_stripe (stripe_subscription_id),
  KEY ix_subscriptions_org (org_id, status),
  KEY ix_subscriptions_trial (status, trial_ends_at),
  CONSTRAINT fk_subscriptions_org  FOREIGN KEY (org_id)    REFERENCES organizations (id),
  CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_code) REFERENCES plans (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Mirror of Stripe subscriptions (history kept)';

CREATE TABLE entitlement_grants (
  id                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                      BIGINT UNSIGNED NOT NULL,
  meter                       ENUM('projects','prompts','seats','drafts','runs_now','daily_prompts') NOT NULL,
  amount                      INT           NOT NULL,
  source                      ENUM('addon','staff_grant','coupon','design_partner') NOT NULL,
  stripe_subscription_item_id VARCHAR(64)   NULL,
  reason                      VARCHAR(255)  NULL,
  granted_by_staff_id         BIGINT UNSIGNED NULL,
  starts_at                   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ends_at                     DATETIME(3)   NULL,
  created_at                  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_entitlement_grants_org (org_id, meter, ends_at),
  CONSTRAINT fk_entitlement_grants_org   FOREIGN KEY (org_id)              REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_entitlement_grants_staff FOREIGN KEY (granted_by_staff_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Add-ons, credits and staff grants on top of plan limits';

CREATE TABLE quota_usage (
  org_id           BIGINT UNSIGNED NOT NULL,
  period_month     DATE          NOT NULL COMMENT 'first day of the month',
  meter            ENUM('drafts','runs_now','audits','drafts_billed') NOT NULL COMMENT 'drafts_billed = drafts past the allowance already reported to Stripe',
  used_units       DECIMAL(10,1) NOT NULL DEFAULT 0,
  updated_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (org_id, period_month, meter),
  CONSTRAINT fk_quota_usage_org FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT ck_quota_usage_month CHECK (DAYOFMONTH(period_month) = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Monthly counters for quota checks at save time';


-- =====================================================================
-- 6. FREE AUDIT FUNNEL (anonymous until claimed; not tenant data)
-- =====================================================================

CREATE TABLE leads (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email              VARCHAR(320)  NOT NULL,
  email_domain       VARCHAR(253)  NOT NULL,
  consent_marketing  BOOLEAN       NOT NULL DEFAULT FALSE,
  consent_version    VARCHAR(32)   NULL,
  consent_at         DATETIME(3)   NULL,
  verified_at        DATETIME(3)   NULL,
  utm                JSON          NULL,
  first_ip_hash      BINARY(32)    NULL,
  converted_org_id   BIGINT UNSIGNED NULL,
  converted_at       DATETIME(3)   NULL,
  unsubscribed_at    DATETIME(3)   NULL,
  delete_after       DATETIME(3)   NULL COMMENT '12 months after the last audit if not converted',
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_leads_email (email),
  KEY ix_leads_delete_after (delete_after),
  CONSTRAINT fk_leads_converted_org FOREIGN KEY (converted_org_id) REFERENCES organizations (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Free-audit leads. OTP codes live in Redis, not here';

CREATE TABLE audits (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id             CHAR(26)      NOT NULL COMMENT 'unguessable report id',
  lead_id               BIGINT UNSIGNED NULL,
  org_id                BIGINT UNSIGNED NULL COMMENT 'set when run in-app (agency) or claimed at signup',
  project_id            BIGINT UNSIGNED NULL,
  requested_by_user_id  BIGINT UNSIGNED NULL,
  input_url             VARCHAR(2048) NOT NULL,
  domain                VARCHAR(253)  NOT NULL,
  competitor_domain     VARCHAR(253)  NULL,
  status                ENUM('awaiting_verification','queued','running','complete','partial','failed','blocked') NOT NULL DEFAULT 'awaiting_verification',
  cached_from_audit_id  BIGINT UNSIGNED NULL COMMENT 'same domain within 24 h',
  ip_hash               BINARY(32)    NULL,
  prompts               JSON          NULL COMMENT 'the 5 generated buyer questions',
  brand_kit_lite        JSON          NULL,
  suggested_competitors JSON          NULL,
  readiness_score       TINYINT UNSIGNED NULL,
  visibility_score      TINYINT UNSIGNED NULL,
  aeo_score             TINYINT UNSIGNED NULL,
  sub_scores            JSON          NULL,
  top_fixes             JSON          NULL,
  rubric_version        VARCHAR(16)   NULL,
  extraction_version    VARCHAR(16)   NULL,
  cost_usd              DECIMAL(10,6) NOT NULL DEFAULT 0,
  claim_token_hash      BINARY(32)    NULL,
  claimed_at            DATETIME(3)   NULL,
  verified_at           DATETIME(3)   NULL,
  started_at            DATETIME(3)   NULL,
  finished_at           DATETIME(3)   NULL,
  report_emailed_at     DATETIME(3)   NULL,
  delete_after          DATETIME(3)   NULL,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audits_public_id (public_id),
  UNIQUE KEY uq_audits_claim_token (claim_token_hash),
  KEY ix_audits_domain (domain, created_at),
  KEY ix_audits_lead (lead_id),
  KEY ix_audits_org (org_id),
  KEY ix_audits_status (status, created_at),
  KEY ix_audits_ip (ip_hash, created_at),
  CONSTRAINT fk_audits_lead         FOREIGN KEY (lead_id)              REFERENCES leads (id),
  CONSTRAINT fk_audits_org          FOREIGN KEY (org_id)               REFERENCES organizations (id),
  CONSTRAINT fk_audits_user         FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_audits_cached_from  FOREIGN KEY (cached_from_audit_id) REFERENCES audits (id) ON DELETE SET NULL,
  CONSTRAINT ck_audits_owner  CHECK (lead_id IS NOT NULL OR org_id IS NOT NULL),
  CONSTRAINT ck_audits_scores CHECK ((readiness_score IS NULL OR readiness_score <= 100)
                                 AND (visibility_score IS NULL OR visibility_score <= 100)
                                 AND (aeo_score IS NULL OR aeo_score <= 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Free AEO audits (F1). FK to projects added below';

CREATE TABLE audit_answers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  audit_id         BIGINT UNSIGNED NOT NULL,
  prompt_idx       TINYINT UNSIGNED NOT NULL,
  engine_code      VARCHAR(32)   NOT NULL,
  provider_code    VARCHAR(32)   NOT NULL,
  method           ENUM('ui_capture','api_grounded','serp') NOT NULL,
  status           ENUM('pending','ok','no_answer','failed') NOT NULL DEFAULT 'pending',
  model_version    VARCHAR(64)   NULL,
  raw_uri          VARCHAR(512)  NULL,
  text_excerpt     VARCHAR(1000) NULL,
  brand_present    BOOLEAN       NULL,
  brand_rank       TINYINT UNSIGNED NULL,
  brand_stance     ENUM('recommended','neutral','cautioned','not_recommended') NULL,
  entities         JSON          NULL,
  citations        JSON          NULL,
  cost_usd         DECIMAL(10,6) NOT NULL DEFAULT 0,
  collected_at     DATETIME(3)   NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_answers_cell (audit_id, prompt_idx, engine_code),
  CONSTRAINT fk_audit_answers_audit FOREIGN KEY (audit_id) REFERENCES audits (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Audit answers (1 sample, live mode). Never used as the tracking baseline';

CREATE TABLE abuse_blocks (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind                 ENUM('ip','ip_prefix','email','email_domain','target_domain') NOT NULL,
  value                VARCHAR(253)  NOT NULL,
  reason               VARCHAR(255)  NOT NULL,
  created_by_staff_id  BIGINT UNSIGNED NULL COMMENT 'NULL = automatic block',
  expires_at           DATETIME(3)   NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_abuse_blocks_value (kind, value),
  KEY ix_abuse_blocks_expires (expires_at),
  CONSTRAINT fk_abuse_blocks_staff FOREIGN KEY (created_by_staff_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Audit abuse blocks. Velocity counters live in Redis';


-- =====================================================================
-- 7. PROJECTS & TRACKING CONFIGURATION
-- =====================================================================

CREATE TABLE projects (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id              CHAR(26)      NOT NULL,
  org_id                 BIGINT UNSIGNED NOT NULL,
  name                   VARCHAR(128)  NOT NULL,
  domain                 VARCHAR(253)  NOT NULL,
  country                CHAR(2)       NOT NULL,
  language               VARCHAR(16)   NOT NULL,
  city                   VARCHAR(128)  NOT NULL DEFAULT '',
  timezone               VARCHAR(64)   NOT NULL DEFAULT 'UTC',
  cadence                ENUM('weekly','daily') NOT NULL DEFAULT 'weekly',
  weekly_slot_hour       SMALLINT UNSIGNED NOT NULL COMMENT 'hash(public_id) mod 168; spreads provider load',
  status                 ENUM('onboarding','active','paused','archived') NOT NULL DEFAULT 'onboarding',
  paused_reason          ENUM('user','plan_limit','payment','spend_cap','staff') NULL,
  source_audit_id        BIGINT UNSIGNED NULL,
  brand_profile_version  INT UNSIGNED  NULL COMMENT 'active Brand Kit version',
  first_run_at           DATETIME(3)   NULL,
  last_run_at            DATETIME(3)   NULL,
  baseline_ready_at      DATETIME(3)   NULL,
  created_by_user_id     BIGINT UNSIGNED NULL,
  deleted_at             DATETIME(3)   NULL,
  purge_after            DATETIME(3)   NULL,
  created_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  domain_verify_token    CHAR(32)      NULL COMMENT 'random proof-of-ownership token; NULL until first requested',
  domain_verified_at     DATETIME(3)   NULL COMMENT 'when ownership was proven; NULL = not verified',
  domain_verify_method   ENUM('dns','file') NULL COMMENT 'how it was proven',
  active_domain          VARCHAR(253)  GENERATED ALWAYS AS (IF(deleted_at IS NULL, domain, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_public_id (public_id),
  UNIQUE KEY uq_projects_id_org (id, org_id) COMMENT 'target of tenant-consistency FKs',
  UNIQUE KEY uq_projects_org_domain (org_id, active_domain),
  KEY ix_projects_schedule (status, weekly_slot_hour),
  CONSTRAINT fk_projects_org          FOREIGN KEY (org_id)             REFERENCES organizations (id),
  CONSTRAINT fk_projects_source_audit FOREIGN KEY (source_audit_id)    REFERENCES audits (id) ON DELETE SET NULL,
  CONSTRAINT fk_projects_created_by   FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_projects_slot CHECK (weekly_slot_hour < 168)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='One brand/site being tracked';

ALTER TABLE audits
  ADD CONSTRAINT fk_audits_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL;

CREATE TABLE membership_projects (
  membership_id    BIGINT UNSIGNED NOT NULL,
  project_id       BIGINT UNSIGNED NOT NULL,
  org_id           BIGINT UNSIGNED NOT NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (membership_id, project_id),
  KEY ix_membership_projects_project (project_id),
  CONSTRAINT fk_membership_projects_membership FOREIGN KEY (membership_id)     REFERENCES memberships (id) ON DELETE CASCADE,
  CONSTRAINT fk_membership_projects_project    FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Project access for memberships with project_access = selected';

CREATE TABLE project_engines (
  project_id        BIGINT UNSIGNED NOT NULL,
  org_id            BIGINT UNSIGNED NOT NULL,
  engine_code       VARCHAR(32)   NOT NULL,
  enabled           BOOLEAN       NOT NULL DEFAULT TRUE,
  weight            DECIMAL(4,2)  NOT NULL DEFAULT 1.00 COMMENT 'w_e in the AI Visibility Score',
  samples_override  TINYINT UNSIGNED NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (project_id, engine_code),
  CONSTRAINT fk_project_engines_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  CONSTRAINT fk_project_engines_engine  FOREIGN KEY (engine_code)        REFERENCES engines (code),
  CONSTRAINT ck_project_engines_weight CHECK (weight > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Engines tracked per project and their weights';

CREATE TABLE brand_profiles (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id              BIGINT UNSIGNED NOT NULL,
  project_id          BIGINT UNSIGNED NOT NULL,
  version             INT UNSIGNED  NOT NULL,
  schema_version      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  data                JSON          NOT NULL COMMENT 'Brand Kit v1: identity, offerings, facts registry, voice',
  source              ENUM('audit','extracted','edited','reanalyzed') NOT NULL,
  created_by_user_id  BIGINT UNSIGNED NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_brand_profiles_version (project_id, version),
  CONSTRAINT fk_brand_profiles_project    FOREIGN KEY (project_id, org_id)  REFERENCES projects (id, org_id),
  CONSTRAINT fk_brand_profiles_created_by FOREIGN KEY (created_by_user_id)  REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Immutable Brand Kit versions; every edit is a new row';

CREATE TABLE tracked_entities (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  project_id        BIGINT UNSIGNED NOT NULL,
  kind              ENUM('brand','competitor','discovered') NOT NULL,
  name              VARCHAR(255)  NOT NULL,
  name_normalized   VARCHAR(255)  NOT NULL,
  primary_domain    VARCHAR(253)  NULL,
  status            ENUM('active','paused','suggested','ignored') NOT NULL DEFAULT 'active',
  source            ENUM('brand_kit','audit','user','discovered') NOT NULL,
  first_seen_at     DATETIME(3)   NULL,
  last_seen_at      DATETIME(3)   NULL,
  mentions_30d      INT UNSIGNED  NOT NULL DEFAULT 0 COMMENT 'ranks discovered brands',
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  brand_project_id  BIGINT UNSIGNED GENERATED ALWAYS AS (IF(kind = 'brand', project_id, NULL)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tracked_entities_name (project_id, name_normalized),
  UNIQUE KEY uq_tracked_entities_one_brand (brand_project_id),
  KEY ix_tracked_entities_kind (project_id, kind, status),
  CONSTRAINT fk_tracked_entities_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='The brand, its competitors and discovered brands (replaces MVP competitors)';

CREATE TABLE entity_aliases (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id               BIGINT UNSIGNED NOT NULL,
  project_id           BIGINT UNSIGNED NOT NULL,
  entity_id            BIGINT UNSIGNED NOT NULL,
  kind                 ENUM('name','domain','exclude') NOT NULL COMMENT 'exclude = "That''s not us" rules',
  value                VARCHAR(255)  NOT NULL,
  value_normalized     VARCHAR(255)  NOT NULL,
  source               ENUM('brand_kit','audit','user','review','system') NOT NULL,
  created_by_user_id   BIGINT UNSIGNED NULL,
  created_by_staff_id  BIGINT UNSIGNED NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_entity_aliases_value (entity_id, kind, value_normalized),
  KEY ix_entity_aliases_project (project_id, kind),
  CONSTRAINT fk_entity_aliases_entity  FOREIGN KEY (entity_id)          REFERENCES tracked_entities (id) ON DELETE CASCADE,
  CONSTRAINT fk_entity_aliases_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id),
  CONSTRAINT fk_entity_aliases_user    FOREIGN KEY (created_by_user_id)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_entity_aliases_staff   FOREIGN KEY (created_by_staff_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Names, domains and exclusions used by the deterministic pre-pass';

CREATE TABLE prompt_clusters (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           BIGINT UNSIGNED NOT NULL,
  project_id       BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(128)  NOT NULL,
  sort_order       SMALLINT      NOT NULL DEFAULT 0,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_prompt_clusters_name (project_id, name),
  CONSTRAINT fk_prompt_clusters_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Topic groups for buyer questions';

CREATE TABLE prompts (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id              BIGINT UNSIGNED NOT NULL,
  project_id          BIGINT UNSIGNED NOT NULL,
  cluster_id          BIGINT UNSIGNED NULL,
  text                VARCHAR(1000) NOT NULL COMMENT 'immutable once tracked; an edit creates a new prompt',
  text_hash           BINARY(32)    NOT NULL COMMENT 'SHA-256 of normalized text (duplicate detection)',
  search_query        VARCHAR(255)  NULL COMMENT 'keyword form for AI Overviews',
  intent              ENUM('discovery','comparison','problem_solution','brand','local','transactional') NOT NULL,
  funnel_stage        ENUM('awareness','consideration','decision') NULL,
  priority            TINYINT UNSIGNED NOT NULL DEFAULT 2,
  country             CHAR(2)       NOT NULL,
  language            VARCHAR(16)   NOT NULL,
  city                VARCHAR(128)  NOT NULL DEFAULT '',
  status              ENUM('active','paused','archived') NOT NULL DEFAULT 'active',
  paused_reason       ENUM('user','plan_limit') NULL,
  source              ENUM('generated','imported','manual','audit') NOT NULL,
  daily_tracking      BOOLEAN       NOT NULL DEFAULT FALSE COMMENT 'daily add-on subset',
  replaces_prompt_id  BIGINT UNSIGNED NULL,
  created_by_user_id  BIGINT UNSIGNED NULL,
  archived_at         DATETIME(3)   NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_prompts_text (project_id, country, language, city, text_hash),
  KEY ix_prompts_status (project_id, status),
  KEY ix_prompts_cluster (cluster_id),
  CONSTRAINT fk_prompts_project    FOREIGN KEY (project_id, org_id)  REFERENCES projects (id, org_id),
  CONSTRAINT fk_prompts_cluster    FOREIGN KEY (cluster_id)          REFERENCES prompt_clusters (id) ON DELETE SET NULL,
  CONSTRAINT fk_prompts_replaces   FOREIGN KEY (replaces_prompt_id)  REFERENCES prompts (id) ON DELETE SET NULL,
  CONSTRAINT fk_prompts_created_by FOREIGN KEY (created_by_user_id)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_prompts_priority CHECK (priority BETWEEN 1 AND 3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Buyer questions ("prompts" internally)';

CREATE TABLE site_pages (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NOT NULL,
  project_id        BIGINT UNSIGNED NOT NULL,
  url               VARCHAR(2048) NOT NULL,
  url_hash          BINARY(32)    NOT NULL,
  title             VARCHAR(512)  NULL,
  page_type         ENUM('home','about','pricing','product','service','article','faq','contact','other') NOT NULL DEFAULT 'other',
  is_key_page       BOOLEAN       NOT NULL DEFAULT FALSE,
  source            ENUM('sitemap','nav','crawl','content_studio','citation','user') NOT NULL,
  last_http_status  SMALLINT UNSIGNED NULL,
  last_crawled_at   DATETIME(3)   NULL,
  last_modified_at  DATETIME(3)   NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_site_pages_url (project_id, url_hash),
  KEY ix_site_pages_key (project_id, is_key_page),
  CONSTRAINT fk_site_pages_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Known pages of the customer site (own-page performance, link targets)';


-- =====================================================================
-- 8. READINESS SCANS (shared by audits, weekly re-checks and fix verification)
-- =====================================================================

CREATE TABLE site_scans (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           BIGINT UNSIGNED NULL,
  project_id       BIGINT UNSIGNED NULL,
  audit_id         BIGINT UNSIGNED NULL,
  trigger_type     ENUM('audit','scheduled','manual','verification') NOT NULL,
  rubric_version   VARCHAR(16)   NOT NULL,
  status           ENUM('queued','running','complete','partial','failed') NOT NULL DEFAULT 'queued',
  readiness_score  TINYINT UNSIGNED NULL,
  category_scores  JSON          NULL,
  robots_txt_uri   VARCHAR(512)  NULL,
  sitemap_urls     JSON          NULL,
  pages_planned    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  pages_fetched    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  started_at       DATETIME(3)   NULL,
  finished_at      DATETIME(3)   NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_site_scans_project (project_id, created_at),
  KEY ix_site_scans_audit (audit_id),
  CONSTRAINT fk_site_scans_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id),
  CONSTRAINT fk_site_scans_audit   FOREIGN KEY (audit_id)           REFERENCES audits (id),
  CONSTRAINT ck_site_scans_owner   CHECK (org_id IS NOT NULL OR audit_id IS NOT NULL),
  CONSTRAINT ck_site_scans_project CHECK (project_id IS NULL OR org_id IS NOT NULL),
  CONSTRAINT ck_site_scans_score   CHECK (readiness_score IS NULL OR readiness_score <= 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='One crawl + readiness evaluation (replaces MVP audit_checks)';

CREATE TABLE scan_pages (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id               BIGINT UNSIGNED NOT NULL,
  org_id                BIGINT UNSIGNED NULL,
  site_page_id          BIGINT UNSIGNED NULL,
  url                   VARCHAR(2048) NOT NULL,
  url_hash              BINARY(32)    NOT NULL,
  is_key_page           BOOLEAN       NOT NULL DEFAULT FALSE,
  http_status           SMALLINT UNSIGNED NULL,
  final_url             VARCHAR(2048) NULL,
  redirect_count        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  content_type          VARCHAR(128)  NULL,
  raw_text_chars        INT UNSIGNED  NULL,
  rendered_text_chars   INT UNSIGNED  NULL COMMENT 'NULL = not rendered',
  raw_uri               VARCHAR(512)  NULL COMMENT 'Spaces key of the raw HTML',
  rendered_uri          VARCHAR(512)  NULL,
  jsonld_types          JSON          NULL,
  fetch_ms              INT UNSIGNED  NULL,
  error                 VARCHAR(500)  NULL,
  fetched_at            DATETIME(3)   NULL,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_scan_pages_url (scan_id, url_hash),
  KEY ix_scan_pages_site_page (site_page_id),
  CONSTRAINT fk_scan_pages_scan      FOREIGN KEY (scan_id)      REFERENCES site_scans (id) ON DELETE CASCADE,
  CONSTRAINT fk_scan_pages_site_page FOREIGN KEY (site_page_id) REFERENCES site_pages (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Pages fetched in a scan';

CREATE TABLE scan_checks (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id          BIGINT UNSIGNED NOT NULL,
  org_id           BIGINT UNSIGNED NULL,
  check_code       VARCHAR(8)    NOT NULL COMMENT 'rubric id, e.g. A1, C2 (MVP 6.6)',
  status           ENUM('pass','partial','fail','not_applicable','error') NOT NULL,
  points_awarded   DECIMAL(4,1)  NOT NULL DEFAULT 0,
  points_possible  DECIMAL(4,1)  NOT NULL,
  evidence         JSON          NULL COMMENT 'failing pages, snippets, bot responses',
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_scan_checks_check (scan_id, check_code),
  CONSTRAINT fk_scan_checks_scan FOREIGN KEY (scan_id) REFERENCES site_scans (id) ON DELETE CASCADE,
  CONSTRAINT ck_scan_checks_points CHECK (points_awarded >= 0 AND points_awarded <= points_possible)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Readiness check results';


-- =====================================================================
-- 9. TRACKING RUNS & FACTS
--    Fact tables (answer_snapshots, mentions, citations, claims) have no
--    FKs and include run_date in every PRIMARY/UNIQUE key: partition-ready.
-- =====================================================================

CREATE TABLE runs (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                 BIGINT UNSIGNED NOT NULL,
  project_id             BIGINT UNSIGNED NOT NULL,
  slot_key               VARCHAR(40)   NOT NULL COMMENT 'weekly 2026-W40 | daily 2026-10-05 | manual/onboarding m-<ULID>',
  trigger_type           ENUM('schedule','daily','manual','onboarding') NOT NULL,
  run_date               DATE          NOT NULL COMMENT 'UTC date the run started; shared by all its facts',
  status                 ENUM('queued','collecting','extracting','rolling_up','complete','partial','failed','canceled') NOT NULL DEFAULT 'queued',
  extraction_mode        ENUM('batch','sync') NOT NULL DEFAULT 'batch',
  brand_profile_version  INT UNSIGNED  NULL,
  extraction_version     VARCHAR(16)   NULL,
  prompts_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  tasks_planned          INT UNSIGNED  NOT NULL DEFAULT 0,
  tasks_ok               INT UNSIGNED  NOT NULL DEFAULT 0,
  tasks_no_answer        INT UNSIGNED  NOT NULL DEFAULT 0,
  tasks_failed           INT UNSIGNED  NOT NULL DEFAULT 0,
  cost_usd               DECIMAL(10,6) NOT NULL DEFAULT 0,
  llm_batch_ids          JSON          NULL,
  error_summary          JSON          NULL,
  requested_by_user_id   BIGINT UNSIGNED NULL,
  queued_at              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at             DATETIME(3)   NULL,
  collected_at           DATETIME(3)   NULL,
  extracted_at           DATETIME(3)   NULL,
  finished_at            DATETIME(3)   NULL,
  created_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_runs_slot (project_id, slot_key) COMMENT 'a double-fired scheduler cannot create a duplicate run',
  KEY ix_runs_project_date (project_id, run_date),
  KEY ix_runs_status (status, queued_at),
  CONSTRAINT fk_runs_project FOREIGN KEY (project_id, org_id)   REFERENCES projects (id, org_id),
  CONSTRAINT fk_runs_user    FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='One tracking run of a project';

CREATE TABLE answer_snapshots (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_date            DATE          NOT NULL,
  org_id              BIGINT UNSIGNED NOT NULL,
  project_id          BIGINT UNSIGNED NOT NULL,
  run_id              BIGINT UNSIGNED NOT NULL,
  prompt_id           BIGINT UNSIGNED NOT NULL,
  engine_code         VARCHAR(32)   NOT NULL,
  provider_code       VARCHAR(32)   NOT NULL,
  method              ENUM('ui_capture','api_grounded','serp') NOT NULL,
  mode                ENUM('standard','priority','live') NOT NULL DEFAULT 'standard',
  is_fallback         BOOLEAN       NOT NULL DEFAULT FALSE,
  sample_idx          TINYINT UNSIGNED NOT NULL,
  status              ENUM('pending','ok','no_answer','failed') NOT NULL DEFAULT 'pending'
                      COMMENT 'no_answer = e.g. no AI Overview shown; failed is never counted as absent',
  attempts            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  provider_task_id    VARCHAR(128)  NULL,
  country             CHAR(2)       NOT NULL,
  language            VARCHAR(16)   NOT NULL,
  city                VARCHAR(128)  NOT NULL DEFAULT '',
  model_version       VARCHAR(64)   NULL,
  collected_at        DATETIME(3)   NULL,
  raw_uri             VARCHAR(512)  NULL COMMENT 'Spaces key: raw payload + normalized full text',
  raw_sha256          BINARY(32)    NULL,
  answer_chars        INT UNSIGNED  NULL,
  text_excerpt        VARCHAR(500)  NULL,
  answer_type         ENUM('list','single_recommendation','comparison','explanatory','refusal') NULL,
  prepass             JSON          NULL COMMENT 'tracked entity ids found by the deterministic pre-pass',
  extraction_status   ENUM('pending','done','skipped','failed') NOT NULL DEFAULT 'pending',
  extraction_version  VARCHAR(16)   NULL,
  extracted_at        DATETIME(3)   NULL,
  cost_usd            DECIMAL(10,6) NOT NULL DEFAULT 0,
  failure_reason      VARCHAR(255)  NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, run_date),
  UNIQUE KEY uq_answer_snapshots_task (run_id, prompt_id, engine_code, sample_idx, run_date),
  KEY ix_answer_snapshots_cell (project_id, prompt_id, engine_code, run_date),
  KEY ix_answer_snapshots_extraction (run_id, extraction_status),
  KEY ix_answer_snapshots_provider_task (provider_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='One collected AI answer (fact). Full text in Spaces';

CREATE TABLE mentions (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_date            DATE          NOT NULL,
  org_id              BIGINT UNSIGNED NOT NULL,
  project_id          BIGINT UNSIGNED NOT NULL,
  run_id              BIGINT UNSIGNED NOT NULL,
  snapshot_id         BIGINT UNSIGNED NOT NULL,
  prompt_id           BIGINT UNSIGNED NOT NULL,
  engine_code         VARCHAR(32)   NOT NULL,
  entity_id           BIGINT UNSIGNED NOT NULL,
  name_as_written     VARCHAR(255)  NOT NULL,
  list_rank           TINYINT UNSIGNED NULL,
  mention_order       TINYINT UNSIGNED NULL,
  prominence          ENUM('primary','secondary','passing') NULL,
  stance              ENUM('recommended','neutral','cautioned','not_recommended') NULL,
  sentiment           TINYINT       NULL,
  excerpt             VARCHAR(300)  NULL COMMENT 'tracked entities only',
  detected_by         ENUM('prepass','llm','both') NOT NULL,
  is_excluded         BOOLEAN       NOT NULL DEFAULT FALSE COMMENT 'removed after a "That''s not us" review',
  extraction_version  VARCHAR(16)   NOT NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, run_date),
  UNIQUE KEY uq_mentions_entity (snapshot_id, entity_id, run_date),
  KEY ix_mentions_entity (project_id, entity_id, run_date),
  CONSTRAINT ck_mentions_sentiment CHECK (sentiment IS NULL OR sentiment BETWEEN -2 AND 2)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Brands named in an answer (fact)';

CREATE TABLE citations (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_date             DATE          NOT NULL,
  org_id               BIGINT UNSIGNED NOT NULL,
  project_id           BIGINT UNSIGNED NOT NULL,
  run_id               BIGINT UNSIGNED NOT NULL,
  snapshot_id          BIGINT UNSIGNED NOT NULL,
  prompt_id            BIGINT UNSIGNED NOT NULL,
  engine_code          VARCHAR(32)   NOT NULL,
  position             SMALLINT UNSIGNED NOT NULL,
  url_id               BIGINT UNSIGNED NOT NULL,
  domain_id            BIGINT UNSIGNED NOT NULL,
  owner_entity_id      BIGINT UNSIGNED NULL COMMENT 'brand or competitor that owns the domain',
  is_own               BOOLEAN       NOT NULL DEFAULT FALSE,
  supports_entity_ids  JSON          NULL,
  extraction_version   VARCHAR(16)   NOT NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, run_date),
  UNIQUE KEY uq_citations_position (snapshot_id, position, run_date),
  KEY ix_citations_domain (project_id, run_date, domain_id),
  KEY ix_citations_url (project_id, url_id, run_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Sources cited by an answer (fact)';

CREATE TABLE claims (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_date          DATE          NOT NULL,
  org_id            BIGINT UNSIGNED NOT NULL,
  project_id        BIGINT UNSIGNED NOT NULL,
  snapshot_id       BIGINT UNSIGNED NOT NULL,
  mention_id        BIGINT UNSIGNED NOT NULL,
  entity_id         BIGINT UNSIGNED NOT NULL,
  attribute         VARCHAR(64)   NOT NULL,
  claim_value       VARCHAR(500)  NOT NULL,
  polarity          ENUM('positive','neutral','negative') NOT NULL,
  accuracy_status   ENUM('unchecked','accurate','inaccurate','unverifiable') NOT NULL DEFAULT 'unchecked' COMMENT 'checked from v1.1',
  checked_at        DATETIME(3)   NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, run_date),
  KEY ix_claims_entity (project_id, entity_id, run_date),
  KEY ix_claims_snapshot (snapshot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Claims about tracked entities (fact). Accuracy monitor in v1.1';


-- =====================================================================
-- 10. ROLLUPS & CHANGE DETECTION (store sums, never averaged rates)
-- =====================================================================

CREATE TABLE cell_results (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_date            DATE          NOT NULL,
  org_id              BIGINT UNSIGNED NOT NULL,
  project_id          BIGINT UNSIGNED NOT NULL,
  run_id              BIGINT UNSIGNED NOT NULL,
  prompt_id           BIGINT UNSIGNED NOT NULL,
  engine_code         VARCHAR(32)   NOT NULL,
  status              ENUM('complete','partial','failed','no_answer') NOT NULL,
  n_planned           TINYINT UNSIGNED NOT NULL,
  n_ok                TINYINT UNSIGNED NOT NULL,
  n_no_answer         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  n_failed            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  cell_score          DECIMAL(5,4)  NULL COMMENT 's(p,e) for the brand, MVP 6.5',
  citations_total     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  citations_own       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  extraction_version  VARCHAR(16)   NOT NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, run_date),
  UNIQUE KEY uq_cell_results_cell (run_id, prompt_id, engine_code, run_date),
  KEY ix_cell_results_history (project_id, prompt_id, engine_code, run_date),
  KEY ix_cell_results_date (project_id, run_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Question x engine x run: the prompt-matrix cell';

CREATE TABLE cell_entity_results (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_date         DATE          NOT NULL,
  org_id           BIGINT UNSIGNED NOT NULL,
  project_id       BIGINT UNSIGNED NOT NULL,
  run_id           BIGINT UNSIGNED NOT NULL,
  prompt_id        BIGINT UNSIGNED NOT NULL,
  engine_code      VARCHAR(32)   NOT NULL,
  entity_id        BIGINT UNSIGNED NOT NULL,
  k_mentioned      TINYINT UNSIGNED NOT NULL,
  k_recommended    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  k_cited          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  rank_sum         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  rank_n           TINYINT UNSIGNED NOT NULL DEFAULT 0,
  best_rank        TINYINT UNSIGNED NULL,
  sentiment_sum    SMALLINT      NOT NULL DEFAULT 0,
  sentiment_n      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, run_date),
  UNIQUE KEY uq_cell_entity_results_cell (run_id, prompt_id, engine_code, entity_id, run_date),
  KEY ix_cell_entity_results_entity (project_id, entity_id, run_date),
  KEY ix_cell_entity_results_cell (project_id, prompt_id, engine_code, run_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Per tracked entity per cell. Only rows with k_mentioned > 0 or k_cited > 0';

CREATE TABLE metric_daily (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id             BIGINT UNSIGNED NOT NULL,
  project_id         BIGINT UNSIGNED NOT NULL,
  metric_date        DATE          NOT NULL,
  engine_code        VARCHAR(32)   NOT NULL,
  entity_id          BIGINT UNSIGNED NOT NULL,
  cells_total        INT UNSIGNED  NOT NULL DEFAULT 0,
  cells_partial      INT UNSIGNED  NOT NULL DEFAULT 0,
  n_answers          INT UNSIGNED  NOT NULL DEFAULT 0,
  k_mentioned        INT UNSIGNED  NOT NULL DEFAULT 0,
  k_recommended      INT UNSIGNED  NOT NULL DEFAULT 0,
  k_cited            INT UNSIGNED  NOT NULL DEFAULT 0,
  rank_sum           INT UNSIGNED  NOT NULL DEFAULT 0,
  rank_n             INT UNSIGNED  NOT NULL DEFAULT 0,
  sentiment_sum      INT           NOT NULL DEFAULT 0,
  sentiment_n        INT UNSIGNED  NOT NULL DEFAULT 0,
  citations_total    INT UNSIGNED  NOT NULL DEFAULT 0 COMMENT 'all citations that date+engine (same on every entity row)',
  citations_entity   INT UNSIGNED  NOT NULL DEFAULT 0,
  vis_weighted_sum   DECIMAL(14,4) NULL COMMENT 'brand rows: sum of w_p * w_e * s(p,e)',
  vis_weight_total   DECIMAL(14,4) NULL COMMENT 'brand rows: sum of w_p * w_e',
  aio_queries        INT UNSIGNED  NULL COMMENT 'google_aio rows: searches checked',
  aio_triggered      INT UNSIGNED  NULL COMMENT 'google_aio rows: searches showing an AI Overview',
  computed_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_metric_daily_cell (project_id, metric_date, engine_code, entity_id),
  KEY ix_metric_daily_entity (project_id, entity_id, metric_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Dashboard rollup: project x date x engine x tracked entity';

CREATE TABLE change_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           BIGINT UNSIGNED NOT NULL,
  project_id       BIGINT UNSIGNED NOT NULL,
  run_id           BIGINT UNSIGNED NULL,
  kind             ENUM('visibility_change','mention_rate_change','sov_change','citation_share_change',
                        'competitor_surge','new_competitor','negative_sentiment','inaccurate_claim') NOT NULL,
  engine_code      VARCHAR(32)   NULL,
  entity_id        BIGINT UNSIGNED NULL,
  prompt_id        BIGINT UNSIGNED NULL,
  cluster_id       BIGINT UNSIGNED NULL,
  before_start     DATE          NULL,
  before_end       DATE          NULL,
  after_start      DATE          NULL,
  after_end        DATE          NULL,
  n_before         INT UNSIGNED  NULL,
  k_before         INT UNSIGNED  NULL,
  n_after          INT UNSIGNED  NULL,
  k_after          INT UNSIGNED  NULL,
  value_before     DECIMAL(7,4)  NULL,
  value_after      DECIMAL(7,4)  NULL,
  delta_pp         DECIMAL(6,2)  NULL,
  p_value          DECIMAL(9,8)  NULL,
  direction        ENUM('up','down','new') NULL,
  is_significant   BOOLEAN       NOT NULL,
  details          JSON          NULL,
  dedupe_key       VARCHAR(191)  NOT NULL,
  alerted_at       DATETIME(3)   NULL,
  digested_at      DATETIME(3)   NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_change_events_dedupe (project_id, dedupe_key) COMMENT 'alerts are never sent twice',
  KEY ix_change_events_project (project_id, created_at),
  CONSTRAINT fk_change_events_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Significant changes; feed alerts and the weekly digest';


-- =====================================================================
-- 11. ACTION CENTER & PROOF
-- =====================================================================

CREATE TABLE recommendations (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                    BIGINT UNSIGNED NOT NULL,
  project_id                BIGINT UNSIGNED NOT NULL,
  rule_code                 VARCHAR(64)   NOT NULL,
  rule_version              SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  stable_key                VARCHAR(191)  NOT NULL COMMENT 'rule + subject; the same issue never appears twice',
  category                  ENUM('crawler_access','renderability','structured_data','entity','content_new',
                                 'content_refresh','offsite_presence','reputation','technical') NOT NULL,
  fix_path                  ENUM('auto_fix','content','guidance') NOT NULL,
  title                     VARCHAR(255)  NOT NULL,
  why_md                    TEXT          NOT NULL,
  steps_md                  TEXT          NULL,
  narrative_version         VARCHAR(16)   NULL,
  evidence                  JSON          NOT NULL COMMENT 'check ids, snapshot ids, citation ids: no recommendation without evidence',
  affected_urls             JSON          NULL,
  impact                    DECIMAL(6,3)  NOT NULL,
  confidence                DECIMAL(4,3)  NOT NULL,
  effort                    TINYINT UNSIGNED NOT NULL,
  ice                       DECIMAL(8,3)  NOT NULL,
  status                    ENUM('open','in_progress','done','verified','unverified','measuring',
                                 'proven_win','no_change','declined','dismissed') NOT NULL DEFAULT 'open',
  status_changed_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  dismiss_reason            ENUM('not_relevant','already_done','wont_do','incorrect') NULL,
  dismiss_note              VARCHAR(500)  NULL,
  done_at                   DATETIME(3)   NULL,
  done_by_user_id           BIGINT UNSIGNED NULL,
  verified_at               DATETIME(3)   NULL,
  verification              JSON          NULL COMMENT 'latest verification summary',
  measuring_started_at      DATETIME(3)   NULL,
  baseline                  JSON          NULL COMMENT 'baseline run ids and k/n per targeted question',
  signal_cleared_at         DATETIME(3)   NULL COMMENT 'the rule stopped firing',
  first_seen_run_id         BIGINT UNSIGNED NULL,
  last_seen_run_id          BIGINT UNSIGNED NULL,
  parent_recommendation_id  BIGINT UNSIGNED NULL COMMENT 'declined -> follow-up recommendation',
  created_at                DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  open_key                  VARCHAR(191)  GENERATED ALWAYS AS
                              (IF(status IN ('proven_win','no_change','declined','dismissed'), NULL, stable_key)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_recommendations_open (project_id, open_key) COMMENT 'upsert target for the rule engine',
  KEY ix_recommendations_board (project_id, status, ice),
  KEY ix_recommendations_stable (project_id, stable_key),
  KEY ix_recommendations_rule (rule_code, status),
  CONSTRAINT fk_recommendations_project FOREIGN KEY (project_id, org_id)       REFERENCES projects (id, org_id),
  CONSTRAINT fk_recommendations_done_by FOREIGN KEY (done_by_user_id)          REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_recommendations_parent  FOREIGN KEY (parent_recommendation_id) REFERENCES recommendations (id) ON DELETE SET NULL,
  CONSTRAINT ck_recommendations_effort CHECK (effort BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Action Center items (F7) with the extended lifecycle';

CREATE TABLE recommendation_prompts (
  recommendation_id  BIGINT UNSIGNED NOT NULL,
  prompt_id          BIGINT UNSIGNED NOT NULL,
  org_id             BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (recommendation_id, prompt_id),
  KEY ix_recommendation_prompts_prompt (prompt_id),
  CONSTRAINT fk_recommendation_prompts_rec    FOREIGN KEY (recommendation_id) REFERENCES recommendations (id) ON DELETE CASCADE,
  CONSTRAINT fk_recommendation_prompts_prompt FOREIGN KEY (prompt_id)         REFERENCES prompts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Questions a recommendation targets (the before/after scope)';

CREATE TABLE recommendation_events (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id             BIGINT UNSIGNED NOT NULL,
  recommendation_id  BIGINT UNSIGNED NOT NULL,
  from_status        VARCHAR(16)   NULL,
  to_status          VARCHAR(16)   NOT NULL,
  actor_type         ENUM('user','staff','system') NOT NULL,
  actor_user_id      BIGINT UNSIGNED NULL,
  actor_staff_id     BIGINT UNSIGNED NULL,
  note               VARCHAR(500)  NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_recommendation_events_rec (recommendation_id, created_at),
  CONSTRAINT fk_recommendation_events_rec FOREIGN KEY (recommendation_id) REFERENCES recommendations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Status history; feeds rule-quality stats (dismiss/verified/win rates)';


-- =====================================================================
-- 12. INTEGRATIONS, CONTENT STUDIO & SITE CHANGES
-- =====================================================================

CREATE TABLE integrations (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                BIGINT UNSIGNED NOT NULL,
  project_id            BIGINT UNSIGNED NOT NULL,
  type                  ENUM('wordpress','google') NOT NULL COMMENT 'google = one OAuth grant for GA4 + Search Console',
  status                ENUM('pending','connected','broken','disconnected') NOT NULL DEFAULT 'pending',
  config                JSON          NULL COMMENT 'site_url, plugin_version, ga4_property_id, gsc_site_url, scopes',
  secret_ciphertext     VARBINARY(4096) NULL COMMENT 'AES-256-GCM (iv | ciphertext | tag)',
  secret_wrapped_dek    VARBINARY(512)  NULL COMMENT 'data key wrapped by the master key (held outside the DB)',
  secret_key_version    SMALLINT UNSIGNED NULL,
  last_success_at       DATETIME(3)   NULL,
  last_error_at         DATETIME(3)   NULL,
  last_error            VARCHAR(500)  NULL,
  connected_by_user_id  BIGINT UNSIGNED NULL,
  connected_at          DATETIME(3)   NULL,
  disconnected_at       DATETIME(3)   NULL,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_integrations_type (project_id, type),
  CONSTRAINT fk_integrations_project FOREIGN KEY (project_id, org_id)     REFERENCES projects (id, org_id),
  CONSTRAINT fk_integrations_user    FOREIGN KEY (connected_by_user_id)   REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='WordPress and Google connections. Secrets never leave the worker';

CREATE TABLE content_items (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id             CHAR(26)      NOT NULL,
  org_id                BIGINT UNSIGNED NOT NULL,
  project_id            BIGINT UNSIGNED NOT NULL,
  recommendation_id     BIGINT UNSIGNED NULL,
  kind                  ENUM('new','refresh') NOT NULL,
  format                ENUM('comparison','best_of','how_to','faq','glossary','facts_page','other','about_page') NOT NULL,
  title                 VARCHAR(255)  NOT NULL,
  target_url            VARCHAR(2048) NULL COMMENT 'page being refreshed',
  status                ENUM('researching','briefing','drafting','qc','ready','approved','publishing',
                             'published','failed','archived') NOT NULL DEFAULT 'researching',
  brief                 JSON          NULL,
  research              JSON          NULL COMMENT 'facts with source URLs',
  qc                    JSON          NULL,
  qc_score              TINYINT UNSIGNED NULL,
  jsonld                JSON          NULL,
  current_revision_id   BIGINT UNSIGNED NULL COMMENT 'app-enforced (avoids a circular FK)',
  approved_revision_id  BIGINT UNSIGNED NULL COMMENT 'the exact revision a human approved',
  quota_units           DECIMAL(3,1)  NOT NULL DEFAULT 1.0,
  llm_cost_usd          DECIMAL(10,6) NOT NULL DEFAULT 0,
  approved_by_user_id   BIGINT UNSIGNED NULL,
  approved_at           DATETIME(3)   NULL,
  cms_ref               VARCHAR(128)  NULL,
  published_url         VARCHAR(2048) NULL,
  published_at          DATETIME(3)   NULL,
  created_by_user_id    BIGINT UNSIGNED NULL,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  failed_stage          VARCHAR(16)   NULL COMMENT 'the stage that failed: researching | briefing | drafting | qc | publishing',
  failure_reason        VARCHAR(500)  NULL COMMENT 'plain-language reason, never a response body or a secret',
  PRIMARY KEY (id),
  UNIQUE KEY uq_content_items_public_id (public_id),
  KEY ix_content_items_board (project_id, status),
  KEY ix_content_items_rec (recommendation_id),
  CONSTRAINT fk_content_items_project     FOREIGN KEY (project_id, org_id)   REFERENCES projects (id, org_id),
  CONSTRAINT fk_content_items_rec         FOREIGN KEY (recommendation_id)    REFERENCES recommendations (id) ON DELETE SET NULL,
  CONSTRAINT fk_content_items_approved_by FOREIGN KEY (approved_by_user_id)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_content_items_created_by  FOREIGN KEY (created_by_user_id)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_content_items_approval CHECK (status NOT IN ('approved','publishing','published')
                                              OR (approved_at IS NOT NULL AND approved_revision_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Content Studio items (F8). Nothing publishes without an approval';

CREATE TABLE content_revisions (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id              BIGINT UNSIGNED NOT NULL,
  content_item_id     BIGINT UNSIGNED NOT NULL,
  revision            INT UNSIGNED  NOT NULL,
  body_html           MEDIUMTEXT    NOT NULL,
  word_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  source              ENUM('ai_draft','ai_revision','user_edit') NOT NULL,
  created_by_user_id  BIGINT UNSIGNED NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_content_revisions_rev (content_item_id, revision),
  CONSTRAINT fk_content_revisions_item FOREIGN KEY (content_item_id)    REFERENCES content_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_content_revisions_user FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Draft history; approval pins a revision';

CREATE TABLE content_target_prompts (
  content_item_id  BIGINT UNSIGNED NOT NULL,
  prompt_id        BIGINT UNSIGNED NOT NULL,
  org_id           BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (content_item_id, prompt_id),
  KEY ix_content_target_prompts_prompt (prompt_id),
  CONSTRAINT fk_content_target_prompts_item   FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_content_target_prompts_prompt FOREIGN KEY (prompt_id)       REFERENCES prompts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Questions a piece of content targets';

CREATE TABLE site_changes (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                  BIGINT UNSIGNED NOT NULL,
  project_id              BIGINT UNSIGNED NOT NULL,
  integration_id          BIGINT UNSIGNED NOT NULL,
  recommendation_id       BIGINT UNSIGNED NULL,
  content_item_id         BIGINT UNSIGNED NULL,
  kind                    ENUM('jsonld','meta','robots_txt','llms_txt','post_create','post_update','indexnow_ping') NOT NULL,
  target_url              VARCHAR(2048) NULL,
  payload                 JSON          NOT NULL COMMENT 'the exact change the customer previewed',
  previous_value          JSON          NULL COMMENT 'for rollback',
  status                  ENUM('pending_approval','approved','applying','applied','failed','rolled_back','canceled') NOT NULL DEFAULT 'pending_approval',
  approved_by_user_id     BIGINT UNSIGNED NULL,
  approved_at             DATETIME(3)   NULL,
  applied_at              DATETIME(3)   NULL,
  remote_ref              VARCHAR(128)  NULL,
  attempts                TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_error              VARCHAR(1000) NULL,
  rolled_back_at          DATETIME(3)   NULL,
  rolled_back_by_user_id  BIGINT UNSIGNED NULL,
  created_at              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_site_changes_project (project_id, status, created_at),
  KEY ix_site_changes_rec (recommendation_id),
  KEY ix_site_changes_content (content_item_id),
  CONSTRAINT fk_site_changes_project     FOREIGN KEY (project_id, org_id)      REFERENCES projects (id, org_id),
  CONSTRAINT fk_site_changes_integration FOREIGN KEY (integration_id)          REFERENCES integrations (id),
  CONSTRAINT fk_site_changes_rec         FOREIGN KEY (recommendation_id)       REFERENCES recommendations (id) ON DELETE SET NULL,
  CONSTRAINT fk_site_changes_content     FOREIGN KEY (content_item_id)         REFERENCES content_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_site_changes_approved_by FOREIGN KEY (approved_by_user_id)     REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_site_changes_rolled_by   FOREIGN KEY (rolled_back_by_user_id)  REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ck_site_changes_approval CHECK (status IN ('pending_approval','canceled') OR approved_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Every change we make to a customer site, with approval and rollback';

CREATE TABLE fix_verifications (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id             BIGINT UNSIGNED NOT NULL,
  project_id         BIGINT UNSIGNED NOT NULL,
  recommendation_id  BIGINT UNSIGNED NOT NULL,
  site_change_id     BIGINT UNSIGNED NULL,
  content_item_id    BIGINT UNSIGNED NULL,
  scan_id            BIGINT UNSIGNED NULL,
  attempt            TINYINT UNSIGNED NOT NULL COMMENT '1 = immediate, then +1 h, +24 h',
  method             ENUM('bot_refetch','readiness_check','url_live','manual') NOT NULL,
  target_url         VARCHAR(2048) NULL,
  status             ENUM('pending','passed','failed','not_verifiable') NOT NULL DEFAULT 'pending',
  scheduled_for      DATETIME(3)   NOT NULL,
  checked_at         DATETIME(3)   NULL,
  details            JSON          NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_fix_verifications_attempt (recommendation_id, attempt),
  KEY ix_fix_verifications_due (status, scheduled_for),
  CONSTRAINT fk_fix_verifications_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id),
  CONSTRAINT fk_fix_verifications_rec     FOREIGN KEY (recommendation_id)  REFERENCES recommendations (id) ON DELETE CASCADE,
  CONSTRAINT fk_fix_verifications_change  FOREIGN KEY (site_change_id)     REFERENCES site_changes (id) ON DELETE SET NULL,
  CONSTRAINT fk_fix_verifications_content FOREIGN KEY (content_item_id)    REFERENCES content_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_fix_verifications_scan    FOREIGN KEY (scan_id)            REFERENCES site_scans (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Same-day "fix verified" checks (moment of truth 3)';

CREATE TABLE action_outcomes (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id             BIGINT UNSIGNED NOT NULL,
  project_id         BIGINT UNSIGNED NOT NULL,
  recommendation_id  BIGINT UNSIGNED NOT NULL,
  horizon            ENUM('week_2','week_4') NOT NULL COMMENT 'check at +2 or +4 weeks (Prisma enum values cannot start with a digit)',
  engine_scope       VARCHAR(32)   NOT NULL DEFAULT 'all' COMMENT 'all | engine code',
  prompts_count      SMALLINT UNSIGNED NOT NULL,
  baseline_run_ids   JSON          NOT NULL,
  after_run_ids      JSON          NOT NULL,
  n_before           INT UNSIGNED  NOT NULL,
  k_before           INT UNSIGNED  NOT NULL,
  n_after            INT UNSIGNED  NOT NULL,
  k_after            INT UNSIGNED  NOT NULL,
  rate_before        DECIMAL(6,4)  NULL,
  rate_after         DECIMAL(6,4)  NULL,
  delta_pp           DECIMAL(6,2)  NULL,
  p_value            DECIMAL(9,8)  NULL,
  verdict            ENUM('proven_win','no_change','declined','insufficient_data') NOT NULL,
  computed_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  notified_at        DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_action_outcomes_check (recommendation_id, horizon, engine_scope),
  KEY ix_action_outcomes_wins (project_id, verdict, computed_at),
  KEY ix_action_outcomes_global (verdict, computed_at),
  CONSTRAINT fk_action_outcomes_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id),
  CONSTRAINT fk_action_outcomes_rec     FOREIGN KEY (recommendation_id)  REFERENCES recommendations (id) ON DELETE CASCADE,
  CONSTRAINT ck_action_outcomes_counts CHECK (k_before <= n_before AND k_after <= n_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Before/after results at +2 and +4 weeks (the north-star "proven wins")';


-- =====================================================================
-- 13. AI TRAFFIC ANALYTICS (F10)
-- =====================================================================

CREATE TABLE traffic_daily (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id             BIGINT UNSIGNED NOT NULL,
  project_id         BIGINT UNSIGNED NOT NULL,
  metric_date        DATE          NOT NULL,
  channel            VARCHAR(32)   NOT NULL COMMENT 'chatgpt | perplexity | gemini | copilot | claude | other_ai | organic_search | all',
  landing_page       VARCHAR(2048) NOT NULL DEFAULT '' COMMENT 'empty = all pages',
  landing_page_hash  BINARY(32)    NOT NULL,
  sessions           INT UNSIGNED  NOT NULL DEFAULT 0,
  engaged_sessions   INT UNSIGNED  NOT NULL DEFAULT 0,
  key_events         INT UNSIGNED  NOT NULL DEFAULT 0,
  revenue            DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency           CHAR(3)       NULL,
  synced_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_traffic_daily_row (project_id, metric_date, channel, landing_page_hash),
  KEY ix_traffic_daily_channel (project_id, channel, metric_date),
  CONSTRAINT fk_traffic_daily_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='GA4 sessions by AI referrer and landing page';

CREATE TABLE search_console_daily (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           BIGINT UNSIGNED NOT NULL,
  project_id       BIGINT UNSIGNED NOT NULL,
  metric_date      DATE          NOT NULL,
  dimension        ENUM('query','page') NOT NULL,
  dim_value        VARCHAR(2048) NOT NULL,
  dim_hash         BINARY(32)    NOT NULL,
  is_branded       BOOLEAN       NULL,
  clicks           INT UNSIGNED  NOT NULL DEFAULT 0,
  impressions      INT UNSIGNED  NOT NULL DEFAULT 0,
  avg_position     DECIMAL(6,2)  NULL,
  synced_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_search_console_daily_row (project_id, metric_date, dimension, dim_hash),
  CONSTRAINT fk_search_console_daily_project FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Search Console clicks/impressions for branded queries and target pages';


-- =====================================================================
-- 14. REPORTS & MESSAGING
-- =====================================================================

CREATE TABLE reports (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id           CHAR(26)      NOT NULL,
  org_id              BIGINT UNSIGNED NOT NULL,
  project_id          BIGINT UNSIGNED NOT NULL,
  kind                ENUM('pdf','share_link') NOT NULL,
  period_start        DATE          NOT NULL,
  period_end          DATE          NOT NULL,
  status              ENUM('queued','ready','failed','revoked') NOT NULL DEFAULT 'queued',
  file_uri            VARCHAR(512)  NULL,
  share_token_hash    BINARY(32)    NULL,
  share_expires_at    DATETIME(3)   NULL,
  revoked_at          DATETIME(3)   NULL,
  view_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  created_by_user_id  BIGINT UNSIGNED NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_reports_public_id (public_id),
  UNIQUE KEY uq_reports_share_token (share_token_hash),
  KEY ix_reports_project (project_id, created_at),
  CONSTRAINT fk_reports_project FOREIGN KEY (project_id, org_id)  REFERENCES projects (id, org_id),
  CONSTRAINT fk_reports_user    FOREIGN KEY (created_by_user_id)  REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='PDF exports and public share links';

CREATE TABLE notifications (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id               BIGINT UNSIGNED NULL COMMENT 'NULL for lead (pre-signup) emails',
  user_id              BIGINT UNSIGNED NULL,
  lead_id              BIGINT UNSIGNED NULL,
  project_id           BIGINT UNSIGNED NULL,
  channel              ENUM('email','in_app') NOT NULL,
  category             ENUM('transactional','proactive','marketing') NOT NULL COMMENT 'max 1 proactive email per user per day',
  kind                 VARCHAR(48)   NOT NULL,
  dedupe_key           VARCHAR(191)  NOT NULL,
  subject              VARCHAR(255)  NULL,
  payload              JSON          NULL,
  status               ENUM('queued','sent','delivered','bounced','complained','failed','suppressed') NOT NULL DEFAULT 'queued',
  provider_message_id  VARCHAR(128)  NULL,
  queued_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at              DATETIME(3)   NULL,
  read_at              DATETIME(3)   NULL,
  error                VARCHAR(500)  NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_notifications_dedupe (dedupe_key),
  KEY ix_notifications_daily_cap (user_id, category, channel, sent_at),
  KEY ix_notifications_inbox (user_id, channel, read_at),
  KEY ix_notifications_org (org_id, created_at),
  KEY ix_notifications_provider (provider_message_id),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_lead FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Email + in-app messages; dedupe_key makes sends idempotent';

CREATE TABLE email_suppressions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email            VARCHAR(320)  NOT NULL,
  reason           ENUM('bounce','complaint','unsubscribe_all','manual') NOT NULL,
  source           VARCHAR(32)   NOT NULL DEFAULT 'resend',
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_email_suppressions_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Never email these addresses (deliverability)';

CREATE TABLE announcements (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message              VARCHAR(500)  NOT NULL,
  link_url             VARCHAR(1024) NULL,
  severity             ENUM('info','warning','incident') NOT NULL DEFAULT 'info',
  audience             ENUM('all','plan','org','engine') NOT NULL DEFAULT 'all',
  audience_value       VARCHAR(64)   NULL COMMENT 'plan code | org id | engine code',
  dismissible          BOOLEAN       NOT NULL DEFAULT TRUE,
  starts_at            DATETIME(3)   NOT NULL,
  ends_at              DATETIME(3)   NULL,
  created_by_staff_id  BIGINT UNSIGNED NOT NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_announcements_window (starts_at, ends_at),
  CONSTRAINT fk_announcements_staff FOREIGN KEY (created_by_staff_id) REFERENCES staff_users (id),
  CONSTRAINT ck_announcements_audience CHECK (audience = 'all' OR audience_value IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='In-app banners, incl. incident notices';


-- =====================================================================
-- 15. INTERNAL ADMIN & OPERATIONS
-- =====================================================================

CREATE TABLE admin_audit_log (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  staff_user_id     BIGINT UNSIGNED NOT NULL,
  action            VARCHAR(64)   NOT NULL,
  org_id            BIGINT UNSIGNED NULL,
  project_id        BIGINT UNSIGNED NULL,
  target_type       VARCHAR(48)   NULL,
  target_id         VARCHAR(64)   NULL,
  reason            VARCHAR(500)  NULL,
  ticket_url        VARCHAR(512)  NULL,
  before_state      JSON          NULL COMMENT 'never secrets',
  after_state       JSON          NULL,
  impersonation_id  BIGINT UNSIGNED NULL,
  ip                VARCHAR(45)   NULL,
  user_agent        VARCHAR(512)  NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_admin_audit_log_staff (staff_user_id, created_at),
  KEY ix_admin_audit_log_org (org_id, created_at),
  KEY ix_admin_audit_log_action (action, created_at),
  CONSTRAINT fk_admin_audit_log_staff FOREIGN KEY (staff_user_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Every staff write action. App DB user has INSERT + SELECT only';

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

CREATE TABLE impersonation_sessions (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  staff_user_id     BIGINT UNSIGNED NOT NULL,
  org_id            BIGINT UNSIGNED NOT NULL,
  reason            VARCHAR(500)  NOT NULL,
  ticket_url        VARCHAR(512)  NULL,
  mode              ENUM('read_only','write') NOT NULL DEFAULT 'read_only',
  write_enabled_at  DATETIME(3)   NULL COMMENT 'second confirmation',
  started_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at        DATETIME(3)   NOT NULL COMMENT 'started_at + 30 min',
  ended_at          DATETIME(3)   NULL,
  end_reason        ENUM('staff_ended','expired','revoked') NULL,
  PRIMARY KEY (id),
  KEY ix_impersonation_org (org_id, started_at),
  KEY ix_impersonation_staff (staff_user_id, started_at),
  CONSTRAINT fk_impersonation_staff FOREIGN KEY (staff_user_id) REFERENCES staff_users (id),
  CONSTRAINT ck_impersonation_reason CHECK (CHAR_LENGTH(TRIM(reason)) >= 10),
  CONSTRAINT ck_impersonation_write  CHECK (mode = 'read_only' OR write_enabled_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Support impersonation: reason required, read-only by default';

CREATE TABLE org_notes (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id           BIGINT UNSIGNED NOT NULL,
  staff_user_id    BIGINT UNSIGNED NOT NULL,
  body             TEXT          NOT NULL,
  is_pinned        BOOLEAN       NOT NULL DEFAULT FALSE,
  deleted_at       DATETIME(3)   NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_org_notes_org (org_id, is_pinned, created_at),
  CONSTRAINT fk_org_notes_org   FOREIGN KEY (org_id)        REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_org_notes_staff FOREIGN KEY (staff_user_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Staff notes per customer (never shown to the customer)';

CREATE TABLE review_items (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                  BIGINT UNSIGNED NOT NULL,
  project_id              BIGINT UNSIGNED NOT NULL,
  source                  ENUM('disagreement','customer_report','low_confidence','staff') NOT NULL,
  snapshot_id             BIGINT UNSIGNED NOT NULL,
  run_date                DATE          NOT NULL COMMENT 'locates the snapshot partition',
  mention_id              BIGINT UNSIGNED NULL,
  entity_id               BIGINT UNSIGNED NULL,
  reported_by_user_id     BIGINT UNSIGNED NULL,
  report_kind             ENUM('not_us','misread','missed','other') NULL,
  report_comment          VARCHAR(1000) NULL,
  details                 JSON          NULL COMMENT 'pre-pass vs LLM disagreement, confidence',
  status                  ENUM('open','in_review','resolved','rejected') NOT NULL DEFAULT 'open',
  assigned_staff_id       BIGINT UNSIGNED NULL,
  resolution              ENUM('extraction_correct','extraction_wrong','alias_added','exclusion_added','rule_fixed','no_action') NULL,
  resolution_note         VARCHAR(1000) NULL,
  resolved_by_staff_id    BIGINT UNSIGNED NULL,
  resolved_at             DATETIME(3)   NULL,
  reextract_requested_at  DATETIME(3)   NULL,
  golden_set_exported_at  DATETIME(3)   NULL COMMENT 'golden set itself lives in the repo (evals/)',
  customer_notified_at    DATETIME(3)   NULL,
  created_at              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_review_items_queue (status, source, created_at),
  KEY ix_review_items_org (org_id, status),
  KEY ix_review_items_snapshot (snapshot_id),
  CONSTRAINT fk_review_items_project     FOREIGN KEY (project_id, org_id)    REFERENCES projects (id, org_id),
  CONSTRAINT fk_review_items_entity      FOREIGN KEY (entity_id)             REFERENCES tracked_entities (id) ON DELETE SET NULL,
  CONSTRAINT fk_review_items_reporter    FOREIGN KEY (reported_by_user_id)   REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_review_items_assignee    FOREIGN KEY (assigned_staff_id)     REFERENCES staff_users (id),
  CONSTRAINT fk_review_items_resolved_by FOREIGN KEY (resolved_by_staff_id)  REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Extraction review queue, incl. customer "That''s not us" reports';

CREATE TABLE provider_health (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider_code    VARCHAR(32)   NOT NULL,
  engine_code      VARCHAR(32)   NOT NULL DEFAULT '' COMMENT 'empty = all engines',
  bucket_start     DATETIME      NOT NULL COMMENT '5-minute bucket, UTC',
  requests         INT UNSIGNED  NOT NULL DEFAULT 0,
  successes        INT UNSIGNED  NOT NULL DEFAULT 0,
  failures         INT UNSIGNED  NOT NULL DEFAULT 0,
  timeouts         INT UNSIGNED  NOT NULL DEFAULT 0,
  p50_ms           INT UNSIGNED  NULL,
  p95_ms           INT UNSIGNED  NULL,
  cost_usd         DECIMAL(10,6) NOT NULL DEFAULT 0,
  breaker_state    ENUM('closed','open','half_open') NOT NULL DEFAULT 'closed',
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_provider_health_bucket (provider_code, engine_code, bucket_start),
  KEY ix_provider_health_time (bucket_start),
  CONSTRAINT fk_provider_health_provider FOREIGN KEY (provider_code) REFERENCES providers (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Provider health time series (written by guard.provider_health)';

CREATE TABLE data_requests (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id                BIGINT UNSIGNED NOT NULL COMMENT 'no FK: the record outlives the deleted org',
  kind                  ENUM('export','delete') NOT NULL,
  requested_by_user_id  BIGINT UNSIGNED NULL,
  requested_via         ENUM('self_serve','support') NOT NULL,
  status                ENUM('pending_verification','queued','processing','undo_window','completed','canceled','failed') NOT NULL DEFAULT 'pending_verification',
  verified_at           DATETIME(3)   NULL,
  undo_until            DATETIME(3)   NULL COMMENT 'deletion: 24-hour undo window',
  export_uri            VARCHAR(512)  NULL,
  completed_at          DATETIME(3)   NULL,
  handled_by_staff_id   BIGINT UNSIGNED NULL,
  notes                 VARCHAR(1000) NULL,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_data_requests_status (status, undo_until),
  KEY ix_data_requests_org (org_id),
  CONSTRAINT fk_data_requests_staff FOREIGN KEY (handled_by_staff_id) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='GDPR/CCPA export and deletion requests';


-- =====================================================================
-- 16. COST LEDGER & WEBHOOK INBOX
-- =====================================================================

CREATE TABLE usage_ledger (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id            BIGINT UNSIGNED NULL COMMENT 'NULL = anonymous audit cost',
  project_id        BIGINT UNSIGNED NULL,
  audit_id          BIGINT UNSIGNED NULL,
  meter             ENUM('answer_collect','serp','llm_extract','llm_content','llm_brand_kit','llm_prompts',
                         'llm_narrative','web_search','crawl','email','other') NOT NULL,
  provider_code     VARCHAR(32)   NOT NULL,
  model             VARCHAR(64)   NULL,
  quantity          DECIMAL(14,4) NOT NULL DEFAULT 1,
  unit              ENUM('request','result','batch','search','email') NOT NULL,
  tokens_in         INT UNSIGNED  NULL,
  tokens_out        INT UNSIGNED  NULL,
  tokens_cached     INT UNSIGNED  NULL,
  cost_usd          DECIMAL(12,6) NOT NULL,
  ref_type          VARCHAR(32)   NULL COMMENT 'snapshot | run | content | audit | batch',
  ref_id            BIGINT UNSIGNED NULL,
  idempotency_key   VARCHAR(128)  NOT NULL COMMENT 'job-derived; a retried job never double-counts',
  occurred_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_usage_ledger_idem (idempotency_key),
  KEY ix_usage_ledger_spend (org_id, occurred_at) COMMENT 'guard.spend: today''s spend per org',
  KEY ix_usage_ledger_provider (provider_code, occurred_at),
  KEY ix_usage_ledger_audit (audit_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Every paid call with its USD cost: COGS, margin, spend caps';

CREATE TABLE webhook_events (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source           ENUM('stripe','clerk','dataforseo','serpapi','perplexity','wordpress','resend') NOT NULL,
  external_id      VARCHAR(255)  NOT NULL,
  event_type       VARCHAR(128)  NOT NULL,
  status           ENUM('received','processed','failed','ignored') NOT NULL DEFAULT 'received',
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  payload          JSON          NULL COMMENT 'kept 30 days',
  error            VARCHAR(1000) NULL,
  received_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at     DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_events_external (source, external_id) COMMENT 'idempotent webhook handling',
  KEY ix_webhook_events_status (status, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Inbound webhook inbox (verified signatures only). Clerk: external_id = svix-id header';

-- Milestone 6 addendum (migration 0006): sharing a proven win.
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

-- Milestone 12 (migration 0007): entity checks. (The About page format, `about_page`, is in content_items above.)
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

-- End of schema (68 tables: the 66 of v1, plus proof_shares (0006) and entity_checks (0007)).
