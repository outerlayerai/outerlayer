-- =============================================================================
-- SSO (Single Sign-On) Schema
-- =============================================================================
-- Purpose: Enterprise SSO configuration, identity mapping, and audit logging
-- Dependencies: 01-types.sql, 10-tenant.sql, 11-profile.sql, 12-rbac.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SSO Configuration Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sso_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    supabase_provider_id UUID,
    metadata_url TEXT,
    entity_id TEXT,
    allowed_domains TEXT[] NOT NULL DEFAULT '{}',
    enforcement_enabled BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT false,
    last_validated_at TIMESTAMPTZ,

    -- Audit columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT sso_config_tenant_unique UNIQUE (tenant_id)
);

COMMENT ON TABLE public.sso_config IS 'Tenant-level SSO configuration for enterprise SAML authentication';
COMMENT ON COLUMN public.sso_config.supabase_provider_id IS 'Supabase Auth SSO provider ID (set after provider creation via Admin API)';
COMMENT ON COLUMN public.sso_config.metadata_url IS 'IdP SAML metadata URL';
COMMENT ON COLUMN public.sso_config.entity_id IS 'IdP entity ID extracted from metadata';
COMMENT ON COLUMN public.sso_config.allowed_domains IS 'Email domains allowed for SSO authentication';
COMMENT ON COLUMN public.sso_config.enforcement_enabled IS 'When true, org members must authenticate via SSO';
COMMENT ON COLUMN public.sso_config.is_active IS 'Whether SSO is operational (separate from enforcement)';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sso_config_domains ON public.sso_config USING GIN (allowed_domains);

-- Update trigger
CREATE TRIGGER on_update_set_updated_columns
BEFORE UPDATE ON public.sso_config
FOR EACH ROW EXECUTE PROCEDURE set_updated_columns();

-- RLS
ALTER TABLE public.sso_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.sso_config
TO service_role USING (((SELECT auth.role()) = 'service_role'))
WITH CHECK (((SELECT auth.role()) = 'service_role'));

CREATE POLICY "Enable read for users with sso_config.read permission"
ON public.sso_config FOR SELECT
USING (( SELECT private.authorize('sso_config.read')) AND public.tenant_id() = tenant_id);

CREATE POLICY "Enable insert for users with sso_config.insert permission"
ON public.sso_config FOR INSERT
WITH CHECK (( SELECT private.authorize('sso_config.insert')) AND public.tenant_id() = tenant_id);

CREATE POLICY "Enable update for users with sso_config.update permission"
ON public.sso_config FOR UPDATE
USING (( SELECT private.authorize('sso_config.update')) AND public.tenant_id() = tenant_id)
WITH CHECK (( SELECT private.authorize('sso_config.update')) AND public.tenant_id() = tenant_id);

CREATE POLICY "Enable delete for users with sso_config.delete permission"
ON public.sso_config FOR DELETE
USING (( SELECT private.authorize('sso_config.delete')) AND public.tenant_id() = tenant_id);

CREATE POLICY "Platform admins can read sso config"
  ON public.sso_config FOR SELECT
  USING (private.platform_authorize('platform.sso_config.read'));

-- -----------------------------------------------------------------------------
-- SSO Identity Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sso_identity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    sso_config_id UUID NOT NULL REFERENCES public.sso_config(id) ON DELETE CASCADE,
    external_subject_id TEXT NOT NULL,
    idp_issuer TEXT,
    first_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT sso_identity_tenant_user_unique UNIQUE (tenant_id, user_id),
    CONSTRAINT sso_identity_config_subject_unique UNIQUE (sso_config_id, external_subject_id)
);

COMMENT ON TABLE public.sso_identity IS 'Maps external IdP user identities to internal user accounts for SSO';
COMMENT ON COLUMN public.sso_identity.external_subject_id IS 'Subject ID from IdP (SAML NameID)';
COMMENT ON COLUMN public.sso_identity.idp_issuer IS 'IdP entity ID / issuer URL';

-- Indexes
-- Backs the ON DELETE CASCADE user_id foreign key. sso_identity_tenant_user_unique
-- leads with tenant_id and so cannot serve a cascade keyed on user_id alone.
CREATE INDEX IF NOT EXISTS idx_sso_identity_user_id ON public.sso_identity(user_id);

-- RLS
ALTER TABLE public.sso_identity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.sso_identity
TO service_role USING (((SELECT auth.role()) = 'service_role'))
WITH CHECK (((SELECT auth.role()) = 'service_role'));

CREATE POLICY "Enable read for users with sso_config.read permission"
ON public.sso_identity FOR SELECT
USING (( SELECT private.authorize('sso_config.read')) AND public.tenant_id() = tenant_id);

CREATE POLICY "Platform admins can read sso identities"
ON public.sso_identity FOR SELECT
USING (private.platform_authorize('platform.sso_config.read'));

-- -----------------------------------------------------------------------------
-- SSO Audit Log Table (Immutable)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sso_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    sso_config_id UUID NOT NULL REFERENCES public.sso_config(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    email TEXT,
    error_message TEXT,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.sso_audit_log IS 'Immutable audit log of SSO authentication and configuration events';
COMMENT ON COLUMN public.sso_audit_log.event_type IS 'Event types: login_success, login_failure, config_updated, enforcement_changed';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sso_audit_log_tenant_created ON public.sso_audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sso_audit_log_config ON public.sso_audit_log(sso_config_id);
-- Backs the user_id foreign key (ON DELETE SET NULL).
CREATE INDEX IF NOT EXISTS idx_sso_audit_log_user_id ON public.sso_audit_log(user_id);

-- RLS
ALTER TABLE public.sso_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.sso_audit_log
TO service_role USING (((SELECT auth.role()) = 'service_role'))
WITH CHECK (((SELECT auth.role()) = 'service_role'));

CREATE POLICY "Enable read for users with sso_config.read permission"
ON public.sso_audit_log FOR SELECT
USING (( SELECT private.authorize('sso_config.read')) AND public.tenant_id() = tenant_id);

CREATE POLICY "Platform admins can read sso audit logs"
ON public.sso_audit_log FOR SELECT
USING (private.platform_authorize('platform.sso_config.read'));

-- -----------------------------------------------------------------------------
-- Role Permissions for SSO
-- -----------------------------------------------------------------------------

-- sso_config.* role_permissions grants are seeded from the generated block in
-- 12-rbac.sql (source: packages/db-types/permission-seed.json). The platform
-- SSO permission below is a separate table (platform_role_permissions).

-- Grant platform SSO permission to platform admins
INSERT INTO public.platform_role_permissions (role, permission) VALUES
    ('platform_admin', 'platform.sso_config.read')
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

GRANT ALL ON public.sso_config TO anon;
GRANT ALL ON public.sso_config TO authenticated;
GRANT ALL ON public.sso_config TO service_role;

GRANT ALL ON public.sso_identity TO anon;
GRANT ALL ON public.sso_identity TO authenticated;
GRANT ALL ON public.sso_identity TO service_role;

GRANT ALL ON public.sso_audit_log TO anon;
GRANT ALL ON public.sso_audit_log TO authenticated;
GRANT ALL ON public.sso_audit_log TO service_role;

