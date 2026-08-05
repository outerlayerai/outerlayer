-- =============================================================================
-- App Member Role Schema
-- =============================================================================
-- Purpose: Per-app role assignments for granular access control
-- Dependencies: 01-types.sql, 02-functions-core.sql, 10-tenant.sql, 11-profile.sql, 12-rbac.sql, 20-app.sql, 29-custom-role.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- App Member Role Table
-- -----------------------------------------------------------------------------

-- Per-app role assignment linking a membership to a specific app with a granular role
CREATE TABLE IF NOT EXISTS public.app_member_role (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id UUID NOT NULL REFERENCES public.membership(id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,

    -- Built-in role (read/write/admin) — always set as fallback
    role public.app_role NOT NULL,

    -- Custom role override (app-level custom roles)
    -- When set, app_authorize() uses custom role permissions instead of built-in role.
    -- Falls back to built-in role when NULL (e.g. after custom role deletion via ON DELETE SET NULL).
    custom_role_id UUID REFERENCES public.custom_role(id) ON DELETE SET NULL,

    -- Audit columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT uq_app_member_role_membership_app UNIQUE (membership_id, app_id),
    CONSTRAINT chk_app_member_role_valid_role CHECK (role IN ('read'::public.app_role, 'write'::public.app_role, 'admin'::public.app_role))
);

COMMENT ON TABLE public.app_member_role IS 'Per-app role assignments for granular access control within a tenant';
COMMENT ON COLUMN public.app_member_role.role IS 'Per-app built-in role: read, write, or admin (owner/disabled are org-level only). Always set as fallback.';
COMMENT ON COLUMN public.app_member_role.custom_role_id IS 'When set, app_authorize() uses this custom role''s permissions instead of the built-in role. Falls back to built-in role when NULL.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_app_member_role_app ON public.app_member_role(app_id);
CREATE INDEX IF NOT EXISTS idx_app_member_role_tenant_membership ON public.app_member_role(tenant_id, membership_id);
CREATE INDEX IF NOT EXISTS idx_app_member_role_custom_role ON public.app_member_role(custom_role_id) WHERE custom_role_id IS NOT NULL;

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

ALTER TABLE public.app_member_role ENABLE ROW LEVEL SECURITY;

-- Service role: full access
CREATE POLICY "service_role_all" ON "public"."app_member_role" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- Read: tenant members with app_member_role.read permission
CREATE POLICY "Enable app_member_role read for tenant users" ON "public"."app_member_role" FOR SELECT USING ((( SELECT "private"."authorize"('app_member_role.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Insert: admins/owners with app_member_role.insert permission
CREATE POLICY "Enable app_member_role insert for admins" ON "public"."app_member_role" FOR INSERT WITH CHECK ((( SELECT "private"."authorize"('app_member_role.insert'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Update: admins/owners with app_member_role.update permission
CREATE POLICY "Enable app_member_role update for admins" ON "public"."app_member_role" FOR UPDATE USING ((( SELECT "private"."authorize"('app_member_role.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Delete: admins/owners with app_member_role.delete permission
CREATE POLICY "Enable app_member_role delete for admins" ON "public"."app_member_role" FOR DELETE USING ((( SELECT "private"."authorize"('app_member_role.delete'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.app_member_role TO anon;
GRANT ALL ON public.app_member_role TO authenticated;
GRANT ALL ON public.app_member_role TO service_role;

-- app_member_role.* role_permissions grants are seeded from the generated block
-- in 12-rbac.sql (source: packages/db-types/permission-seed.json).
