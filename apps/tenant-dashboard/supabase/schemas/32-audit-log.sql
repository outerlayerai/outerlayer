-- =============================================================================
-- Audit Log Schema (consolidated, polymorphic actor)
-- =============================================================================
-- Purpose: THE audit log. One immutable, write-once trail for platform-admin
--   actions AND tenant-visible access-control changes, with a polymorphic
--   actor (human | gateway | api_key | system | webhook) and optional tenant
--   scope. The human actor is `actor_id`, nullable because machine actors
--   have no profile.
--
-- Write path: service_role only, via AuditLogService in the dashboard
--   (src/services/audit-log/) — the single write seam. No triggers: writers
--   hold the actor and before/after context a trigger cannot attribute.
-- Read paths:
--   * service_role — the internal platform-admin viewer (all rows).
--   * authenticated — a tenant's own trail only (tenant_id = caller's tenant
--     AND audit_log.read, seeded to owner/admin). Platform-scoped rows
--     (tenant_id IS NULL) are never tenant-readable.
-- Dependencies: 02-functions-core.sql (tenant_id()), 10-tenant.sql, 11-profile.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Audit Log Table (Immutable)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    -- NULL = platform-scoped event; set = event belongs to a tenant's trail.
    -- Deliberately NOT a foreign key: rows are frozen at write time. An
    -- ON DELETE SET NULL would MUTATE hashed content when a tenant is
    -- deleted (row_hash covers tenant_id), turning every affected row into
    -- a false tamper alarm — and orphaned trails must stay identifiable
    -- (tenant_id present, tenant gone) for retention handling.
    tenant_id UUID,
    -- Human actor profile id at write time. NULL only for machine actors
    -- (actor_type <> 'human'). Same no-FK rationale as tenant_id: the value
    -- must survive profile deletion without mutating hashed content. Display
    -- identity survives via actor_label (denormalized email for humans).
    actor_id UUID,
    actor_type TEXT DEFAULT 'human' NOT NULL,  -- human | gateway | api_key | system | webhook
    actor_label TEXT,                          -- non-human handle: api key id, 'gateway', ...
    action_type TEXT NOT NULL,                 -- 'org_delete', 'member_role_changed', etc.
    target_type TEXT NOT NULL,                 -- 'tenant', 'user', 'membership', 'custom_role', ...
    target_id UUID,
    target_identifier TEXT,                    -- Human-readable name that survives target deletion
    details JSONB,
    before_state JSONB,
    after_state JSONB,
    -- Request context (nullable; absent for machine and background writers)
    ip_address INET,
    user_agent TEXT,
    request_id TEXT,
    -- Tamper-evidence hash chain, maintained by the audit_log_hash_chain
    -- trigger (99-triggers.sql). seq gives the chain a total order; each
    -- row_hash covers the row's content plus the previous row's hash, so any
    -- post-hoc edit or deletion is detectable via verify_audit_log_chain().
    seq BIGINT GENERATED ALWAYS AS IDENTITY,
    prev_hash TEXT,
    row_hash TEXT
);

COMMENT ON TABLE public.audit_log IS 'Immutable audit log: platform admin actions and tenant access-control changes, polymorphic actor';
COMMENT ON COLUMN public.audit_log.tenant_id IS 'NULL = platform-scoped event; set = part of that tenant''s trail. No FK: frozen at write time (hash chain), survives tenant deletion';
COMMENT ON COLUMN public.audit_log.actor_id IS 'Human actor profile id at write time; NULL for machine actors. No FK: frozen, survives profile deletion';
COMMENT ON COLUMN public.audit_log.actor_type IS 'Actor discriminator: human, gateway, api_key, system, webhook';
COMMENT ON COLUMN public.audit_log.actor_label IS 'Denormalized actor display: email for humans (survives profile deletion), machine handle (api key id, ''gateway'', ...) otherwise';
COMMENT ON COLUMN public.audit_log.target_identifier IS 'Human-readable identifier for audit display';
COMMENT ON COLUMN public.audit_log.before_state IS 'State before the action (for rollback reference)';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON public.audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON public.audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON public.audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON public.audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created ON public.audit_log(tenant_id, created_at DESC);

