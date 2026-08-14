-- =============================================================================
-- Grants the gateway Postgres role read access to public.membership,
-- public.profile, and public.pull_request_session, for the `prOutcomes` and
-- `actorNames` ports an API-key caller's session reads build
-- (packages/gateway-core/src/lib/pr-outcomes.ts,
-- packages/gateway-core/src/openapi/routes/sessions.ts). The gateway role's
-- tenant-isolation policies (95-gateway-rls.sql) are per-table opt-in; none
-- of these had one, so a gateway-authenticated read returned zero rows under
-- RLS. public.pull_request, which these ports also read, got its gateway
-- grant + policy in the add_artifact migration that precedes this one.
-- =============================================================================

BEGIN;

GRANT SELECT ON public.membership TO gateway;

CREATE POLICY "gateway_tenant_read_membership" ON public.membership
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

GRANT SELECT ON public.profile TO gateway;

CREATE POLICY "gateway_tenant_read_profile" ON public.profile
    FOR SELECT TO gateway
    USING (
      id IN (
        SELECT m.user_id
        FROM public.membership m
        WHERE m.tenant_id = public.tenant_id()
          AND (m.status)::text = 'active'::text
      )
    );

GRANT SELECT ON public.pull_request_session TO gateway;

CREATE POLICY "gateway_tenant_read_pull_request_session" ON public.pull_request_session
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

-- The pre-existing "Users can read memberships" / "Users can read profiles"
-- policies (12-rbac.sql) carry no TO clause, so PUBLIC, so the gateway role
-- inherits their OR-arm that calls private.authorize('membership.read'/...).
-- Without EXECUTE on that function, every gateway-role SELECT against
-- membership/profile fails with 42501 ("permission denied for function
-- authorize") rather than falling through to the tenant-scoped policies
-- above. Granting EXECUTE is safe: authorize() keys off auth.uid(), which
-- for gateway JWTs is the tenant id and matches no membership.user_id row,
-- so the legacy policies' OR-arm always evaluates to false for this role —
-- the grant only prevents the error, it does not widen what the role can
-- read.
GRANT EXECUTE ON FUNCTION private.authorize(public.app_permission) TO gateway;

COMMIT;
