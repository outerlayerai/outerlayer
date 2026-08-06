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
    last_body_hash TEXT NOT NULL DEFAULT '',
    last_posted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_pr_session_comment UNIQUE (tenant_id, repository, pr_number)
);

COMMENT ON TABLE public.pr_session_comment IS 'Identity of the single GitHub PR comment summarizing agent sessions for a (tenant, repository, pr_number)';
COMMENT ON COLUMN public.pr_session_comment.github_comment_id IS 'GitHub comment id; NULL until first successful post, cleared and re-posted if GitHub 404s it';
COMMENT ON COLUMN public.pr_session_comment.last_body_hash IS 'Short hash of the last rendered comment body; an equal hash skips the GitHub write';
COMMENT ON COLUMN public.pr_session_comment.last_posted_at IS 'Timestamp of the last successful post/update to GitHub';

CREATE INDEX IF NOT EXISTS idx_pr_session_comment_tenant_id
    ON public.pr_session_comment (tenant_id);

ALTER TABLE public.pr_session_comment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."pr_session_comment"
    FOR SELECT TO "authenticated"
    USING ((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

GRANT SELECT ON public.pr_session_comment TO authenticated;
GRANT ALL ON public.pr_session_comment TO service_role;
