-- =============================================================================
-- Connector-Token PostgREST Confinement
-- =============================================================================
-- A Supabase OAuth connector token (claude.ai / ChatGPT custom connector) is
-- an ordinary `role: authenticated` user JWT distinguished only by a
-- `client_id` claim — Supabase does not enforce OAuth scopes, so a leaked
-- token can otherwise be replayed directly against `/rest/v1/*` with the
-- full power of the approving user's role. See
-- apps/tenant-dashboard/supabase/schemas/98a-connector-token-confinement.sql
-- for the full design note and the exemption list.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION private.is_connector_token()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'pg_temp'
AS $function$
  SELECT COALESCE(auth.jwt() ->> 'client_id', '') <> '';
$function$
;

REVOKE EXECUTE ON FUNCTION private.is_connector_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.is_connector_token() TO authenticated, service_role;

CREATE POLICY connector_token_confinement ON public.tenant                        AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.role_permissions              AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.platform_role_permissions     AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.platform_user_role            AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.app                          AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.env_var                       AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.terms_agreement               AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.api_key                       AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.billing                       AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.dashboard                     AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.dashboard_widget              AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.custom_role                   AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.custom_role_permission        AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.user_git_identity             AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.git_connection                AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.git_branch                    AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.context_blob                  AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.context_tree_entry            AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.context_head                  AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.context_sync_event            AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.temp_access_grant             AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.tenant_entitlement_override   AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.audit_log                     AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.notification                  AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.feature_flag                  AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.feature_flag_override         AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.sso_config                    AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.sso_identity                  AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.sso_audit_log                 AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.app_member_role               AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.saved_trace_filters           AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.worker_run                    AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.worker_run_event              AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.worker_workspace              AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.ai_cost_config                AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.pr_session_comment            AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.pr_evidence_evaluation         AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());
CREATE POLICY connector_token_confinement ON public.artifact                       AS RESTRICTIVE FOR ALL TO authenticated USING (NOT private.is_connector_token());

-- SELECT-exempt tables above still deny writes: a connector token reads
-- membership/profile/environment/context_snapshot/pull_request/
-- pull_request_session under ordinary RLS (see the exemption note above),
-- but FOR ALL can't be split into "SELECT permissive, everything else
-- restrictive" in one policy — a RESTRICTIVE USING clause governs SELECT
-- too. Three narrower policies per table cover INSERT/UPDATE/DELETE only.
CREATE POLICY connector_token_write_confinement ON public.membership              AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_update_confinement ON public.membership             AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT private.is_connector_token()) WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_delete_confinement ON public.membership             AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT private.is_connector_token());

CREATE POLICY connector_token_write_confinement ON public.profile                 AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_update_confinement ON public.profile                AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT private.is_connector_token()) WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_delete_confinement ON public.profile                AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT private.is_connector_token());

CREATE POLICY connector_token_write_confinement ON public.environment             AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_update_confinement ON public.environment            AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT private.is_connector_token()) WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_delete_confinement ON public.environment            AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT private.is_connector_token());

CREATE POLICY connector_token_write_confinement ON public.context_snapshot        AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_update_confinement ON public.context_snapshot       AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT private.is_connector_token()) WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_delete_confinement ON public.context_snapshot       AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT private.is_connector_token());

CREATE POLICY connector_token_write_confinement ON public.pull_request            AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_update_confinement ON public.pull_request           AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT private.is_connector_token()) WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_delete_confinement ON public.pull_request           AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT private.is_connector_token());

CREATE POLICY connector_token_write_confinement ON public.pull_request_session    AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_update_confinement ON public.pull_request_session   AS RESTRICTIVE FOR UPDATE TO authenticated USING (NOT private.is_connector_token()) WITH CHECK (NOT private.is_connector_token());
CREATE POLICY connector_token_delete_confinement ON public.pull_request_session   AS RESTRICTIVE FOR DELETE TO authenticated USING (NOT private.is_connector_token());

COMMIT;
