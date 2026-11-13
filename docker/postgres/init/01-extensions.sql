-- Runs once, on first init of the dev database volume.
-- pg_stat_statements: query-level timing for debugging (see .claude/skills/db-inspect).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
