-- =============================================================================
-- Git Connection Schema
-- =============================================================================
-- Purpose: Git provider integration (GitHub, GitLab, etc.)
-- Dependencies: 20-app.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Git Connection Table
-- -----------------------------------------------------------------------------

-- Git provider connection configuration per app
-- Supports multiple providers (GitHub, GitLab)
CREATE TABLE IF NOT EXISTS public.git_connection (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid() UNIQUE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,

    -- Provider support
    provider TEXT NOT NULL DEFAULT 'github',

    -- Repository info
    repository TEXT,
    installation_id INT,

    -- Webhook configuration
    webhook_id TEXT,
    webhook_secret TEXT,

    -- Per-app toggle for posting the agent-sessions summary comment on PRs.
    -- OPT-IN: defaults OFF, and that is a made product decision, not an
    -- omission. The comment carries dollar amounts and is world-readable on
    -- a public repo, and this column governs every ALREADY-CONNECTED repo at
    -- migration time — defaulting on would have put a bot comment nobody
    -- asked for on the first PR opened after deploy, across every existing
    -- connection. Turning it on is one toggle in app settings (see
    -- `app-id.tsx`), which is the right amount of friction for a write into
    -- someone else's repository.
    pr_comments_enabled BOOLEAN NOT NULL DEFAULT false,

    -- Audit columns
    created_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT uc_git_connection UNIQUE (app_id, tenant_id),
    CONSTRAINT chk_git_provider CHECK (provider IN ('github', 'gitlab')),

    -- A GitHub App installation belongs to exactly one GitHub account, so
    -- exactly one tenant may claim it — but an installation covers the whole
    -- account/org, so any number of that tenant's apps may share it (one app
    -- per repo). The signed state on the install callback covers the app and
    -- tenant but not the installation id, so this constraint is what stops a
    -- foreign tenant claiming someone else's installation; a cross-tenant
    -- claim raises 23P01.
    CONSTRAINT excl_git_connection_installation_one_tenant
        EXCLUDE USING gist (installation_id WITH =, tenant_id WITH <>)
        WHERE (installation_id IS NOT NULL)
);

COMMENT ON TABLE public.git_connection IS 'Stores Git repository connections for apps (GitHub, GitLab)';
COMMENT ON COLUMN public.git_connection.provider IS 'Git hosting provider: github or gitlab';
COMMENT ON COLUMN public.git_connection.installation_id IS 'GitHub App installation ID';

COMMENT ON COLUMN public.git_connection.webhook_id IS 'Provider-specific webhook identifier for cleanup on disconnect';
COMMENT ON COLUMN public.git_connection.webhook_secret IS 'Per-app webhook secret for signature verification (encrypted)';
COMMENT ON COLUMN public.git_connection.pr_comments_enabled IS 'Gates whether PR session-summary comments are posted for this app; opt-in, defaults OFF';

-- -----------------------------------------------------------------------------
-- Git Branch Table
-- -----------------------------------------------------------------------------

