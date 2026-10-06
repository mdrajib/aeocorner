-- Self-confirmed profiles (Entity screen). Some sites never let our crawler read a profile (LinkedIn's robots.txt allows
-- only LinkedInBot and approved search engines), so its check ends as 'error' ("couldn't check") for ever. A person who
-- has looked at the profile themselves can say so. That is a separate fact from the machine's result, so it gets its
-- own columns and the check's `status` stays exactly what our crawler found.
--
-- confirmed_at / confirmed_by_user_id are set only while the latest check is 'error'. A later real result ('passed' or
-- 'failed', a page we could read) clears them: what we read outranks what a person said. The row goes with the profile
-- address, so changing the address starts clean. confirmed_by_user_id has no foreign key on purpose: it is an audit
-- trail, and a user who leaves must not block anything or erase the fact that someone confirmed.

ALTER TABLE entity_checks
  ADD COLUMN confirmed_at DATETIME(3) NULL COMMENT 'a person said they checked this profile; only while the latest check is error',
  ADD COLUMN confirmed_by_user_id BIGINT UNSIGNED NULL COMMENT 'who said so (no foreign key: an audit trail)';
