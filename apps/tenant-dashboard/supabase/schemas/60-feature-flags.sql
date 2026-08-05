-- =============================================================================
-- Feature Flags Schema
-- =============================================================================
-- Purpose: Feature flag system for gradual rollouts and A/B testing
-- Dependencies: 01-types.sql, 10-tenant.sql, 11-profile.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Feature Flag Table
-- -----------------------------------------------------------------------------

-- Global feature flags managed by platform admins
CREATE TABLE IF NOT EXISTS public.feature_flag (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL UNIQUE,
    description TEXT,
    is_enabled BOOLEAN DEFAULT false,
    rollout_percentage INTEGER DEFAULT 100,
    strategy public.flag_strategy NOT NULL DEFAULT 'global',

    -- Audit columns
    created_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.feature_flag IS 'Global feature flags for gradual rollouts';
COMMENT ON COLUMN public.feature_flag.key IS 'Unique identifier used in code to check flag';
COMMENT ON COLUMN public.feature_flag.strategy IS 'Rollout strategy: global, random, targeted, percentage';
COMMENT ON COLUMN public.feature_flag.rollout_percentage IS 'Percentage of users to receive the feature (for percentage/random strategies)';

-- -----------------------------------------------------------------------------
-- Feature Flag Override Table
-- -----------------------------------------------------------------------------

-- Per-tenant overrides for feature flags (include/exclude specific orgs)
CREATE TABLE IF NOT EXISTS public.feature_flag_override (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flag_id UUID NOT NULL REFERENCES public.feature_flag(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    is_enabled BOOLEAN NOT NULL,
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    UNIQUE(flag_id, tenant_id)
);

COMMENT ON TABLE public.feature_flag_override IS 'Per-tenant overrides for feature flags';
COMMENT ON COLUMN public.feature_flag_override.is_enabled IS 'true = force enable for this tenant, false = force disable';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Note: idx_feature_flag_key is implicitly created by the UNIQUE constraint on key column
CREATE INDEX IF NOT EXISTS idx_feature_flag_override_tenant_id ON public.feature_flag_override(tenant_id);

-- -----------------------------------------------------------------------------
-- Row Level Security - Feature Flag
-- -----------------------------------------------------------------------------

ALTER TABLE public.feature_flag ENABLE ROW LEVEL SECURITY;

-- Reads are platform-admin only, matching the write policies below and the
-- override table's own SELECT policy. Every production read of this table goes
-- through a service-role client, which bypasses RLS entirely -- the gateway's
-- flag evaluation, the dashboard's flag evaluation, and the platform-admin
-- management UI all use one. No authenticated or anonymous session needs to
-- reach this table directly, so an unrestricted read predicate grants nothing
-- the product uses and exposes the key and description of every unreleased
-- feature to anyone holding the publishable key.
CREATE POLICY "Platform admins can read feature flags" ON "public"."feature_flag" FOR SELECT USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));

CREATE POLICY "Platform admins can delete feature flags" ON "public"."feature_flag" FOR DELETE USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));

CREATE POLICY "Platform admins can insert feature flags" ON "public"."feature_flag" FOR INSERT WITH CHECK ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));

CREATE POLICY "Platform admins can update feature flags" ON "public"."feature_flag" FOR UPDATE USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));

-- -----------------------------------------------------------------------------
-- Row Level Security - Feature Flag Override
-- -----------------------------------------------------------------------------

ALTER TABLE public.feature_flag_override ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can delete feature flag overrides" ON "public"."feature_flag_override" FOR DELETE USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));

CREATE POLICY "Platform admins can insert feature flag overrides" ON "public"."feature_flag_override" FOR INSERT WITH CHECK ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));

CREATE POLICY "Platform admins can update feature flag overrides" ON "public"."feature_flag_override" FOR UPDATE USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));

-- Read is platform-admin only: no per-tenant read is granted. The tenant claim
-- lives at app_metadata.tenant_id (nothing mints a top-level `tenant_id`), so a
-- per-tenant arm keyed on a top-level claim would be dead; read is granted
-- solely through platform_authorize.
CREATE POLICY "Users can read feature flag overrides" ON "public"."feature_flag_override" FOR SELECT USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));


-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

GRANT ALL ON public.feature_flag TO anon;
GRANT ALL ON public.feature_flag TO authenticated;
GRANT ALL ON public.feature_flag TO service_role;

GRANT ALL ON public.feature_flag_override TO anon;
GRANT ALL ON public.feature_flag_override TO authenticated;
GRANT ALL ON public.feature_flag_override TO service_role;

