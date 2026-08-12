-- Read/revoke surface for MCP connector grants (Supabase's OAuth 2.1
-- server owns auth.oauth_clients / auth.sessions / auth.oauth_consents —
-- these are not public-schema tables, so the dashboard's RLS-scoped client
-- can't query them directly. Both functions are SECURITY DEFINER, scoped
-- to auth.uid() so a caller can only ever see or revoke their own grants.
--
-- A "grant" here is a connector-issued session: auth.sessions rows with
-- oauth_client_id set. Deleting the session is the verified kill switch —
-- it invalidates the refresh token immediately. Setting oauth_consents.revoked_at
-- does NOT stop refresh (Supabase's OAuth server does not check consent
-- state on refresh), so revocation goes through the session row, never
-- oauth_consents. An already-issued access token stays valid for up to its
-- remaining lifetime (≤1h) regardless — there is no server-side access-token
-- revocation list.
--
-- Both functions stay callable by a connector (OAuth) token — the
-- confinement in 98a-connector-token-confinement.sql narrows table access,
-- not RPC execution. That's safe here: `auth.uid()` scopes both to the
-- caller's own grants, so a connector token can only list or revoke
-- sessions belonging to the same user who approved it, including its own
-- session — self-revocation via the connector is intended, not a gap.

CREATE OR REPLACE FUNCTION public.list_current_user_oauth_grants()
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
