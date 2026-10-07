-- Claude after a downgrade (founder decision F3, option C; ADR-0006 decision 9).
--
-- Claude is a plan feature (`claude_engine`, the top tier). When an organization moves to a plan without it, a project
-- that already tracks Claude keeps being collected until the end of the billing period the customer has already paid
-- for, then stops. `claude_until` is that moment: set when the plan changes from one with the feature to one without
-- (to the subscription's current period end), cleared when a plan with the feature comes back, and read by the tracking
-- planner (so nothing is asked of Claude after it) and by a daily sweep that switches the engine off on the projects.
-- NULL means no grace is running. No other table changes.

ALTER TABLE organizations
  ADD COLUMN claude_until DATETIME(3) NULL COMMENT 'after a downgrade: Claude is still collected until this moment (the paid period end), then switched off; NULL = no grace';
