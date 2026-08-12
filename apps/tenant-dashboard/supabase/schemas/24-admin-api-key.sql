-- =============================================================================
-- Admin API Key Schema
-- =============================================================================
-- Purpose: Org-scoped machine credentials for the dashboard admin REST API
--   (member/role management, SCIM-layerable later). Distinct from
--   public.api_key (23-api-key.sql), which is app-scoped and carries gateway
--   permissions — an admin API key is tenant-scoped and carries the same
--   `app_permission` org-level verbs (membership.*, custom_role.*, ...) a
--   session-authed member holds.
-- Dependencies: 01-types.sql, 10-tenant.sql, 11-profile.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Admin API Key Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_api_key (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- Public, non-secret identifier (`admin_key_` + hex). Safe to log and
    -- join on; the digest that actually verifies the key lives in the
    -- private.admin_api_key_secret side table (24a-admin-api-key-secret.sql).
    admin_api_key_id TEXT NOT NULL,
    -- The plaintext key's leading segment, shown in the dashboard so a user
    -- can recognize a key without its secret. The full plaintext is never
    -- stored.
    key_prefix TEXT,
    -- Org-level permission set this key is granted, drawn from the same
    -- app_permission enum a session-authed member's role resolves to (e.g.
    -- membership.read, custom_role.insert) — never a gateway permission.
    permissions public.app_permission[] NOT NULL DEFAULT '{}',
    -- Optional hard expiry. NULL = never expires.
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    -- Revocation is a timestamp, not row deletion, so a revoked key keeps its
    -- audit trail (created_by, name, grants) visible in the key list.
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    CONSTRAINT admin_api_key_admin_api_key_id_key UNIQUE (admin_api_key_id),
    CONSTRAINT uc_admin_api_key UNIQUE (name, tenant_id)
);

COMMENT ON TABLE public.admin_api_key IS 'Org-scoped machine credentials for the dashboard admin REST API';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_admin_api_key_tenant ON public.admin_api_key(tenant_id);

-- -----------------------------------------------------------------------------
-- RLS Policies
-- -----------------------------------------------------------------------------
-- Modeled on api_key's four verb-scoped policies (23-api-key.sql), tenant-
-- scoped instead of app-scoped since this table has no app_id.

ALTER TABLE public.admin_api_key ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable admin_api_key delete for users with admin access" ON "public"."admin_api_key" FOR DELETE TO "authenticated" USING (( SELECT "private"."authorize"('admin_api_key.delete'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

CREATE POLICY "Enable admin_api_key insert for users with admin access" ON "public"."admin_api_key" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."authorize"('admin_api_key.insert'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

CREATE POLICY "Enable read access for tenant users" ON "public"."admin_api_key" FOR SELECT TO "authenticated" USING (( SELECT "private"."authorize"('admin_api_key.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

CREATE POLICY "Enable admin_api_key update for users with update access" ON "public"."admin_api_key" FOR UPDATE TO "authenticated" USING (( SELECT "private"."authorize"('admin_api_key.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")) WITH CHECK (( SELECT "private"."authorize"('admin_api_key.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.admin_api_key TO authenticated;
GRANT ALL ON public.admin_api_key TO service_role;