-- Branch tracking per app for git-based deployments
CREATE TABLE IF NOT EXISTS public.git_branch (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    app_id UUID NOT NULL,
    branch_name TEXT,
    repo TEXT,

    -- Audit columns
    created_at TIMESTAMPTZ DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ,
    updated_by UUID,

    -- Constraints with database-matching names
    CONSTRAINT github_branch_pkey PRIMARY KEY (id),
    CONSTRAINT unique_git_repo_branch_constraint UNIQUE (repo, branch_name, tenant_id),
    CONSTRAINT github_branch_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    CONSTRAINT github_branch_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.app(id) ON DELETE CASCADE,
    CONSTRAINT git_branch_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profile(id) ON DELETE SET NULL,
    CONSTRAINT git_branch_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profile(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.git_branch IS 'Git branch tracking per application';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_git_connection_tenant ON public.git_connection(tenant_id);
CREATE INDEX IF NOT EXISTS idx_git_connection_provider_tenant ON public.git_connection(provider, tenant_id);
CREATE INDEX IF NOT EXISTS idx_git_branch_tenant ON public.git_branch(tenant_id);
CREATE INDEX IF NOT EXISTS idx_git_branch_app ON public.git_branch(app_id);

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Row Level Security - Git Connection
-- -----------------------------------------------------------------------------

ALTER TABLE public.git_connection ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable policy delete for users" ON "public"."git_connection" FOR DELETE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.delete'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable policy insert for users" ON "public"."git_connection" FOR INSERT TO "authenticated" WITH CHECK (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.insert'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable policy update for users" ON "public"."git_connection" FOR UPDATE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable read access for tenant users" ON "public"."git_connection" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Row Level Security - Git Branch
-- -----------------------------------------------------------------------------

ALTER TABLE public.git_branch ENABLE ROW LEVEL SECURITY;

-- All three policies scoped TO authenticated so they don't overlap
-- with the gateway_tenant_*_git_branch policies in 95-gateway-rls.sql.
-- Without the explicit TO clause both policy chains fire for the
-- gateway role and splinter flags multiple_permissive_policies.
-- The per-app permission check uses the dashboard's permission
-- system which the gateway role doesn't participate in, so TO
-- authenticated matches actual behavior.
CREATE POLICY "Enable policy delete for users" ON "public"."git_branch" FOR DELETE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_branch.delete'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable policy insert for users" ON "public"."git_branch" FOR INSERT TO "authenticated" WITH CHECK (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_branch.insert'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable policy update for users" ON "public"."git_branch" FOR UPDATE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_branch.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable read access for tenant users" ON "public"."git_branch" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_branch.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- User Git Identity Table
-- -----------------------------------------------------------------------------

-- User's git provider identity for commit attribution
CREATE TABLE IF NOT EXISTS public.user_git_identity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id UUID NOT NULL REFERENCES public.profile(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    username TEXT NOT NULL,
    email TEXT,
    provider_user_id TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ,
    CONSTRAINT chk_git_identity_provider CHECK (provider IN ('github', 'gitlab')),
    CONSTRAINT uc_provider_username UNIQUE (provider, username),
    CONSTRAINT uc_user_provider UNIQUE (profile_id, provider)
);

COMMENT ON TABLE public.user_git_identity IS 'User git provider identities for commit attribution';

-- -----------------------------------------------------------------------------
-- User Git Identity Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_git_identity_provider_email ON public.user_git_identity(provider, email);
CREATE INDEX IF NOT EXISTS idx_git_identity_tenant ON public.user_git_identity(tenant_id);

-- -----------------------------------------------------------------------------
-- User Git Identity RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.user_git_identity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable delete for own identity" ON "public"."user_git_identity" FOR DELETE USING (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));

CREATE POLICY "Enable insert for own identity" ON "public"."user_git_identity" FOR INSERT WITH CHECK (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));

-- Owner-scoped like the sibling INSERT/UPDATE/DELETE policies: a member may
-- read only their OWN git identity, not every colleague's row. The row holds
-- (app-layer-encrypted) access_token / refresh_token plus email /
-- provider_user_id, so a tenant-wide SELECT let any member read that for the
-- whole org. Machine paths (webhooks, token refresh, deployment) use the
-- service-role client and bypass RLS, so they are unaffected.
CREATE POLICY "Enable read access for tenant users" ON "public"."user_git_identity" FOR SELECT USING (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));

CREATE POLICY "Enable update for own identity" ON "public"."user_git_identity" FOR UPDATE USING (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid")))) WITH CHECK (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));

-- -----------------------------------------------------------------------------
-- User Git Identity Grants
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_git_identity TO authenticated;
GRANT ALL ON public.user_git_identity TO service_role;


-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

-- `webhook_secret` is a provider credential. No authenticated-role code path
-- reads it — the dashboard webhook handler reads it under service_role to
-- verify push signatures. SELECT/INSERT/UPDATE for `authenticated` are
-- column-scoped to exclude it; DELETE has no column granularity, so it stays
-- table-level (RLS still gates which rows). `anon` gets nothing — every policy
-- on this table is `TO authenticated`, so this is a dead grant today, but
-- "nothing on this table without a name" is the point for a credential column
-- specifically, not "GRANT ALL and let RLS carry it" the way most tables here
-- do.
--
-- A column-level REVOKE cannot subtract from a table-level GRANT ALL, so this
-- REVOKEs everything for `authenticated` first and re-grants the safe columns
-- rather than narrowing the existing grant in place.
--
-- FOOTGUN: a column added to this table later is excluded from the
-- `authenticated` grants until someone adds it here deliberately. That is the
-- point for a future credential column, and a trap for an ordinary one — it
-- fails as `permission denied for table git_connection`, which reads like an
-- RLS problem, not a missing column grant. Update this list when the table
-- gains a column any authenticated-role code path needs to read or write.
--
-- FOOTGUN: `Prefer: return=representation` (what a chained `.select()` on an
-- insert/update/upsert sends) implies `RETURNING *`, which needs SELECT on
-- every column the table has — including the one withheld here. A write
-- that would otherwise succeed 403s the instant a call site adds `.select()`
-- to read the row back, even though the columns it names are all granted;
-- the failure looks nothing like a grant problem at the call site. Write
-- with no chained `.select()` (`Prefer: return=minimal`, what every current
-- authenticated-role write against this table already does), or read the
-- row back in a separate query naming only the granted columns.
--
-- The UPDATE list is deliberately narrower than SELECT/INSERT: Postgres
-- checks UPDATE column privilege against the literal SET-list of the SQL
-- statement, including PostgREST's generated `ON CONFLICT (...) DO UPDATE
-- SET` for an upsert — and that check applies even on a call that ends up
-- taking the INSERT branch, since the statement is planned as one query. It
-- does NOT apply to columns a BEFORE trigger assigns on `NEW` (`updated_at`/
-- `updated_by` via `set_updated_columns()`, `tenant_id` via
-- `set_tenant_id()`), because those never appear in the client's SET-list —
-- so they need no UPDATE grant here despite being written on every update.
-- `features/git-connection/service.ts`'s OAuth-callback upsert sends
-- `{app_id, provider, installation_id, repository}`; PostgREST's upsert sets
-- every payload column in `DO UPDATE SET` (including the conflict-target
-- columns), so all four need UPDATE even though `app_id` is unchanged on a
-- re-connect. `webhook_id` is added because `removeGitWebhook`
-- (`services/git/remove-git-files.ts`, git disconnect) plain-UPDATEs it to
-- null as `authenticated`. `repository` is also written by
-- `AppsService.linkRepository`/`unlinkRepository` (`packages/gateway-core`),
-- reachable under `authenticated` when the dashboard forwards the user's own
-- session bearer to the gateway rather than a minted `gateway`-role JWT — do
-- not assume gateway-core code is gateway-role-only.
--
-- `supabase db diff --local` against this schema and its migration reports
-- zero drift. If a future edit near this block ever makes it emit a
-- table-level `grant select/insert/update ... to anon, authenticated`, do not
-- paste that generated statement in — it would silently restore the broader
-- grant on the credential columns — and note that CI's "Verify zero schema
-- drift" job (`.github/workflows/ci.yml`) fails the build on any
-- such drift line, so a spurious grant here is a build failure to fix at the
-- source, not a diff to launder through.
REVOKE ALL ON public.git_connection FROM anon;
REVOKE ALL ON public.git_connection FROM authenticated;
GRANT SELECT (
    id, tenant_id, app_id, provider, pr_comments_enabled, repository,
    installation_id, webhook_id, created_at, created_by, updated_at, updated_by
), INSERT (
    id, tenant_id, app_id, provider, pr_comments_enabled, repository,
    installation_id, webhook_id, created_at, created_by, updated_at, updated_by
), UPDATE (
    app_id, provider, pr_comments_enabled, installation_id, repository, webhook_id
) ON public.git_connection TO authenticated;
GRANT DELETE ON public.git_connection TO authenticated;
GRANT ALL ON public.git_connection TO service_role;

GRANT ALL ON public.git_branch TO anon;
GRANT ALL ON public.git_branch TO authenticated;
GRANT ALL ON public.git_branch TO service_role;

