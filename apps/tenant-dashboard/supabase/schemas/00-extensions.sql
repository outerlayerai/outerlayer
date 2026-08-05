-- =============================================================================
-- Extensions Schema
-- =============================================================================
-- Purpose: Database extensions required by the application
-- Dependencies: None (must be loaded first)
-- =============================================================================

-- UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- Cryptographic functions
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

-- Case-insensitive text type
CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA public;

-- GiST operator classes for btree-indexable types; required by the
-- git_connection exclusion constraint (one tenant per installation)
CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA extensions;

-- Scheduled jobs extension (managed by Supabase, runs in pg_cron schema)
CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA pg_catalog;
