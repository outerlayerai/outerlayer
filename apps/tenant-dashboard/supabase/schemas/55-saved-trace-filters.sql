-- =============================================================================
-- Saved Trace Filters Schema
-- =============================================================================
-- Purpose: App-scoped saved filter/view configurations for traces, requests, and sessions views
-- Dependencies: 10-tenant.sql, 11-profile.sql
-- Feature: 009-trace-search-filter
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Saved Trace Filters Table
-- -----------------------------------------------------------------------------

-- Stores saved filter/view configurations scoped per app
CREATE TABLE IF NOT EXISTS public.saved_trace_filters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL,
    name TEXT NOT NULL,
    filter_config JSONB NOT NULL,
    page TEXT NOT NULL DEFAULT 'traces',

    -- Audit columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT saved_trace_filters_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT saved_trace_filters_page_check CHECK (page IN ('traces', 'requests', 'sessions', 'agents-sessions')),
    CONSTRAINT saved_trace_filters_unique_name_page UNIQUE (tenant_id, app_id, name, page)
);

COMMENT ON TABLE public.saved_trace_filters IS 'App-scoped saved filter/view configurations for traces, requests, and sessions views';
COMMENT ON COLUMN public.saved_trace_filters.filter_config IS 'JSONB filter/view configuration: v1/v2 for traces, v3 for requests views';
COMMENT ON COLUMN public.saved_trace_filters.app_id IS 'App this saved view belongs to — each app has its own set of views';
COMMENT ON COLUMN public.saved_trace_filters.name IS 'Filter name (1-100 chars, unique per tenant+app+page)';
COMMENT ON COLUMN public.saved_trace_filters.user_id IS 'User who created this filter (metadata only, not used for access control)';
COMMENT ON COLUMN public.saved_trace_filters.page IS 'Which page this filter belongs to: traces, requests, sessions, or agents-sessions';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------


-- Backs the ON DELETE CASCADE user_id foreign key.
CREATE INDEX IF NOT EXISTS idx_saved_trace_filters_user_id
ON public.saved_trace_filters(user_id);

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

ALTER TABLE public.saved_trace_filters ENABLE ROW LEVEL SECURITY;

-- Saved views stay SHARED within an app — any member who can reach the app's
-- trace surfaces may edit or delete a teammate's view. That is deliberate (see
-- lib/analytics/saved-filters/actions.ts: `user_id` is provenance, never an
-- access-control column), so this policy does not restrict writes to the author.
--
-- The boundary that does apply is the APP one. The server actions narrow every
-- mutation by `appId`, but RLS — not the action layer — is what a direct
-- PostgREST call has to satisfy, so `authorized_app_ids('trace.read')` makes the
-- database enforce the same scope the actions intend, on the same permission
-- those actions gate on. An app-scoped member reaches only their own apps.
--
-- Both (SELECT ...) wraps are there for cost, not style: the planner
-- hoists each to an InitPlan evaluated once per statement rather than per row.
CREATE POLICY "tenant_shared_filters" ON "public"."saved_trace_filters" FOR ALL TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('trace.read'::"public"."app_permission") AS "authorized_app_ids")) AND ("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")))) WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('trace.read'::"public"."app_permission") AS "authorized_app_ids")) AND ("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id"))));

-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

GRANT ALL ON public.saved_trace_filters TO anon;
GRANT ALL ON public.saved_trace_filters TO authenticated;
GRANT ALL ON public.saved_trace_filters TO service_role;

