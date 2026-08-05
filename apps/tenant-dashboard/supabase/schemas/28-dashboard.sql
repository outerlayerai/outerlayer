-- =============================================================================
-- Dashboard Schema
-- =============================================================================
-- Purpose: Org-scoped analytics dashboards with customizable widgets
-- Dependencies: 10-tenant.sql, 11-profile.sql, 20-app.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Dashboard Table
-- -----------------------------------------------------------------------------

-- Per-org analytics dashboards scoped to a tenant and app
CREATE TABLE IF NOT EXISTS public.dashboard (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profile(id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    is_default BOOLEAN NOT NULL DEFAULT false,
    layout JSONB NOT NULL DEFAULT '[]'::jsonb,
    global_time_range TEXT NOT NULL DEFAULT '7d',

    -- Audit columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT uq_dashboard_tenant_app_name UNIQUE (tenant_id, app_id, name)
);

COMMENT ON TABLE public.dashboard IS 'Org-scoped analytics dashboards with customizable widgets and layouts';

-- -----------------------------------------------------------------------------
-- Dashboard Widget Table
-- -----------------------------------------------------------------------------

-- Individual widget configurations belonging to a dashboard
CREATE TABLE IF NOT EXISTS public.dashboard_widget (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id UUID NOT NULL REFERENCES public.dashboard(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    metric TEXT NOT NULL,
    visualization TEXT NOT NULL DEFAULT 'line',
    filters JSONB NOT NULL DEFAULT '[]'::jsonb,
    group_by TEXT,
    time_granularity TEXT NOT NULL DEFAULT 'auto',
    sort_order BIGINT NOT NULL DEFAULT 0,
    score_name TEXT,
    score_name_b TEXT,
    -- NULL / {"mode":"inherit"} follows the dashboard-level env filter;
    -- {"mode":"override","environments":[...]} pins the widget to one or more
    -- envs. Listing several is how a widget compares across environments.
    environment_config JSONB,

    -- Audit columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ,
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT chk_widget_visualization CHECK (visualization IN ('line', 'bar', 'area', 'stat'))
);

COMMENT ON TABLE public.dashboard_widget IS 'Individual widget configurations belonging to a dashboard';
COMMENT ON COLUMN public.dashboard_widget.environment_config IS 'Environment dimension. NULL or {"mode":"inherit"} follows the dashboard-level env filter; {"mode":"override","environments":[...]} pins the widget to one or more envs, and listing several enables cross-env comparison.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Only one default dashboard per tenant per app
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_one_default_per_tenant_app
    ON public.dashboard (tenant_id, app_id) WHERE is_default = true;

-- Fast lookup for widgets in a dashboard
CREATE INDEX IF NOT EXISTS idx_widget_dashboard ON public.dashboard_widget(dashboard_id);

-- Backs the ON DELETE CASCADE foreign keys. uq_dashboard_tenant_app_name
-- leads with tenant_id, so it cannot serve a cascade keyed on app_id alone.
CREATE INDEX IF NOT EXISTS idx_dashboard_app_id ON public.dashboard(app_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_user_id ON public.dashboard(user_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_widget_tenant_id ON public.dashboard_widget(tenant_id);

-- Note: Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Row Level Security - Dashboard
-- -----------------------------------------------------------------------------

ALTER TABLE public.dashboard ENABLE ROW LEVEL SECURITY;

-- Service role: full access (used by server actions with admin client)
CREATE POLICY "service_role_all" ON "public"."dashboard" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- Read: org members can read dashboards in their tenant
CREATE POLICY "Org members can read dashboards" ON "public"."dashboard" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('dashboard.read'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Insert: org members can create dashboards in their tenant
CREATE POLICY "Org members can create dashboards" ON "public"."dashboard" FOR INSERT TO "authenticated" WITH CHECK (("app_id" IN ( SELECT "private"."authorized_app_ids"('dashboard.insert'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Update: org members can update dashboards in their tenant
CREATE POLICY "Org members can update dashboards" ON "public"."dashboard" FOR UPDATE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('dashboard.update'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Delete: org members can delete dashboards in their tenant
CREATE POLICY "Org members can delete dashboards" ON "public"."dashboard" FOR DELETE TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('dashboard.delete'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Row Level Security - Dashboard Widget
-- -----------------------------------------------------------------------------

-- Resolves a dashboard's app for app-aware widget RLS. dashboard_widget has no
-- app_id column, so its policies authorize against the parent dashboard's app.
-- SECURITY DEFINER so the lookup bypasses dashboard RLS (the caller's per-app
-- role may grant dashboard.* without the reads the dashboard policies need),
-- tenant-bound so it cannot disclose another tenant's dashboard→app mapping.
-- Lives in the unexposed `private` schema: it is SECURITY DEFINER
-- and consulted only from the widget RLS policies below, never as an RPC, so
-- keeping it out of the API schema clears the splinter secdef finding while RLS
-- (evaluated as the querying role) can still call it.
CREATE OR REPLACE FUNCTION private.get_dashboard_app_id(target_dashboard_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT app_id FROM public.dashboard
  WHERE id = target_dashboard_id
    AND tenant_id = public.tenant_id();
$$;

-- Postgres default-grants EXECUTE to PUBLIC on new functions; policies run as
-- the querying user, so authenticated needs it back explicitly.
REVOKE EXECUTE ON FUNCTION private.get_dashboard_app_id(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.get_dashboard_app_id(uuid) TO authenticated, service_role;

ALTER TABLE public.dashboard_widget ENABLE ROW LEVEL SECURITY;

-- Service role: full access
CREATE POLICY "service_role_all" ON "public"."dashboard_widget" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- Widget policies mirror the dashboard policies above: app-aware through the
-- parent dashboard's app (private.get_dashboard_app_id), so app-scoped members
-- whose per-app role grants dashboard.* can manage widgets (org-level
-- authorize() denied them — they hold no org-level permissions at all).

-- Read: members can read widgets of dashboards in apps they can read
CREATE POLICY "Org members can read widgets" ON "public"."dashboard_widget" FOR SELECT TO "authenticated" USING ((("private"."get_dashboard_app_id"("dashboard_id") IS NOT NULL) AND "private"."get_dashboard_app_id"("dashboard_id") IN ( SELECT "private"."authorized_app_ids"('dashboard.read'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Insert: members can create widgets on dashboards in apps they can edit
CREATE POLICY "Org members can create widgets" ON "public"."dashboard_widget" FOR INSERT TO "authenticated" WITH CHECK ((("private"."get_dashboard_app_id"("dashboard_id") IS NOT NULL) AND "private"."get_dashboard_app_id"("dashboard_id") IN ( SELECT "private"."authorized_app_ids"('dashboard.insert'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Update: members can update widgets on dashboards in apps they can edit
CREATE POLICY "Org members can update widgets" ON "public"."dashboard_widget" FOR UPDATE TO "authenticated" USING ((("private"."get_dashboard_app_id"("dashboard_id") IS NOT NULL) AND "private"."get_dashboard_app_id"("dashboard_id") IN ( SELECT "private"."authorized_app_ids"('dashboard.update'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Delete: members can delete widgets on dashboards in apps they can edit
CREATE POLICY "Org members can delete widgets" ON "public"."dashboard_widget" FOR DELETE TO "authenticated" USING ((("private"."get_dashboard_app_id"("dashboard_id") IS NOT NULL) AND "private"."get_dashboard_app_id"("dashboard_id") IN ( SELECT "private"."authorized_app_ids"('dashboard.delete'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.dashboard TO anon;
GRANT ALL ON public.dashboard TO authenticated;
GRANT ALL ON public.dashboard TO service_role;
GRANT ALL ON public.dashboard_widget TO anon;
GRANT ALL ON public.dashboard_widget TO authenticated;
GRANT ALL ON public.dashboard_widget TO service_role;
