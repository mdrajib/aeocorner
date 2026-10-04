-- Milestone 7 (Content Studio): where a failed pipeline stopped and why. The pipeline runs one stage at a time
-- (research, plan, write, check) and a failure sends the item to `failed`; the screen needs to say which stage broke
-- and the retry needs to know where to start again (src/core/content-lifecycle.js `retryStage`). Both columns are
-- nullable (expand-only, online DDL), so existing rows are simply "no failure".
ALTER TABLE content_items
  ADD COLUMN failed_stage    VARCHAR(16)  NULL COMMENT 'the stage that failed: researching | briefing | drafting | qc | publishing',
  ADD COLUMN failure_reason  VARCHAR(500) NULL COMMENT 'plain-language reason, never a response body or a secret',
  ALGORITHM=INSTANT;
