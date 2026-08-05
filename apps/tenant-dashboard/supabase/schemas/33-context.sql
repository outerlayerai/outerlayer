-- =============================================================================
-- Context Mirror Schema (OuterLayer context layer)
-- =============================================================================
-- Purpose: Content-addressed, append-only Postgres mirror of `.outerlayer/`
-- context files synced from git. Git remains the source of truth; every table
-- here is rebuildable from git at any time. Written exclusively
-- by the server-side sync path (service_role) — no authenticated INSERT/
-- UPDATE/DELETE policy exists on any of these tables.
-- Dependencies: 01-types.sql (context.* permission enum values), 10-tenant.sql,
--   12-rbac.sql (role_permissions), 20-app.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- context_snapshot — one row per synced commit that actually touched context
-- -----------------------------------------------------------------------------
-- Snapshot identity is decoupled from commit sha: a push whose
-- compare touches no context files advances only context_head's commit_sha
-- and reuses the existing snapshot. New rows are written only when context
-- actually changes.
--
-- tenant_id is denormalized from app.tenant_id (house RLS pattern: every
-- app-scoped table carries tenant_id as a flat column so policies stay flat,
-- e.g. app_member_role in 31-app-member-role.sql — no EXISTS-joins in policies).
CREATE TABLE IF NOT EXISTS public.context_snapshot (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    classifier_version BIGINT NOT NULL,
    -- Per-skill count of non-content files (assets/scripts) present in git but
    -- not mirrored (NG2) — the tree's "N other files in git" annotation. Stored
    -- on the snapshot because the count is computed from the full git tree at
    -- sync time; the mirror never stores those asset paths, so it cannot be
    -- re-derived at read time. Shape: [{ scopePath, skillName, count }].
    excluded_counts JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uc_context_snapshot UNIQUE (app_id, commit_sha, classifier_version),

    -- Target key for the composite foreign keys on the three child tables. It
    -- adds no uniqueness beyond the primary key; it exists so a child can
    -- reference (snapshot_id, app_id) together and have the pair checked.
    CONSTRAINT context_snapshot_id_app_unique UNIQUE (id, app_id)
);

COMMENT ON TABLE public.context_snapshot IS 'One row per synced commit whose .outerlayer/ tree actually changed relative to its parent (clone-then-patch). Insert-only; never updated or deleted by user-facing paths. classifier_version stamps which classifier produced the tree so a classifier bump can trigger lazy resync.';
COMMENT ON COLUMN public.context_snapshot.classifier_version IS 'Version of the packages/context-core classifier that produced this snapshot''s tree entries.';

CREATE INDEX IF NOT EXISTS idx_context_snapshot_tenant_id ON public.context_snapshot(tenant_id);

-- -----------------------------------------------------------------------------
-- context_blob — content-addressed, immutable, per-app
-- -----------------------------------------------------------------------------
-- No FK from context_tree_entry.blob_sha to this table: oversize blobs
-- (> 1 MB oversize guard) are indexed by tree entries but
-- deliberately NOT mirrored here, so a tree entry may legitimately reference
-- a blob_sha with no corresponding context_blob row.
CREATE TABLE IF NOT EXISTS public.context_blob (
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    blob_sha TEXT NOT NULL,
    content TEXT NOT NULL,
    size BIGINT NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (app_id, blob_sha)
);

COMMENT ON TABLE public.context_blob IS 'Content-addressed, immutable blob store for .outerlayer/ file content. Per-app for RLS simplicity. No blob-size CHECK constraint — the >1MB mirror cap is sync-layer policy, not a DB invariant; oversize blobs are indexed elsewhere (context_tree_entry) but not content-mirrored here.';

-- The primary key leads with app_id, so it cannot serve the tenant_id foreign
-- key's RI check.
CREATE INDEX IF NOT EXISTS idx_context_blob_tenant_id ON public.context_blob(tenant_id);

