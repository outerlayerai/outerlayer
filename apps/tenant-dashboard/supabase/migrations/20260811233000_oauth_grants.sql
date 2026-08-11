-- =============================================================================
-- Read/revoke surface for MCP connector grants. auth.sessions /
-- auth.oauth_clients belong to Supabase's OAuth 2.1 server, not the public
-- schema, so the dashboard needs SECURITY DEFINER functions scoped to
-- auth.uid() to read and revoke a caller's own connector grants.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.list_current_user_oauth_grants()
 RETURNS TABLE (
   session_id uuid,
   client_id uuid,
   client_name text,
   scopes text,
   created_at timestamptz,
   refreshed_at timestamp
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    s.id AS session_id,
    s.oauth_client_id AS client_id,
    c.client_name,
    s.scopes,
    s.created_at,
    s.refreshed_at
  FROM auth.sessions s
  JOIN auth.oauth_clients c ON c.id = s.oauth_client_id
  WHERE s.user_id = auth.uid()
    AND s.oauth_client_id IS NOT NULL
  ORDER BY s.created_at DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.revoke_current_user_oauth_grant(target_session_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM auth.sessions
  WHERE id = target_session_id
    AND user_id = auth.uid()
    -- Scoped to connector sessions only — this function must never become
    -- a way to end a caller's own dashboard session by id.
    AND oauth_client_id IS NOT NULL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count > 0;
END;
$function$
;

REVOKE EXECUTE ON FUNCTION public.list_current_user_oauth_grants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_current_user_oauth_grants() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.revoke_current_user_oauth_grant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_current_user_oauth_grant(uuid) TO authenticated, service_role;

COMMIT;
