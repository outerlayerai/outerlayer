-- =============================================================================
-- Table Privilege Hardening
-- =============================================================================
-- Purpose: strip the table privileges the Data API roles must never hold
-- Dependencies: every table-defining schema file (this must sort AFTER them)
-- =============================================================================
--
-- anon and authenticated reach the database only through PostgREST, which issues
-- SELECT / INSERT / UPDATE / DELETE and nothing else. Every one of those four is
-- gated by row-level security. The remaining table privileges are not:
--
--   TRUNCATE   RLS DOES NOT APPLY. A caller holding TRUNCATE empties the table
--              regardless of policy — the same session that can SELECT zero rows
--              under RLS can still destroy every row. This is the one that
--              matters.
--   REFERENCES lets a role point a foreign key at the table, which can pin rows
--              against deletion.
--   TRIGGER    lets a role attach a trigger to the table.
--
-- These arrive two ways, which is why this is a schema-wide sweep rather than
-- per-table edits: `GRANT ALL ON <table> TO anon` in the table's own schema
-- file, and Supabase's legacy default privileges on public (auto-granted for
-- projects created before 2026-05-30). A sweep covers both, and covers tables
-- added later that repeat the `GRANT ALL` idiom.
--
-- This sweeps the schema rather than naming tables, so it must stay near the end
-- of `schema_paths` in config.toml — that list, not the filename number, is the
-- order `db diff` honours. Nothing here touches SELECT/INSERT/UPDATE/DELETE, so
-- no RLS-gated access path changes.

REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Same treatment for tables created after this file runs.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;
