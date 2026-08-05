-- =============================================================================
-- Pull Request ↔ Agent Session reconciliation links
-- =============================================================================
-- Purpose: the MATERIALIZED many-to-many mapping between pull requests
--   (webhook-fed `pull_request` rows, Postgres) and coding-agent sessions
--   (`agent_session_summary` rows, ClickHouse — identified here by TraceId).
--   A session can produce many PRs (stacked PRs, long seat sessions) and a PR
--   can accumulate many sessions; arrival order is arbitrary (webhooks land
--   immediately, local sessions sync minutes-to-days later), so links are
--   written by a TWO-SIDED reconciler: per-PR on webhook events, and a sweep
--   over recently-ingested sessions.
--
-- `method` records the STRONGEST evidence backing the link:
--   pr_link — the session transcript explicitly linked this PR number
--   branch  — the session ran on the PR's head branch inside the PR's
--             activity window (weaker; branch names get recycled)
--
-- `verification` is the reconciler's cross-source check — a session-claimed
-- link is only as good as its agreement with the provider-fed record:
--   pending   — session claims the PR; no `pull_request` row seen yet
--   confirmed — a `pull_request` row exists for (app, pr_number)
--   unmatched — claimed, but no row appeared within the grace window
--               (a ghost link: rewritten history, wrong repo, or a repo
--               whose webhooks aren't connected)
--
-- Writers: the reconciler only, via service_role. Readers: tenant users
--   (session detail ⇄ PR surfaces, reconciliation health).
-- Dependencies: 20-app.sql. No FK to pull_request: a link may exist BEFORE
--   the pull_request row (that is what `pending` means).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pull_request_session (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,

    -- Provider PR number (GitHub PR number / GitLab MR iid; unique per app).
    pr_number BIGINT NOT NULL,

    -- ClickHouse session identity: agent_session_summary.TraceId (32-hex) and
    -- the human-facing SessionId it derives from.
    trace_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',

    method TEXT NOT NULL
        CONSTRAINT chk_pr_session_method CHECK (method IN ('pr_link', 'branch')),
    verification TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT chk_pr_session_verification
        CHECK (verification IN ('pending', 'confirmed', 'unmatched')),

    -- The branch the session ran on when linked (diagnostic for branch-tier
    -- links; '' when the session carried no branch).
    git_branch TEXT NOT NULL DEFAULT '',

    first_linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_pull_request_session UNIQUE (app_id, pr_number, trace_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_session_app_trace
    ON public.pull_request_session (app_id, trace_id);
-- Backs the ON DELETE CASCADE tenant_id foreign key; every other index here
-- leads with app_id.
CREATE INDEX IF NOT EXISTS idx_pull_request_session_tenant_id
    ON public.pull_request_session (tenant_id);
-- The sweep's pending→unmatched aging scan.
CREATE INDEX IF NOT EXISTS idx_pr_session_pending
    ON public.pull_request_session (verification, first_linked_at)
    WHERE verification = 'pending';

ALTER TABLE public.pull_request_session ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."pull_request_session"
    FOR SELECT TO "authenticated"
    USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.read'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

GRANT SELECT ON public.pull_request_session TO authenticated;
GRANT ALL ON public.pull_request_session TO service_role;
