-- =============================================================================
-- Drops the platform DORA-metrics data plane: the platform_deployment,
-- platform_incident, and platform_dora_collection_state tables, and the
-- platform_admin grant for `platform.dora.read`.
--
-- The `platform.dora.read` enum label itself is retained: Postgres has no
-- `ALTER TYPE ... DROP VALUE`, and rebuilding platform_permission would mean
-- dropping and recreating private.platform_authorize plus every RLS policy
-- that casts to the type. 01-types.sql documents it as a dead, ungranted
-- label alongside the changelog and alert_agent ones.
-- =============================================================================

BEGIN;

-- Retire the grant first: private.platform_authorize resolves permissions
-- from this table, so removing the row is what actually revokes access.
DELETE FROM public.platform_role_permissions
WHERE permission = 'platform.dora.read';

-- platform_incident references platform_deployment (deployment_id FK), so it
-- goes first; CASCADE clears policies, indexes, and triggers with each table.
-- Dropping the tables is the point of this migration, not accidental data loss.
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.platform_incident CASCADE;
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.platform_deployment CASCADE;
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.platform_dora_collection_state CASCADE;

COMMIT;
