-- =============================================================================
-- Grants the gateway Postgres role read access to public.context_snapshot,
-- for GET /v1/context/changes. The gateway role's existing tenant-isolation
-- policies (95-gateway-rls.sql) are per-table opt-in; context_snapshot had
-- none, so a gateway-authenticated read returned zero rows under RLS.
-- =============================================================================

BEGIN;

GRANT SELECT ON public.context_snapshot TO gateway;

CREATE POLICY "gateway_tenant_read_context_snapshot" ON public.context_snapshot
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

COMMIT;
