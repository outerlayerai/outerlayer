-- =============================================================================
-- Agent Insights Schema
-- =============================================================================
-- Purpose: Coding-agent fleet insights — detector findings
--          and LLM-labeled error themes computed offline from ClickHouse
--          agent sessions and served to the dashboard's /agents views.
-- Dependencies: 10-tenant.sql, 20-app.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Agent Finding Table
-- -----------------------------------------------------------------------------

-- One row per detector finding for a tenant+app compute pass. Rows are
-- replaced wholesale per (tenant, app) by the compute job (delete + insert),
-- never mutated in place.
CREATE TABLE IF NOT EXISTS public.agent_finding (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    detector_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    summary TEXT NOT NULL,
    suggestion TEXT,
    cost_usd NUMERIC,
    session_count BIGINT NOT NULL DEFAULT 0,
    session_ids JSONB NOT NULL DEFAULT '[]',
    evidence JSONB NOT NULL DEFAULT '[]',
    project TEXT,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_finding IS 'Detector findings over coding-agent sessions, recomputed per tenant+app by the insights compute job';
COMMENT ON COLUMN public.agent_finding.detector_id IS 'Stable id of the @outerlayer/insights-core detector that produced this finding';
COMMENT ON COLUMN public.agent_finding.severity IS 'Finding severity: info | warn | high';
COMMENT ON COLUMN public.agent_finding.summary IS 'One human-readable sentence describing the finding';
COMMENT ON COLUMN public.agent_finding.suggestion IS 'One-line remediation hint (nullable)';
COMMENT ON COLUMN public.agent_finding.cost_usd IS 'Estimated wasted spend in USD, null when not honestly computable';
COMMENT ON COLUMN public.agent_finding.session_count IS 'Full count of sessions implicated (session_ids is capped)';
COMMENT ON COLUMN public.agent_finding.session_ids IS 'JSON array of implicated session ids, capped at 8 for display';
COMMENT ON COLUMN public.agent_finding.evidence IS 'JSON array of evidence refs ({sessionId, turnIndex?, toolSeq?, note?}) for drill-down';
COMMENT ON COLUMN public.agent_finding.project IS 'Project (git repo or cwd) of the first affected session';
COMMENT ON COLUMN public.agent_finding.computed_at IS 'When the compute pass that produced this row ran';

-- -----------------------------------------------------------------------------
-- Agent Theme Table
-- -----------------------------------------------------------------------------

-- One row per LLM-labeled error theme (a named group of deterministic error
-- clusters). Replaced wholesale per (tenant, app) alongside agent_finding.
CREATE TABLE IF NOT EXISTS public.agent_theme (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL,
    cluster_keys JSONB NOT NULL DEFAULT '[]',
    evidence_session_ids JSONB NOT NULL DEFAULT '[]',
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_theme IS 'LLM-labeled themes over deterministic error clusters, recomputed per tenant+app by the insights compute job';
COMMENT ON COLUMN public.agent_theme.label IS 'Short human-readable theme label from the labeling model';
COMMENT ON COLUMN public.agent_theme.description IS 'One-paragraph theme description from the labeling model';
COMMENT ON COLUMN public.agent_theme.severity IS 'Theme severity: info | warn | high';
COMMENT ON COLUMN public.agent_theme.cluster_keys IS 'JSON array of `${tool}::${signature}` cluster keys this theme groups (validated against our clusters, never invented)';
COMMENT ON COLUMN public.agent_theme.evidence_session_ids IS 'JSON array: union of the referenced clusters'' session ids (our data, not model output)';
COMMENT ON COLUMN public.agent_theme.computed_at IS 'When the compute pass that produced this row ran';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_agent_finding_tenant_app ON public.agent_finding(tenant_id, app_id);
CREATE INDEX IF NOT EXISTS idx_agent_theme_tenant_app ON public.agent_theme(tenant_id, app_id);

-- The composite indexes above lead with tenant_id, so they cannot serve the
-- ON DELETE CASCADE foreign keys keyed on app_id alone.
CREATE INDEX IF NOT EXISTS idx_agent_finding_app_id ON public.agent_finding(app_id);
CREATE INDEX IF NOT EXISTS idx_agent_theme_app_id ON public.agent_theme(app_id);

-- -----------------------------------------------------------------------------
-- Row Level Security - Agent Finding
-- -----------------------------------------------------------------------------

ALTER TABLE public.agent_finding ENABLE ROW LEVEL SECURITY;

-- Service role: full access (writes happen only via the compute job / server
-- actions using the admin client)
CREATE POLICY "service_role_all" ON "public"."agent_finding" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- Read: tenant members can read findings in their tenant
-- App-scoped reads. Both terms do distinct work: `authorized_app_ids` supplies
-- the app boundary and, because the resolver requires an ACTIVE, non-disabled
-- membership, the permission check itself; `tenant_id` closes tenancy. A
-- `tenant_id()`-only predicate would ignore app scoping and role entirely.
CREATE POLICY "Enable read access for tenant users" ON "public"."agent_finding" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('agents.findings.read'::"public"."app_permission") AS "authorized_app_ids")) AND ("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id"))));

-- -----------------------------------------------------------------------------
-- Row Level Security - Agent Theme
-- -----------------------------------------------------------------------------

ALTER TABLE public.agent_theme ENABLE ROW LEVEL SECURITY;

-- Service role: full access
CREATE POLICY "service_role_all" ON "public"."agent_theme" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- Read: tenant members can read themes in their tenant
-- App-scoped reads. Both terms do distinct work: `authorized_app_ids` supplies
-- the app boundary and, because the resolver requires an ACTIVE, non-disabled
-- membership, the permission check itself; `tenant_id` closes tenancy. A
-- `tenant_id()`-only predicate would ignore app scoping and role entirely.
CREATE POLICY "Enable read access for tenant users" ON "public"."agent_theme" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('agents.findings.read'::"public"."app_permission") AS "authorized_app_ids")) AND ("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id"))));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables (changelog #45329) — declare explicitly; RLS above still gates rows.

GRANT ALL ON public.agent_finding TO anon;
GRANT ALL ON public.agent_finding TO authenticated;
GRANT ALL ON public.agent_finding TO service_role;

GRANT ALL ON public.agent_theme TO anon;
GRANT ALL ON public.agent_theme TO authenticated;
GRANT ALL ON public.agent_theme TO service_role;
