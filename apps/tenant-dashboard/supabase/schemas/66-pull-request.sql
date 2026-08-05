-- =============================================================================
-- Pull / Merge Request Tracking
-- =============================================================================
-- Purpose: persist EVERY pull request (GitHub) / merge request (GitLab) on a
--   connected repo — both to link preview-worthy ones to their ephemeral
--   preview environment (torn down on close) and as the lifecycle record
--   behind agent-fleet PR metrics (merge rate, cycle time). Lifecycle
--   timestamps come from the provider payload, not webhook delivery time.
-- Provider-agnostic: `provider` distinguishes GitHub PRs from GitLab MRs;
--   `pr_number` holds the GitHub PR number or the GitLab MR iid, `comment_id`
--   the GitHub issue-comment id or the GitLab MR note id.
-- Dependencies: 20-app.sql, 52-environment.sql (FK to environment).
-- Writers: the GitHub/GitLab webhooks + publish flow, via service_role.
--   Readers: tenant users (to surface PRs/MRs / ephemeral envs in the UI).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pull_request (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,

    -- Which SCM opened it. Drives the per-provider webhook handler + comment API.
    provider TEXT NOT NULL DEFAULT 'github'
        CONSTRAINT chk_pull_request_provider CHECK (provider IN ('github', 'gitlab')),

    -- Provider PR/MR number (GitHub PR number or GitLab MR iid; unique per app).
    pr_number BIGINT NOT NULL,
    -- Head branch (e.g. `outerlayer/publish/<slug>`) and its current tip.
    head_branch TEXT NOT NULL,
    head_sha TEXT,
    -- The branch the PR/MR targets (the app's connected branch).
    base_branch TEXT NOT NULL,

    state TEXT NOT NULL DEFAULT 'open'
        CONSTRAINT chk_pull_request_state CHECK (state IN ('open', 'closed', 'merged')),
    url TEXT,

    -- The ephemeral preview env created for this PR/MR. NULL when previews are off
    -- or the env hasn't been created yet. ON DELETE SET NULL so tearing the env
    -- down (on PR/MR close) leaves the record's audit trail intact.
    environment_id UUID REFERENCES public.environment(id) ON DELETE SET NULL,

    -- The bot's single status comment/note (Vercel-style). Stored so each deploy
    -- EDITS the one comment instead of posting a new one. Provider comment/note
    -- ids are large — use BIGINT.
    comment_id BIGINT,

    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    -- Set only when state = 'merged' (from the provider payload; GitLab MR
    -- hooks carry no merged_at, so the merge event's updated_at stands in).
    -- Cycle time = merged_at - opened_at; cohort key for cost-per-merged-PR.
    merged_at TIMESTAMPTZ,

    -- Cycle-time phase boundaries (decomposed cycle time),
    -- aligned with the industry-standard phase model (LinearB/Swarmia):
    -- ready → first review (pickup) → first approval → merge. All three are
    -- FIRST-OCCURRENCE timestamps, monotone by construction: re-reviews,
    -- dismissals and draft→ready cycles never move them.
    --
    -- ready_for_review_at: the draft-aware pickup baseline — time spent as a
    -- draft is coding time, not review latency. Non-draft PRs: opened_at;
    -- drafts: the first draft→ready transition. NULL = still draft or
    -- unknown; readers COALESCE(ready_for_review_at, opened_at). The
    -- backfill approximates with opened_at for non-draft PRs and never
    -- overwrites a webhook-exact value.
    --
    -- Review milestones are HUMAN reviews only: self-reviews (author = PR
    -- author) and bot reviews never count — an instant bot reviewer would
    -- zero out pickup time on every PR and hide exactly the human-review
    -- bottleneck the decomposition exists to expose. NULL = no qualifying
    -- review observed — unknown, not zero.
    -- GitLab: only first_approved_at is populated (MR `approved` hook action);
    -- first_review_at stays NULL — comment/note review events are explicitly
    -- deferred (Note Hook isn't subscribed and maps poorly to "a review").
    ready_for_review_at TIMESTAMPTZ,
    first_review_at TIMESTAMPTZ,
    first_approved_at TIMESTAMPTZ,

    -- How many times this PR/MR was REOPENED after a close (reopen rate —
    -- a rework/churn quality signal). Incremented by the
    -- `reopened` (GitHub) / `reopen` (GitLab) webhook action; every other
    -- action leaves it untouched (omitted from the upsert, preserved on
    -- conflict). WEBHOOK-FED ONLY: the backfill can't reconstruct reopen
    -- history (it needs the per-PR timeline API), so backfilled rows keep the
    -- default 0 — a metric built on this undercounts reopens that predate the
    -- app's connection. NOT NULL DEFAULT 0 so readers never branch on NULL.
    reopen_count BIGINT NOT NULL DEFAULT 0,

    -- When this PR/MR was REVERTED (autonomy durability signal — "did the
    -- agent's work stick?"). Set two ways: (1) a merged revert PR/MR whose
    -- body references this one — "Reverts owner/repo#N" (GitHub) / "This
    -- reverts merge request !N" (GitLab); (2) a commit pushed to this row's
    -- base branch whose message names it — the `Revert "… (#N)"` squash-title
    -- convention, a "reverts …" body line, or "This reverts commit <sha>"
    -- matching this row's head_sha. NULL = not reverted (the common case), so
    -- the revert rate reads `reverted_at IS NOT NULL`. Residual undercount: a
    -- manual revert of a squash/merge commit that names neither the PR/MR
    -- number nor the head sha is unresolvable to a row — documented, not
    -- silent.
    reverted_at TIMESTAMPTZ,

    -- Diff size, from the provider: GitHub's pull_request webhook payload
    -- carries all three on every event; GitLab MR hooks carry none, so a
    -- merge-time API fetch fills what it can (changed_files from
    -- `changes_count`; line counts stay NULL when unavailable). NULL = not
    -- captured (row predates these columns, or provider didn't say) — readers
    -- must treat NULL as unknown, never 0: a "0-line PR" is a real (if odd)
    -- value, an unknown-size PR is not a tiny one. Backs the batch-size
    -- guardrail (median PR size next to throughput) and size-normalized
    -- throughput.
    additions BIGINT,
    deletions BIGINT,
    changed_files BIGINT,

    -- First-pass CI verdict: the FIRST completed CI conclusion observed for
    -- this PR, locked to the head sha it arrived on (first_ci_sha). Later
    -- pushes never move it — "did CI pass on the first try?" is a rework
    -- signal, and re-runs after a fix are exactly what it exists to count.
    -- Within that first sha the verdict is failure-sticky: any failing
    -- run/check flips success → failure (the fastest green check must not
    -- shadow the failing test suite), but never failure → success.
    -- first_ci_at is when that first conclusion landed. NULL = no completed
    -- CI signal observed (no CI configured, or the row predates ingestion) —
    -- unknown, never "passed".
    first_ci_sha TEXT,
    first_ci_status TEXT
        CONSTRAINT chk_pull_request_first_ci_status CHECK (first_ci_status IN ('success', 'failure')),
    first_ci_at TIMESTAMPTZ,

    -- Audit columns. Writes are service_role-only (the webhook), so created_by/
    -- updated_by are usually NULL — but the columns must exist: the shared
    -- set_updated_columns() trigger assigns updated_by for non-service roles.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    CONSTRAINT uc_pull_request UNIQUE (app_id, pr_number)
);

COMMENT ON TABLE public.pull_request IS 'Tracks pull requests (GitHub) / merge requests (GitLab) opened against an app''s connected branch and the ephemeral preview env (if any) created for each.';
COMMENT ON COLUMN public.pull_request.environment_id IS 'Ephemeral preview env for this PR/MR; NULL when previews disabled or not yet created. ON DELETE SET NULL so teardown keeps the audit row.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_pull_request_tenant ON public.pull_request(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pull_request_app_state ON public.pull_request(app_id, state);
CREATE INDEX IF NOT EXISTS idx_pull_request_environment ON public.pull_request(environment_id);

-- Note: updated_at trigger is registered in 99-triggers.sql.

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
-- Reads: tenant users who can read the git connection see its PRs/MRs (reuse
--   git_connection.read — no new permission). Writes: exclusively service_role
--   (the webhook / publish flow), which bypasses RLS — no authenticated
--   insert/update/delete policy is defined, so those operations are denied to
--   normal users.

ALTER TABLE public.pull_request ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."pull_request"
    FOR SELECT TO "authenticated"
    USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.read'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT SELECT ON public.pull_request TO authenticated;
GRANT ALL ON public.pull_request TO service_role;
