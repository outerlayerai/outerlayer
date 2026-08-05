-- =============================================================================
-- Environment Variables Schema
-- =============================================================================
-- Purpose: Encrypted environment variables for managed code deployments
-- Dependencies: 10-tenant.sql, 11-profile.sql, 20-app.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Env Var Table
-- -----------------------------------------------------------------------------

-- Stores encrypted environment variables per app for managed deployments.
-- Actual secret values live in Supabase Vault; this table holds metadata + vault references.
CREATE TABLE IF NOT EXISTS public.env_var (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id uuid NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    key text NOT NULL,
    vault_secret_id uuid NOT NULL,

    -- A row targets EITHER a specific environment (environment_id set) OR a set
    -- of environment kinds (target_kind set) — exactly one, enforced by
    -- chk_env_var_scope_exactly_one below. The kind layer is what
    -- lets an ephemeral preview env inherit vars it was never individually
    -- configured with (a fresh preview env has zero specific-env rows); the
    -- specific-env layer is the override that wins over any kind match
    -- (precedence resolved in EnvVarService via @repo/env-kind resolveEnvVarRows).
    -- Deleting an environment cascades to its specific-env rows only.
    environment_id uuid REFERENCES public.environment(id) ON DELETE CASCADE,

    -- Kind target: 'all' (every kind) | 'development' (the default env) |
    -- 'preview' (every ephemeral PR env) | 'promoted' (every pinned env). NULL
    -- on a specific-environment row. Mirrors @repo/env-kind's EnvVarTargetKind.
    -- NULL passes the CHECK (NULL IN (...) yields NULL, not FALSE).
    target_kind text
        CONSTRAINT chk_env_var_target_kind
        CHECK (target_kind IN ('all', 'development', 'preview', 'promoted')),

    -- Audit columns
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at timestamptz,
    updated_by uuid REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    -- One specific-env row per (app, key, environment). environment_id is again
    -- nullable (kind rows leave it NULL), and NULLs are distinct under a plain
    -- UNIQUE — so this still governs specific-env rows while leaving kind rows
    -- (env NULL) to the partial unique index below. Constraint name kept stable
    -- so integration tests referencing it by name continue to work.
    CONSTRAINT env_var_app_key_env_unique
        UNIQUE (app_id, key, environment_id),

    -- Exactly one targeting axis: a specific environment OR a kind, never both,
    -- never neither.
    CONSTRAINT chk_env_var_scope_exactly_one
        CHECK ((environment_id IS NULL) <> (target_kind IS NULL))
);

COMMENT ON TABLE public.env_var IS 'Encrypted environment variables for managed code deployments';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_env_var_tenant ON public.env_var(tenant_id);
-- Env-var resolution is a direct env-scoped lookup per (app_id, key, environment_id).
CREATE INDEX IF NOT EXISTS idx_env_var_environment ON public.env_var(environment_id);
-- Kind-targeted rows: one row per (app, key, target_kind). Partial so it only
-- covers kind rows; specific-env rows (target_kind NULL) are governed by the
-- env_var_app_key_env_unique constraint above.
CREATE UNIQUE INDEX IF NOT EXISTS env_var_app_key_kind_unique
    ON public.env_var (app_id, key, target_kind)
    WHERE target_kind IS NOT NULL;

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- RLS Policies
-- -----------------------------------------------------------------------------

ALTER TABLE public.env_var ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable env_var read access for users" ON "public"."env_var" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('env_var.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable env_var insert for users" ON "public"."env_var" FOR INSERT TO "authenticated" WITH CHECK (("app_id" IN ( SELECT "private"."authorized_app_ids"('env_var.insert'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable env_var update for users" ON "public"."env_var" FOR UPDATE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('env_var.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable env_var delete for users" ON "public"."env_var" FOR DELETE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('env_var.delete'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Service role: full access
CREATE POLICY "service_role_all" ON "public"."env_var" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.env_var TO anon;
GRANT ALL ON public.env_var TO authenticated;
GRANT ALL ON public.env_var TO service_role;

-- -----------------------------------------------------------------------------
-- Realtime
-- -----------------------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE public.env_var;
