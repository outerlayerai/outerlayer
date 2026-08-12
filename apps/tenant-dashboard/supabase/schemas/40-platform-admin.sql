-- =============================================================================
-- Platform Admin Schema
-- =============================================================================
-- Purpose: Platform-level administration (separate from tenant admin)
-- Dependencies: 10-tenant.sql, 11-profile.sql, 12-rbac.sql
-- =============================================================================

-- NOTE: the platform audit log lives in 32-audit-log.sql (public.audit_log,
-- the consolidated polymorphic-actor trail). Platform-admin actions are
-- recorded there, not in this file.

-- -----------------------------------------------------------------------------
-- Temporary Access Grant Table
-- -----------------------------------------------------------------------------

-- Platform admins can grant themselves temporary read access to any tenant
-- Uses membership + role for actual access; this table tracks grants
CREATE TABLE IF NOT EXISTS public.temp_access_grant (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID REFERENCES public.profile(id) ON DELETE CASCADE NOT NULL,
    tenant_id UUID REFERENCES public.tenant(tenant_id) ON DELETE CASCADE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    expires_at TIMESTAMPTZ NOT NULL,  -- created_at + 24 hours typically
    revoked_at TIMESTAMPTZ,           -- NULL if still active
    reason TEXT,                      -- Optional reason for audit purposes
    customer_permission_confirmed BOOLEAN NOT NULL DEFAULT false  -- Customer gave permission for support access
);

COMMENT ON TABLE public.temp_access_grant IS 'Tracks temporary access grants for platform admins';
COMMENT ON COLUMN public.temp_access_grant.expires_at IS 'Auto-expiry time (typically 24 hours)';
COMMENT ON COLUMN public.temp_access_grant.revoked_at IS 'NULL if still active, timestamp if manually revoked';
COMMENT ON COLUMN public.temp_access_grant.customer_permission_confirmed IS 'Admin confirmed they received customer permission before granting access';

-- -----------------------------------------------------------------------------
-- Tenant Entitlement Override Table
-- -----------------------------------------------------------------------------

-- Per-tenant entitlement overrides for tiered feature gating
-- Allows platform admins to override tier defaults for specific tenants
CREATE TABLE IF NOT EXISTS public.tenant_entitlement_override (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    entitlement_key TEXT NOT NULL,
    value JSONB NOT NULL,
    override_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    UNIQUE(tenant_id, entitlement_key)
);

COMMENT ON TABLE public.tenant_entitlement_override IS 'Per-tenant entitlement overrides for tiered feature gating';
COMMENT ON COLUMN public.tenant_entitlement_override.entitlement_key IS 'Key from the entitlement catalog (e.g., maxApps, maxUsers)';
COMMENT ON COLUMN public.tenant_entitlement_override.value IS 'JSON value overriding the tier default';
COMMENT ON COLUMN public.tenant_entitlement_override.override_reason IS 'Audit reason for the override';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Entitlement override indexes

-- Temp access indexes
CREATE INDEX IF NOT EXISTS idx_temp_access_created_by ON public.temp_access_grant(created_by);
CREATE INDEX IF NOT EXISTS idx_temp_access_tenant ON public.temp_access_grant(tenant_id);
CREATE INDEX IF NOT EXISTS idx_temp_access_expires ON public.temp_access_grant(expires_at) WHERE revoked_at IS NULL;

-- Partial unique index: only one ACTIVE grant per admin per org
CREATE UNIQUE INDEX IF NOT EXISTS temp_access_grant_active_idx
    ON public.temp_access_grant(created_by, tenant_id)
    WHERE revoked_at IS NULL;

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Row Level Security - Temp Access Grant
-- -----------------------------------------------------------------------------

ALTER TABLE public.temp_access_grant ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON "public"."temp_access_grant" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- Grant to auth admin for custom_access_token_hook
grant select on table "public"."temp_access_grant" to "supabase_auth_admin";

-- -----------------------------------------------------------------------------
-- Row Level Security - Tenant Entitlement Override
-- -----------------------------------------------------------------------------

ALTER TABLE public.tenant_entitlement_override ENABLE ROW LEVEL SECURITY;

-- Service role has full access (for system operations)
CREATE POLICY "Service role has full access to entitlement overrides"
    ON public.tenant_entitlement_override
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Platform admins can read overrides
CREATE POLICY "Platform admins can read entitlement overrides"
    ON public.tenant_entitlement_override
    FOR SELECT
    TO authenticated
    USING (private.platform_authorize('platform.entitlement.read'::platform_permission));

-- Platform admins can create/update overrides
CREATE POLICY "Platform admins can write entitlement overrides"
    ON public.tenant_entitlement_override
    FOR INSERT
    TO authenticated
    WITH CHECK (private.platform_authorize('platform.entitlement.write'::platform_permission));

CREATE POLICY "Platform admins can update entitlement overrides"
    ON public.tenant_entitlement_override
    FOR UPDATE
    TO authenticated
    USING (private.platform_authorize('platform.entitlement.write'::platform_permission))
    WITH CHECK (private.platform_authorize('platform.entitlement.write'::platform_permission));

-- Platform admins can delete overrides
CREATE POLICY "Platform admins can delete entitlement overrides"
    ON public.tenant_entitlement_override
    FOR DELETE
    TO authenticated
    USING (private.platform_authorize('platform.entitlement.delete'::platform_permission));

-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

GRANT ALL ON public.temp_access_grant TO anon;
GRANT ALL ON public.temp_access_grant TO authenticated;
GRANT ALL ON public.temp_access_grant TO service_role;

GRANT ALL ON public.tenant_entitlement_override TO anon;
GRANT ALL ON public.tenant_entitlement_override TO authenticated;
GRANT ALL ON public.tenant_entitlement_override TO service_role;


-- -----------------------------------------------------------------------------
-- Platform Role Permissions Seed
-- -----------------------------------------------------------------------------
-- What `platform_admin` may do. The table is declared in 12-rbac.sql; each
-- domain seeds its own permissions, so the SSO grant lives in 65-sso.sql.
--
-- Unlike public.role_permissions, this table is NOT generated from
-- permission-seed.json — it is hand-maintained, so a new platform permission
-- has to be added here as well as to the platform_permission enum in
-- 01-types.sql. Without a row here the enum value exists but grants nothing:
-- private.platform_authorize looks the pair up in this table.
--
-- The changelog, alert_agent, and dora enum values are deliberately absent;
-- 01-types.sql records why they are retained but ungranted.
INSERT INTO public.platform_role_permissions (role, permission) VALUES
    ('platform_admin', 'platform.org.read'),
    ('platform_admin', 'platform.org.delete'),
    ('platform_admin', 'platform.user.read'),
    ('platform_admin', 'platform.user.delete'),
    ('platform_admin', 'platform.temp_access.grant'),
    ('platform_admin', 'platform.flag.manage'),
    ('platform_admin', 'platform.audit.read'),
    ('platform_admin', 'platform.entitlement.read'),
    ('platform_admin', 'platform.entitlement.write'),
    ('platform_admin', 'platform.entitlement.delete'),
    ('platform_admin', 'platform.environment.read'),
    ('platform_admin', 'platform.sso_config.read')
ON CONFLICT DO NOTHING;
