-- Read/revoke surface for MCP connector grants (Supabase's OAuth 2.1
-- server owns auth.oauth_clients / auth.sessions / auth.oauth_consents —
-- these are not public-schema tables, so the dashboard's RLS-scoped client
-- can't query them directly). Both functions are SECURITY DEFINER, scoped
-- to an explicit p_user_id parameter rather than auth.uid() — neither is
-- callable by anon/authenticated (96-function-execution-grants.sql), so
-- only the dashboard's service-role admin client can call them, after
-- resolving the caller's own id from the authenticated session server-side
-- (never from caller input) and passing it in. A caller can still only ever
-- see or revoke their own grants; the scoping now happens at the call site
-- instead of inside the function.
--
-- A "grant" here is a connector-issued session: auth.sessions rows with
-- oauth_client_id set. Deleting the session is the verified kill switch —
-- it invalidates the refresh token immediately. Setting oauth_consents.revoked_at
-- does NOT stop refresh (Supabase's OAuth server does not check consent
-- state on refresh), so revocation goes through the session row, never
-- oauth_consents. An already-issued access token stays valid for up to its
-- remaining lifetime (≤1h) regardless — there is no server-side access-token
-- revocation list.

CREATE OR REPLACE FUNCTION public.list_current_user_oauth_grants(p_user_id uuid)
 RETURNS TABLE (
   session_id uuid,
   client_id uuid,
   client_name text,
   scopes text,
   created_at timestamptz,
   refreshed_at timestamptz
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
  WHERE s.user_id = p_user_id
    AND s.oauth_client_id IS NOT NULL
  ORDER BY s.created_at DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.revoke_current_user_oauth_grant(p_user_id uuid, target_session_id uuid)
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
    AND user_id = p_user_id
    -- Scoped to connector sessions only — this function must never become
    -- a way to end a caller's own dashboard session by id.
    AND oauth_client_id IS NOT NULL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count > 0;
END;
$function$
;
