-- =============================================================================
-- Environment Schema
-- =============================================================================
-- Purpose: Per-app named pointers ("environments") that decouple "what's
--          running for users" from "what I'm iterating on." Each env carries
--          its own live pointer (current_commit_sha), its own runtime (Fly
--          app), its own API key.
-- Dependencies: 10-tenant.sql, 11-profile.sql, 20-app.sql,
--               01-types.sql (app_permission enum extended with environment.*).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Environment Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.environment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,

    -- Immutable name: 2-40 chars, lowercase alnum + hyphens, must start with
    -- a letter. Rename rejected by trigger.
    name TEXT NOT NULL
        CONSTRAINT chk_environment_name_pattern
        CHECK (name ~ '^[a-z][a-z0-9-]{1,39}$'),

    -- Exactly one default env per app. Default env always at
    -- current_version = 0 (it tracks HEAD live rather than a pin).
    is_default BOOLEAN NOT NULL DEFAULT false,

    -- Frozen. No promote/rollback saga exists to advance this counter, so it
    -- holds whatever value an env last reached. Retained for existing envs.
    -- Stored as BIGINT so the monotonic counter cannot wrap the int32 ceiling
    -- on long-lived envs (Squawk prefer-bigint-over-int).
    current_version BIGINT NOT NULL DEFAULT 0
        CONSTRAINT chk_environment_current_version_nonneg
        CHECK (current_version >= 0),

    -- Denormalized git commit SHA this env is currently pinned to. Advanced by
    -- advanceCommitPointers on link/push/resync (default env), and read by the
    -- gateway environment-resolver for trace/score stamping. NULL until the
    -- first pointer advance. Carried as a real column (not a derived join) so
    -- reads never need a PostgREST embed.
    current_commit_sha TEXT,

    -- Fly app provisioned for this env. NULL during provisioning;
    -- set once the Fly app is created. 1:1 mapping between env and Fly app.
    fly_app_name TEXT,

    -- Retained while legacy rows still name a Fly machine: the platform-admin
    -- overview lists them so an operator can reconcile what remains.
    fly_machine_id  TEXT,

    -- Per-env-instance identity that survives name reuse after delete.
    -- deployment.environment_epoch denormalizes this so the audit trail
    -- distinguishes between two incarnations of the same env name.
    epoch BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,

    -- Ephemeral preview environments. An ephemeral env is
    -- branch-backed: it is auto-created when a pull request opens (if the app
    -- has previews enabled) and torn down when the PR closes/merges, living
    -- next to dev/prod/stg in the switcher. Unlike normal envs (version pins
    -- off the connected branch), it builds from `source_branch` — the PR head.
    is_ephemeral BOOLEAN NOT NULL DEFAULT false,
    -- The PR head branch this ephemeral env builds from (e.g.
    -- `outerlayer/publish/<slug>`). NULL for normal envs.
    source_branch TEXT,
    -- The pull request number this ephemeral env serves. NULL for normal envs.
    -- Drives teardown on PR/MR close (see pull_request).
    source_pr_number BIGINT,

    -- Audit columns (Constitution VIII.A)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Default env always sits at current_version = 0 — it tracks HEAD live
    -- and cannot be a promote target.
    CONSTRAINT environment_default_unpinned
        CHECK (NOT is_default OR current_version = 0),

    -- An ephemeral env is never the default, and always knows its source PR +
    -- branch (both are required to build it and to tear it down on PR close).
    CONSTRAINT environment_ephemeral_not_default
        CHECK (NOT is_ephemeral OR NOT is_default),
    CONSTRAINT environment_ephemeral_has_source
        CHECK (NOT is_ephemeral OR (source_branch IS NOT NULL AND source_pr_number IS NOT NULL)),

    -- Composite-FK target: lets child tables declare
    -- FOREIGN KEY (environment_id, app_id) REFERENCES environment(id, app_id),
    -- correlating an env reference to the SAME app (and therefore tenant).
    CONSTRAINT environment_id_app_unique UNIQUE (id, app_id)
);

COMMENT ON TABLE public.environment IS
  'Per-app named pointer to a content version + runtime. Default env tracks HEAD live (current_version = 0). No env-promotion machinery exists; current_version is retained on existing envs but no longer advances.';
COMMENT ON COLUMN public.environment.name IS
  'Immutable after creation. Pattern: ^[a-z][a-z0-9-]{1,39}$';
COMMENT ON COLUMN public.environment.is_default IS
  'Exactly one default env per app, auto-created with the app, named ''dev''. Cannot be deleted.';
COMMENT ON COLUMN public.environment.current_version IS
  'Frozen. No promote saga exists to advance this. Retained for existing envs; no longer written.';
COMMENT ON COLUMN public.environment.current_commit_sha IS
  'Live pointer — denormalized git commit SHA this env is currently pinned to. Advanced by advanceCommitPointers on link/push/resync (default env), and read by the gateway environment-resolver for trace/score stamping. NULL until the first pointer advance.';
