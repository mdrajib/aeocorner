-- Claude as a fifth engine (Milestone 16, tasks 16.02 and 16.05; ADR-0006 addendum).
--
-- No table changes. The engine list is DATA (the `engines` table, keyed by a code), not an ENUM on the fact tables, so
-- adding an engine is a row, not a rewrite of tables that will grow: `answer_snapshots.engine_code`, `mentions`,
-- `cell_results` and the rest already take any code. (The plan's worry about new ENUM values on large tables did not
-- apply to this design; the `claude` row was seeded as `disabled` in 0002 for exactly this.)
--
-- What this switches on: the `claude` row becomes live, answered by the Claude API with its web-search tool
-- (provider `anthropic`, method `api_grounded`, no fallback, as the other four have none built).
--
-- It does NOT add the engine to any existing project. A project gets a `project_engines` row only when its organization
-- chooses the engine (or, for a new project, when the plan includes it), so a project with four engines is unchanged by
-- this migration (founder decision F5, a suggestion until answered).
UPDATE engines
   SET status = 'active',
       primary_provider_code = 'anthropic',
       primary_method = 'api_grounded',
       fallback_provider_code = NULL,
       fallback_method = NULL
 WHERE code = 'claude';

-- The plan feature (founder decision F3, a suggestion: the top tier, because a Claude answer costs several times what
-- another engine's does). A plan without it can see Claude in the engine list but not switch it on.
UPDATE plans SET features = JSON_SET(features, '$.claude_engine', FALSE) WHERE code IN ('starter', 'growth');
UPDATE plans SET features = JSON_SET(features, '$.claude_engine', TRUE)  WHERE code = 'agency';
