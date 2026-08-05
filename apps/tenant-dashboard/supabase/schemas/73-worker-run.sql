-- =============================================================================
-- Cloud Workers Schema
-- =============================================================================
-- Purpose: Durable record of a cloud worker run — a terminal coding agent
--          (Claude Code, Codex CLI, ...) executed against the app's connected
--          repo on managed compute (ephemeral Fly machine, or a local child
--          process in dev). worker_run is the run header the dashboard polls;
--          worker_run_event is its append-only normalized transcript.
--
--          Runs are dispatched by an authenticated user (RLS INSERT), then
--          status-transitioned exclusively by the worker's event/callback
--          routes and the reaper cron via the service role (bypasses RLS) —
--          matching the eval_run / env_escalation posture.
-- Dependencies: 10-tenant.sql, 11-profile.sql, 20-app.sql, 52-environment.sql,
--               01-types.sql (app_permission extended with worker_run.*).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.worker_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    -- NULL = the app's default environment; SET NULL so run history survives
    -- environment deletion (eval_run convention — no epoch denormalization).
    environment_id UUID REFERENCES public.environment(id) ON DELETE SET NULL,

    -- Which agent adapter executes the task (e.g. 'claude-code'). TEXT, not a
    -- CHECK: the adapter registry is application code and grows without
    -- migrations.
    agent TEXT NOT NULL,
    -- Model the agent CLI ran (adapter alias, e.g. 'sonnet'). NULL = the agent's
    -- own default. Free TEXT for the same reason as `agent`: the model catalog
    -- is application code, not a migration-bound enum.
    model TEXT,
    task_prompt TEXT NOT NULL,
    -- Metadata of files the user attached to the task ([{name, mime,
    -- size_bytes}]). Content is never stored here — it rides to the runner in
    -- the dispatch params (Vault-staged for fly, params file for local).
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    base_branch TEXT NOT NULL DEFAULT '',

    -- Lifecycle. TEXT + CHECK (repo convention for state columns, not an enum):
    --   queued       row created, dispatch in flight
    --   provisioning machine create accepted (fly) / child spawned (local)
    --   running      first transcript event received
    --   pushing      agent finished with changes; landing branch + PR
    --   completed / failed / cancelled / timed_out  terminal
    status TEXT NOT NULL DEFAULT 'queued'
        CONSTRAINT chk_worker_run_status
        CHECK (status IN ('queued', 'provisioning', 'running', 'pushing',
                          'completed', 'failed', 'cancelled', 'timed_out')),

    -- How the run executes: 'fly' (ephemeral machine) or 'local' (dev child
    -- process). Drives cancel + reaper semantics (only fly runs have a
    -- machine to destroy).
    dispatch TEXT NOT NULL DEFAULT 'fly'
        CONSTRAINT chk_worker_run_dispatch CHECK (dispatch IN ('fly', 'local')),
    machine_id TEXT,

    -- Result delivery (set on completed runs whose agent produced a diff).
    outcome TEXT
        CONSTRAINT chk_worker_run_outcome
        CHECK (outcome IS NULL OR outcome IN ('changes', 'no_changes')),
    branch_name TEXT,
    pr_url TEXT,
    pr_number INTEGER,

    -- Failure taxonomy: failure_code is machine-readable (preflight_failed /
    -- dispatch_failed / clone_failed / agent_error / diff_too_large /
    -- wall_clock_exceeded / callback_missing), error_message is human-readable
    -- and must never contain tokens (scrubbed by the worker).
    failure_code TEXT,
    error_message TEXT,

    -- Metrics reported by the agent's terminal result event.
    cost_usd NUMERIC,
    num_turns INTEGER,
    -- Tail of the agent's raw output, capped by the callback route. The
    -- normalized transcript lives in worker_run_event.
    raw_log TEXT,

    -- Wall-clock enforcement: the runner self-enforces the cap; the reaper
    -- cron force-terminates runs whose heartbeat went silent past cap + grace.
    wall_clock_cap_s INTEGER NOT NULL DEFAULT 1800
        CONSTRAINT chk_worker_run_cap CHECK (wall_clock_cap_s > 0 AND wall_clock_cap_s <= 3600),
    started_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms BIGINT,

    -- Audit columns. Set explicitly by callers (dispatch route + service-role
    -- worker) — NO set_* triggers, matching eval_run / env_escalation.
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ
);

