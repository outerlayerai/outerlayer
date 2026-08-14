-- =============================================================================
-- Gateway Role + RLS
-- =============================================================================
-- Purpose: Dedicated Postgres role for gateway (machine-to-machine) DB access.
--
-- Design:
--   - The gateway mints JWTs with `role: 'gateway'`. PostgREST does SET ROLE
--     gateway for the duration of each request. Tenant isolation is enforced
--     at the DB via simple tenant_id policies below.
--   - API-level permissions (`gateway_permissions` claim) are checked at the
--     Hono middleware layer BEFORE any DB call. Re-encoding that check in RLS
--     creates a permission translation layer we don't want to maintain.
--   - Dashboard users (role: 'authenticated') are unaffected; their policies
--     continue to route through app_authorize()/authorize().
--
-- Dependencies: 20-app.sql, 22-git-connection.sql, 30-billing.sql,
--               40-platform-admin.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Role creation
-- -----------------------------------------------------------------------------

-- NOLOGIN: never connects directly. PostgREST switches into it via SET ROLE.
-- No BYPASSRLS: the tenant-isolation RLS below is what keeps this role scoped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway') THEN
    CREATE ROLE gateway NOLOGIN;
  END IF;
END $$;

-- Authenticator must be a member of `gateway` for PostgREST to SET ROLE into it
GRANT gateway TO authenticator;

-- Schema usage (mirrors authenticated)
GRANT USAGE ON SCHEMA public TO gateway;

-- The gateway's tenant-isolation policies call public.tenant_id(), which
-- references private.resolve_member_tenant. Postgres resolves that reference at
-- plan time regardless of which CASE arm runs, so the role needs schema USAGE +
-- EXECUTE even though the gateway never reaches an arm that calls it: tenant_id()
-- routes through the validator only for `authenticated`, and the gateway role
-- keeps the raw claim (its system-user `sub` has no membership row, so validating
-- would resolve every gateway request to NULL). Granting it is safe regardless —
-- the helper resolves a value only to a tenant the caller (auth.uid()) is an
-- active member of.
GRANT USAGE ON SCHEMA private TO gateway;
GRANT EXECUTE ON FUNCTION private.resolve_member_tenant(text) TO gateway;

-- -----------------------------------------------------------------------------
-- Table grants (least privilege — column-level where sensitive columns exist)
-- -----------------------------------------------------------------------------
-- Gateway accesses these tables via createTenantScopedClient. The allowlist
-- lives in apps/gateway/eslint.config.mjs; non-allowlisted handlers MUST route
-- all DB calls through the scoped client, which lands in this role.
--
-- Reads: straightforward tenant-scoped SELECTs.
-- Writes: limit+override tables are read-only quota lookups.

GRANT SELECT ON public.app                          TO gateway;
GRANT SELECT ON public.git_branch                   TO gateway;
GRANT SELECT ON public.billing                      TO gateway;
GRANT SELECT ON public.tenant_entitlement_override  TO gateway;

-- Cloud workers: the public /v1/workers surface launches runs
-- (INSERT), records provisioning/failure transitions (UPDATE), and reads run
-- + session state. worker_run_event stays dashboard/service-role only — the
-- API returns the deep link for transcripts, not the event stream.
GRANT SELECT, INSERT, UPDATE ON public.worker_run          TO gateway;
GRANT SELECT, INSERT, UPDATE ON public.worker_workspace    TO gateway;

-- Artifacts: /v1/artifacts ingests exhibit records (INSERT) and re-reads the
-- stored row to answer idempotent retries (SELECT). No UPDATE: a retried
-- ingest inserts with ON CONFLICT DO NOTHING, and the sweeps that mutate
-- rows (verification aging, blob_deleted stamping) run under service_role.
GRANT SELECT, INSERT ON public.artifact                    TO gateway;
-- Emitted results: /v1/emitted-results ingests CI check outcomes (INSERT)
-- and re-reads the winner after an idempotency race (SELECT).
GRANT SELECT, INSERT ON public.emitted_result              TO gateway;
-- Anchor resolution at ingest confirms a claimed PR number against the
-- webhook-fed pull_request record; read-only.
GRANT SELECT ON public.pull_request                        TO gateway;