-- RLS: write-once via service_role; explicit block policies make immutability
-- auditable at a glance. Tenant members with audit_log.read (owner/admin by
-- default, custom roles by opt-in) can SELECT their own tenant's rows —
-- platform-scoped rows (tenant_id IS NULL) never match the tenant policy.
-- service_role_select + the tenant policy are intentionally separate permissive
-- SELECT policies (documented splinter multiple_permissive_policies exclusion).
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- RESTRICTIVE, not permissive. Permissive policies OR together, so a
-- USING(false) blocker denies only while it is the ONLY policy for that
-- command — adding "admins can redact PII" later would silently end
-- append-only with no diff to these lines. RESTRICTIVE ANDs, so it cannot be
-- out-voted.
CREATE POLICY "block_delete" ON "public"."audit_log" AS RESTRICTIVE FOR DELETE USING (false);

CREATE POLICY "block_update" ON "public"."audit_log" AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY "service_role_insert" ON "public"."audit_log" FOR INSERT WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

CREATE POLICY "service_role_select" ON "public"."audit_log" FOR SELECT USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

CREATE POLICY "Members can read own tenant audit trail" ON "public"."audit_log" FOR SELECT USING ((("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('audit_log.read'::"public"."app_permission"))));

-- Grants: RLS above is the real gate (matches the admin_audit_log pattern).
GRANT ALL ON public.audit_log TO anon;
GRANT ALL ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;

-- -----------------------------------------------------------------------------
-- Tamper-Evidence Hash Chain
-- -----------------------------------------------------------------------------
-- Immutability above is enforced by RLS, which service_role and superusers
-- bypass. The hash chain makes such edits DETECTABLE: each row's hash covers
-- its content plus the previous row's hash. verify_audit_log_chain() recomputes
-- the chain and reports any row whose content or linkage no longer matches.

-- Canonical hash of one row's content chained onto the previous hash. Shared
-- by the insert trigger and the verifier so the two can never drift.
CREATE OR REPLACE FUNCTION public.audit_log_compute_hash(p_prev TEXT, r public.audit_log)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
    SELECT encode(sha256(convert_to(
        coalesce(p_prev, 'genesis')
        || '|' || r.id::text
        || '|' || r.created_at::text
        || '|' || coalesce(r.tenant_id::text, '')
        || '|' || coalesce(r.actor_id::text, '')
        || '|' || r.actor_type
        || '|' || coalesce(r.actor_label, '')
        || '|' || r.action_type
        || '|' || r.target_type
        || '|' || coalesce(r.target_id::text, '')
        || '|' || coalesce(r.target_identifier, '')
        || '|' || coalesce(r.details::text, '')
        || '|' || coalesce(r.before_state::text, '')
        || '|' || coalesce(r.after_state::text, '')
        || '|' || coalesce(r.ip_address::text, '')
        || '|' || coalesce(r.user_agent, '')
        || '|' || coalesce(r.request_id, '')
    , 'utf8')), 'hex')
$$;

-- BEFORE INSERT trigger body: links the new row onto the chain. Client-supplied
-- prev_hash/row_hash values are overwritten unconditionally. The advisory xact
-- lock serializes chain computation; audit volume is human-action rate, so the
-- serialization cost is negligible.
CREATE OR REPLACE FUNCTION public.audit_log_hash_chain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
    v_prev TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('audit_log_hash_chain'));

    SELECT row_hash INTO v_prev
    FROM public.audit_log
    ORDER BY seq DESC
    LIMIT 1;

    NEW.prev_hash := v_prev;
    NEW.row_hash := public.audit_log_compute_hash(v_prev, NEW);

    RETURN NEW;
END;
$$;

-- Reports every row whose linkage or content hash no longer verifies.
-- An empty result means the chain is intact.
CREATE OR REPLACE FUNCTION public.verify_audit_log_chain()
RETURNS TABLE(bad_seq BIGINT, reason TEXT)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
    WITH links AS (
        SELECT seq, lag(row_hash) OVER (ORDER BY seq) AS chain_prev
        FROM public.audit_log
    )
    SELECT a.seq,
           CASE
               WHEN a.prev_hash IS DISTINCT FROM l.chain_prev THEN 'broken_link'
               ELSE 'content_hash_mismatch'
           END
    FROM public.audit_log a
    JOIN links l USING (seq)
    WHERE a.prev_hash IS DISTINCT FROM l.chain_prev
       OR a.row_hash IS DISTINCT FROM public.audit_log_compute_hash(a.prev_hash, a)
    ORDER BY a.seq
$$;

-- Note: the audit_log_hash_chain trigger itself is registered in
-- 99-triggers.sql alongside all other triggers.

REVOKE EXECUTE ON FUNCTION public.audit_log_compute_hash(text, public.audit_log) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_log_compute_hash(text, public.audit_log) TO service_role;

REVOKE EXECUTE ON FUNCTION public.audit_log_hash_chain() FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.verify_audit_log_chain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_audit_log_chain() TO service_role;
