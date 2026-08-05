-- =============================================================================
-- API Key Schema
-- =============================================================================
-- Purpose: API key management for tenant applications
-- Dependencies: 10-tenant.sql, 11-profile.sql, 20-app.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- API Key Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.api_key (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    -- NOT NULL is required, not cosmetic. Two RLS policies scope this table
    -- by different columns — the gateway's read policy trusts `tenant_id`, the
    -- dashboard's CRUD policies trust `app_id`. The composite FK in
    -- 97-tenant-app-consistency.sql is what forces those two to agree, and a
    -- composite FK is MATCH SIMPLE: it skips enforcement entirely on any row
    -- where a key column is NULL. A nullable tenant_id here would make the
    -- constraint a no-op on exactly the table that most needs it.
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    api_key_id VARCHAR(255) NOT NULL,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    -- A key is bound EITHER to one concrete environment (environment_id, the
    -- legacy "pin") OR to a set of environment KINDS it may target per request
    -- (allowed_env_kinds), or both (the pin is used when a request names no env;
    -- the kinds gate per-request env selection). environment_id is nullable
    -- again so a purely kind-scoped key needs no concrete env — the request
    -- names the env (or PR) and the gateway authorizes it against
    -- allowed_env_kinds. ON DELETE CASCADE still revokes a pinned key when its
    -- environment is deleted.
    environment_id UUID REFERENCES public.environment(id) ON DELETE CASCADE,

    -- The environment KINDS this key may target when a request selects an env by
    -- name/PR. NULL = legacy pinned key (environment_id only). A subset of
    -- {development, preview, promoted} — mirrors @repo/env-kind's EnvTargetKind.
    -- A preview-only CI key (['preview']) can never write to production: this is
    -- the blast-radius bound that replaces the single-env binding.
    allowed_env_kinds TEXT[]
        CONSTRAINT chk_api_key_allowed_env_kinds
        CHECK (
            allowed_env_kinds IS NULL
            OR allowed_env_kinds <@ ARRAY['development', 'preview', 'promoted']::text[]
        ),

    -- The plaintext key's leading segment (`sk_outerlayer_` + first bytes),
    -- shown in the dashboard so a user can recognize a key without the secret.
    -- The full plaintext is never stored — only its HMAC digest, in the
    -- private.api_key_secret side table (see 23a-api-key-secret.sql).
    key_prefix TEXT,
    -- The gateway permission set granted to this key. Enforced app-side against
    -- GATEWAY_PERMISSIONS; the enum[] column type bounds the RLS UPDATE surface
    -- to real app_permission values.
    permissions public.app_permission[] NOT NULL DEFAULT '{}',
    -- Optional hard expiry. NULL = never expires. verify_api_key gates on
    -- (expires_at IS NULL OR expires_at > now()).
    expires_at TIMESTAMPTZ,
    -- Machine-minted keys (managed-build / deployment SDK keys) carry a row like
    -- any other key. The entitlement count (max_api_keys) filters is_machine=false,
    -- so they never consume a tenant's quota. The dashboard list query does NOT
    -- filter on this column, so a machine key currently DOES appear there —
    -- whether that's correct is an open product question, not settled here.
    is_machine BOOLEAN NOT NULL DEFAULT false,
    -- Developer-seat attribution (057 A6b, actor-scoped keys). When set, agent
    -- sessions ingested with this key are stamped ActorId = this membership id
    -- (a membership UUID, never an email). NULL on shared/app keys — those
    -- ingest as key-scoped actors. SET NULL on membership removal so revoking
    -- a seat never revokes the key, only its attribution.
    actor_membership_id UUID REFERENCES public.membership(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT api_key_api_key_id_key UNIQUE (api_key_id),
    CONSTRAINT uc_api_key UNIQUE (name, app_id),
    -- A key must be usable: pinned to an env, scoped to kinds, or both.
    CONSTRAINT chk_api_key_scope_present
        CHECK (environment_id IS NOT NULL OR allowed_env_kinds IS NOT NULL)
);

COMMENT ON TABLE public.api_key IS 'API keys for tenant applications';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_api_key_tenant ON public.api_key(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_key_app ON public.api_key(app_id);
-- Gateway env resolution reads api_key.environment_id.
CREATE INDEX IF NOT EXISTS idx_api_key_environment ON public.api_key(environment_id);
-- Backs the actor_membership_id foreign key so revoking a membership does not
-- sequentially scan api_key to apply ON DELETE SET NULL.
CREATE INDEX IF NOT EXISTS idx_api_key_actor_membership_id ON public.api_key(actor_membership_id);

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- RLS Policies
-- -----------------------------------------------------------------------------

ALTER TABLE public.api_key ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable api_key delete for users with admin access" ON "public"."api_key" FOR DELETE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.delete'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable api_key insert for users with write or admin access" ON "public"."api_key" FOR INSERT TO "authenticated" WITH CHECK (("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.insert'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable read access for tenant users" ON "public"."api_key" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable api_key update for users with update access" ON "public"."api_key" FOR UPDATE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"))) WITH CHECK (("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.api_key TO anon;
GRANT ALL ON public.api_key TO authenticated;
GRANT ALL ON public.api_key TO service_role;

