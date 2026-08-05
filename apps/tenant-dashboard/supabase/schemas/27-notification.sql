-- =============================================================================
-- Notification Schema
-- =============================================================================
-- Purpose: User notifications within tenants
-- Dependencies: 10-tenant.sql, 11-profile.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Notification Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    type TEXT,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ
);

COMMENT ON TABLE public.notification IS 'User notifications within tenant context';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_notification_tenant ON public.notification(tenant_id);

-- Note: Triggers are defined in 99-triggers.sql
-- Note: Realtime subscription is enabled in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- RLS Policies
-- -----------------------------------------------------------------------------

ALTER TABLE public.notification ENABLE ROW LEVEL SECURITY;

-- Realtime subscriptions carry no request headers, so visibility derives from
-- the caller's active memberships; the client filters to the org on screen.
-- The feed is tenant-wide (`notification` has no user_id column): every member
-- of an org sees and marks read the same rows.
CREATE POLICY "Enable read access for tenant users" ON "public"."notification" FOR SELECT TO "authenticated" USING (("tenant_id" IN ( SELECT "private"."member_tenant_ids"())));

CREATE POLICY "Enable update access for tenant users" ON "public"."notification" FOR UPDATE TO "authenticated" USING (("tenant_id" IN ( SELECT "private"."member_tenant_ids"()))) WITH CHECK (("tenant_id" IN ( SELECT "private"."member_tenant_ids"())));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.notification TO anon;
-- Members' only write is marking a notification read; rows are created and
-- maintained by the service role. The REVOKE is needed in the shadow
-- database too: default privileges grant ALL on new tables, and GRANT only
-- ever adds.
REVOKE ALL ON public.notification FROM authenticated;
GRANT SELECT ON public.notification TO authenticated;
GRANT UPDATE (read) ON public.notification TO authenticated;
GRANT ALL ON public.notification TO service_role;

