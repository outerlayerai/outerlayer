-- =============================================================================
-- Env Escalation Schema
-- =============================================================================
-- Purpose: The env-prep escalation queue. When env-prep's
--          repair ladder exhausts its budget on a repo, the eval worker writes
--          one row here instead of failing silently — unbuildable repos
--          surface to the team as human-readable tickets (this queue doubles
--          as design-partner concierge intake). Rows are written by the
--          worker with the service-role key (callers pass tenant_id/app_id
--          explicitly, same as eval_run); tenants read their own and
--          ack/resolve them.
-- Dependencies: 10-tenant.sql, 20-app.sql, 11-profile.sql, 71-eval-run.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.env_escalation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    -- The run whose env build escalated. NULL when the producer had no run
    -- context (e.g. a future qualification job).
    eval_run_id UUID REFERENCES public.eval_run(id) ON DELETE SET NULL,

    -- The EscalationItem payload (@outerlayer/env-prep, escalation.ts) — the
    -- ticket body. Field-for-field so the OSS type round-trips.
    repo TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    task_ids TEXT[] NOT NULL DEFAULT '{}',
    -- [{stage, excerpt, setup}] — most recent first, bounded by the producer.
    last_errors JSONB NOT NULL DEFAULT '[]',
    attempts BIGINT NOT NULL DEFAULT 0,
    cost_usd NUMERIC NOT NULL DEFAULT 0,
    suggested_next_steps TEXT NOT NULL DEFAULT '',

    -- Lifecycle. TEXT + CHECK (repo convention for state columns, not an enum):
    --   open     → needs a human look
    --   acked    → someone owns it
    --   resolved → env fixed, or repo descoped
    status TEXT NOT NULL DEFAULT 'open'
        CONSTRAINT chk_env_escalation_status CHECK (status IN ('open', 'acked', 'resolved')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.env_escalation IS
  'Escalation queue: env builds whose repair ladder exhausted its budget. Written by the eval worker (service role); read + acked in the dashboard.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Primary read path: "open escalations, newest first" (the queue view).
CREATE INDEX IF NOT EXISTS idx_env_escalation_status_created
    ON public.env_escalation(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_env_escalation_app_created
    ON public.env_escalation(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_env_escalation_tenant
    ON public.env_escalation(tenant_id);
-- Backs the eval_run_id foreign key (ON DELETE SET NULL).
CREATE INDEX IF NOT EXISTS idx_env_escalation_eval_run_id
    ON public.env_escalation(eval_run_id);

-- -----------------------------------------------------------------------------
-- RLS Policies (Constitution VIII.E)
-- -----------------------------------------------------------------------------

ALTER TABLE public.env_escalation ENABLE ROW LEVEL SECURITY;

-- Read: the queue explains why a repo's evals aren't running.
CREATE POLICY "Enable read access for env_escalation" ON public.env_escalation FOR SELECT
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('env_escalation.read'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- Update: ack/resolve transitions. Inserts come from the worker's
-- service-role client only, so no INSERT policy exists on purpose.
CREATE POLICY "Enable update access for env_escalation" ON public.env_escalation FOR UPDATE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('env_escalation.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)))
  WITH CHECK ((app_id IN ( SELECT private.authorized_app_ids('env_escalation.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.env_escalation TO anon;
GRANT ALL ON public.env_escalation TO authenticated;
GRANT ALL ON public.env_escalation TO service_role;
