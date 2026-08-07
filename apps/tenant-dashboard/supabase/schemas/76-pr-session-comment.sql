-- =============================================================================
-- PR Session Comment identity
-- =============================================================================
-- Purpose: tracks the single GitHub PR comment a tenant's app posts summarizing
--   the agent sessions linked to a pull request — one row per (tenant,
--   repository, pr_number), holding just enough identity to find and
--   idempotently update that comment.
-- Writers: the comment poster only, via service_role. Readers: tenant users
--   (surfacing comment status alongside the PR).
-- Dependencies: 10-tenant.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pr_session_comment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    pr_number BIGINT NOT NULL,
    -- NULL until the first successful post. A non-null id that GitHub 404s
    -- (comment hand-deleted) is cleared and re-posted; decision 10.
    github_comment_id BIGINT,
    -- Short hash of the last rendered body. Equal hash ⇒ skip the GitHub
    -- write entirely. This is what makes at-least-once delivery cheap.
    -- The '' default is LOAD-BEARING, not cosmetic: a claim row (see the
    -- constraint below) is inserted before anything has been rendered, and
    -- '' can never collide with a sha256 hex digest, so the short-circuit
    -- can never mistake a fresh claim for "already posted this body".
    last_body_hash TEXT NOT NULL DEFAULT '',
    -- Also the freshness stamp for the periodic existence check: past
    -- COMMENT_VERIFY_INTERVAL_MS (refresh.ts) an unchanged body still costs
    -- one getIssueComment, so a hand-deleted comment can't hide forever.
    last_posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Doubles as the age of an unfinished create claim: refresh.ts only
    -- takes over a claim older than its TTL, and does so with a
    -- compare-and-set on this column. The BEFORE UPDATE trigger in
    -- 99-triggers.sql stamps it on every update, which is compatible — the
    -- compare-and-set matches on the OLD value, and a claim inserted (never
    -- updated) carries the claimant's own timestamp.
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- "One comment per PR" (AC-057-02), at the schema level. It guarantees
    -- one ROW; one COMMENT additionally requires that nobody POST to GitHub
    -- without first winning a row here — which is exactly what
    -- `claimCreate` in refresh.ts does with an ignore-duplicates insert.
    -- This constraint is that claim's arbiter, i.e. the actual lock, not
    -- merely a uniqueness assertion after the fact.
    CONSTRAINT uq_pr_session_comment UNIQUE (tenant_id, repository, pr_number)
);

COMMENT ON TABLE public.pr_session_comment IS 'Identity of the single GitHub PR comment summarizing agent sessions for a (tenant, repository, pr_number)';
COMMENT ON COLUMN public.pr_session_comment.github_comment_id IS 'GitHub comment id; NULL until first successful post, cleared and re-posted if GitHub 404s it';
COMMENT ON COLUMN public.pr_session_comment.last_body_hash IS 'Short hash of the last rendered comment body; an equal hash skips the GitHub write';
COMMENT ON COLUMN public.pr_session_comment.last_posted_at IS 'Timestamp of the last successful post/update to GitHub';

-- No standalone tenant_id index: uq_pr_session_comment leads with tenant_id,
-- so it already serves every tenant-scoped lookup. A second one would be dead
-- weight on write (and the redundant-index guard rejects it).

ALTER TABLE public.pr_session_comment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."pr_session_comment"
    FOR SELECT TO "authenticated"
    USING ((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

GRANT SELECT ON public.pr_session_comment TO authenticated;
GRANT ALL ON public.pr_session_comment TO service_role;