-- -----------------------------------------------------------------------------
-- context_tree_entry — snapshot membership: one row per path in a snapshot
-- -----------------------------------------------------------------------------
-- tenant_id + app_id are denormalized from context_snapshot (house RLS
-- pattern — see table header comment), and avoid a join through
-- context_snapshot on this, the highest-volume, table.
CREATE TABLE IF NOT EXISTS public.context_tree_entry (
    snapshot_id UUID NOT NULL REFERENCES public.context_snapshot(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    blob_sha TEXT NOT NULL,
    -- 'kind' is TEXT, not a DB enum: kinds will grow (subagent, memory later)
    -- and per-kind enum migrations are not worth it. Validated in the app
    -- layer by packages/context-core.
    kind TEXT NOT NULL,
    scope_path TEXT NOT NULL,

    PRIMARY KEY (snapshot_id, path),

    -- The row's app_id must be the app that owns its snapshot. RLS on this
    -- table filters by the local app_id, so without this a row could point at
    -- another org's snapshot while claiming an app the caller does own, and
    -- the policies would serve it. tenant_app_fk does not catch that: the
    -- (tenant_id, app_id) pair is internally consistent, it is the snapshot
    -- linkage that is not.
    CONSTRAINT context_tree_entry_snapshot_app_fk
        FOREIGN KEY (snapshot_id, app_id)
        REFERENCES public.context_snapshot (id, app_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.context_tree_entry IS 'Snapshot membership: one row per classified path in a context_snapshot''s tree. Insert-only (copy-forward + patch on incremental sync). kind is unvalidated TEXT by design.';
COMMENT ON COLUMN public.context_tree_entry.scope_path IS 'Repo path of the .outerlayer/ directory this entry belongs to (nearest-scope-wins nesting).';

CREATE INDEX IF NOT EXISTS idx_context_tree_entry_app ON public.context_tree_entry(app_id);
CREATE INDEX IF NOT EXISTS idx_context_tree_entry_tenant_id ON public.context_tree_entry(tenant_id);

-- -----------------------------------------------------------------------------
-- context_head — the only mutable row: current synced commit per (app, branch)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.context_head (
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    snapshot_id UUID NOT NULL REFERENCES public.context_snapshot(id),
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (app_id, branch),

    -- Same invariant as context_tree_entry: the head's app must own the
    -- snapshot it points at. No delete action, matching the single-column key
    -- above — a snapshot still referenced by a head must not vanish.
    CONSTRAINT context_head_snapshot_app_fk
        FOREIGN KEY (snapshot_id, app_id)
        REFERENCES public.context_snapshot (id, app_id)
);

COMMENT ON TABLE public.context_head IS 'The only mutable state in the context mirror: current synced (commit_sha, snapshot_id) per (app, branch). Updated by every sync (initial, incremental, resync); no updated_at trigger — synced_at is set explicitly by the sync path on every write.';

-- snapshot_id intentionally has no ON DELETE behavior override (defaults to
-- NO ACTION / RESTRICT): retention pruning explicitly excludes
-- snapshots reachable from any context_head row, so this FK should never be
-- violated in normal operation; RESTRICT makes a retention bug fail loudly
-- instead of silently orphaning a branch's head.

-- That loud failure needs an index to be cheap: the NO ACTION check runs a
-- lookup on this table for every snapshot the pruner tries to delete, and the
-- primary key leads with app_id so it cannot serve either FK.
CREATE INDEX IF NOT EXISTS idx_context_head_snapshot_id ON public.context_head(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_context_head_tenant_id ON public.context_head(tenant_id);

-- -----------------------------------------------------------------------------
-- Row Level Security — all four tables: read-only for authenticated users,
-- gated on context.read + app membership; no INSERT/UPDATE/DELETE policies
-- for authenticated at all. Each table also carries an explicit
-- service_role_all policy (house pattern from agent_finding in 71-agent-insights.sql)
-- so the mirror is written exclusively by server-side sync via the
-- service_role client.
-- -----------------------------------------------------------------------------

ALTER TABLE public.context_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_tree_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_head ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."context_snapshot" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('context.read'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable read access for tenant users" ON "public"."context_blob" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('context.read'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable read access for tenant users" ON "public"."context_tree_entry" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('context.read'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

CREATE POLICY "Enable read access for tenant users" ON "public"."context_head" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('context.read'::"public"."app_permission") AS "authorized_app_ids") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Service role: full access
CREATE POLICY "service_role_all" ON "public"."context_snapshot" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

CREATE POLICY "service_role_all" ON "public"."context_blob" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

CREATE POLICY "service_role_all" ON "public"."context_tree_entry" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

CREATE POLICY "service_role_all" ON "public"."context_head" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). Declare
-- explicitly, matching every other table in this schema; RLS above still
-- gates every row (and blocks all writes for anon/authenticated — there are
-- no INSERT/UPDATE/DELETE policies for those roles).
-- -----------------------------------------------------------------------------

GRANT ALL ON public.context_snapshot TO anon;
GRANT ALL ON public.context_snapshot TO authenticated;
GRANT ALL ON public.context_snapshot TO service_role;

GRANT ALL ON public.context_blob TO anon;
GRANT ALL ON public.context_blob TO authenticated;
GRANT ALL ON public.context_blob TO service_role;

GRANT ALL ON public.context_tree_entry TO anon;
GRANT ALL ON public.context_tree_entry TO authenticated;
GRANT ALL ON public.context_tree_entry TO service_role;

GRANT ALL ON public.context_head TO anon;
GRANT ALL ON public.context_head TO authenticated;
GRANT ALL ON public.context_head TO service_role;

-- -----------------------------------------------------------------------------
-- create_context_snapshot — atomic multi-table write for a sync
-- -----------------------------------------------------------------------------
-- Supabase JS cannot transact across tables, and a sync writes up to four:
-- new blobs, the snapshot row, its tree entries, and (for a connected-branch
-- sync) the head pointer. This SQL function makes that one round trip.
--
-- p_branch is nullable: the sync service's `ensureSnapshotAt(ref)` primitive
-- resolves EITHER a branch OR a bare commit sha to a snapshot —
-- future callers (PR-branch views, eval baselines) materialize a snapshot
-- for a historical/foreign sha that must NOT move context_head. When
-- p_branch is NULL the function still writes blobs/snapshot/entries
-- atomically but skips the context_head upsert. Every sync caller (initial
-- sync, incremental sync, resync) always passes the connected branch.
--
-- Idempotent: UNIQUE(app_id, commit_sha, classifier_version) means a repeat
-- call for the same commit (duplicate resync, retried webhook) conflicts on
-- the snapshot row; ON CONFLICT DO UPDATE (a no-op self-write) lets
-- RETURNING report the existing snapshot id instead of erroring, so a
-- duplicate call is a success with no new rows rather than a thrown
-- unique-violation the caller has to catch.
--
-- House template: 56-deployment-saga-functions.sql. Bodies must match exact
-- database format for declarative schema diffing.
CREATE OR REPLACE FUNCTION private.create_context_snapshot(
    p_app_id UUID,
    p_tenant_id UUID,
    p_branch TEXT,
    p_commit_sha TEXT,
    p_classifier_version BIGINT,
    p_blobs JSONB,
    p_entries JSONB,
    p_excluded_counts JSONB DEFAULT '[]'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_snapshot_id UUID;
BEGIN
    -- Content-addressed, immutable blobs: skip any already present.
    INSERT INTO public.context_blob (tenant_id, app_id, blob_sha, content, size)
    SELECT p_tenant_id, p_app_id, b.blob_sha, b.content, b.size
    FROM jsonb_to_recordset(COALESCE(p_blobs, '[]'::jsonb))
        AS b(blob_sha TEXT, content TEXT, size BIGINT)
    ON CONFLICT (app_id, blob_sha) DO NOTHING;

    -- Insert (or reuse, on a duplicate call for the same commit) the
    -- snapshot row. On a duplicate call for the same commit the excluded
    -- counts are refreshed (a resync recomputes them from the full tree).
    INSERT INTO public.context_snapshot (tenant_id, app_id, commit_sha, classifier_version, excluded_counts)
    VALUES (p_tenant_id, p_app_id, p_commit_sha, p_classifier_version, COALESCE(p_excluded_counts, '[]'::jsonb))
    ON CONFLICT (app_id, commit_sha, classifier_version)
        DO UPDATE SET commit_sha = EXCLUDED.commit_sha,
                      excluded_counts = EXCLUDED.excluded_counts
    RETURNING id INTO v_snapshot_id;

    -- Tree entries for this snapshot. ON CONFLICT DO NOTHING makes a repeat
    -- call for the same (already-existing) snapshot_id a safe no-op rather
    -- than a PRIMARY KEY violation.
    INSERT INTO public.context_tree_entry (snapshot_id, tenant_id, app_id, path, blob_sha, kind, scope_path)
    SELECT v_snapshot_id, p_tenant_id, p_app_id, e.path, e.blob_sha, e.kind, e.scope_path
    FROM jsonb_to_recordset(COALESCE(p_entries, '[]'::jsonb))
        AS e(path TEXT, blob_sha TEXT, kind TEXT, scope_path TEXT)
    ON CONFLICT (snapshot_id, path) DO NOTHING;

    -- Advance the connected branch's head to this snapshot. Skipped when no
    -- branch is given (see function header) — a bare-sha materialization
    -- must never move the live pointer.
    IF p_branch IS NOT NULL THEN
        INSERT INTO public.context_head (app_id, tenant_id, branch, commit_sha, snapshot_id, synced_at)
        VALUES (p_app_id, p_tenant_id, p_branch, p_commit_sha, v_snapshot_id, now())
        ON CONFLICT (app_id, branch) DO UPDATE
            SET commit_sha = EXCLUDED.commit_sha,
                snapshot_id = EXCLUDED.snapshot_id,
                synced_at = now();
    END IF;

    RETURN v_snapshot_id;
END;
$function$
;

COMMENT ON FUNCTION private.create_context_snapshot IS
  'Atomic multi-table write for a context sync: inserts new blobs (content-addressed, ON CONFLICT DO NOTHING), inserts or reuses the snapshot row (idempotent on the UNIQUE(app_id, commit_sha, classifier_version) conflict), inserts its tree entries, and — when p_branch is given — upserts context_head. p_branch is nullable so ensureSnapshotAt(ref) can materialize a snapshot for a bare commit sha (future PR-branch/eval-baseline callers) without moving the connected branch''s head. SECURITY DEFINER — call only via service_role.';

-- -----------------------------------------------------------------------------
-- Public SECURITY INVOKER wrapper (service_role over PostgREST)
-- -----------------------------------------------------------------------------
-- `private` is absent from config.toml [api].schemas, so it has no PostgREST
-- RPC surface — the sync service calls the public wrapper via `.rpc(...)`,
-- which delegates to the DEFINER body. Mirrors the 23a-api-key-secret idiom.
CREATE OR REPLACE FUNCTION public.create_context_snapshot(
    p_app_id UUID,
    p_tenant_id UUID,
    p_branch TEXT,
    p_commit_sha TEXT,
    p_classifier_version BIGINT,
    p_blobs JSONB,
    p_entries JSONB,
    p_excluded_counts JSONB DEFAULT '[]'::jsonb
)
RETURNS UUID
LANGUAGE sql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT private.create_context_snapshot(
    p_app_id, p_tenant_id, p_branch, p_commit_sha, p_classifier_version, p_blobs, p_entries, p_excluded_counts
  );
$function$
;

-- -----------------------------------------------------------------------------
-- Grants — service_role only (the sync service's admin Supabase client).
-- Postgres default-grants EXECUTE to PUBLIC on creation; REVOKE from a named
-- role does NOT remove that PUBLIC grant, so revoke PUBLIC explicitly first.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION private.create_context_snapshot(UUID, UUID, TEXT, TEXT, BIGINT, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.create_context_snapshot(UUID, UUID, TEXT, TEXT, BIGINT, JSONB, JSONB, JSONB) TO service_role;

REVOKE EXECUTE ON FUNCTION public.create_context_snapshot(UUID, UUID, TEXT, TEXT, BIGINT, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_context_snapshot(UUID, UUID, TEXT, TEXT, BIGINT, JSONB, JSONB, JSONB) TO service_role;

-- =============================================================================
-- context_sync_event — insert-only sync attempt ledger
-- =============================================================================
-- One row per sync ATTEMPT (link / push / resync). `context-sync` self-reports
-- through its own db port (`recordSyncEvent`) — no orchestration-layer stamping.
-- The Context tab's History panel reads this table; it is the single source of
-- sync state. Insert-only: no updated_at, redelivery = a second row (attempt
-- log, by design).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.context_sync_event (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    commit_sha TEXT,  -- NULL only when a FAILED attempt dies before HEAD resolution
    -- The head commit's message from the push payload (link/resync leave it
    -- NULL — no extra provider call). The History panel renders it as the row's
    -- primary text, falling back to the short SHA.
    commit_message TEXT,
    trigger TEXT NOT NULL CHECK (trigger IN ('link','push','resync')),
    status TEXT NOT NULL CHECK (status IN ('synced','failed')),
    error TEXT,
    duration_ms BIGINT,
    -- ON DELETE SET NULL (not RESTRICT like context_head): future snapshot
    -- retention-pruning must never be blocked by this audit log.
    snapshot_id UUID REFERENCES public.context_snapshot(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_sync_event_error CHECK ((status = 'failed') = (error IS NOT NULL)),
    CONSTRAINT chk_sync_event_sha CHECK (status <> 'synced' OR commit_sha IS NOT NULL),
    CONSTRAINT chk_sync_event_snapshot CHECK (status = 'synced' OR snapshot_id IS NULL),

    -- Same invariant as the other two children. The column list on SET NULL
    -- clears only snapshot_id when a snapshot is pruned; without it Postgres
    -- would also null app_id, which is NOT NULL, and the prune would fail.
    -- MATCH SIMPLE means a row with a NULL snapshot_id skips the check, which
    -- is what the failed-sync rows need.
    CONSTRAINT context_sync_event_snapshot_app_fk
        FOREIGN KEY (snapshot_id, app_id)
        REFERENCES public.context_snapshot (id, app_id) ON DELETE SET NULL (snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_context_sync_event_app_created
    ON public.context_sync_event (app_id, created_at DESC);

-- Both back foreign keys on the referencing side, which Postgres never indexes
-- on its own. tenant_id carries ON DELETE CASCADE; snapshot_id ON DELETE SET
-- NULL. Without them a tenant delete or a retention prune scans this table.
CREATE INDEX IF NOT EXISTS idx_context_sync_event_tenant_id
    ON public.context_sync_event (tenant_id);
CREATE INDEX IF NOT EXISTS idx_context_sync_event_snapshot_id
    ON public.context_sync_event (snapshot_id);

-- -----------------------------------------------------------------------------
-- RLS — read-only for tenant users (writes are service_role only, same posture
-- as the mirror tables above). No INSERT/UPDATE/DELETE policy for authenticated.
-- -----------------------------------------------------------------------------

ALTER TABLE public.context_sync_event ENABLE ROW LEVEL SECURITY;

-- The History panel's realtime subscription carries no request headers, so
-- visibility derives from the caller's active memberships: member_app_ids()
-- requires context.read on the row's app, and the tenant_id conjunct keeps the
-- row's tenant inside the caller's membership set (this table's tenant_id is
-- not FK-tied to its app_id's tenant).
CREATE POLICY "Enable read access for tenant users" ON "public"."context_sync_event" FOR SELECT TO "authenticated" USING (("app_id" IN ( SELECT "private"."member_app_ids"('context.read'::"public"."app_permission")) AND "tenant_id" IN ( SELECT "private"."member_tenant_ids"())));

CREATE POLICY "service_role_all" ON "public"."context_sync_event" TO service_role USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- -----------------------------------------------------------------------------
-- Grants — granular SELECT/INSERT/UPDATE/DELETE, a deliberate deviation from
-- the house GRANT ALL: this new table does not hand out TRUNCATE (the DB
-- re-review's ungated-TRUNCATE finding). RLS above still gates every row and
-- blocks all writes for anon/authenticated.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON public.context_sync_event TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.context_sync_event TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.context_sync_event TO service_role;

-- -----------------------------------------------------------------------------
-- Realtime — the History panel subscribes for live sync attempts.
-- -----------------------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE public.context_sync_event;