-- git_connection: column-level grant — webhook_secret is withheld because it
-- is never needed by any gateway code path (webhook verification runs under
-- service_role, not this role).
GRANT SELECT (
    id,
    tenant_id,
    app_id,
    provider,
    repository,
    installation_id,
    webhook_id,
    created_at,
    created_by,
    updated_at,
    updated_by
) ON public.git_connection TO gateway;

-- UPDATE grant on git_connection covers two flows:
--   1. AppsService.linkRepository / unlinkRepository: writes `repository`
--      when an app is linked to a repo, clears it on unlink.
--   2. Webhook registration: writes webhook_id + webhook_secret (encrypted)
--      per app when the link route registers a push webhook.
-- `webhook_secret` UPDATE is granted (vs. SELECT being withheld) because
-- the gateway WRITES the encrypted secret but never READS it back — the
-- dashboard webhook handler reads it to verify push signatures.
GRANT UPDATE (
    repository,
    webhook_id,
    webhook_secret
) ON public.git_connection TO gateway;

-- git_branch: linkRepository upserts (INSERT for first link, UPDATE on
-- re-link with a different branch). unlinkRepository deletes the row.
-- SELECT is granted above alongside the other read tables.
GRANT INSERT, UPDATE, DELETE ON public.git_branch TO gateway;

-- -----------------------------------------------------------------------------
-- Tenant-isolation policies for gateway role
-- -----------------------------------------------------------------------------
-- One uniform shape per table: USING (tenant_id = public.tenant_id()).
-- Multiple permissive policies OR together, so these coexist with existing
-- `TO authenticated` / PUBLIC policies without conflict.

CREATE POLICY "gateway_tenant_read_app" ON public.app
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_read_git_connection" ON public.git_connection
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

-- UPDATE path: only the columns granted above can be written, enforced by the
-- column-level GRANT. This policy restricts *which rows*: tenant match only.
CREATE POLICY "gateway_tenant_token_refresh_git_connection" ON public.git_connection
    FOR UPDATE TO gateway
    USING (tenant_id = public.tenant_id())
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_read_git_branch" ON public.git_branch
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

-- Tenant-scoped INSERT/UPDATE/DELETE for the link/unlink flow. Permission is
-- enforced at the Hono middleware layer (app.update); RLS only owes tenant
-- isolation here.
CREATE POLICY "gateway_tenant_insert_git_branch" ON public.git_branch
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_update_git_branch" ON public.git_branch
    FOR UPDATE TO gateway
    USING (tenant_id = public.tenant_id())
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_delete_git_branch" ON public.git_branch
    FOR DELETE TO gateway
    USING (tenant_id = public.tenant_id());

-- billing: 1:1 with tenant, pk is tenant_id (see 30-billing.sql).
CREATE POLICY "gateway_tenant_read_billing" ON public.billing
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_read_entitlement_override"
    ON public.tenant_entitlement_override
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

-- api_key: gateway needs CRUD for the /v1/api-keys endpoints.
-- Permission enforcement (api_key.read / .insert / .delete) happens at the
-- Hono middleware layer before the DB call; RLS only owes tenant isolation.
GRANT SELECT, INSERT, DELETE ON public.api_key TO gateway;

CREATE POLICY "gateway_tenant_read_api_key" ON public.api_key
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_insert_api_key" ON public.api_key
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_delete_api_key" ON public.api_key
    FOR DELETE TO gateway
    USING (tenant_id = public.tenant_id());

