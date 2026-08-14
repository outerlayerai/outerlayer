-- =============================================================================
-- PR Evidence Evaluation record
-- =============================================================================
-- Purpose: append-only record of every evidence evaluation the PR comment
--   pipeline computes for a (tenant, repository, pr_number) — the verdict and
--   the facts behind it — so verdicts are queryable against merge/revert
--   outcomes ("did flagged PRs go bad more often") from day one, not
--   reconstructed later from comment edits.
-- Writers: the comment refresh only, via service_role. Readers: tenant users.
-- Dependencies: 10-tenant.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pr_evidence_evaluation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    pr_number BIGINT NOT NULL,
    -- The derived verdict. `unverifiable` is stored-but-unreachable today:
    -- no red-class fact exists yet, and the CHECK names it now so the first
    -- red-class validator is a code change, not a schema migration.
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'flag', 'unverifiable', 'waiting')),
    -- The stated facts, verbatim as evaluated (EvidenceFact[] JSON). The
    -- evaluation is deterministic and recomputable, so this is a record of
    -- what was said, not the only way to know it.
    facts JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Candidate links still pending at evaluation time — what the waiting
    -- verdict was waiting on.
    pending_link_count INTEGER NOT NULL DEFAULT 0,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.pr_evidence_evaluation IS 'Append-only record of each evidence evaluation (facts + verdict) for a (tenant, repository, pr_number), queryable against PR merge/revert outcomes';
COMMENT ON COLUMN public.pr_evidence_evaluation.verdict IS 'Derived verdict: pass | flag | unverifiable | waiting';
COMMENT ON COLUMN public.pr_evidence_evaluation.facts IS 'The evaluated facts (EvidenceFact[] JSON), verbatim as rendered into the comment';
COMMENT ON COLUMN public.pr_evidence_evaluation.pending_link_count IS 'Candidate session links still pending confirmation at evaluation time';

-- The one read path: latest-first per PR (the writer's dedupe read, and the
-- outcomes join). Leads with tenant_id so it also serves every tenant-scoped
-- lookup without a second index.
CREATE INDEX IF NOT EXISTS idx_pr_evidence_evaluation_pr
    ON public.pr_evidence_evaluation (tenant_id, repository, pr_number, evaluated_at DESC);

ALTER TABLE public.pr_evidence_evaluation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."pr_evidence_evaluation"
    FOR SELECT TO "authenticated"
    USING ((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

-- REVOKE first, then re-grant — same reasoning as 76-pr-session-comment.sql:
-- without this the table inherits the init migration's legacy default grants
-- (full CRUD to anon/authenticated), leaving the single SELECT policy as the
-- only guard on rows that identify which repositories and PRs an org works
-- in. Stating the privileges outright also keeps a fresh install identical
-- to an existing one.
REVOKE ALL ON public.pr_evidence_evaluation FROM anon;
REVOKE ALL ON public.pr_evidence_evaluation FROM authenticated;
GRANT SELECT ON public.pr_evidence_evaluation TO authenticated;
GRANT ALL ON public.pr_evidence_evaluation TO service_role;
