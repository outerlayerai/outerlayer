-- =============================================================================
-- Billing Schema
-- =============================================================================
-- Purpose: Stripe billing integration for tenant subscriptions
-- Dependencies: 10-tenant.sql, 11-profile.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Billing Table
-- -----------------------------------------------------------------------------

-- Stripe billing configuration - 1:1 relationship with tenant
CREATE TABLE IF NOT EXISTS public.billing (
    tenant_id UUID PRIMARY KEY REFERENCES public.tenant(tenant_id) ON DELETE CASCADE UNIQUE NOT NULL,
    stripe_customer_id VARCHAR(255) UNIQUE,
    stripe_subscription_id VARCHAR(255) UNIQUE,
    tier_id TEXT NOT NULL DEFAULT 'hobby'
        CONSTRAINT chk_billing_tier_id CHECK (tier_id IN ('hobby', 'growth', 'team', 'enterprise')),

    -- Audit columns
    created_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.billing IS 'Stripe billing configuration - 1:1 with tenant';
COMMENT ON COLUMN public.billing.tenant_id IS 'References tenant.tenant_id (1:1 relationship); also this table''s primary key';
COMMENT ON COLUMN public.billing.stripe_customer_id IS 'Stripe customer ID (null when billing is disabled for self-hosting)';
COMMENT ON COLUMN public.billing.stripe_subscription_id IS 'Active Stripe subscription ID';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------

CREATE TRIGGER on_update_set_billing_updated_columns
    BEFORE UPDATE ON public.billing
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_columns();

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

ALTER TABLE public.billing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable billing read access for tenant admins" ON "public"."billing" FOR SELECT TO "authenticated" USING ((( SELECT "private"."authorize"('billing.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));


-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

GRANT ALL ON public.billing TO anon;
GRANT ALL ON public.billing TO authenticated;
GRANT ALL ON public.billing TO service_role;