-- environment: the gateway owns the public-API env surface
-- (apps/gateway/src/openapi/routes/environments.ts):
--   * SELECT — list/get envs, and CreateApiKey's default-env lookup.
--   * INSERT — POST /v1/environments (env create). The dashboard's
--     create-env dialog calls this same route via gatewayFetch.
--   * UPDATE — restricted to `fly_app_name` + `updated_by` only.
--     `EnvironmentService.createEnvironment` writes `fly_app_name` back onto
--     the row after the per-env runtime is provisioned, and stamps
--     `updated_by` for audit. Every other column is off-limits to the gateway
--     role: `current_version` is frozen (no promote saga advances it),
--     `current_commit_sha` is owned exclusively by
--     advanceCommitPointers (admin-client), and the machine-state columns
--     (`fly_machine_url`, `fly_machine_id`) are owned by admin-client-only
--     write paths. Granting wider UPDATE here would let a buggy or
--     compromised gateway path corrupt those invariants.
--   * DELETE — DELETE /v1/environments/{id} (env delete), and the create-path
--     rollback when the fly_app_name UPDATE fails.
-- Permission enforcement (environment.read / .insert / .delete) happens at the
-- Hono middleware layer before the DB call; RLS only owes tenant isolation.
GRANT SELECT, INSERT, DELETE ON public.environment TO gateway;
GRANT UPDATE (fly_app_name, updated_by) ON public.environment TO gateway;

CREATE POLICY "gateway_tenant_read_environment" ON public.environment
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_insert_environment" ON public.environment
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_update_environment" ON public.environment
    FOR UPDATE TO gateway
    USING (tenant_id = public.tenant_id())
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_delete_environment" ON public.environment
    FOR DELETE TO gateway
    USING (tenant_id = public.tenant_id());

