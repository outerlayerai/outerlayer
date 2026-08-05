-- =============================================================================
-- App Schema
-- =============================================================================
-- Purpose: Application entities and LLM API configuration
-- Dependencies: 10-tenant.sql, 11-profile.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- App Table
-- -----------------------------------------------------------------------------

-- Main application entity - represents a project/app within a tenant
CREATE TABLE IF NOT EXISTS public.app (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid() UNIQUE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    name TEXT NOT NULL,

    -- Human-friendly label shown in the UI. `name` is the URL-stable slug
    -- (unique per tenant, used in routes); `display_name` is free-form and
    -- optional. The UI renders `display_name` when set and falls back to
    -- `name`, so this stays nullable with no backfill required.
    display_name TEXT,
    commit_sha TEXT,

    -- Managed deployment configuration.
    -- `entry_point` / `runtime` are the INITIAL DEFAULT for an app, seeded by
    -- the link-repo / webhook handler detection. They are NOT the runtime
    -- authority for what an environment serves: the per-env source of truth
    -- is `deployment.metadata.entry_point` / `deployment.metadata.runtime`
    -- on that env's current deployment. The build orchestrator reads the
    -- deployment row first and falls back to these app columns only when
    -- the deployment row has no entry_point of its own.
    entry_point TEXT,
    runtime TEXT DEFAULT 'nodejs',

    -- Fly Machine state (`fly_app_name`, `fly_machine_id`, `fly_machine_url`)
    -- lives on `public.environment`, not here. The gateway DO is keyed by
    -- (app, env), so each env's Fly state must sit with its env row.

    -- Per-app idempotency marker for the default-env seed. NULL means this app
    -- still needs its default-env seed and key/deployment backfill; NOT NULL
    -- means that has run.
    environment_migration_done_at TIMESTAMPTZ,

    -- App-level publish policy. When true, publishing a prompt/template opens a
    -- pull request against the connected branch instead of committing directly
    -- (combined with branch protection: `require_pull_request OR branch-protected
    -- → PR`). Governed by the dedicated `app_policy.update` permission via the
    -- `enforce_app_policy_permission` trigger — NOT by the table's `app.update`
    -- RLS policy, so connection editors can't silently weaken the review gate.
    require_pull_request BOOLEAN NOT NULL DEFAULT false,

    -- Audit columns
    created_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT unique_name_per_tenant UNIQUE(tenant_id, name),

    -- Redundant against the primary key on its own, and that is the point: a
    -- composite FOREIGN KEY needs a UNIQUE constraint on exactly the columns it
    -- targets. Every child table carrying both `tenant_id` and `app_id` points
    -- at this key so the database — not application code — guarantees the two
    -- agree. See 97-tenant-app-consistency.sql. Do not drop it because it looks
    -- superfluous; 28 constraints depend on it.
    CONSTRAINT app_tenant_id_unique UNIQUE(tenant_id, id),

    CONSTRAINT chk_runtime CHECK (runtime IN ('nodejs', 'python'))
);

COMMENT ON TABLE public.app IS 'Application/project entity within a tenant';
COMMENT ON COLUMN public.app.display_name IS 'Optional human-friendly label shown in the UI. Falls back to name when null. Unlike name it is not URL-stable and not unique.';
COMMENT ON COLUMN public.app.commit_sha IS 'Git commit SHA for version tracking';
COMMENT ON COLUMN public.app.environment_migration_done_at IS 'NULL means this app still needs its default-env seed and key/deployment backfill. NOT NULL means that has run.';
COMMENT ON COLUMN public.app.require_pull_request IS 'When true, prompt/template publishes open a PR against the connected branch instead of committing directly. Toggling it requires the app_policy.update permission (enforced by the enforce_app_policy_permission trigger, not app.update RLS).';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_app_commit_sha ON public.app(commit_sha);

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Row Level Security - App
-- -----------------------------------------------------------------------------

ALTER TABLE public.app ENABLE ROW LEVEL SECURITY;

-- TO authenticated on every policy: splinter flagged `multiple_permissive_policies`
-- once the gateway-role policies were added (see 95-gateway-rls.sql). Scoping
-- these to the authenticated role keeps the dashboard path intact and removes
-- the overlap with `gateway_tenant_{insert,update,delete}_app` for the gateway
-- role. Mirrors the same rescoping done on the Slack surface.
-- These policies authorize against the app's OWN id, not an FK to another app.
-- They keep the boolean app_authorize(perm, id) form rather than the set-based
-- `id IN (SELECT private.authorized_app_ids(perm))` used on child tables. The
-- set enumerates the tenant's EXISTING apps, but INSERT WITH CHECK evaluates a
-- prospective id that does not exist yet, so the set form would deny every app
-- creation; the boolean form resolves a prospective id through the org-level
-- fallback. Read/update/delete stay boolean too so the whole table uses one form.
CREATE POLICY "Enable app delete for users" ON "public"."app" FOR DELETE TO "authenticated" USING (("private"."app_authorize"('app.delete'::"public"."app_permission", "id") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable app read access for users within tenant" ON "public"."app" FOR SELECT TO "authenticated" USING (("private"."app_authorize"('app.read'::"public"."app_permission", "id") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable app update access for users within tenant" ON "public"."app" FOR UPDATE TO "authenticated" USING (("private"."app_authorize"('app.update'::"public"."app_permission", "id") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable app write access for users within tenant" ON "public"."app" FOR INSERT TO "authenticated" WITH CHECK (("private"."app_authorize"('app.insert'::"public"."app_permission", "id") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Realtime - App
-- -----------------------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE public.app;


-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

GRANT ALL ON public.app TO anon;
GRANT ALL ON public.app TO authenticated;
GRANT ALL ON public.app TO service_role;

