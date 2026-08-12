-- =============================================================================
-- Grants the gateway Postgres role read access to public.membership,
-- public.profile, public.pull_request, and public.pull_request_session, for
-- the `prOutcomes` and `actorNames` ports an API-key caller's session reads
-- build (packages/gateway-core/src/lib/pr-outcomes.ts,
-- packages/gateway-core/src/openapi/routes/sessions.ts). The gateway role's
-- tenant-isolation policies (95-gateway-rls.sql) are per-table opt-in; none
-- of these four had one, so a gateway-authenticated read returned zero rows
-- under RLS.
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

GRANT SELECT ON public.pull_request TO gateway;

CREATE POLICY "gateway_tenant_read_pull_request" ON public.pull_request
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

GRANT SELECT ON public.pull_request_session TO gateway;

CREATE POLICY "gateway_tenant_read_pull_request_session" ON public.pull_request_session
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

COMMIT;