-- -----------------------------------------------------------------------------
-- Apps surface (public.app)
-- -----------------------------------------------------------------------------
-- Gateway needs full CRUD on `app` for the public /v1/apps/* surface — the
-- prerequisite for headless agent onboarding. SELECT was already granted at
-- the top of this file with the gateway_tenant_read_app policy; the block
-- below adds INSERT / UPDATE / DELETE.
--
-- Permission enforcement (app.read / .insert / .update / .delete) happens at
-- the Hono middleware layer BEFORE any DB call. RLS only owes tenant
-- isolation, the same split used on every gateway surface in this file.
--
-- Audit columns (`created_by`, `updated_by`) are FK'd to public.profile.
-- The gateway role's tenant-id JWT claim does not satisfy that FK, so the
-- service retries with NULL on FK violations (see apps-service.ts). The
-- columns are ON DELETE SET NULL, so NULL is a valid steady-state for
-- headless-agent-authored rows.

GRANT INSERT, UPDATE, DELETE ON public.app TO gateway;

CREATE POLICY "gateway_tenant_insert_app" ON public.app
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_update_app" ON public.app
    FOR UPDATE TO gateway
    USING (tenant_id = public.tenant_id())
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_delete_app" ON public.app
    FOR DELETE TO gateway
    USING (tenant_id = public.tenant_id());

-- Artifacts + PR anchor check: the ingest surface's SELECT/INSERT pair (no
-- UPDATE policy — the role holds no UPDATE grant) and the read-only
-- pull_request lookup that confirms a claimed PR number at ingest.
CREATE POLICY "gateway_tenant_read_artifact" ON public.artifact
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_insert_artifact" ON public.artifact
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_read_emitted_result" ON public.emitted_result
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_insert_emitted_result" ON public.emitted_result
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());


CREATE POLICY "gateway_tenant_read_pull_request" ON public.pull_request
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

-- Cloud workers: tenant-scoped run + environment access for the
-- /v1/workers routes. Permission checks (worker_run.read / worker_run.insert)
-- happen at the Hono middleware layer, matching every other table here.
CREATE POLICY "gateway_tenant_read_worker_run" ON public.worker_run
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_insert_worker_run" ON public.worker_run
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_update_worker_run" ON public.worker_run
    FOR UPDATE TO gateway
    USING (tenant_id = public.tenant_id())
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_read_worker_workspace" ON public.worker_workspace
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_insert_worker_workspace" ON public.worker_workspace
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_update_worker_workspace" ON public.worker_workspace
    FOR UPDATE TO gateway
    USING (tenant_id = public.tenant_id())
    WITH CHECK (tenant_id = public.tenant_id());

-- -----------------------------------------------------------------------------
-- Context mirror surface (public.context_snapshot) — read-only, for
-- GET /v1/context/changes. Permission enforcement (metrics.read) happens at
-- the Hono middleware layer; RLS here only owes tenant isolation, matching
-- every other table in this file. App scoping is applied by the route's own
-- `.eq('app_id', ...)` filter, the same split `GetEnvironment`/`DeleteEnvironment`
-- use for a tenant-wide gateway policy.
-- -----------------------------------------------------------------------------
GRANT SELECT ON public.context_snapshot TO gateway;

CREATE POLICY "gateway_tenant_read_context_snapshot" ON public.context_snapshot
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

-- -----------------------------------------------------------------------------
-- PR outcomes + actor names (public.membership, public.profile,
-- public.pull_request_session) — read-only, for the `prOutcomes` and
-- `actorNames` ports an API-key caller's session reads build
-- (packages/gateway-core/src/lib/pr-outcomes.ts,
-- packages/gateway-core/src/openapi/routes/sessions.ts). Without these, every
-- query under the `gateway` role fails RLS and the caller silently gets
-- "no PR outcome" / "no actor name" for every session — permission
-- enforcement (session.read) happens at the Hono middleware layer, matching
-- every other table in this file. public.pull_request, which these ports also
-- read, already carries its gateway grant + gateway_tenant_read_pull_request
-- policy in the artifact block above.
-- -----------------------------------------------------------------------------
GRANT SELECT ON public.membership TO gateway;

CREATE POLICY "gateway_tenant_read_membership" ON public.membership
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

-- profile carries no tenant_id (a user can belong to multiple tenants), so
-- gateway scoping mirrors the "Users can read profiles" policy in
-- 12-rbac.sql: readable rows are exactly the active members of the caller's
-- tenant, via a membership join, rather than the self-row branch that
-- policy also has (the gateway role has no `auth.uid()` — it acts for a
-- tenant, not a signed-in user).
GRANT SELECT ON public.profile TO gateway;

CREATE POLICY "gateway_tenant_read_profile" ON public.profile
    FOR SELECT TO gateway
    USING (
      id IN (
        SELECT m.user_id
        FROM public.membership m
        WHERE m.tenant_id = public.tenant_id()
          AND (m.status)::text = 'active'::text
      )
    );

GRANT SELECT ON public.pull_request_session TO gateway;

CREATE POLICY "gateway_tenant_read_pull_request_session" ON public.pull_request_session
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

-- The pre-existing "Users can read memberships" / "Users can read profiles"
-- policies (12-rbac.sql) carry no TO clause, so PUBLIC, so the gateway role
-- inherits their OR-arm that calls private.authorize('membership.read'/...).
-- Without EXECUTE on that function, every gateway-role SELECT against
-- membership/profile fails with 42501 ("permission denied for function
-- authorize") rather than falling through to the tenant-scoped policies
-- above — Postgres evaluates all permissive policies' quals regardless of
-- which one ultimately grants access. Granting EXECUTE is safe: authorize()
-- keys off auth.uid(), which for gateway JWTs is the tenant id and matches
-- no membership.user_id row, so the legacy policies' OR-arm always
-- evaluates to false for this role — the grant only prevents the error,
-- it does not widen what the role can read.
GRANT EXECUTE ON FUNCTION private.authorize(public.app_permission) TO gateway;

-- -----------------------------------------------------------------------------
-- Storage policy for gateway: intentionally omitted
-- -----------------------------------------------------------------------------
-- An earlier iteration defined `gateway_tenant_read_template_bucket` on
-- storage.objects FOR SELECT TO gateway. That policy was unreachable:
-- the gateway Postgres role needs USAGE on schema `storage`, and that
-- grant is not issuable from a migration. `postgres` (the role migrations
-- run as) has USAGE on `storage` but not WITH GRANT OPTION; only
-- `supabase_admin` (the schema owner) can pass it on, and supabase_admin
-- is not accessible from migrations. Any `GRANT USAGE ON SCHEMA storage
-- TO gateway` silently no-ops with `WARNING: no privileges were granted
-- for "storage"`, and every `SET ROLE gateway; SELECT FROM storage.objects`
-- then fails at schema visibility (`relation "objects" does not exist`)
-- before the RLS engine is ever consulted.
--
-- Gateway storage reads go through a service-role client — see
-- apps/gateway/src/lib/system-client.ts::createStorageClient and its
-- single call site in services/template/content-fetcher.ts. Tenant
-- isolation is enforced by the storage path, which always embeds
-- tenant_id as its first folder segment (see template-repository.ts).
