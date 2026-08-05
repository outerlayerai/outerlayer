-- =============================================================================
-- Tenant Schema
-- =============================================================================
-- Purpose: Organization/tenant management - the root entity for multi-tenancy
-- Dependencies: 00-extensions.sql, 01-types.sql, 02-functions-core.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenant Table
-- -----------------------------------------------------------------------------

-- Root entity for multi-tenant architecture
-- All tenant-scoped data references this table via tenant_id foreign key
CREATE TABLE IF NOT EXISTS public.tenant (
    tenant_id UUID PRIMARY KEY DEFAULT gen_random_uuid() UNIQUE,
    organization_name VARCHAR(255) NOT NULL UNIQUE,
    company_name VARCHAR(255) NOT NULL,

    -- Audit columns (per Constitution VIII.A)
    created_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ,
    updated_by UUID,

    -- Set once atomically on the tenant's first successful trace ingest.
    -- Guards org_first_trace against false positives from billing-period resets.
    first_trace_at TIMESTAMPTZ,

    -- Agent-session capture ceiling (057 A6b). The sync endpoint clamps every
    -- ingested session to the LOWER of this and the client-declared tier
    -- (effectiveTier) — the server never stores more than the tenant allows,
    -- whatever the client sends. Tiers: metrics ⊂ redacted ⊂ full.
    agent_capture_tier TEXT NOT NULL DEFAULT 'full'
        CONSTRAINT chk_tenant_agent_capture_tier
        CHECK (agent_capture_tier IN ('metrics', 'redacted', 'full'))
);

COMMENT ON TABLE public.tenant IS 'Root entity for multi-tenant architecture. All tenant-scoped data references this table.';
COMMENT ON COLUMN public.tenant.organization_name IS 'URL-safe unique identifier for the organization';
COMMENT ON COLUMN public.tenant.company_name IS 'Human-readable company/organization name';

-- -----------------------------------------------------------------------------
-- Delete rule for tenant references
-- -----------------------------------------------------------------------------
-- Every FK that references public.tenant carries ON DELETE CASCADE. There are
-- no exceptions, and a new one must not be introduced: a mixed set is not a
-- weaker guarantee, it is a nondeterministic one.
--
-- Deleting a tenant fires one RI trigger per referencing constraint, and those
-- fire in trigger-name order -- which follows constraint creation order, not
-- dependency order. A NO ACTION constraint on any tenant-scoped table is
-- therefore a race against the CASCADE that would have emptied it. Consider a
-- table that cascades from `app` while its own tenant FK is NO ACTION: if the
-- cascade through `app` happens to run first the rows are already gone and the
-- check passes; if the check runs first it sees live rows and aborts the whole
-- delete with "still referenced from table ...". Neither order is guaranteed,
-- and it shifts whenever a constraint is dropped and recreated -- so the same
-- delete can pass in one environment and fail in another off nothing but
-- migration history.
--
-- Uniform CASCADE removes the ordering dependency: whichever trigger fires
-- first, the child row is deleted and the others find nothing.
--
-- The guard against an accidental tenant delete is authorization, not
-- referential integrity -- platform_admin_delete_tenant is the only path and it
-- is gated on the platform.org.delete permission. A NO ACTION constraint never
-- provided that guard; it only made deletion fail loudly some of the time.

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Note: Primary key creates implicit index on tenant_id
CREATE UNIQUE INDEX IF NOT EXISTS tenant_organization_name_unique_lower ON public.tenant(lower(organization_name));

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

ALTER TABLE public.tenant ENABLE ROW LEVEL SECURITY;

-- Note: The "Users can read tenant" and "Enable tenant admin to update tenant" policies
-- are defined in 12-rbac.sql because they depend on the membership table.


-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

GRANT ALL ON public.tenant TO anon;
GRANT ALL ON public.tenant TO authenticated;
GRANT ALL ON public.tenant TO service_role;

