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
-- Platform Deployment Table (DORA Metrics)
-- -----------------------------------------------------------------------------

-- Tracks our platform's own CI/CD deployments for DORA metrics.
-- This is NOT the user-facing deployment table (public.deployment).
-- Data comes from our CI/CD pipeline (GitHub Actions, etc.).
CREATE TABLE IF NOT EXISTS public.platform_deployment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service TEXT NOT NULL,                      -- Platform service/component (e.g. 'tenant-dashboard', 'gateway', 'docs')
    environment TEXT NOT NULL DEFAULT 'production', -- Deployment target (production, staging, preview)
    status TEXT NOT NULL,                       -- 'success', 'failure', 'running'
    commit_sha TEXT,                            -- Git commit SHA deployed
    commit_message TEXT,                        -- First line of commit message
    branch TEXT,                                -- Git branch deployed from
    failure_reason TEXT,                        -- Reason for failure (null on success)
    duration_ms BIGINT,                         -- Time from start to completion in milliseconds
    triggered_by TEXT,                          -- Who/what triggered (e.g. 'github-actions', 'manual')
    pipeline_url TEXT,                          -- URL to CI/CD pipeline run
    external_id TEXT,                           -- External ID for deduplication (e.g. GitHub Actions run ID)
    pr_number BIGINT,                           -- PR number for lead time calculation
    pr_merged_at TIMESTAMPTZ,                   -- When PR was merged
    first_commit_at TIMESTAMPTZ,                -- Earliest commit on PR branch for true DORA lead time
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- When deployment started
    completed_at TIMESTAMPTZ,                  -- When deployment finished (null if still running)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.platform_deployment IS 'Tracks platform CI/CD deployments for DORA metrics (not user-facing deployments)';
COMMENT ON COLUMN public.platform_deployment.service IS 'Platform service name (e.g. tenant-dashboard, gateway)';
COMMENT ON COLUMN public.platform_deployment.environment IS 'Target environment: production, staging, preview';
COMMENT ON COLUMN public.platform_deployment.duration_ms IS 'Deployment duration from start to completion in milliseconds';

-- Platform deployment indexes
CREATE INDEX IF NOT EXISTS idx_platform_deployment_status ON public.platform_deployment(status);
CREATE INDEX IF NOT EXISTS idx_platform_deployment_started_at ON public.platform_deployment(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_deployment_service_started ON public.platform_deployment(service, started_at DESC);
-- environment='production' is the default filter on every dashboard query;
-- without this index those queries scan started_at and filter in memory.
CREATE INDEX IF NOT EXISTS idx_platform_deployment_env_started ON public.platform_deployment(environment, started_at DESC);
-- Full (not partial) unique index: ON CONFLICT (external_id) upserts cannot
-- target a partial index, and Postgres treats NULLs as distinct in unique
-- indexes so the WHERE external_id IS NOT NULL predicate was never needed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_deployment_external_id ON public.platform_deployment(external_id);

-- RLS: service_role only (platform admin API uses service_role client)
ALTER TABLE public.platform_deployment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.platform_deployment
    USING (( SELECT auth.role() AS role) = 'service_role'::text);

GRANT ALL ON public.platform_deployment TO service_role;

-- -----------------------------------------------------------------------------
-- Platform Incident Table (DORA Metrics - Incident Data)
-- -----------------------------------------------------------------------------

-- Stores normalized incident data from BetterStack for MTTR and CFR.
CREATE TABLE IF NOT EXISTS public.platform_incident (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT NOT NULL,                     -- BetterStack incident ID (unique for dedup)
    source TEXT NOT NULL DEFAULT 'betterstack',    -- Data source identifier
    monitor_name TEXT,                             -- Name of the triggering monitor
    service TEXT,                                  -- Mapped platform service name
    environment TEXT,                              -- Mapped environment (production, staging); NULL = could not infer
    severity TEXT,                                 -- Incident severity
    cause TEXT,                                    -- Incident cause description
    status TEXT NOT NULL,                          -- started, acknowledged, resolved
    url TEXT,                                      -- Monitored endpoint URL
    started_at TIMESTAMPTZ NOT NULL,               -- When incident was detected
    acknowledged_at TIMESTAMPTZ,                   -- When incident was acknowledged
    resolved_at TIMESTAMPTZ,                       -- When incident was resolved
    resolution_ms BIGINT,                          -- resolved_at - started_at in milliseconds
    deployment_id UUID REFERENCES public.platform_deployment(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ
);

COMMENT ON TABLE public.platform_incident IS 'Normalized incident data from monitoring systems for DORA MTTR and CFR';

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_incident_external_id ON public.platform_incident(external_id);
CREATE INDEX IF NOT EXISTS idx_platform_incident_started_at ON public.platform_incident(started_at DESC);
-- environment is filtered on every MTTR/CFR query (the dashboard's env toggle)
CREATE INDEX IF NOT EXISTS idx_platform_incident_env_started ON public.platform_incident(environment, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_incident_service ON public.platform_incident(service);
CREATE INDEX IF NOT EXISTS idx_platform_incident_status ON public.platform_incident(status);
CREATE INDEX IF NOT EXISTS idx_platform_incident_deployment ON public.platform_incident(deployment_id);

ALTER TABLE public.platform_incident ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.platform_incident
    USING (( SELECT auth.role() AS role) = 'service_role'::text);

GRANT ALL ON public.platform_incident TO service_role;

-- -----------------------------------------------------------------------------
-- DORA Collection State (tracks incremental data collection)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.platform_dora_collection_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL,                          -- e.g. 'github_actions', 'betterstack_incidents'
    last_collected_at TIMESTAMPTZ,                 -- Timestamp of latest record collected
    last_run_at TIMESTAMPTZ,                       -- When collection last ran
    last_run_status TEXT NOT NULL DEFAULT 'pending', -- pending, running, success, error
    last_error TEXT,                                -- Error from last failed run
    metadata JSONB NOT NULL DEFAULT '{}',           -- Source-specific state
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ
);

COMMENT ON TABLE public.platform_dora_collection_state IS 'Tracks incremental data collection state for DORA metrics sources';

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_dora_collection_state_source ON public.platform_dora_collection_state(source);

ALTER TABLE public.platform_dora_collection_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.platform_dora_collection_state
    USING (( SELECT auth.role() AS role) = 'service_role'::text);

GRANT ALL ON public.platform_dora_collection_state TO service_role;


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
-- The changelog and alert_agent enum values are deliberately absent; 01-types.sql
-- records why they are retained but ungranted.
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
    ('platform_admin', 'platform.dora.read'),
    ('platform_admin', 'platform.environment.read'),
    ('platform_admin', 'platform.sso_config.read')
ON CONFLICT DO NOTHING;
