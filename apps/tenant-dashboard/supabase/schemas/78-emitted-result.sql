-- =============================================================================
-- Emitted results — CI-run validator outcomes bound to pull requests
-- =============================================================================
-- Purpose: one row per `outerlayer emit <name> --link <url>` — the record of
--   a check that ran in the customer's infrastructure (their CI, their
--   compute) and reported in. The engine never executes the check; it
--   evaluates these records: a custom validator declaring the emit name is
--   satisfied by the latest row for that name on the PR, and the row's link
--   is the customer's own proof (their CI run).
--
-- `provenance` is derived by the gateway from the submission path, never
--   accepted from the caller:
--   ci    — direct submission from a CI environment on a non-actor key
--   local — direct submission from a developer machine
--
-- Anchoring: unlike artifacts, an emitted result carries its PR number at
--   ingest (CI on a pull_request event knows it; otherwise the CLI refuses)
--   — there is no branch/session reconciliation tier. `verification` is
--   `confirmed` when the webhook-fed pull_request row already exists and
--   `pending` when the emit arrived first; pending rows still render for
--   the PR they name.
--
-- Writers: the gateway (ingest). Readers: tenant users and the PR comment
--   refresh. Dependencies: 20-app.sql. No FK to pull_request: an emit may
--   arrive before the PR row exists (that is what `pending` means).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.emitted_result (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,

    -- Client-generated id making retried submissions idempotent per app.
    client_emit_id TEXT NOT NULL,

    -- The declared emit name a validator references (id characters only).
    name TEXT NOT NULL,
    result TEXT NOT NULL
        CONSTRAINT chk_emitted_result_result
        CHECK (result IN ('pass', 'fail')),
    -- The run URL the emitting step supplied — the row's proof link.
    link TEXT NOT NULL DEFAULT '',

    provenance TEXT NOT NULL
        CONSTRAINT chk_emitted_result_provenance
        CHECK (provenance IN ('ci', 'local')),

    -- PR anchor: canonical lowercase owner/repo the PR comment keys on.
    repository TEXT NOT NULL,
    pr_number BIGINT NOT NULL,

    verification TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT chk_emitted_result_verification
        CHECK (verification IN ('pending', 'confirmed')),

    emitted_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_emitted_result_client UNIQUE (app_id, client_emit_id)
);

-- The PR comment's evidence read: every emitted result anchored to one PR.
CREATE INDEX IF NOT EXISTS idx_emitted_result_pr
    ON public.emitted_result (tenant_id, repository, pr_number);
-- Backs the ON DELETE CASCADE tenant_id foreign key.
CREATE INDEX IF NOT EXISTS idx_emitted_result_tenant_id
    ON public.emitted_result (tenant_id);

ALTER TABLE public.emitted_result ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."emitted_result"
    FOR SELECT TO "authenticated"
    USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('trace.read'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- REVOKE first, then re-grant: without this the table inherits the legacy
-- `ALTER DEFAULT PRIVILEGES` from the init migration, which grants
-- anon/authenticated full CRUD on new tables in this schema. Precedent:
-- 76-pr-session-comment.sql.
REVOKE ALL ON public.emitted_result FROM anon;
REVOKE ALL ON public.emitted_result FROM authenticated;
GRANT SELECT ON public.emitted_result TO authenticated;
GRANT ALL ON public.emitted_result TO service_role;
