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
    -- (the comment was hand-deleted) is cleared and re-posted.
    github_comment_id BIGINT,
    -- Set when a caller wins the right to POST the first comment for this PR,
    -- cleared when that post is persisted. Its AGE is the claim's liveness:
    -- refresh.ts only takes over a claim older than its TTL, with a
    -- compare-and-set on this exact column.
    --
    -- Deliberately NOT updated_at (which the BEFORE UPDATE trigger stamps on
    -- every write, and which therefore cannot distinguish "someone is posting
    -- right now" from "someone touched this row"). The distinction is
    -- load-bearing for the refresh queue below: a row inserted purely to
    -- remember "this PR still needs a refresh" carries claimed_at NULL, and a
    -- NULL claim is takeable immediately rather than blocking the next real
    -- poster for a TTL.
    claimed_at TIMESTAMPTZ,
    -- The cron sweep's durable backlog. The sweep's in-tick change list is
    -- EDGE-triggered (it reports only links that moved this tick), so a PR
    -- deferred past the per-tick cap would otherwise never be seen again:
    -- the next tick compares those links equal and they vanish from the
    -- list. Deferred and failed PRs are flagged here instead, and the next
    -- tick drains the flagged set FIRST — which is also what keeps a
    -- deterministic sort from starving the same late-sorting tenants forever.
    needs_refresh BOOLEAN NOT NULL DEFAULT false,
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
    -- Plain row-modification stamp, maintained by the BEFORE UPDATE trigger
    -- in 99-triggers.sql. Claim liveness lives in claimed_at instead — see
    -- the note there.
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One comment per PR, at the schema level. It guarantees
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
COMMENT ON COLUMN public.pr_session_comment.claimed_at IS 'When a caller won the right to post the first comment; NULL when no create is in flight. Its age is the claim TTL.';
COMMENT ON COLUMN public.pr_session_comment.needs_refresh IS 'Durable cron backlog: this PR was deferred or failed and must be refreshed on a later tick';

-- No standalone tenant_id index: uq_pr_session_comment leads with tenant_id,
-- so it already serves every tenant-scoped lookup. A second one would be dead
-- weight on write (and the redundant-index guard rejects it).

-- The cron sweep's backlog drain reads only flagged rows, which are a tiny
-- minority of the table in steady state (empty, in fact, whenever the sweep
-- keeps up). A PARTIAL index keeps that scan off the full table without
-- carrying every row's worth of index on every write.
CREATE INDEX IF NOT EXISTS idx_pr_session_comment_needs_refresh
    ON public.pr_session_comment (updated_at)
    WHERE needs_refresh;

ALTER TABLE public.pr_session_comment ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."pr_session_comment"
    FOR SELECT TO "authenticated"
    USING ((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

-- REVOKE first, then re-grant. Without this the table inherits the legacy
-- `ALTER DEFAULT PRIVILEGES` from the init migration, which grants
-- anon/authenticated full CRUD on new tables in this schema — so the GRANT
-- below would read like a narrow policy while narrowing nothing, and the
-- single SELECT policy would be the only thing standing between those
-- grants and cross-tenant writes. Stating the privileges outright also
-- keeps a fresh install identical to an existing one. Precedent:
-- 22-git-connection.sql.
REVOKE ALL ON public.pr_session_comment FROM anon;
REVOKE ALL ON public.pr_session_comment FROM authenticated;
GRANT SELECT ON public.pr_session_comment TO authenticated;
GRANT ALL ON public.pr_session_comment TO service_role;
