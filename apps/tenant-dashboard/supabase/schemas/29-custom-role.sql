-- =============================================================================
-- Custom Role Schema
-- =============================================================================
-- Purpose: Custom permission roles for granular tenant-level access control
-- Dependencies: 01-types.sql, 10-tenant.sql, 11-profile.sql, 02-functions-core.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Custom Role Table
-- -----------------------------------------------------------------------------

-- Tenant-scoped custom roles with cherry-picked permissions
CREATE TABLE IF NOT EXISTS public.custom_role (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) <= 100),
    description TEXT CHECK (char_length(description) <= 500),

    -- Audit columns (Constitution VIII.A)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL
);

-- Case-insensitive name uniqueness per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_role_tenant_name
    ON public.custom_role (tenant_id, lower(name));

COMMENT ON TABLE public.custom_role IS 'Custom permission roles with cherry-picked permissions per tenant';
COMMENT ON COLUMN public.custom_role.name IS 'Display name, unique per tenant (case-insensitive)';

-- Note: Triggers (set_tenant_id, set_updated_columns) are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Membership custom_role_id column (deferred from 12-rbac.sql — custom_role
-- must exist before the FK can reference it)
-- -----------------------------------------------------------------------------

ALTER TABLE public.membership
    ADD COLUMN IF NOT EXISTS custom_role_id UUID REFERENCES public.custom_role(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.membership.custom_role_id IS 'When set, member uses this custom role instead of the built-in role for authorization';

CREATE INDEX IF NOT EXISTS idx_membership_custom_role_id ON public.membership(custom_role_id) WHERE custom_role_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Custom Role Permission Table
-- -----------------------------------------------------------------------------

-- Maps custom roles to cherry-picked app_permission values
CREATE TABLE IF NOT EXISTS public.custom_role_permission (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    custom_role_id UUID NOT NULL REFERENCES public.custom_role(id) ON DELETE CASCADE,
    permission public.app_permission NOT NULL,

    CONSTRAINT custom_role_permission_unique UNIQUE (custom_role_id, permission)
);


COMMENT ON TABLE public.custom_role_permission IS 'Maps custom roles to cherry-picked app_permission values';

-- -----------------------------------------------------------------------------
-- Custom Role RLS Policies
-- -----------------------------------------------------------------------------

ALTER TABLE public.custom_role ENABLE ROW LEVEL SECURITY;

-- Service role: full access
CREATE POLICY "service_role_all" ON "public"."custom_role"
    TO service_role
    USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"))
    WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- SELECT: users with custom_role.read permission in their tenant
CREATE POLICY "Enable custom_role read for tenant users" ON "public"."custom_role"
    FOR SELECT
    USING ((( SELECT "private"."authorize"('custom_role.read'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- INSERT: users with custom_role.insert permission
CREATE POLICY "Enable custom_role insert for admins" ON "public"."custom_role"
    FOR INSERT
    WITH CHECK ((( SELECT "private"."authorize"('custom_role.insert'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- UPDATE: users with custom_role.update permission
CREATE POLICY "Enable custom_role update for admins" ON "public"."custom_role"
    FOR UPDATE
    USING ((( SELECT "private"."authorize"('custom_role.update'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- DELETE: users with custom_role.delete permission
CREATE POLICY "Enable custom_role delete for admins" ON "public"."custom_role"
    FOR DELETE
    USING ((( SELECT "private"."authorize"('custom_role.delete'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Custom Role Permission RLS Policies
-- -----------------------------------------------------------------------------

ALTER TABLE public.custom_role_permission ENABLE ROW LEVEL SECURITY;

-- Service role: full access
CREATE POLICY "service_role_all" ON "public"."custom_role_permission"
    TO service_role
    USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"))
    WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- SELECT: follows parent custom_role visibility
CREATE POLICY "Enable custom_role_permission read for tenant users" ON "public"."custom_role_permission"
    FOR SELECT
    USING ((EXISTS (
        SELECT 1 FROM "public"."custom_role" "cr"
        WHERE "cr"."id" = "custom_role_id"
            AND "cr"."tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")
            AND ( SELECT "private"."authorize"('custom_role.read'::"public"."app_permission"))
    )));

-- INSERT: users with custom_role.insert permission on parent role's tenant
CREATE POLICY "Enable custom_role_permission insert for admins" ON "public"."custom_role_permission"
    FOR INSERT
    WITH CHECK ((EXISTS (
        SELECT 1 FROM "public"."custom_role" "cr"
        WHERE "cr"."id" = "custom_role_id"
            AND "cr"."tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")
            AND ( SELECT "private"."authorize"('custom_role.insert'::"public"."app_permission"))
    )));

-- DELETE: users with custom_role.delete permission on parent role's tenant
CREATE POLICY "Enable custom_role_permission delete for admins" ON "public"."custom_role_permission"
    FOR DELETE
    USING ((EXISTS (
        SELECT 1 FROM "public"."custom_role" "cr"
        WHERE "cr"."id" = "custom_role_id"
            AND "cr"."tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")
            AND ( SELECT "private"."authorize"('custom_role.delete'::"public"."app_permission"))
    )));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_role TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_role TO service_role;

GRANT SELECT, INSERT, DELETE ON public.custom_role_permission TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_role_permission TO service_role;

-- custom_role.* role_permissions grants are seeded from the generated block in
-- 12-rbac.sql (source: packages/db-types/permission-seed.json).
