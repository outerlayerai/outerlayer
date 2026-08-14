-- =============================================================================
-- SECURITY DEFINER Function Execution Grants
-- =============================================================================
-- Purpose: Lock down every internal/service-role/trigger SECURITY DEFINER
--   function so it is NOT callable by `anon` / `authenticated` (nor via the
--   default PUBLIC grant) over PostgREST `/rest/v1/rpc/*`.
--
-- Why this file exists: Postgres default-grants EXECUTE to PUBLIC on every new
--   function, and a `REVOKE ... FROM <role>` does NOT remove that PUBLIC grant.
--   The Supabase splinter linter (anon_/authenticated_security_definer_function_
--   executable) flags any SECURITY DEFINER function in an API-exposed schema
--   that anon/authenticated can execute. Centralising the revokes here keeps the
--   policy auditable in one place.
--
-- The JWT-reading authz helpers that RLS needs (authorize, app_authorize,
--   platform_authorize, get_dashboard_app_id, get_current_user_app_permissions)
--   are handled separately — their DEFINER bodies live in the unexposed `private`
--   schema (01a-private-authz.sql, 28-dashboard.sql).
--
-- Dependencies: all function definitions (02/03/52/56/65/...). Loaded late.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Vault secret access — service-role admin client ONLY. Must never be anon- or
-- authenticated-callable: these functions read tenant secrets.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.read_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_secret(text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.insert_secret(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_secret(text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.delete_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_secret(text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_secret(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_secret(text, text) TO service_role;

-- -----------------------------------------------------------------------------
-- JWT claims management — internally gated by is_claims_admin() (true only for
-- service_role / trigger context); revoke the API surface regardless.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.get_claim(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_claim(uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.set_claim(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_claim(uuid, text, jsonb) TO service_role;

-- -----------------------------------------------------------------------------
-- Multi-statement transaction RPCs — called by the dashboard's service-role
-- admin client (server actions), never directly by the browser/user session.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.create_organization_transaction(uuid, text, text, character varying, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_organization_transaction(uuid, text, text, character varying, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.invite_new_user_transaction(uuid, uuid, uuid, citext, text, character varying, timestamp with time zone, timestamp with time zone, inet, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invite_new_user_transaction(uuid, uuid, uuid, citext, text, character varying, timestamp with time zone, timestamp with time zone, inet, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.invite_existing_user_transaction(uuid, uuid, uuid, character varying, timestamp with time zone, timestamp with time zone, inet, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invite_existing_user_transaction(uuid, uuid, uuid, character varying, timestamp with time zone, timestamp with time zone, inet, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.change_member_role_transaction(uuid, uuid, uuid, character varying, uuid, inet, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_member_role_transaction(uuid, uuid, uuid, character varying, uuid, inet, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.remove_member_transaction(uuid, uuid, uuid, inet, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_member_transaction(uuid, uuid, uuid, inet, text, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.grant_temp_access_transaction(uuid, uuid, text, boolean, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_temp_access_transaction(uuid, uuid, text, boolean, timestamp with time zone) TO service_role;

REVOKE EXECUTE ON FUNCTION public.platform_admin_delete_tenant(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_admin_delete_tenant(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.change_user_password(character varying, character varying) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_user_password(character varying, character varying) TO service_role;

-- list_current_user_oauth_grants/revoke_current_user_oauth_grant
-- (68-oauth-grants.sql) take the target user id as a parameter rather than
-- reading auth.uid() internally, so only the service-role client can
-- execute them — the dashboard resolves the caller's own id from the
-- authenticated session server-side before calling in.
REVOKE EXECUTE ON FUNCTION public.list_current_user_oauth_grants(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_current_user_oauth_grants(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.revoke_current_user_oauth_grant(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_current_user_oauth_grant(uuid, uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- Scheduled cleanup (pg_cron / service-role) — never user-facing.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_temp_access() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_temp_access() TO service_role;

-- -----------------------------------------------------------------------------
-- PUBLIC is revoked explicitly: a REVOKE FROM authenticated, anon does not
-- remove PUBLIC's EXECUTE, so naming only those two roles leaves the function
-- callable.
-- -----------------------------------------------------------------------------
-- Keeps the supabase_auth_admin grant from 02-functions-core.sql; just removes
-- the PUBLIC/role leak.
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Trigger functions — fired by the trigger machinery regardless of EXECUTE
-- privilege, so no role needs it. Strip the API surface entirely.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.set_updated_columns() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_created_columns() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_profile_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_auth_email_to_profile() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nullify_custom_role_on_downgrade() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.protect_last_owner() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_membership_limit() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.app_seed_default_env() FROM PUBLIC, anon, authenticated;