COMMENT ON COLUMN public.environment.fly_app_name IS
  'Names a Fly app a legacy environment claimed. Nothing writes it; retained so an operator can reconcile what remains.';
COMMENT ON COLUMN public.environment.fly_machine_id IS
  'Fly Machine ID for the env''s current runtime. Used for platform-admin deep-links to fly.io.';
COMMENT ON COLUMN public.environment.epoch IS
  'Per-env-instance identity. Denormalized onto deployment saga rows so the audit trail distinguishes recreated envs.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Names unique per app
CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_app_name_unique
    ON public.environment(app_id, name);

-- Exactly one default env per app
CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_one_default_per_app
    ON public.environment(app_id) WHERE is_default = true;

-- Fly app names unique per tenant (Fly app names are globally unique within an org,
-- but tenant scoping matches the rest of the codebase's posture).
CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_fly_app_name_unique
    ON public.environment(tenant_id, fly_app_name) WHERE fly_app_name IS NOT NULL;

-- Lookup by app (env list views, app-create default-env auto-create)
CREATE INDEX IF NOT EXISTS idx_environment_tenant ON public.environment(tenant_id);

-- -----------------------------------------------------------------------------
-- Triggers: name immutability + default-env delete guard
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.environment_enforce_invariants()
RETURNS TRIGGER AS $$
BEGIN
  -- Name is immutable post-creation
  IF TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name THEN
    RAISE EXCEPTION 'environment.name is immutable';
  END IF;

  -- Default env cannot be deleted DIRECTLY. pg_trigger_depth() = 1
  -- means a top-level DELETE on `environment`; depth >= 2 means a CASCADE from
  -- a parent (app -> environment, tenant -> app -> environment), which must be
  -- allowed per data-model.md FK cascade table.
  IF TG_OP = 'DELETE'
     AND OLD.is_default = true
     AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'default environment cannot be deleted';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql
   SET search_path TO 'public';

CREATE OR REPLACE TRIGGER trg_environment_enforce_invariants
    BEFORE UPDATE OR DELETE ON public.environment
    FOR EACH ROW EXECUTE FUNCTION public.environment_enforce_invariants();

-- Note: on_update_environment_set_updated_columns trigger lives in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Default-env auto-seed (invariant enforcement)
-- -----------------------------------------------------------------------------

-- Every app has exactly one default environment, named `dev`, in the no-pin
-- state (current_version = 0). An app with zero environments is broken:
-- settings → Environment Variables cannot resolve any env to write against.
--
-- Enforcing the invariant in a trigger makes it true for EVERY create path
-- (gateway POST /v1/apps, seed.sql, raw SQL, any future path) atomically
-- within the app-insert transaction: an env-less app can never exist.
--
-- SECURITY DEFINER: the seed must succeed regardless of the creating role's RLS
-- posture on `environment`. The inserted row is
-- fully derived from the NEW app row — no user-controlled shape — and the
-- search_path is pinned, so this is not a privilege-escalation vector.
--
-- ON CONFLICT (app_id, name) DO NOTHING keeps it idempotent: a path that also
-- seeds `dev` explicitly (the deprecated action) cannot collide. The trigger
-- declaration lives in 99-triggers.sql alongside the other `ON public.app`
-- triggers.
CREATE OR REPLACE FUNCTION public.app_seed_default_env()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.environment (
    tenant_id, app_id, name, is_default, current_version, created_by
  ) VALUES (
    NEW.tenant_id, NEW.id, 'dev', true, 0, NEW.created_by
  )
  ON CONFLICT (app_id, name) DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.app_seed_default_env() IS
  'AFTER INSERT ON app: seeds the mandatory default ''dev'' environment (no-pin) so every app has exactly one default env regardless of create path. Idempotent via ON CONFLICT (app_id, name).';

-- -----------------------------------------------------------------------------
-- RLS Policies (Constitution VIII.E — permission-based)
-- -----------------------------------------------------------------------------

ALTER TABLE public.environment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for environment" ON public.environment FOR SELECT
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('environment.read'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

CREATE POLICY "Enable insert for environment" ON public.environment FOR INSERT
  TO authenticated
  WITH CHECK ((app_id IN ( SELECT private.authorized_app_ids('environment.insert'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

CREATE POLICY "Enable update for environment" ON public.environment FOR UPDATE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('environment.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

CREATE POLICY "Enable delete for environment" ON public.environment FOR DELETE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('environment.delete'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- Platform admins can read env state across tenants — read-only; mutations
-- flow through temp_access_grant.
CREATE POLICY "Platform admins can read environment" ON public.environment FOR SELECT
  TO authenticated
  USING (private.platform_authorize('platform.environment.read'::public.platform_permission));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.environment TO anon;
GRANT ALL ON public.environment TO authenticated;
GRANT ALL ON public.environment TO service_role;