COMMENT ON TABLE public.worker_run IS
  'Cloud worker run: a terminal coding agent executed against the app''s repo on managed compute. Backs run history, transcript polling, cancel, and PR delivery.';

CREATE INDEX IF NOT EXISTS idx_worker_run_app_created
    ON public.worker_run(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_worker_run_tenant
    ON public.worker_run(tenant_id);
-- Serves both the environment_id foreign key (ON DELETE SET NULL) and the
-- environment-scoped run listing.
CREATE INDEX IF NOT EXISTS idx_worker_run_environment_id
    ON public.worker_run(environment_id);
-- Reaper scan: in-flight runs, stalest heartbeat first.
CREATE INDEX IF NOT EXISTS idx_worker_run_inflight
    ON public.worker_run(status, heartbeat_at)
    WHERE status IN ('queued', 'provisioning', 'running', 'pushing');

ALTER TABLE public.worker_run ENABLE ROW LEVEL SECURITY;

-- Read: anyone who can see the Workers tab.
CREATE POLICY "Enable read access for worker_run" ON public.worker_run FOR SELECT
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('worker_run.read'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- Insert: anyone who can launch a worker run.
CREATE POLICY "Enable insert access for worker_run" ON public.worker_run FOR INSERT
  TO authenticated
  WITH CHECK ((app_id IN ( SELECT private.authorized_app_ids('worker_run.insert'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- Update: cancel from the dashboard. Worker-side status transitions arrive via
-- the service role and bypass RLS.
CREATE POLICY "Enable update access for worker_run" ON public.worker_run FOR UPDATE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('worker_run.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)))
  WITH CHECK ((app_id IN ( SELECT private.authorized_app_ids('worker_run.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- Delete: removing a run from history.
CREATE POLICY "Enable delete access for worker_run" ON public.worker_run FOR DELETE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('worker_run.delete'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.worker_run TO anon;
GRANT ALL ON public.worker_run TO authenticated;
GRANT ALL ON public.worker_run TO service_role;

-- -----------------------------------------------------------------------------
-- Worker Run Event (append-only normalized transcript)
-- -----------------------------------------------------------------------------
-- Immutable, seq-ordered event stream for a run. Written exclusively by the
-- worker's internal event route (service role); read incrementally by the
-- dashboard (?after_seq=N) via the PARENT run's worker_run.read permission.
-- Append-only by construction: only created_at, a single SELECT policy, and no
-- INSERT/UPDATE/DELETE policies on purpose.

CREATE TABLE IF NOT EXISTS public.worker_run_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_run_id UUID NOT NULL REFERENCES public.worker_run(id) ON DELETE CASCADE,
    -- Denormalized for direct RLS (env_escalation posture).
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,

    -- Monotonic order within a run, assigned by the runner. Stable under equal
    -- timestamps; the unique constraint makes event-batch retries idempotent.
    seq BIGINT NOT NULL,
    -- Normalized agent-agnostic event type: agent-message / tool-use /
    -- file-change / status / result / error.
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT worker_run_event_run_seq_unique UNIQUE (worker_run_id, seq)
);

COMMENT ON TABLE public.worker_run_event IS
  'Append-only normalized transcript for a worker_run. Written by the worker via the service role; read via the parent run''s worker_run.read permission.';


-- This is the highest-row-count table in the schema and both of these columns
-- carry ON DELETE CASCADE. Unindexed, deleting one app or one tenant means two
-- sequential scans of the whole transcript history while holding locks. The
-- write cost on an append-only table is the accepted trade.
CREATE INDEX IF NOT EXISTS idx_worker_run_event_app_id
    ON public.worker_run_event(app_id);
CREATE INDEX IF NOT EXISTS idx_worker_run_event_tenant_id
    ON public.worker_run_event(tenant_id);

ALTER TABLE public.worker_run_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for worker_run_event" ON public.worker_run_event FOR SELECT
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('worker_run.read'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT ALL ON public.worker_run_event TO anon;
GRANT ALL ON public.worker_run_event TO authenticated;
GRANT ALL ON public.worker_run_event TO service_role;

-- =============================================================================
-- Worker Workspace — persistent "computer" for workers
-- =============================================================================
-- A durable workspace that owns compute (a local workspace in dev, an E2B
-- sandbox or suspend/resumable Fly machine in prod) ACROSS turns, so a worker
-- can be continued ("also add tests") in the same warm workspace with the
-- agent's session resumed. Inverts the ephemeral run<->machine 1:1: many
-- worker_run rows (turns) execute against one worker_workspace.
--
-- Agent-agnostic: `agent` + `session_ref` are generic. session_ref is whatever
-- resume handle the agent adapter emits (Claude Code session id, Codex/Cursor/
-- opencode equivalent). Agents without native resume still reuse the workspace.
--
-- Reuses the worker_run.* permissions (an environment is part of the workers
-- feature); no new enum values.

CREATE TABLE IF NOT EXISTS public.worker_workspace (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    environment_id UUID REFERENCES public.environment(id) ON DELETE SET NULL,

    agent TEXT NOT NULL,
    -- Model this environment's turns run (adapter alias). NULL = agent default.
    model TEXT,
    base_branch TEXT NOT NULL DEFAULT '',
    -- Where the durable branch of work lives (WIP checkpoints each turn).
    work_branch TEXT,

    -- Compute substrate + its handle. 'local' = a persistent workspace dir
    -- (dev/e2e); 'e2b' = a pausable sandbox; 'fly' = a suspend/resumable machine.
    substrate TEXT NOT NULL DEFAULT 'local'
        CONSTRAINT chk_worker_env_substrate CHECK (substrate IN ('local', 'e2b', 'fly')),
    machine_ref TEXT,
    -- Absolute workspace path (local substrate) or mount point.
    workspace_ref TEXT,
    -- Agent session handle for resume (adapter-specific; NULL until first turn).
    session_ref TEXT,

    -- Lifecycle: creating -> active -> (idle) suspended -> active -> destroyed.
    status TEXT NOT NULL DEFAULT 'creating'
        CONSTRAINT chk_worker_env_status
        CHECK (status IN ('creating', 'active', 'suspended', 'destroyed')),
    -- Serialization lock: one turn at a time per environment. The id of the
    -- run currently holding the environment, or NULL when free.
    current_run_id UUID,

    idle_ttl_s INTEGER NOT NULL DEFAULT 1800
        CONSTRAINT chk_worker_env_ttl CHECK (idle_ttl_s > 0),
    last_active_at TIMESTAMPTZ,
    failure_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ
);

COMMENT ON TABLE public.worker_workspace IS
  'Persistent worker workspace: durable compute (local dir / E2B sandbox / suspendable Fly machine) that many worker_run turns execute against, enabling multi-turn continue-in-the-same-workspace with agent session resume.';

CREATE INDEX IF NOT EXISTS idx_worker_workspace_app ON public.worker_workspace(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_worker_workspace_tenant ON public.worker_workspace(tenant_id);
-- Serves both the environment_id foreign key (ON DELETE SET NULL) and the
-- environment-scoped workspace listing.
CREATE INDEX IF NOT EXISTS idx_worker_workspace_environment_id
    ON public.worker_workspace(environment_id);
-- Reaper: suspend/destroy idle workspaces, stalest first.
CREATE INDEX IF NOT EXISTS idx_worker_workspace_idle
    ON public.worker_workspace(status, last_active_at)
    WHERE status IN ('active', 'suspended');

ALTER TABLE public.worker_workspace ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for worker_workspace" ON public.worker_workspace FOR SELECT
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('worker_run.read'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

CREATE POLICY "Enable insert access for worker_workspace" ON public.worker_workspace FOR INSERT
  TO authenticated
  WITH CHECK ((app_id IN ( SELECT private.authorized_app_ids('worker_run.insert'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

CREATE POLICY "Enable update access for worker_workspace" ON public.worker_workspace FOR UPDATE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('worker_run.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)))
  WITH CHECK ((app_id IN ( SELECT private.authorized_app_ids('worker_run.update'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

CREATE POLICY "Enable delete access for worker_workspace" ON public.worker_workspace FOR DELETE
  TO authenticated
  USING ((app_id IN ( SELECT private.authorized_app_ids('worker_run.delete'::public.app_permission))
    AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));

GRANT ALL ON public.worker_workspace TO anon;
GRANT ALL ON public.worker_workspace TO authenticated;
GRANT ALL ON public.worker_workspace TO service_role;

-- -----------------------------------------------------------------------------
-- Link runs to a persistent workspace (NULL = ephemeral one-shot run).
-- -----------------------------------------------------------------------------
ALTER TABLE public.worker_run
    ADD COLUMN IF NOT EXISTS workspace_id UUID
        REFERENCES public.worker_workspace(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS turn_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_worker_run_workspace_id
    ON public.worker_run(workspace_id, turn_index);
