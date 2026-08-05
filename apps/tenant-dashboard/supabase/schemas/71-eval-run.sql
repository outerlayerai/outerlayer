-- =============================================================================
-- Eval Run Schema
-- =============================================================================
-- Purpose: Durable record of a Harness Report Card run. A run
--          is dispatched from the evals UI, executed asynchronously on compute
--          (the eval worker runs the agent trials + grading against sandboxes),
--          and its Report Card is written back on completion. Persisting the run
--          gives history, survive-refresh, shareable cards, and the runId the UI
--          polls while a run executes. `request` holds the wizard's two configs +
--          task/trial/budget params; `card` holds the Report Card once done.
-- Dependencies: 10-tenant.sql, 20-app.sql, 11-profile.sql, environment table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.eval_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    -- The environment the run was scoped to (its Vault env vars supply the
    -- agents' model keys). NULL = the app's default environment. The composite
    -- FK below pins it to an environment of THIS app (and therefore this
    -- tenant); a bare row-exists FK would let a run bind a foreign env.
    environment_id UUID,

    -- Lifecycle. TEXT + CHECK (repo convention for state columns, not an enum):
    --   queued    → dispatched, not yet picked up
    --   running   → the eval worker is executing trials
    --   succeeded → card written
    --   failed    → error written
    status TEXT NOT NULL DEFAULT 'queued'
        CONSTRAINT chk_eval_run_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),

    -- Display label for the repo the eval ran against (app.git_connection.repository).
    repo_label TEXT NOT NULL DEFAULT '',

    -- The run request the wizard emitted: { configs: [A, B], taskCount, trialsPerTask, budgetUsd }.
    request JSONB NOT NULL DEFAULT '{}',
    -- The Report Card, written on completion. NULL while queued/running.
    card JSONB,
    -- Measured total spend (kept out of `card` so history/cost queries don't parse JSON).
    cost_usd NUMERIC NOT NULL DEFAULT 0,
    -- Failure reason when status = 'failed'.
    error TEXT,

    -- Audit columns (Constitution VIII.A). tenant_id/created_by/updated_* are
    -- populated by the set_* triggers in 99-triggers.sql, so callers never pass them.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    CONSTRAINT eval_run_environment_app_fkey
        FOREIGN KEY (environment_id, app_id)
        REFERENCES public.environment(id, app_id)
        ON DELETE SET NULL (environment_id)
);

COMMENT ON TABLE public.eval_run IS
  'Durable record of a Harness Report Card run: the dispatched request, lifecycle status, and the resulting Report Card. Backs run history, polling, and shareable cards.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Primary read path: "recent runs for one app" (the evals history list).
CREATE INDEX IF NOT EXISTS idx_eval_run_app_created
    ON public.eval_run(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_run_tenant
    ON public.eval_run(tenant_id);

-- Serves both the environment_id foreign key (ON DELETE SET NULL) and the
-- environment-scoped run listing, which is the primary UI filter on this table.
CREATE INDEX IF NOT EXISTS idx_eval_run_environment_id
    ON public.eval_run(environment_id);

-- -----------------------------------------------------------------------------
-- RLS Policies (Constitution VIII.E)
-- -----------------------------------------------------------------------------

ALTER TABLE public.eval_run ENABLE ROW LEVEL SECURITY;

-- Read: anyone who can see the evals section.
CREATE POLICY "Enable read access for eval_run" ON public.eval_run FOR SELECT
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('eval_run.read'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- Insert: anyone who can dispatch an eval run.
CREATE POLICY "Enable insert access for eval_run" ON public.eval_run FOR INSERT
  TO authenticated
  WITH CHECK ((app_id IN ( SELECT private.authorized_app_ids('eval_run.insert'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- Update: status transitions + card/cost write-back (dispatcher & worker callback).
CREATE POLICY "Enable update access for eval_run" ON public.eval_run FOR UPDATE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('eval_run.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)))
  WITH CHECK ((app_id IN ( SELECT private.authorized_app_ids('eval_run.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- Delete: removing a run from history.
CREATE POLICY "Enable delete access for eval_run" ON public.eval_run FOR DELETE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('eval_run.delete'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.eval_run TO anon;
GRANT ALL ON public.eval_run TO authenticated;
GRANT ALL ON public.eval_run TO service_role;
