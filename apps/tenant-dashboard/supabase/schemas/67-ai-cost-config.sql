-- =============================================================================
-- AI Program Cost Configuration (org-wide seat spend)
-- =============================================================================
-- Purpose: one row per tenant declaring the org's fixed AI tooling spend as
--   seats × $/seat/month. Feeds the "Total Cost of AI" executive metric:
--   fixed seat spend (this table, prorated to the widget's window) + metered
--   token spend (ClickHouse). Kept deliberately simple — a single blended
--   seat count and rate; orgs on several tools enter the blended totals.
-- Dependencies: 10-tenant.sql, 12-rbac.sql (permission seeds).
-- Writers: tenant owners/admins via Settings -> AI costs (RLS-gated).
-- Readers: the same admins (settings form) and the analytics widget route
--   (service_role, tenant-pinned in code).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ai_cost_config (
    -- 1:1 with tenant (the billing-table pattern): the tenant id IS the key.
    tenant_id UUID PRIMARY KEY REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,

    -- Paid AI tool seats across the org (Claude, Cursor, Copilot, …) and the
    -- blended monthly price per seat. Zero means "not configured" — the
    -- widget then shows metered spend alone and says so.
    seat_count BIGINT NOT NULL DEFAULT 0
        CONSTRAINT chk_ai_cost_config_seat_count CHECK (seat_count >= 0),
    cost_per_seat_usd NUMERIC(10, 2) NOT NULL DEFAULT 0
        CONSTRAINT chk_ai_cost_config_cost_per_seat CHECK (cost_per_seat_usd >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.ai_cost_config IS 'Per-tenant fixed AI program spend (seats x $/seat/month) — the seat-cost half of Total Cost of AI; metered token spend is the other half.';

-- Note: updated_at trigger is registered in 99-triggers.sql.

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
-- Owner/admin only (seeded in 12-rbac.sql) — org-level financial config, like
-- billing. The widget read path uses service_role (bypasses RLS, tenant-pinned
-- in code).

ALTER TABLE public.ai_cost_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read for ai cost config" ON "public"."ai_cost_config"
    FOR SELECT TO "authenticated"
    USING (("private"."authorize"('ai_cost_config.read'::"public"."app_permission")
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable insert for ai cost config" ON "public"."ai_cost_config"
    FOR INSERT TO "authenticated"
    WITH CHECK (("private"."authorize"('ai_cost_config.insert'::"public"."app_permission")
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable update for ai cost config" ON "public"."ai_cost_config"
    FOR UPDATE TO "authenticated"
    USING (("private"."authorize"('ai_cost_config.update'::"public"."app_permission")
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable delete for ai cost config" ON "public"."ai_cost_config"
    FOR DELETE TO "authenticated"
    USING (("private"."authorize"('ai_cost_config.delete'::"public"."app_permission")
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.ai_cost_config TO anon;
GRANT ALL ON public.ai_cost_config TO authenticated;
GRANT ALL ON public.ai_cost_config TO service_role;
