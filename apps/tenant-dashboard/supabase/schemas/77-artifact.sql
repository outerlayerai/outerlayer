-- =============================================================================
-- Artifacts — emitted exhibits bound to pull requests
-- =============================================================================
-- Purpose: one row per emitted exhibit (screenshot, recording, report, log)
--   proving a change works. Bytes live in the agent blob store (ClickHouse
--   `agent_blobs` + object storage), content-addressed by sha256; this table
--   is the record: what was emitted, why (caption, optional criterion id),
--   how it arrived (provenance), and which pull request it anchors to.
--
-- `provenance` is derived by the gateway from the submission path, never
--   accepted from the caller:
--   session — uploaded by `outerlayer sync` bound to a recorded session
--   ci      — direct upload from a CI environment on a non-actor key
--   local   — direct upload from a developer machine
--
-- Anchoring: every artifact must resolve to a PR — that is the point of the
--   refusal rule at ingest ("nothing to attach this to"). `verification`
--   mirrors pull_request_session's lifecycle:
--   pending   — anchored by session / git context / claimed PR number, but
--               not yet confirmed against a `pull_request` row
--   confirmed — resolved to a real PR (directly or via its session's link)
--   unmatched — no PR appeared within the grace window; the sweep marks the
--               row and the gateway retention job deletes the blob bytes
--               (`blob_deleted`) — an artifact's lifecycle is its PR's.
--
-- Writers: the gateway (ingest) and the reconciler sweep (service_role).
--   Readers: tenant users (PR comment evidence links resolve to a dashboard
--   page that serves bytes through the signed-capability blob route).
-- Dependencies: 20-app.sql. No FK to pull_request: an artifact may arrive
--   before the PR row exists (that is what `pending` means).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.artifact (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,

    -- Client-generated id making retried uploads idempotent per app.
    client_artifact_id TEXT NOT NULL,

    -- Blob identity in the agent blob store (lowercase hex sha256 of bytes).
    sha256 TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    kind TEXT NOT NULL
        CONSTRAINT chk_artifact_kind
        CHECK (kind IN ('video', 'screenshot', 'report', 'log', 'file')),

    caption TEXT NOT NULL DEFAULT '',
    -- Acceptance-criterion id this artifact was emitted `--for` ('' = none).
    criterion_id TEXT NOT NULL DEFAULT '',

    provenance TEXT NOT NULL
        CONSTRAINT chk_artifact_provenance
        CHECK (provenance IN ('session', 'ci', 'local')),

    -- Session binding (provenance = session): agent_session_summary identity
    -- plus the turn the emit call was recorded in (NULL when unresolved).
    session_id TEXT NOT NULL DEFAULT '',
    trace_id TEXT NOT NULL DEFAULT '',
    turn_index BIGINT,

    -- PR anchor. `repository` is the canonical lowercase owner/repo the PR
    -- comment keys on; '' until resolved for session/branch-anchored rows.
    repository TEXT NOT NULL DEFAULT '',
    pr_number BIGINT,

    -- Git context recorded at emit time (host-qualified repo, e.g.
    -- github.com/acme/app) — the reconciler's branch-tier matching input.
    git_repo TEXT NOT NULL DEFAULT '',
    git_branch TEXT NOT NULL DEFAULT '',
    commit_sha TEXT NOT NULL DEFAULT '',

    verification TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT chk_artifact_verification
        CHECK (verification IN ('pending', 'confirmed', 'unmatched')),
    blob_deleted BOOLEAN NOT NULL DEFAULT false,

    emitted_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_artifact_client UNIQUE (app_id, client_artifact_id)
);

-- The PR comment's evidence read: every artifact anchored to one PR.
CREATE INDEX IF NOT EXISTS idx_artifact_pr
    ON public.artifact (tenant_id, repository, pr_number)
    WHERE pr_number IS NOT NULL;
-- Session-link resolution joins artifacts to pull_request_session by trace.
CREATE INDEX IF NOT EXISTS idx_artifact_app_trace
    ON public.artifact (app_id, trace_id)
    WHERE trace_id <> '';
-- Backs the ON DELETE CASCADE tenant_id foreign key.
CREATE INDEX IF NOT EXISTS idx_artifact_tenant_id
    ON public.artifact (tenant_id);
-- The sweep's pending→confirmed/unmatched aging scan.
CREATE INDEX IF NOT EXISTS idx_artifact_pending
    ON public.artifact (verification, emitted_at)
    WHERE verification = 'pending';
-- The blob-deletion job's scan for aged-out rows whose bytes still exist.
CREATE INDEX IF NOT EXISTS idx_artifact_unmatched_blob
    ON public.artifact (verification)
    WHERE verification = 'unmatched' AND NOT blob_deleted;

ALTER TABLE public.artifact ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."artifact"
    FOR SELECT TO "authenticated"
    USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('trace.read'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- REVOKE first, then re-grant: without this the table inherits the legacy
-- `ALTER DEFAULT PRIVILEGES` from the init migration, which grants
-- anon/authenticated full CRUD on new tables in this schema. Precedent:
-- 76-pr-session-comment.sql.
REVOKE ALL ON public.artifact FROM anon;
REVOKE ALL ON public.artifact FROM authenticated;
GRANT SELECT ON public.artifact TO authenticated;
GRANT ALL ON public.artifact TO service_role;
