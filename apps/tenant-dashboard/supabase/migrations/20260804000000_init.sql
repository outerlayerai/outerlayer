-- squawk-ignore-file
-- Squawk lints migrations for locking hazards against live tables. This
-- baseline only ever runs against an empty database — every table it
-- constrains is created in this same file — so those rules do not apply.
-- Cluster-level bootstrap: the `gateway` machine-to-machine role. Roles are
-- cluster objects, so a schema dump cannot carry this; it must precede every
-- policy below that is scoped TO gateway. Mirrors schemas/95-gateway-rls.sql.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gateway') THEN
    CREATE ROLE gateway NOLOGIN;
  END IF;
END $$;

GRANT gateway TO authenticator;
GRANT USAGE ON SCHEMA public TO gateway;



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






CREATE SCHEMA IF NOT EXISTS "ops";


ALTER SCHEMA "ops" OWNER TO "postgres";


COMMENT ON SCHEMA "ops" IS 'Operational telemetry about the database itself. No tenant data; not exposed over PostgREST.';



CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "btree_gist" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."app_permission" AS ENUM (
    'app.read',
    'app.insert',
    'app.update',
    'app.delete',
    'profile.read',
    'profile.insert',
    'profile.update',
    'profile.delete',
    'api_key.read',
    'api_key.insert',
    'api_key.update',
    'api_key.delete',
    'tenant.read',
    'tenant.update',
    'billing.read',
    'billing.update',
    'billing.insert',
    'git_connection.read',
    'git_connection.insert',
    'git_connection.update',
    'git_connection.delete',
    'git_branch.read',
    'git_branch.insert',
    'git_branch.update',
    'git_branch.delete',
    'dashboard.read',
    'dashboard.insert',
    'dashboard.update',
    'dashboard.delete',
    'app_member_role.read',
    'app_member_role.insert',
    'app_member_role.update',
    'app_member_role.delete',
    'sso_config.read',
    'sso_config.insert',
    'sso_config.update',
    'sso_config.delete',
    'custom_role.read',
    'custom_role.insert',
    'custom_role.update',
    'custom_role.delete',
    'trace.read',
    'experiment.read',
    'env_var.read',
    'env_var.insert',
    'env_var.update',
    'env_var.delete',
    'trace.write',
    'score.read',
    'score.write',
    'score.delete',
    'span.read',
    'session.read',
    'metrics.read',
    'environment.read',
    'environment.insert',
    'environment.update',
    'environment.delete',
    'environment.promote',
    'app_policy.update',
    'audit_log.read',
    'eval_run.read',
    'eval_run.insert',
    'eval_run.update',
    'eval_run.delete',
    'context.read',
    'context.insert',
    'context.update',
    'context.delete',
    'agents.sessions.self.read',
    'agents.sessions.team.read',
    'agents.findings.read',
    'agents.settings.write',
    'env_escalation.read',
    'env_escalation.update',
    'worker_run.read',
    'worker_run.insert',
    'worker_run.update',
    'worker_run.delete',
    'ai_cost_config.read',
    'ai_cost_config.insert',
    'ai_cost_config.update',
    'ai_cost_config.delete',
    'membership.read',
    'membership.insert',
    'membership.update',
    'membership.delete'
);


ALTER TYPE "public"."app_permission" OWNER TO "postgres";


CREATE TYPE "public"."app_role" AS ENUM (
    'admin',
    'write',
    'read',
    'disabled',
    'owner'
);


ALTER TYPE "public"."app_role" OWNER TO "postgres";


CREATE TYPE "public"."flag_strategy" AS ENUM (
    'global',
    'random',
    'targeted',
    'percentage'
);


ALTER TYPE "public"."flag_strategy" OWNER TO "postgres";


CREATE TYPE "public"."platform_permission" AS ENUM (
    'platform.org.read',
    'platform.org.delete',
    'platform.user.read',
    'platform.user.delete',
    'platform.temp_access.grant',
    'platform.flag.manage',
    'platform.audit.read',
    'platform.changelog.read',
    'platform.changelog.write',
    'platform.changelog.delete',
    'platform.entitlement.read',
    'platform.entitlement.write',
    'platform.entitlement.delete',
    'platform.dora.read',
    'platform.alert_agent_config.read',
    'platform.alert_agent_config.write',
    'platform.alert_agent_config.update',
    'platform.alert_agent_config.delete',
    'platform.alert_agent_run.read',
    'platform.alert_agent_run.write',
    'platform.sso_config.read',
    'platform.environment.read',
    'platform.promotion.intervene'
);


ALTER TYPE "public"."platform_permission" OWNER TO "postgres";


CREATE TYPE "public"."platform_role" AS ENUM (
    'platform_admin'
);


ALTER TYPE "public"."platform_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "ops"."capture_usage_snapshot"() RETURNS timestamp with time zone
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  v_captured_at TIMESTAMPTZ := NOW();
  v_stats_reset TIMESTAMPTZ;
BEGIN
  SELECT ds.stats_reset INTO v_stats_reset
  FROM pg_catalog.pg_stat_database ds
  WHERE ds.datname = current_database();

  INSERT INTO ops.table_usage_snapshot (
    captured_at, schemaname, relname,
    seq_scan, idx_scan, n_tup_ins, n_tup_upd, n_tup_del, n_live_tup, stats_reset
  )
  SELECT
    v_captured_at, st.schemaname, st.relname,
    st.seq_scan, st.idx_scan, st.n_tup_ins, st.n_tup_upd, st.n_tup_del,
    st.n_live_tup, v_stats_reset
  FROM pg_catalog.pg_stat_user_tables st
  -- Skip `ops` — the capture writes to these tables, so including them would
  -- record its own inserts as activity.
  WHERE st.schemaname NOT IN ('ops', 'pg_catalog', 'information_schema');

  INSERT INTO ops.index_usage_snapshot (
    captured_at, schemaname, relname, indexrelname,
    idx_scan, idx_tup_read, idx_tup_fetch, index_bytes, stats_reset
  )
  SELECT
    v_captured_at, si.schemaname, si.relname, si.indexrelname,
    si.idx_scan, si.idx_tup_read, si.idx_tup_fetch,
    pg_catalog.pg_relation_size(si.indexrelid), v_stats_reset
  FROM pg_catalog.pg_stat_user_indexes si
  WHERE si.schemaname NOT IN ('ops', 'pg_catalog', 'information_schema');

  RETURN v_captured_at;
END;
$$;


ALTER FUNCTION "ops"."capture_usage_snapshot"() OWNER TO "postgres";


COMMENT ON FUNCTION "ops"."capture_usage_snapshot"() IS 'Captures one snapshot of table + index usage counters. Returns the captured_at stamp shared by every row it wrote.';



CREATE OR REPLACE FUNCTION "ops"."index_usage_delta"("p_since" timestamp with time zone) RETURNS TABLE("schemaname" "text", "relname" "text", "indexrelname" "text", "baseline_at" timestamp with time zone, "latest_at" timestamp with time zone, "idx_scan_delta" bigint, "index_bytes" bigint, "stats_reset_between" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  WITH bounds AS (
    SELECT
      COALESCE(
        (SELECT MAX(s.captured_at) FROM ops.index_usage_snapshot s
          WHERE s.captured_at <= p_since),
        (SELECT MIN(s.captured_at) FROM ops.index_usage_snapshot s)
      ) AS baseline_at,
      (SELECT MAX(s.captured_at) FROM ops.index_usage_snapshot s) AS latest_at
  ),
  usable AS (
    SELECT b.baseline_at, b.latest_at FROM bounds b
    WHERE b.baseline_at IS NOT NULL AND b.baseline_at < b.latest_at
  ),
  baseline AS (
    SELECT s.* FROM ops.index_usage_snapshot s, usable u
    WHERE s.captured_at = u.baseline_at
  ),
  latest AS (
    SELECT s.* FROM ops.index_usage_snapshot s, usable u
    WHERE s.captured_at = u.latest_at
  )
  SELECT
    l.schemaname,
    l.relname,
    l.indexrelname,
    b.captured_at,
    l.captured_at,
    CASE WHEN reset_between THEN NULL ELSE l.idx_scan - b.idx_scan END,
    l.index_bytes,
    reset_between
  FROM latest l
  JOIN baseline b
    ON b.schemaname = l.schemaname AND b.indexrelname = l.indexrelname
  CROSS JOIN LATERAL (
    SELECT l.stats_reset IS DISTINCT FROM b.stats_reset AS reset_between
  ) r
  ORDER BY 1, 2, 3;
$$;


ALTER FUNCTION "ops"."index_usage_delta"("p_since" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "ops"."index_usage_delta"("p_since" timestamp with time zone) IS 'Index usage between a baseline capture (newest at or before p_since, else the oldest held) and the newest capture. No rows when fewer than two captures exist; NULL deltas when a stats reset falls between them. Always read baseline_at for the real window.';



CREATE OR REPLACE FUNCTION "ops"."table_usage_delta"("p_since" timestamp with time zone) RETURNS TABLE("schemaname" "text", "relname" "text", "baseline_at" timestamp with time zone, "latest_at" timestamp with time zone, "seq_scan_delta" bigint, "idx_scan_delta" bigint, "writes_delta" bigint, "n_live_tup" bigint, "stats_reset_between" boolean)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  WITH bounds AS (
    SELECT
      COALESCE(
        (SELECT MAX(s.captured_at) FROM ops.table_usage_snapshot s
          WHERE s.captured_at <= p_since),
        (SELECT MIN(s.captured_at) FROM ops.table_usage_snapshot s)
      ) AS baseline_at,
      (SELECT MAX(s.captured_at) FROM ops.table_usage_snapshot s) AS latest_at
  ),
  -- Baseline == latest means only one capture exists, or p_since is after it.
  -- No window, so return nothing rather than a false zero.
  usable AS (
    SELECT b.baseline_at, b.latest_at FROM bounds b
    WHERE b.baseline_at IS NOT NULL AND b.baseline_at < b.latest_at
  ),
  baseline AS (
    SELECT s.* FROM ops.table_usage_snapshot s, usable u
    WHERE s.captured_at = u.baseline_at
  ),
  latest AS (
    SELECT s.* FROM ops.table_usage_snapshot s, usable u
    WHERE s.captured_at = u.latest_at
  )
  SELECT
    l.schemaname,
    l.relname,
    b.captured_at,
    l.captured_at,
    CASE WHEN reset_between THEN NULL ELSE l.seq_scan - b.seq_scan END,
    CASE WHEN reset_between THEN NULL ELSE COALESCE(l.idx_scan, 0) - COALESCE(b.idx_scan, 0) END,
    CASE WHEN reset_between THEN NULL
         ELSE (l.n_tup_ins + l.n_tup_upd + l.n_tup_del)
            - (b.n_tup_ins + b.n_tup_upd + b.n_tup_del) END,
    l.n_live_tup,
    reset_between
  FROM latest l
  JOIN baseline b
    ON b.schemaname = l.schemaname AND b.relname = l.relname
  CROSS JOIN LATERAL (
    SELECT l.stats_reset IS DISTINCT FROM b.stats_reset AS reset_between
  ) r
  ORDER BY 1, 2;
$$;


ALTER FUNCTION "ops"."table_usage_delta"("p_since" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "ops"."table_usage_delta"("p_since" timestamp with time zone) IS 'Table usage between a baseline capture (newest at or before p_since, else the oldest held) and the newest capture. No rows when fewer than two captures exist; NULL deltas when a stats reset falls between them. Always read baseline_at for the real window.';



CREATE OR REPLACE FUNCTION "private"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM private.effective_app_permissions(app_authorize.target_app_id) AS p
    WHERE p = app_authorize.requested_permission
  );
$$;


ALTER FUNCTION "private"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."authorize"("requested_permission" "public"."app_permission") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_tenant_id uuid := public.tenant_id();
  v_role public.app_role;
  v_custom_role_id uuid;
begin
  -- The domain is an active, permission-bearing membership of the current
  -- tenant — the same state gate the resolver uses (status = 'active' AND
  -- role <> 'disabled'). A disabled/absent membership, or a spoofed header that
  -- resolved tenant_id() to NULL, yields no row and denies.
  select m.role, m.custom_role_id
    into v_role, v_custom_role_id
  from public.membership m
  where m.user_id = auth.uid()
    and m.tenant_id = v_tenant_id
    and m.status = 'active'
    and m.role <> 'disabled';

  if not found then
    return false;
  end if;

  -- One precedence: a stored custom_role_id wins over the built-in role. The set
  -- helper applies it and is tenant-scoped, so a custom role from another tenant
  -- contributes nothing.
  return exists (
    select 1
    from private.get_org_permission_set(v_custom_role_id, v_role, v_tenant_id) as p
    where p = authorize.requested_permission
  );
end;
$$;


ALTER FUNCTION "private"."authorize"("requested_permission" "public"."app_permission") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."authorized_app_ids"("requested_permission" "public"."app_permission") RETURNS SETOF "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
    SELECT a.id
    FROM public.app a
    WHERE a.tenant_id = public.tenant_id()
      AND EXISTS (
        SELECT 1
        FROM private.effective_app_permissions(a.id) AS p
        WHERE p = authorized_app_ids.requested_permission
      );
END;
$$;


ALTER FUNCTION "private"."authorized_app_ids"("requested_permission" "public"."app_permission") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
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
$$;


ALTER FUNCTION "private"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."effective_app_permissions"("target_app_id" "uuid") RETURNS SETOF "public"."app_permission"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_tenant_id uuid := public.tenant_id();
  v_membership_id uuid;
  v_membership_role public.app_role;
  v_org_custom_role_id uuid;
  v_is_app_scoped boolean;
  v_app_role public.app_role;
  v_app_custom_role_id uuid;
BEGIN
  -- I1 + I2 as the domain: an active, permission-bearing membership of the current
  -- tenant, with target_app_id inside that tenant's app universe. The LEFT JOIN is
  -- the tenant closure: an app owned by another tenant fails the closure predicate
  -- and yields no row; an id owned by no tenant (a.id IS NULL — the row does not
  -- exist yet when INSERT WITH CHECK runs) is a prospective app of this tenant. The
  -- status/role predicates are the state gate.
  SELECT m.id, m.role, m.custom_role_id, m.is_app_scoped
    INTO v_membership_id, v_membership_role, v_org_custom_role_id, v_is_app_scoped
  FROM public.membership m
  LEFT JOIN public.app a
    ON a.id = target_app_id
  WHERE m.user_id = auth.uid()
    AND m.tenant_id = v_tenant_id
    AND m.status = 'active'
    AND m.role <> 'disabled'
    AND (a.id IS NULL OR a.tenant_id = m.tenant_id);

  IF NOT FOUND THEN
    -- Outside the tenant closure, or no active/enabled membership → no answer.
    RETURN;
  END IF;

  -- I3, top of precedence: an owner's effective set for every app in the tenant is
  -- exactly their org-level set, regardless of any per-app override row.
  IF v_membership_role = 'owner' THEN
    RETURN QUERY SELECT * FROM private.get_org_permission_set(v_org_custom_role_id, v_membership_role, v_tenant_id);
    RETURN;
  END IF;

  -- I3, per-app override (replacement, not additive): custom_role_id wins over the
  -- built-in role. This lookup runs only for the row admitted by the domain above,
  -- so it can never attach to a disabled/cross-tenant member.
  SELECT amr.role, amr.custom_role_id INTO v_app_role, v_app_custom_role_id
  FROM public.app_member_role amr
  WHERE amr.membership_id = v_membership_id
    AND amr.app_id = target_app_id;

  IF FOUND THEN
    IF v_app_custom_role_id IS NOT NULL THEN
      RETURN QUERY
        SELECT crp.permission
        FROM public.custom_role_permission crp
        JOIN public.custom_role cr ON cr.id = crp.custom_role_id
        WHERE crp.custom_role_id = v_app_custom_role_id
          AND cr.tenant_id = v_tenant_id;
    ELSE
      RETURN QUERY
        SELECT rp.permission
        FROM public.role_permissions rp
        WHERE rp.role = v_app_role;
    END IF;
    RETURN;
  END IF;

  -- I3, no per-app override: an app-scoped member is confined to apps it has an
  -- explicit row for (empty here); everyone else inherits the org-level set.
  IF v_is_app_scoped THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT * FROM private.get_org_permission_set(v_org_custom_role_id, v_membership_role, v_tenant_id);
END;
$$;


ALTER FUNCTION "private"."effective_app_permissions"("target_app_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."get_dashboard_app_id"("target_dashboard_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT app_id FROM public.dashboard
  WHERE id = target_dashboard_id
    AND tenant_id = public.tenant_id();
$$;


ALTER FUNCTION "private"."get_dashboard_app_id"("target_dashboard_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."get_org_permission_set"("p_custom_role_id" "uuid", "p_role" "public"."app_role", "p_tenant_id" "uuid") RETURNS SETOF "public"."app_permission"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF p_custom_role_id IS NOT NULL THEN
    RETURN QUERY
      SELECT crp.permission
      FROM public.custom_role_permission crp
      JOIN public.custom_role cr ON cr.id = crp.custom_role_id
      WHERE crp.custom_role_id = p_custom_role_id
        AND cr.tenant_id = p_tenant_id;
  ELSE
    RETURN QUERY
      SELECT rp.permission
      FROM public.role_permissions rp
      WHERE rp.role = p_role;
  END IF;
END;
$$;


ALTER FUNCTION "private"."get_org_permission_set"("p_custom_role_id" "uuid", "p_role" "public"."app_role", "p_tenant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."member_app_ids"("requested_permission" "public"."app_permission") RETURNS SETOF "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
    SELECT a.id
    FROM public.membership m
    JOIN public.app a ON a.tenant_id = m.tenant_id
    LEFT JOIN public.app_member_role amr
      ON amr.membership_id = m.id AND amr.app_id = a.id
    WHERE m.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role <> 'disabled'
      AND (m.role = 'owner' OR NOT m.is_app_scoped OR amr.membership_id IS NOT NULL)
      AND EXISTS (
        SELECT 1
        FROM private.get_org_permission_set(
          CASE WHEN m.role = 'owner' OR amr.membership_id IS NULL THEN m.custom_role_id ELSE amr.custom_role_id END,
          CASE WHEN m.role = 'owner' OR amr.membership_id IS NULL THEN m.role ELSE amr.role END,
          m.tenant_id
        ) p
        WHERE p = member_app_ids.requested_permission
      );
END;
$$;


ALTER FUNCTION "private"."member_app_ids"("requested_permission" "public"."app_permission") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."member_tenant_ids"() RETURNS SETOF "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
    SELECT m.tenant_id
    FROM public.membership m
    WHERE m.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role <> 'disabled';
END;
$$;


ALTER FUNCTION "private"."member_tenant_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."platform_authorize"("required_permission" "public"."platform_permission") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  user_platform_role platform_role;
  has_permission boolean;
BEGIN
  -- Get the platform_role from JWT claims
  user_platform_role := (auth.jwt() ->> 'platform_role')::platform_role;

  -- If no platform role, deny access
  IF user_platform_role IS NULL THEN
    RETURN false;
  END IF;

  -- Check if this role has the required permission
  SELECT EXISTS (
    SELECT 1 FROM platform_role_permissions
    WHERE role = user_platform_role
      AND permission = required_permission
  ) INTO has_permission;

  RETURN has_permission;
END;
$$;


ALTER FUNCTION "private"."platform_authorize"("required_permission" "public"."platform_permission") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."resolve_member_tenant"("p_raw" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_tenant uuid;
BEGIN
  -- A present-but-malformed value is a spoof shape, not an absent one: fail
  -- closed (NULL) rather than let the caller fall through to another source.
  BEGIN
    v_tenant := p_raw::uuid;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  -- The claimed tenant scopes the request only if the caller is an active,
  -- permission-bearing member of it — the same domain predicate the per-app
  -- resolver uses. A non-member value returns NULL (deny), so a spoofed header
  -- or a stale claim yields empty result sets, never another tenant's rows.
  IF EXISTS (
    SELECT 1
    FROM public.membership m
    WHERE m.user_id = auth.uid()
      AND m.tenant_id = v_tenant
      AND m.status = 'active'
      AND m.role <> 'disabled'
  ) THEN
    RETURN v_tenant;
  END IF;

  RETURN NULL;
END;
$$;


ALTER FUNCTION "private"."resolve_member_tenant"("p_raw" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO private.api_key_secret (api_key_id, key_digest, pepper_version)
  VALUES (p_api_key_id, p_key_digest, p_pepper_version)
  ON CONFLICT (api_key_id) DO UPDATE
    SET key_digest = EXCLUDED.key_digest,
        pepper_version = EXCLUDED.pepper_version;
END;
$$;


ALTER FUNCTION "private"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "private"."verify_api_key"("p_key_digest" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'appId', k.app_id,
    'tenantId', k.tenant_id,
    'appName', COALESCE(a.name, ''),
    'stripeCustomerId', COALESCE(b.stripe_customer_id, ''),
    'stripeSubscriptionId', b.stripe_subscription_id,
    'branchId', COALESCE(br.id::text, ''),
    'environmentId', k.environment_id,
    'allowedEnvKinds', to_jsonb(k.allowed_env_kinds),
    'apiKeyId', k.api_key_id,
    'actorMembershipId', k.actor_membership_id,
    'permissions', COALESCE(to_jsonb(k.permissions), '[]'::jsonb)
  ))
  INTO v_result
  FROM public.api_key k
  JOIN private.api_key_secret s ON s.api_key_id = k.id
  JOIN public.app a ON a.id = k.app_id
  LEFT JOIN public.billing b ON b.tenant_id = k.tenant_id
  LEFT JOIN LATERAL (
    SELECT gb.id
    FROM public.git_branch gb
    WHERE gb.app_id = k.app_id
    LIMIT 1
  ) br ON true
  WHERE s.key_digest = p_key_digest
    AND (k.expires_at IS NULL OR k.expires_at > now());

  RETURN v_result;
END;
$$;


ALTER FUNCTION "private"."verify_api_key"("p_key_digest" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT private.app_authorize(requested_permission, target_app_id);
$$;


ALTER FUNCTION "public"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_seed_default_env"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.environment (
    tenant_id, app_id, name, is_default, current_version, created_by
  ) VALUES (
    NEW.tenant_id, NEW.id, 'dev', true, 0, NEW.created_by
  )
  ON CONFLICT (app_id, name) DO NOTHING;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."app_seed_default_env"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."app_seed_default_env"() IS 'AFTER INSERT ON app: seeds the mandatory default ''dev'' environment (no-pin) so every app has exactly one default env regardless of create path. Idempotent via ON CONFLICT (app_id, name).';


SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tenant_id" "uuid",
    "actor_id" "uuid",
    "actor_type" "text" DEFAULT 'human'::"text" NOT NULL,
    "actor_label" "text",
    "action_type" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid",
    "target_identifier" "text",
    "details" "jsonb",
    "before_state" "jsonb",
    "after_state" "jsonb",
    "ip_address" "inet",
    "user_agent" "text",
    "request_id" "text",
    "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    "prev_hash" "text",
    "row_hash" "text"
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."audit_log" IS 'Immutable audit log: platform admin actions and tenant access-control changes, polymorphic actor';



COMMENT ON COLUMN "public"."audit_log"."tenant_id" IS 'NULL = platform-scoped event; set = part of that tenant''s trail';



COMMENT ON COLUMN "public"."audit_log"."actor_id" IS 'Human actor profile; NULL for machine actors and after profile deletion (row is preserved)';



COMMENT ON COLUMN "public"."audit_log"."actor_type" IS 'Actor discriminator: human, gateway, api_key, system, webhook';



COMMENT ON COLUMN "public"."audit_log"."actor_label" IS 'Non-human actor handle (api key id, ''gateway'', ...); read actor = actor_id when human, else actor_label';



COMMENT ON COLUMN "public"."audit_log"."target_identifier" IS 'Human-readable identifier for audit display';



COMMENT ON COLUMN "public"."audit_log"."before_state" IS 'State before the action (for rollback reference)';



CREATE OR REPLACE FUNCTION "public"."audit_log_compute_hash"("p_prev" "text", "r" "public"."audit_log") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."audit_log_compute_hash"("p_prev" "text", "r" "public"."audit_log") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_log_hash_chain"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."audit_log_hash_chain"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorize"("requested_permission" "public"."app_permission") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT private.authorize(requested_permission);
$$;


ALTER FUNCTION "public"."authorize"("requested_permission" "public"."app_permission") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."change_member_role_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_new_role" character varying DEFAULT NULL::character varying, "p_custom_role_id" "uuid" DEFAULT NULL::"uuid", "p_ip_address" "inet" DEFAULT NULL::"inet", "p_user_agent" "text" DEFAULT NULL::"text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_membership RECORD;
    v_after RECORD;
    v_email TEXT;
    v_actor_role public.app_role;
    v_actor_custom_role_id uuid;
BEGIN
    -- Actor authority. Resolved from the live membership table, never from a
    -- claim or an argument the caller chose. Authority is a PERMISSION check
    -- (membership.update), not a hardcoded role list: a custom role always
    -- pins the built-in role column to 'read' (see below), so a tenant that
    -- grants membership.update to a custom role would otherwise be locked out
    -- by a role-name check even though get_org_permission_set says they can.
    SELECT m.role, m.custom_role_id INTO v_actor_role, v_actor_custom_role_id
    FROM public.membership m
    WHERE m.user_id = p_actor_id
      AND m.tenant_id = p_tenant_id
      AND m.status = 'active'
      AND m.role <> 'disabled';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'actor_not_authorized';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM private.get_org_permission_set(v_actor_custom_role_id, v_actor_role, p_tenant_id) p
        WHERE p = 'membership.update'
    ) THEN
        RAISE EXCEPTION 'actor_not_authorized';
    END IF;

    IF p_actor_id = p_target_user_id THEN
        RAISE EXCEPTION 'cannot_change_own_role';
    END IF;

    SELECT id, role, custom_role_id INTO v_membership
    FROM public.membership
    WHERE user_id = p_target_user_id
      AND tenant_id = p_tenant_id
      AND status IN ('active', 'pending')
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'member_not_found';
    END IF;

    -- Only an owner may mint another owner. Deliberately role-based, not the
    -- membership.update permission check above: owner is a built-in-role
    -- capability, not something a permission grants, so it is exempt from the
    -- custom-role pinning trap that motivated the check above it.
    IF p_new_role = 'owner' AND v_actor_role <> 'owner' THEN
        RAISE EXCEPTION 'only_owner_can_promote_to_owner';
    END IF;

    IF p_custom_role_id IS NOT NULL THEN
        -- Custom role active. Pin role to the built-in 'read' fallback so the role
        -- column always holds a real built-in (consulted only if the custom role
        -- is later cleared); the custom_role_id is what drives permissions.
        UPDATE public.membership
        SET custom_role_id = p_custom_role_id,
            role = 'read'::public.app_role
        WHERE id = v_membership.id;
    ELSE
        UPDATE public.membership
        SET role = p_new_role::public.app_role, custom_role_id = NULL
        WHERE id = v_membership.id;
    END IF;

    SELECT role, custom_role_id INTO v_after
    FROM public.membership
    WHERE id = v_membership.id;

    SELECT email INTO v_email FROM public.profile WHERE id = p_target_user_id;

    INSERT INTO public.audit_log (
        tenant_id, actor_id, actor_label, action_type, target_type, target_id,
        target_identifier, before_state, after_state,
        ip_address, user_agent, request_id
    ) VALUES (
        p_tenant_id, p_actor_id,
        (SELECT email FROM public.profile WHERE id = p_actor_id),
        'member_role_changed', 'membership', v_membership.id,
        v_email,
        jsonb_build_object('role', v_membership.role, 'custom_role_id', v_membership.custom_role_id),
        jsonb_build_object('role', v_after.role, 'custom_role_id', v_after.custom_role_id),
        p_ip_address, p_user_agent, p_request_id
    );

    RETURN jsonb_build_object(
        'membership_id', v_membership.id,
        'before_role', v_membership.role,
        'after_role', v_after.role
    );
END;
$$;


ALTER FUNCTION "public"."change_member_role_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_new_role" character varying, "p_custom_role_id" "uuid", "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."change_user_password"("current_plain_password" character varying, "new_plain_password" character varying) RETURNS "json"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
_uid uuid; -- for checking by 'is not found'
user_id uuid; -- to store the user id from the request
BEGIN
  -- First of all check the new password rules
  -- not empty
  IF (new_plain_password = '') IS NOT FALSE THEN
    RAISE EXCEPTION 'New password is empty';
  -- minimum 6 chars
  ELSIF char_length(new_plain_password) < 6 THEN
    RAISE EXCEPTION 'It must be at least 6 characters in length';
  ELSIF char_length(new_plain_password) > 30 THEN
    RAISE EXCEPTION 'It must be no more than 30 characters in length';
  END IF;

  -- Get user by his current auth.uid and current password
  user_id := auth.uid();
  SELECT id INTO _uid
  FROM auth.users
  WHERE id = user_id
  AND encrypted_password =
  crypt(current_plain_password::text, auth.users.encrypted_password);

  -- Check the currect password
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Incorrect password';
  END IF;

  -- Then set the new password
  UPDATE auth.users SET
  encrypted_password =
  crypt(new_plain_password, gen_salt('bf'))
  WHERE id = user_id;

  RETURN '{"data":true}';
END;
$$;


ALTER FUNCTION "public"."change_user_password"("current_plain_password" character varying, "new_plain_password" character varying) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_membership_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    -- Only check on INSERT or when status changes to 'active'
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status != 'active') THEN
        IF (SELECT COUNT(*) FROM public.membership
            WHERE user_id = NEW.user_id
            AND status = 'active') >= 10 THEN
            RAISE EXCEPTION 'User cannot belong to more than 10 organizations';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."check_membership_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_expired_temp_access"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  expired_count integer := 0;
  deleted_memberships integer := 0;
  grant_record record;
  result jsonb;
BEGIN
  -- Find all expired grants that haven't been revoked yet
  FOR grant_record IN
    SELECT
      tag.id,
      tag.created_by,
      tag.tenant_id,
      tag.expires_at
    FROM temp_access_grant tag
    WHERE tag.revoked_at IS NULL
      AND tag.expires_at <= NOW()
  LOOP
    -- Delete the corresponding membership entry (role is now in membership)
    DELETE FROM membership
    WHERE user_id = grant_record.created_by
      AND tenant_id = grant_record.tenant_id;

    IF FOUND THEN
      deleted_memberships := deleted_memberships + 1;
    END IF;

    -- Mark the grant as revoked (by system cleanup)
    UPDATE temp_access_grant
    SET revoked_at = NOW()
    WHERE id = grant_record.id;

    expired_count := expired_count + 1;
  END LOOP;

  result := jsonb_build_object(
    'expired_grants_processed', expired_count,
    'memberships_deleted', deleted_memberships,
    'cleanup_timestamp', NOW()
  );

  RETURN result;
END;
$$;


ALTER FUNCTION "public"."cleanup_expired_temp_access"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb" DEFAULT '[]'::"jsonb") RETURNS "uuid"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
  SELECT private.create_context_snapshot(
    p_app_id, p_tenant_id, p_branch, p_commit_sha, p_classifier_version, p_blobs, p_entries, p_excluded_counts
  );
$$;


ALTER FUNCTION "public"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_organization_transaction"("p_user_id" "uuid", "p_organization_name" "text", "p_company_name" "text", "p_stripe_customer_id" character varying DEFAULT NULL::character varying, "p_tier_id" "text" DEFAULT 'hobby'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_tenant_id uuid;
  v_result jsonb := '{}';
BEGIN
  -- Validate inputs
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_id is required';
  END IF;

  IF p_organization_name IS NULL OR p_organization_name = '' THEN
    RAISE EXCEPTION 'organization_name is required';
  END IF;

  IF p_company_name IS NULL OR p_company_name = '' THEN
    RAISE EXCEPTION 'company_name is required';
  END IF;

  -- stripe_customer_id is optional: null when billing is disabled (self-hosting).

  -- Check if organization name already exists (case-insensitive)
  IF EXISTS (SELECT 1 FROM tenant WHERE LOWER(organization_name) = LOWER(p_organization_name)) THEN
    RAISE EXCEPTION 'Organization name already exists';
  END IF;

  -- Step 1: Create tenant
  INSERT INTO tenant (organization_name, company_name, created_by)
  VALUES (p_organization_name, p_company_name, p_user_id)
  RETURNING tenant_id INTO v_tenant_id;

  v_result := jsonb_set(v_result, '{tenant_id}', to_jsonb(v_tenant_id::text));
  v_result := jsonb_set(v_result, '{tenant}', '"created"');

  -- Step 2: Create billing record. stripe_customer_id is null when billing is
  -- disabled; tier_id defaults to 'hobby' (hosted free) but self-host passes
  -- 'enterprise' so entitlements resolve unlimited through the normal resolver.
  INSERT INTO billing (tenant_id, stripe_customer_id, tier_id, created_by)
  VALUES (v_tenant_id, p_stripe_customer_id, COALESCE(p_tier_id, 'hobby'), p_user_id);

  v_result := jsonb_set(v_result, '{billing}', '"created"');

  -- Step 3: Create membership with owner role
  INSERT INTO membership (user_id, tenant_id, role, status)
  VALUES (p_user_id, v_tenant_id, 'owner', 'active');

  v_result := jsonb_set(v_result, '{membership}', '"created"');

  -- New orgs provision no "Gateway System" fake user. Machine-to-machine
  -- writes attribute via set_created_columns() (created_by NULL for the
  -- gateway role); the gateway needs no per-tenant profile id as its JWT sub.

  -- Step 5: record the new org as the creator's last-active org.
  UPDATE profile SET last_active_tenant_id = v_tenant_id WHERE id = p_user_id;
  v_result := jsonb_set(v_result, '{last_active_tenant_id}', to_jsonb(v_tenant_id::text));

  v_result := jsonb_set(v_result, '{organization_name}', to_jsonb(p_organization_name));

  RETURN v_result;

EXCEPTION WHEN OTHERS THEN
  -- Any failure automatically rolls back the entire transaction
  -- Re-raise to let caller handle (and rollback Stripe customer)
  RAISE;
END $$;


ALTER FUNCTION "public"."create_organization_transaction"("p_user_id" "uuid", "p_organization_name" "text", "p_company_name" "text", "p_stripe_customer_id" character varying, "p_tier_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."custom_access_token_hook"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  claims jsonb;
  user_role_value public.app_role;
  custom_role_id_value uuid;
  platform_role_value public.platform_role;
  impersonating_tenant uuid;
  active_tenant_id uuid;
begin
  claims := event->'claims';

  -- Get the active tenant_id from app_metadata (set by set_claim when switching orgs)
  active_tenant_id := (event->'claims'->'app_metadata'->>'tenant_id')::uuid;

  -- Get the tenant-specific role for the ACTIVE tenant (from membership table)
  -- Wrapped in sub-block: if custom_role_id column is missing (pre-migration),
  -- gracefully degrade to role-only lookup so auth is never blocked.
  BEGIN
    IF active_tenant_id IS NOT NULL THEN
      SELECT role, custom_role_id INTO user_role_value, custom_role_id_value
      FROM public.membership
      WHERE user_id = (event->>'user_id')::uuid
        AND tenant_id = active_tenant_id
        AND status = 'active';
    ELSE
      -- Fallback: get any role from an active membership (for backwards compatibility)
      SELECT role, custom_role_id INTO user_role_value, custom_role_id_value
      FROM public.membership
      WHERE user_id = (event->>'user_id')::uuid
        AND status = 'active'
      LIMIT 1;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Gracefully degrade: set role without custom_role_id
    custom_role_id_value := NULL;
    RAISE WARNING 'custom_access_token_hook: membership lookup failed: %', SQLERRM;
    IF active_tenant_id IS NOT NULL THEN
      SELECT role INTO user_role_value
      FROM public.membership
      WHERE user_id = (event->>'user_id')::uuid
        AND tenant_id = active_tenant_id
        AND status = 'active';
    END IF;
  END;

  -- Get the platform role (from platform_user_role table)
  SELECT role INTO platform_role_value
  FROM public.platform_user_role
  WHERE user_id = (event->>'user_id')::uuid
  LIMIT 1;

  -- Get active impersonation grant (if any) for platform admins
  -- Only set if user has a platform role and grant is active (not expired, not revoked)
  IF platform_role_value IS NOT NULL THEN
    SELECT tenant_id INTO impersonating_tenant
    FROM public.temp_access_grant
    WHERE created_by = (event->>'user_id')::uuid
      AND revoked_at IS NULL
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  -- Set user_role claim (tenant context)
  IF user_role_value IS NOT NULL THEN
    claims := jsonb_set(claims, '{user_role}', to_jsonb(user_role_value));
  ELSE
    claims := jsonb_set(claims, '{user_role}', 'null');
  END IF;

  -- Set custom_role_id claim (custom permission roles)
  IF custom_role_id_value IS NOT NULL THEN
    claims := jsonb_set(claims, '{custom_role_id}', to_jsonb(custom_role_id_value));
  ELSE
    claims := jsonb_set(claims, '{custom_role_id}', 'null');
  END IF;

  -- Set platform_role claim (platform admin context)
  IF platform_role_value IS NOT NULL THEN
    claims := jsonb_set(claims, '{platform_role}', to_jsonb(platform_role_value));
  ELSE
    claims := jsonb_set(claims, '{platform_role}', 'null');
  END IF;

  -- Set impersonating_tenant_id claim (for JWT-based impersonation)
  IF impersonating_tenant IS NOT NULL THEN
    claims := jsonb_set(claims, '{impersonating_tenant_id}', to_jsonb(impersonating_tenant));
  ELSE
    claims := jsonb_set(claims, '{impersonating_tenant_id}', 'null');
  END IF;

  event := jsonb_set(event, '{claims}', claims);
  RETURN event;
END;
$$;


ALTER FUNCTION "public"."custom_access_token_hook"("event" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_secret"("secret_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if current_setting('role') != 'service_role' then
    raise exception 'authentication required';
  end if;

  delete from vault.decrypted_secrets where name = secret_name;
end;
$$;


ALTER FUNCTION "public"."delete_secret"("secret_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_app_policy_permission"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    -- Only do any work when a governed policy column actually changes. The
    -- permission check is NESTED (not a flat AND) so auth.role()/app_authorize
    -- never run — and can never error — on unrelated app updates such as the
    -- gateway role renaming an app. Postgres does not guarantee AND
    -- short-circuit, so the column-change guard must be its own outer IF.
    IF NEW.require_pull_request IS DISTINCT FROM OLD.require_pull_request THEN
        IF (SELECT auth.role()) = 'authenticated'
           AND NOT private.app_authorize('app_policy.update', NEW.id) THEN
            RAISE EXCEPTION 'Changing an app publish policy requires the app_policy.update permission'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."enforce_app_policy_permission"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."environment_enforce_invariants"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Name is immutable post-creation
  IF TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name THEN
    RAISE EXCEPTION 'environment.name is immutable';
  END IF;

  -- Default env cannot be deleted DIRECTLY. pg_trigger_depth() = 1
  -- means a top-level DELETE on `environment`; depth >= 2 means a CASCADE from
  -- a parent (app -> environment, tenant -> app -> environment), which must be
  -- allowed per data-model.md FK cascade table.
  IF TG_OP = 'DELETE'
     AND OLD.is_default = true
     AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'default environment cannot be deleted';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION "public"."environment_enforce_invariants"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_claim"("uid" "uuid", "claim" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
    declare retval jsonb;
    begin
      if not is_claims_admin() then
          return '{"error":"access denied"}'::jsonb;
      else
        select coalesce(raw_app_meta_data->claim, null) from auth.users into retval where id = uid::uuid;
        return retval;
      end if;
    end;
$$;


ALTER FUNCTION "public"."get_claim"("uid" "uuid", "claim" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_current_user_app_permissions"("target_app_id" "uuid") RETURNS SETOF "public"."app_permission"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT * FROM private.effective_app_permissions(target_app_id);
$$;


ALTER FUNCTION "public"."get_current_user_app_permissions"("target_app_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."grant_temp_access_transaction"("p_admin_user_id" "uuid", "p_tenant_id" "uuid", "p_reason" "text", "p_customer_permission_confirmed" boolean, "p_expires_at" timestamp with time zone) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_grant_id UUID;
    v_now TIMESTAMPTZ := NOW();
BEGIN
    -- Insert membership record with role='read'
    INSERT INTO public.membership (
        user_id,
        tenant_id,
        role,
        status,
        accepted_at
    ) VALUES (
        p_admin_user_id,
        p_tenant_id,
        'read',
        'active',
        v_now
    );

    -- Insert temp_access_grant record
    INSERT INTO public.temp_access_grant (
        created_by,
        tenant_id,
        created_at,
        expires_at,
        reason,
        customer_permission_confirmed
    ) VALUES (
        p_admin_user_id,
        p_tenant_id,
        v_now,
        p_expires_at,
        p_reason,
        p_customer_permission_confirmed
    )
    RETURNING id INTO v_grant_id;

    RETURN v_grant_id;

EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to grant temp access: %', SQLERRM;
END;
$$;


ALTER FUNCTION "public"."grant_temp_access_transaction"("p_admin_user_id" "uuid", "p_tenant_id" "uuid", "p_reason" "text", "p_customer_permission_confirmed" boolean, "p_expires_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."grant_temp_access_transaction"("p_admin_user_id" "uuid", "p_tenant_id" "uuid", "p_reason" "text", "p_customer_permission_confirmed" boolean, "p_expires_at" timestamp with time zone) IS 'Atomically creates membership and temp_access_grant for platform admin temp access.';



CREATE OR REPLACE FUNCTION "public"."insert_secret"("name" "text", "secret" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  if current_setting('role') != 'service_role' then
    raise exception 'authentication required';
  end if;

  return vault.create_secret(secret, name);
end;
$$;


ALTER FUNCTION "public"."insert_secret"("name" "text", "secret" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invite_existing_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet" DEFAULT NULL::"inet", "p_user_agent" "text" DEFAULT NULL::"text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_membership_id UUID;
    v_email TEXT;
BEGIN
    -- Insert membership record with role (role now stored in membership)
    INSERT INTO public.membership (
        user_id,
        tenant_id,
        role,
        status,
        invited_at,
        invited_by,
        expires_at
    ) VALUES (
        p_user_id,
        p_tenant_id,
        p_role::public.app_role,
        'pending',
        p_invited_at,
        p_invited_by,
        p_expires_at
    )
    RETURNING id INTO v_membership_id;

    SELECT email INTO v_email FROM public.profile WHERE id = p_user_id;

    -- actor_label denormalizes the inviter's email so the trail's display
    -- identity survives profile deletion (actor_id has no FK and is frozen).
    INSERT INTO public.audit_log (
        tenant_id, actor_id, actor_label, action_type, target_type, target_id,
        target_identifier, after_state, ip_address, user_agent, request_id
    ) VALUES (
        p_tenant_id, p_invited_by,
        (SELECT email FROM public.profile WHERE id = p_invited_by),
        'member_invited', 'membership', v_membership_id,
        v_email, jsonb_build_object('role', p_role, 'status', 'pending'),
        p_ip_address, p_user_agent, p_request_id
    );

    RETURN v_membership_id;

EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to create invitation: %', SQLERRM;
END;
$$;


ALTER FUNCTION "public"."invite_existing_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."invite_new_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_email" "public"."citext", "p_name" "text", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet" DEFAULT NULL::"inet", "p_user_agent" "text" DEFAULT NULL::"text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_membership_id UUID;
BEGIN
    -- Insert profile record
    INSERT INTO public.profile (
        id,
        email,
        name
    ) VALUES (
        p_user_id,
        p_email,
        p_name
    );

    -- Insert membership record with role (role now stored in membership)
    INSERT INTO public.membership (
        user_id,
        tenant_id,
        role,
        status,
        invited_at,
        invited_by,
        expires_at
    ) VALUES (
        p_user_id,
        p_tenant_id,
        p_role::public.app_role,
        'pending',
        p_invited_at,
        p_invited_by,
        p_expires_at
    )
    RETURNING id INTO v_membership_id;

    -- An invitation does not change the invitee's active tenant claim: the
    -- membership above is 'pending', and tenant_id() falls back to that claim
    -- for headerless traffic (Realtime, Storage), so setting it here would let
    -- the invitee read the inviting tenant's data before they have accepted.
    -- The claim is set once acceptance flips the membership to 'active'
    -- (apps/tenant-dashboard/src/app/auth/confirm/route.ts).

    INSERT INTO public.audit_log (
        tenant_id, actor_id, actor_label, action_type, target_type, target_id,
        target_identifier, after_state, ip_address, user_agent, request_id
    ) VALUES (
        p_tenant_id, p_invited_by,
        (SELECT email FROM public.profile WHERE id = p_invited_by),
        'member_invited', 'membership', v_membership_id,
        p_email, jsonb_build_object('role', p_role, 'status', 'pending'),
        p_ip_address, p_user_agent, p_request_id
    );

    RETURN v_membership_id;

EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to create invitation: %', SQLERRM;
END;
$$;


ALTER FUNCTION "public"."invite_new_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_email" "public"."citext", "p_name" "text", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_claims_admin"() RETURNS boolean
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
  begin
    if session_user = 'authenticator' then
      -- Authenticated app users may never edit claims. Only the service role
      -- (which drives the set_claim/get_claim machinery) is a claims admin
      -- within a user session; every other authenticated caller falls through
      -- to false.
      if extract(epoch from now()) > coalesce((current_setting('request.jwt.claims', true)::jsonb)->>'exp', '0')::numeric then
        return false; -- jwt expired
      end if;
      if current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role' then
        return true; -- service role users have admin rights
      end if;
      return false;
    else -- not a user session, probably being called from a trigger or something
      return true;
    end if;
  end;
$$;


ALTER FUNCTION "public"."is_claims_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."nullify_custom_role_on_downgrade"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- Only act when tier_id actually changes
  IF NEW.tier_id = OLD.tier_id THEN
    RETURN NEW;
  END IF;

  -- ── Entitlement: custom_roles ────────────────────────────────────────────────
  -- custom_roles is enabled on team/enterprise and disabled on hobby/growth.
  -- When moving from an enabled tier to a disabled tier:
  --   a) NULL out custom_role_id on all memberships (billing.tenant_id = tenant_id 1:1)
  --   b) Scrub custom_role.* permissions — they gate the custom roles settings UI
  IF NEW.tier_id IN ('hobby', 'growth')
     AND OLD.tier_id NOT IN ('hobby', 'growth') THEN
    -- a) NULL out custom role assignments on memberships
    UPDATE public.membership
    SET custom_role_id = NULL
    WHERE tenant_id = NEW.tenant_id
      AND custom_role_id IS NOT NULL;

    -- b) Scrub custom_role.* permissions from all custom roles for this tenant
    DELETE FROM public.custom_role_permission
    WHERE permission IN (
      'custom_role.read', 'custom_role.insert',
      'custom_role.update', 'custom_role.delete'
    )
    AND custom_role_id IN (
      SELECT id FROM public.custom_role WHERE tenant_id = NEW.tenant_id
    );
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."nullify_custom_role_on_downgrade"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."platform_admin_delete_tenant"("p_tenant_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- Set compensation mode flag to bypass protect_last_owner trigger
  -- This allows cascading deletes of user_role records without blocking
  PERFORM set_config('app.compensating', 'true', true);

  -- Delete the tenant - cascades to all related tables including:
  -- user_role, membership, app, api_key, billing, git_connection, etc.
  DELETE FROM tenant WHERE tenant_id = p_tenant_id;

  -- Flag is automatically cleared when transaction ends (third param = true means local)
END $$;


ALTER FUNCTION "public"."platform_admin_delete_tenant"("p_tenant_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."platform_admin_delete_tenant"("p_tenant_id" "uuid") IS 'SECURITY DEFINER function - Deletes a tenant with compensation flag set to bypass protect_last_owner trigger. Only callable by service_role (platform admin operations).';



CREATE OR REPLACE FUNCTION "public"."prevent_app_member_role_self_grant"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- auth.role(), not current_user: inside a SECURITY DEFINER function
  -- current_user is the function's OWNER (postgres), so a current_user test
  -- never matches and the guard silently never fires. auth.role() reads the
  -- request's JWT role claim, which is what actually distinguishes an end-user
  -- call from the service-role paths that legitimately provision app roles
  -- during invite acceptance (and from a direct psql session, where it is NULL).
  IF (SELECT auth.role()) = 'authenticated' AND EXISTS (
    SELECT 1
    FROM public.membership m
    WHERE m.id = NEW.membership_id
      AND m.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'cannot_grant_own_app_role';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_app_member_role_self_grant"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_membership_self_privilege_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    IF current_user = 'authenticated' THEN
        -- Whitelist the invitation-acceptance columns (status, accepted_at)
        -- plus the audit columns set_updated_columns stamps (updated_at,
        -- updated_by). If ANY other column differs, reject. Diffing the
        -- stripped row-jsonb is secure by default: columns added to membership
        -- later are protected automatically.
        IF (to_jsonb(NEW) - 'status' - 'accepted_at' - 'updated_at' - 'updated_by')
           IS DISTINCT FROM
           (to_jsonb(OLD) - 'status' - 'accepted_at' - 'updated_at' - 'updated_by') THEN
            RAISE EXCEPTION 'A member may only accept their own invitation; privilege-bearing membership columns (role, custom_role_id, is_app_scoped, invited_by, ...) cannot be changed via self-service update'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_membership_self_privilege_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_membership_tenant_change"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
    IF OLD.tenant_id != NEW.tenant_id THEN
        RAISE EXCEPTION 'Cannot change tenant_id of membership record';
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."prevent_membership_tenant_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_last_owner"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
    owner_count INTEGER;
BEGIN
    -- Skip protection during compensation (when entire tenant is being deleted)
    -- This allows cascade deletes to complete during registration rollback
    IF current_setting('app.compensating', true) = 'true' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    -- Only check when removing owner role or deleting owner (active memberships only)
    IF (TG_OP = 'DELETE' AND OLD.role = 'owner' AND OLD.status = 'active') OR
       (TG_OP = 'UPDATE' AND OLD.role = 'owner' AND OLD.status = 'active' AND (NEW.role != 'owner' OR NEW.status != 'active')) THEN
        -- FOR UPDATE locks matching rows so concurrent transactions serialize
        -- correctly, preventing the TOCTOU race where both see each other as
        -- still being an owner.
        SELECT COUNT(*) INTO owner_count
        FROM (
            SELECT 1 FROM public.membership
            WHERE tenant_id = OLD.tenant_id
            AND role = 'owner'
            AND status = 'active'
            AND user_id != OLD.user_id
            FOR UPDATE
        ) locked_owners;

        IF owner_count = 0 THEN
            RAISE EXCEPTION 'Cannot remove the last owner from organization';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_last_owner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."read_secret"("secret_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  secret text;
begin
  if current_setting('role') != 'service_role' then
    raise exception 'authentication required';
  end if;

  select decrypted_secret from vault.decrypted_secrets where name =
  secret_name into secret;
  return secret;
end;
$$;


ALTER FUNCTION "public"."read_secret"("secret_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_member_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_ip_address" "inet" DEFAULT NULL::"inet", "p_user_agent" "text" DEFAULT NULL::"text", "p_request_id" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
    v_membership RECORD;
    v_email TEXT;
BEGIN
    SELECT id, role, status INTO v_membership
    FROM public.membership
    WHERE user_id = p_target_user_id
      AND tenant_id = p_tenant_id
      AND status IN ('active', 'pending')
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'member_not_found';
    END IF;

    SELECT email INTO v_email FROM public.profile WHERE id = p_target_user_id;

    DELETE FROM public.membership WHERE id = v_membership.id;

    INSERT INTO public.audit_log (
        tenant_id, actor_id, actor_label, action_type, target_type, target_id,
        target_identifier, before_state,
        ip_address, user_agent, request_id
    ) VALUES (
        p_tenant_id, p_actor_id,
        (SELECT email FROM public.profile WHERE id = p_actor_id),
        'member_removed', 'membership', v_membership.id,
        v_email,
        jsonb_build_object('role', v_membership.role, 'status', v_membership.status),
        p_ip_address, p_user_agent, p_request_id
    );

    RETURN jsonb_build_object('membership_id', v_membership.id, 'removed_role', v_membership.role);
END;
$$;


ALTER FUNCTION "public"."remove_member_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
  SELECT private.set_api_key_secret(p_api_key_id, p_key_digest, p_pepper_version);
$$;


ALTER FUNCTION "public"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_claim"("uid" "uuid", "claim" "text", "value" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
    begin
      if not is_claims_admin() then
          return 'error: access denied';
      else        
        update auth.users set raw_app_meta_data = 
          raw_app_meta_data || 
            json_build_object(claim, value)::jsonb where id = uid;
        return 'ok';
      end if;
    end;
$$;


ALTER FUNCTION "public"."set_claim"("uid" "uuid", "claim" "text", "value" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_created_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    -- Admin operations / FK cascades: keep whatever was provided.
    NULL;
  ELSIF auth.role() = 'gateway' THEN
    -- Gateway (machine) writes: preserve the handler's explicit value
    -- (a real profile.id or NULL). A DEFAULT auth.uid() would resolve to the
    -- tenant_id sub claim here, which is not a profile row.
    NULL;
  ELSE
    -- Regular users: stamp created_by from auth.uid() only when not already
    -- set: an explicit value always wins.
    NEW.created_by = COALESCE(NEW.created_by, auth.uid());
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_created_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_profile_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_profile_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_tenant_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  -- Dashboard clients sometimes set this via SET LOCAL to mark service_role
  -- code paths; kept for backwards-compat with existing service-role writes.
  pg_role text := current_setting('myvars.pg_client_role', true);
  -- Read the JWT role directly from session config rather than routing
  -- through auth.role(). The `gateway` Postgres role has no USAGE on the
  -- auth schema (and that grant is unavailable via normal migration — see
  -- 20260420201743_annotation_queues_fk_to_profile.sql), so any trigger
  -- that calls auth.role() fires `permission denied for schema auth`
  -- and blocks every gateway INSERT on tables carrying this trigger.
  -- current_setting reads the same session variable auth.role() wraps —
  -- the behavior is identical, the schema dependency disappears.
  jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif((nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'role', '')
  );
begin
  if jwt_role = 'service_role' or pg_role = 'service_role' then
    -- Service role: trust whatever tenant_id was passed.
    new.tenant_id = new.tenant_id;
  else
    -- Non-service callers: enforce the JWT's tenant_id.
    new.tenant_id = public.tenant_id();
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."set_tenant_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_at_only"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_updated_at_only"() IS 'Stamps updated_at. For tables that track modification time but carry no updated_by column.';



CREATE OR REPLACE FUNCTION "public"."set_updated_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    -- For service_role (admin operations, FK cascades), keep the value as-is
    -- This respects FK cascade SET NULL operations
    NULL;
  ELSIF auth.role() = 'gateway' THEN
    -- For gateway role (headless agents and dashboard-via-gateway calls),
    -- preserve whatever the gateway service set explicitly. The trigger's
    -- default `auth.uid()` would otherwise resolve to the JWT sub claim,
    -- which is the *tenant_id* for gateway JWTs — not a row in `profile`
    -- — and trip the `*_updated_by_fkey` FK with code 23503. The route
    -- handler is responsible for passing a real profile.id (or NULL) in
    -- `updated_by` before we land here.
    NULL;
  ELSE
    -- For regular users, set the updated_by using auth.uid()
    NEW.updated_by = auth.uid();
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_updated_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_auth_email_to_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profile
    SET email = NEW.email
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_auth_email_to_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tenant_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
      SELECT CASE
        WHEN (nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-tenant-id') IS NOT NULL THEN
          private.resolve_member_tenant(
            nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-tenant-id'
          )
        WHEN (current_setting('request.jwt.claims', true)::jsonb ->> 'role') = 'authenticated' THEN
          private.resolve_member_tenant(
            ((current_setting('request.jwt.claims', true)::jsonb ->> 'app_metadata')::jsonb ->> 'tenant_id')
          )
        ELSE
          nullif(
              ((current_setting('request.jwt.claims', true)::jsonb ->> 'app_metadata')::jsonb ->> 'tenant_id'),
            ''
            )::uuid
      END
$$;


ALTER FUNCTION "public"."tenant_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_secret"("secret_name" "text", "secret" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  target_id uuid;
begin
  if current_setting('role') != 'service_role' then
    raise exception 'authentication required';
  end if;

  select id from vault.secrets where name = secret_name into target_id;
  if target_id is null then
    return false;
  end if;

  perform vault.update_secret(target_id, secret);
  return true;
end;
$$;


ALTER FUNCTION "public"."update_secret"("secret_name" "text", "secret" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_api_key"("p_key_digest" "text") RETURNS "jsonb"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
  SELECT private.verify_api_key(p_key_digest);
$$;


ALTER FUNCTION "public"."verify_api_key"("p_key_digest" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_audit_log_chain"() RETURNS TABLE("bad_seq" bigint, "reason" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."verify_audit_log_chain"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ops"."index_usage_snapshot" (
    "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "schemaname" "text" NOT NULL,
    "relname" "text" NOT NULL,
    "indexrelname" "text" NOT NULL,
    "idx_scan" bigint NOT NULL,
    "idx_tup_read" bigint NOT NULL,
    "idx_tup_fetch" bigint NOT NULL,
    "index_bytes" bigint,
    "stats_reset" timestamp with time zone
);


ALTER TABLE "ops"."index_usage_snapshot" OWNER TO "postgres";


COMMENT ON TABLE "ops"."index_usage_snapshot" IS 'Periodic capture of pg_stat_user_indexes counters. Differencing two captures identifies indexes unused over a known window.';





CREATE TABLE IF NOT EXISTS "ops"."table_usage_snapshot" (
    "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "schemaname" "text" NOT NULL,
    "relname" "text" NOT NULL,
    "seq_scan" bigint NOT NULL,
    "idx_scan" bigint,
    "n_tup_ins" bigint NOT NULL,
    "n_tup_upd" bigint NOT NULL,
    "n_tup_del" bigint NOT NULL,
    "n_live_tup" bigint NOT NULL,
    "stats_reset" timestamp with time zone
);


ALTER TABLE "ops"."table_usage_snapshot" OWNER TO "postgres";


COMMENT ON TABLE "ops"."table_usage_snapshot" IS 'Periodic capture of pg_stat_user_tables counters. Two captures differenced give real usage over a known window.';



COMMENT ON COLUMN "ops"."table_usage_snapshot"."stats_reset" IS 'Stats epoch start from pg_stat_database. Counters are only comparable within one epoch.';





CREATE TABLE IF NOT EXISTS "private"."api_key_secret" (
    "api_key_id" "uuid" NOT NULL,
    "key_digest" "text" NOT NULL,
    "pepper_version" smallint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "private"."api_key_secret" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_finding" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "detector_id" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "summary" "text" NOT NULL,
    "suggestion" "text",
    "cost_usd" numeric,
    "session_count" bigint DEFAULT 0 NOT NULL,
    "session_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "evidence" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "project" "text",
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_finding" OWNER TO "postgres";


COMMENT ON TABLE "public"."agent_finding" IS 'Detector findings over coding-agent sessions, recomputed per tenant+app by the insights compute job';



COMMENT ON COLUMN "public"."agent_finding"."detector_id" IS 'Stable id of the @outerlayer/insights-core detector that produced this finding';



COMMENT ON COLUMN "public"."agent_finding"."severity" IS 'Finding severity: info | warn | high';



COMMENT ON COLUMN "public"."agent_finding"."summary" IS 'One human-readable sentence describing the finding';



COMMENT ON COLUMN "public"."agent_finding"."suggestion" IS 'One-line remediation hint (nullable)';



COMMENT ON COLUMN "public"."agent_finding"."cost_usd" IS 'Estimated wasted spend in USD, null when not honestly computable';



COMMENT ON COLUMN "public"."agent_finding"."session_count" IS 'Full count of sessions implicated (session_ids is capped)';



COMMENT ON COLUMN "public"."agent_finding"."session_ids" IS 'JSON array of implicated session ids, capped at 8 for display';



COMMENT ON COLUMN "public"."agent_finding"."evidence" IS 'JSON array of evidence refs ({sessionId, turnIndex?, toolSeq?, note?}) for drill-down';



COMMENT ON COLUMN "public"."agent_finding"."project" IS 'Project (git repo or cwd) of the first affected session';



COMMENT ON COLUMN "public"."agent_finding"."computed_at" IS 'When the compute pass that produced this row ran';



CREATE TABLE IF NOT EXISTS "public"."agent_theme" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "label" "text" NOT NULL,
    "description" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "cluster_keys" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "evidence_session_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_theme" OWNER TO "postgres";


COMMENT ON TABLE "public"."agent_theme" IS 'LLM-labeled themes over deterministic error clusters, recomputed per tenant+app by the insights compute job';



COMMENT ON COLUMN "public"."agent_theme"."label" IS 'Short human-readable theme label from the labeling model';



COMMENT ON COLUMN "public"."agent_theme"."description" IS 'One-paragraph theme description from the labeling model';



COMMENT ON COLUMN "public"."agent_theme"."severity" IS 'Theme severity: info | warn | high';



COMMENT ON COLUMN "public"."agent_theme"."cluster_keys" IS 'JSON array of `${tool}::${signature}` cluster keys this theme groups (validated against our clusters, never invented)';



COMMENT ON COLUMN "public"."agent_theme"."evidence_session_ids" IS 'JSON array: union of the referenced clusters'' session ids (our data, not model output)';



COMMENT ON COLUMN "public"."agent_theme"."computed_at" IS 'When the compute pass that produced this row ran';



CREATE TABLE IF NOT EXISTS "public"."ai_cost_config" (
    "tenant_id" "uuid" NOT NULL,
    "seat_count" bigint DEFAULT 0 NOT NULL,
    "cost_per_seat_usd" numeric(10,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid",
    CONSTRAINT "chk_ai_cost_config_cost_per_seat" CHECK (("cost_per_seat_usd" >= (0)::numeric)),
    CONSTRAINT "chk_ai_cost_config_seat_count" CHECK (("seat_count" >= 0))
);


ALTER TABLE "public"."ai_cost_config" OWNER TO "postgres";


COMMENT ON TABLE "public"."ai_cost_config" IS 'Per-tenant fixed AI program spend (seats x $/seat/month) — the seat-cost half of Total Cost of AI; metered token spend is the other half.';



CREATE TABLE IF NOT EXISTS "public"."api_key" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "api_key_id" character varying(255) NOT NULL,
    "app_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "environment_id" "uuid",
    "allowed_env_kinds" "text"[],
    "expires_at" timestamp with time zone,
    "is_machine" boolean DEFAULT false NOT NULL,
    "key_prefix" "text",
    "permissions" "public"."app_permission"[] DEFAULT '{}'::"public"."app_permission"[] NOT NULL,
    "actor_membership_id" "uuid",
    CONSTRAINT "chk_api_key_allowed_env_kinds" CHECK ((("allowed_env_kinds" IS NULL) OR ("allowed_env_kinds" <@ ARRAY['development'::"text", 'preview'::"text", 'promoted'::"text"]))),
    CONSTRAINT "chk_api_key_scope_present" CHECK ((("environment_id" IS NOT NULL) OR ("allowed_env_kinds" IS NOT NULL)))
);


ALTER TABLE "public"."api_key" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "commit_sha" "text",
    "entry_point" "text",
    "runtime" "text" DEFAULT 'nodejs'::"text",
    "environment_migration_done_at" timestamp with time zone,
    "require_pull_request" boolean DEFAULT false NOT NULL,
    "display_name" "text",
    CONSTRAINT "chk_runtime" CHECK (("runtime" = ANY (ARRAY['nodejs'::"text", 'python'::"text"])))
);


ALTER TABLE "public"."app" OWNER TO "postgres";


COMMENT ON COLUMN "public"."app"."commit_sha" IS 'Latest commit SHA from the connected repository branch';



COMMENT ON COLUMN "public"."app"."environment_migration_done_at" IS 'NULL means this app still needs its default-env seed and key/deployment backfill. NOT NULL means that has run.';



COMMENT ON COLUMN "public"."app"."require_pull_request" IS 'When true, prompt/template publishes open a PR against the connected branch instead of committing directly. Toggling it requires the app_policy.update permission (enforced by the enforce_app_policy_permission trigger, not app.update RLS).';



COMMENT ON COLUMN "public"."app"."display_name" IS 'Optional human-friendly label shown in the UI. Falls back to name when null. Unlike name it is not URL-stable and not unique.';



CREATE TABLE IF NOT EXISTS "public"."app_member_role" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "membership_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "role" "public"."app_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "custom_role_id" "uuid",
    CONSTRAINT "chk_app_member_role_valid_role" CHECK (("role" = ANY (ARRAY['read'::"public"."app_role", 'write'::"public"."app_role", 'admin'::"public"."app_role"])))
);


ALTER TABLE "public"."app_member_role" OWNER TO "postgres";


COMMENT ON TABLE "public"."app_member_role" IS 'Per-app role assignments for granular access control within a tenant';



COMMENT ON COLUMN "public"."app_member_role"."role" IS 'Per-app role: read, write, or admin (owner/disabled are org-level only)';





CREATE TABLE IF NOT EXISTS "public"."billing" (
    "tenant_id" "uuid" NOT NULL,
    "stripe_customer_id" character varying(255),
    "stripe_subscription_id" character varying(255),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "tier_id" "text" DEFAULT 'hobby'::"text" NOT NULL,
    CONSTRAINT "chk_billing_tier_id" CHECK (("tier_id" = ANY (ARRAY['hobby'::"text", 'growth'::"text", 'team'::"text", 'enterprise'::"text"])))
);


ALTER TABLE "public"."billing" OWNER TO "postgres";


COMMENT ON COLUMN "public"."billing"."tenant_id" IS 'References tenant.tenant_id (1:1 relationship); also this table''s primary key';



CREATE TABLE IF NOT EXISTS "public"."context_blob" (
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "blob_sha" "text" NOT NULL,
    "content" "text" NOT NULL,
    "size" bigint NOT NULL,
    "inserted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."context_blob" OWNER TO "postgres";


COMMENT ON TABLE "public"."context_blob" IS 'Content-addressed, immutable blob store for .outerlayer/ file content. Per-app for RLS simplicity. No blob-size CHECK constraint — the >1MB mirror cap is sync-layer policy, not a DB invariant; oversize blobs are indexed elsewhere (context_tree_entry) but not content-mirrored here.';



CREATE TABLE IF NOT EXISTS "public"."context_head" (
    "app_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "branch" "text" NOT NULL,
    "commit_sha" "text" NOT NULL,
    "snapshot_id" "uuid" NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."context_head" OWNER TO "postgres";


COMMENT ON TABLE "public"."context_head" IS 'The only mutable state in the context mirror: current synced (commit_sha, snapshot_id) per (app, branch). Updated by every sync (initial, incremental, resync); no updated_at trigger — synced_at is set explicitly by the sync path on every write.';



CREATE TABLE IF NOT EXISTS "public"."context_snapshot" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "commit_sha" "text" NOT NULL,
    "classifier_version" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "excluded_counts" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL
);


ALTER TABLE "public"."context_snapshot" OWNER TO "postgres";


COMMENT ON TABLE "public"."context_snapshot" IS 'One row per synced commit whose .outerlayer/ tree actually changed relative to its parent (clone-then-patch). Insert-only; never updated or deleted by user-facing paths. classifier_version stamps which classifier produced the tree so a classifier bump can trigger lazy resync.';



COMMENT ON COLUMN "public"."context_snapshot"."classifier_version" IS 'Version of the packages/context-core classifier that produced this snapshot''s tree entries.';



CREATE TABLE IF NOT EXISTS "public"."context_sync_event" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "app_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "branch" "text" NOT NULL,
    "commit_sha" "text",
    "commit_message" "text",
    "trigger" "text" NOT NULL,
    "status" "text" NOT NULL,
    "error" "text",
    "duration_ms" bigint,
    "snapshot_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_sync_event_error" CHECK ((("status" = 'failed'::"text") = ("error" IS NOT NULL))),
    CONSTRAINT "chk_sync_event_sha" CHECK ((("status" <> 'synced'::"text") OR ("commit_sha" IS NOT NULL))),
    CONSTRAINT "chk_sync_event_snapshot" CHECK ((("status" = 'synced'::"text") OR ("snapshot_id" IS NULL))),
    CONSTRAINT "context_sync_event_status_check" CHECK (("status" = ANY (ARRAY['synced'::"text", 'failed'::"text"]))),
    CONSTRAINT "context_sync_event_trigger_check" CHECK (("trigger" = ANY (ARRAY['link'::"text", 'push'::"text", 'resync'::"text"])))
);


ALTER TABLE "public"."context_sync_event" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."context_tree_entry" (
    "snapshot_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "path" "text" NOT NULL,
    "blob_sha" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "scope_path" "text" NOT NULL
);


ALTER TABLE "public"."context_tree_entry" OWNER TO "postgres";


COMMENT ON TABLE "public"."context_tree_entry" IS 'Snapshot membership: one row per classified path in a context_snapshot''s tree. Insert-only (copy-forward + patch on incremental sync). kind is unvalidated TEXT by design.';



COMMENT ON COLUMN "public"."context_tree_entry"."scope_path" IS 'Repo path of the .outerlayer/ directory this entry belongs to (nearest-scope-wins nesting).';



CREATE TABLE IF NOT EXISTS "public"."custom_role" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    CONSTRAINT "custom_role_description_check" CHECK (("char_length"("description") <= 500)),
    CONSTRAINT "custom_role_name_check" CHECK (("char_length"("name") <= 100))
);


ALTER TABLE "public"."custom_role" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_role_permission" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "custom_role_id" "uuid" NOT NULL,
    "permission" "public"."app_permission" NOT NULL
);


ALTER TABLE "public"."custom_role_permission" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dashboard" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "app_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_default" boolean DEFAULT false NOT NULL,
    "layout" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "global_time_range" "text" DEFAULT '7d'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."dashboard" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dashboard_widget" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "dashboard_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "metric" "text" NOT NULL,
    "visualization" "text" DEFAULT 'line'::"text" NOT NULL,
    "filters" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "group_by" "text",
    "time_granularity" "text" DEFAULT 'auto'::"text" NOT NULL,
    "sort_order" bigint DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid",
    "score_name" "text",
    "score_name_b" "text",
    "environment_config" "jsonb",
    CONSTRAINT "chk_widget_visualization" CHECK (("visualization" = ANY (ARRAY['line'::"text", 'bar'::"text", 'area'::"text", 'stat'::"text"])))
);


ALTER TABLE "public"."dashboard_widget" OWNER TO "postgres";


COMMENT ON COLUMN "public"."dashboard_widget"."score_name" IS 'Score name for score_histogram, score_trend, and score_comparison widgets';



COMMENT ON COLUMN "public"."dashboard_widget"."score_name_b" IS 'Second score name for score_comparison widgets';



COMMENT ON COLUMN "public"."dashboard_widget"."environment_config" IS 'Environment dimension. NULL or {"mode":"inherit"} follows the dashboard-level env filter; {"mode":"override","environments":[...]} pins the widget to one or more envs, and listing several enables cross-env comparison.';



CREATE TABLE IF NOT EXISTS "public"."env_escalation" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "eval_run_id" "uuid",
    "repo" "text" NOT NULL,
    "base_commit" "text" NOT NULL,
    "task_ids" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "last_errors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "attempts" bigint DEFAULT 0 NOT NULL,
    "cost_usd" numeric DEFAULT 0 NOT NULL,
    "suggested_next_steps" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    CONSTRAINT "chk_env_escalation_status" CHECK (("status" = ANY (ARRAY['open'::"text", 'acked'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."env_escalation" OWNER TO "postgres";


COMMENT ON TABLE "public"."env_escalation" IS 'Escalation queue: env builds whose repair ladder exhausted its budget. Written by the eval worker (service role); read + acked in the dashboard.';



CREATE TABLE IF NOT EXISTS "public"."env_var" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "key" "text" NOT NULL,
    "vault_secret_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "environment_id" "uuid",
    "target_kind" "text",
    CONSTRAINT "chk_env_var_scope_exactly_one" CHECK ((("environment_id" IS NULL) <> ("target_kind" IS NULL))),
    CONSTRAINT "chk_env_var_target_kind" CHECK (("target_kind" = ANY (ARRAY['all'::"text", 'development'::"text", 'preview'::"text", 'promoted'::"text"])))
);


ALTER TABLE "public"."env_var" OWNER TO "postgres";


COMMENT ON TABLE "public"."env_var" IS 'Encrypted environment variables for managed code deployments';



CREATE TABLE IF NOT EXISTS "public"."environment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "current_version" bigint DEFAULT 0 NOT NULL,
    "current_commit_sha" "text",
    "fly_app_name" "text",
    "epoch" bigint DEFAULT ((EXTRACT(epoch FROM "now"()) * (1000)::numeric))::bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "fly_machine_id" "text",
    "is_ephemeral" boolean DEFAULT false NOT NULL,
    "source_branch" "text",
    "source_pr_number" bigint,
    CONSTRAINT "chk_environment_current_version_nonneg" CHECK (("current_version" >= 0)),
    CONSTRAINT "chk_environment_name_pattern" CHECK (("name" ~ '^[a-z][a-z0-9-]{1,39}$'::"text")),
    CONSTRAINT "environment_default_unpinned" CHECK (((NOT "is_default") OR ("current_version" = 0))),
    CONSTRAINT "environment_ephemeral_has_source" CHECK (((NOT "is_ephemeral") OR (("source_branch" IS NOT NULL) AND ("source_pr_number" IS NOT NULL)))),
    CONSTRAINT "environment_ephemeral_not_default" CHECK (((NOT "is_ephemeral") OR (NOT "is_default")))
);


ALTER TABLE "public"."environment" OWNER TO "postgres";


COMMENT ON TABLE "public"."environment" IS 'Per-app named pointer to a content version + runtime. Default env tracks HEAD live (current_version = 0). No env-promotion machinery exists; current_version is retained on existing envs but no longer advances.';



COMMENT ON COLUMN "public"."environment"."current_version" IS 'Frozen. No promote saga exists to advance this. Retained for existing envs; no longer written.';



COMMENT ON COLUMN "public"."environment"."current_commit_sha" IS 'Live pointer — denormalized git commit SHA this env is currently pinned to (commit_sha of the deployment referenced by latest_deployment_id). Set atomically with current_version + latest_deployment_id by commit_env_deployment. NULL until first successful saga.';



COMMENT ON COLUMN "public"."environment"."fly_app_name" IS '1:1 with a Fly app. Name pattern: agentmark-<app-slug>-<env-name>, hash-truncated app-slug on overflow. NULL during provisioning.';



COMMENT ON COLUMN "public"."environment"."epoch" IS 'Per-env-instance identity. Denormalized onto deployment saga rows so the audit trail distinguishes recreated envs.';



COMMENT ON COLUMN "public"."environment"."fly_machine_id" IS 'Fly Machine ID for the env''s current runtime. Used for platform-admin deep-links to fly.io.';



CREATE TABLE IF NOT EXISTS "public"."eval_run" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "environment_id" "uuid",
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "repo_label" "text" DEFAULT ''::"text" NOT NULL,
    "request" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "card" "jsonb",
    "cost_usd" numeric DEFAULT 0 NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    CONSTRAINT "chk_eval_run_status" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."eval_run" OWNER TO "postgres";


COMMENT ON TABLE "public"."eval_run" IS 'Durable record of a Harness Report Card run: the dispatched request, lifecycle status, and the resulting Report Card. Backs run history, polling, and shareable cards.';



CREATE TABLE IF NOT EXISTS "public"."feature_flag" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "key" "text" NOT NULL,
    "description" "text",
    "is_enabled" boolean DEFAULT false,
    "rollout_percentage" integer DEFAULT 100,
    "strategy" "public"."flag_strategy" DEFAULT 'global'::"public"."flag_strategy" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."feature_flag" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feature_flag_override" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "flag_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "is_enabled" boolean NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone,
    "updated_by" "uuid"
);


ALTER TABLE "public"."feature_flag_override" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."git_branch" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "branch_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "repo" "text"
);


ALTER TABLE "public"."git_branch" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."git_connection" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "provider" "text" DEFAULT 'github'::"text" NOT NULL,
    "repository" "text",
    "installation_id" integer,
    "webhook_id" "text",
    "webhook_secret" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    CONSTRAINT "chk_git_provider" CHECK (("provider" = ANY (ARRAY['github'::"text", 'gitlab'::"text"])))
);


ALTER TABLE "public"."git_connection" OWNER TO "postgres";


COMMENT ON TABLE "public"."git_connection" IS 'Stores Git repository connections for apps (GitHub, GitLab)';



COMMENT ON COLUMN "public"."git_connection"."provider" IS 'Git hosting provider: github or gitlab';



COMMENT ON COLUMN "public"."git_connection"."installation_id" IS 'GitHub App installation ID (null for GitLab)';



COMMENT ON COLUMN "public"."git_connection"."webhook_id" IS 'Provider-specific webhook identifier for cleanup on disconnect';



COMMENT ON COLUMN "public"."git_connection"."webhook_secret" IS 'Per-app webhook secret for signature verification (encrypted)';



CREATE TABLE IF NOT EXISTS "public"."membership" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "role" "public"."app_role" NOT NULL,
    "status" character varying(20) DEFAULT 'active'::character varying NOT NULL,
    "invited_at" timestamp with time zone,
    "invited_by" "uuid",
    "expires_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid",
    "is_app_scoped" boolean DEFAULT false NOT NULL,
    "custom_role_id" "uuid",
    CONSTRAINT "membership_status_check" CHECK ((("status")::"text" = ANY (ARRAY[('pending'::character varying)::"text", ('active'::character varying)::"text"])))
);


ALTER TABLE "public"."membership" OWNER TO "postgres";


COMMENT ON TABLE "public"."membership" IS 'User-tenant relationships with role and invitation tracking for multi-tenant membership';



COMMENT ON COLUMN "public"."membership"."role" IS 'User role within the tenant (owner/admin/write/read/disabled)';



COMMENT ON COLUMN "public"."membership"."status" IS 'pending = invited but not accepted, active = full member';



COMMENT ON COLUMN "public"."membership"."expires_at" IS '7-day expiry for pending invitations';



COMMENT ON COLUMN "public"."membership"."accepted_at" IS 'Timestamp when user accepted the invitation';



COMMENT ON COLUMN "public"."membership"."is_app_scoped" IS 'When true, user can only access apps with explicit app_member_role rows. When false, user sees all apps via org role.';



CREATE TABLE IF NOT EXISTS "public"."notification" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "message" "text" NOT NULL,
    "type" "text",
    "read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_by" "uuid",
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."notification" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_deployment" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "service" "text" NOT NULL,
    "environment" "text" DEFAULT 'production'::"text" NOT NULL,
    "status" "text" NOT NULL,
    "commit_sha" "text",
    "commit_message" "text",
    "branch" "text",
    "failure_reason" "text",
    "duration_ms" bigint,
    "triggered_by" "text",
    "pipeline_url" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "external_id" "text",
    "pr_number" bigint,
    "pr_merged_at" timestamp with time zone,
    "first_commit_at" timestamp with time zone
);


ALTER TABLE "public"."platform_deployment" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_deployment" IS 'Tracks platform CI/CD deployments for DORA metrics (not user-facing deployments)';



COMMENT ON COLUMN "public"."platform_deployment"."service" IS 'Platform service name (e.g. tenant-dashboard, gateway)';



COMMENT ON COLUMN "public"."platform_deployment"."environment" IS 'Target environment: production, staging, preview';



COMMENT ON COLUMN "public"."platform_deployment"."duration_ms" IS 'Deployment duration from start to completion in milliseconds';



CREATE TABLE IF NOT EXISTS "public"."platform_dora_collection_state" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source" "text" NOT NULL,
    "last_collected_at" timestamp with time zone,
    "last_run_at" timestamp with time zone,
    "last_run_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "last_error" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone
);


ALTER TABLE "public"."platform_dora_collection_state" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_dora_collection_state" IS 'Tracks incremental data collection state for DORA metrics sources';



CREATE TABLE IF NOT EXISTS "public"."platform_incident" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "external_id" "text" NOT NULL,
    "source" "text" DEFAULT 'betterstack'::"text" NOT NULL,
    "monitor_name" "text",
    "service" "text",
    "severity" "text",
    "cause" "text",
    "status" "text" NOT NULL,
    "url" "text",
    "started_at" timestamp with time zone NOT NULL,
    "acknowledged_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "resolution_ms" bigint,
    "deployment_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "environment" "text"
);


ALTER TABLE "public"."platform_incident" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_incident" IS 'Normalized incident data from monitoring systems for DORA MTTR and CFR';



COMMENT ON COLUMN "public"."platform_incident"."environment" IS 'Mapped environment (production, staging); NULL = could not infer from monitor';



CREATE TABLE IF NOT EXISTS "public"."platform_role_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role" "public"."platform_role" NOT NULL,
    "permission" "public"."platform_permission" NOT NULL
);


ALTER TABLE "public"."platform_role_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_user_role" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."platform_role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid"
);


ALTER TABLE "public"."platform_user_role" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile" (
    "id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "avatar_url" "text",
    "email" "text" NOT NULL,
    "github_username" "text",
    "updated_at" timestamp with time zone,
    "last_active_tenant_id" "uuid"
);


ALTER TABLE "public"."profile" OWNER TO "postgres";


COMMENT ON TABLE "public"."profile" IS 'Profile table with strict RLS - Users can only update their own profiles with profile.update permission, all DELETE operations blocked';



CREATE TABLE IF NOT EXISTS "public"."pull_request" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "pr_number" bigint NOT NULL,
    "head_branch" "text" NOT NULL,
    "head_sha" "text",
    "base_branch" "text" NOT NULL,
    "state" "text" DEFAULT 'open'::"text" NOT NULL,
    "url" "text",
    "environment_id" "uuid",
    "comment_id" bigint,
    "opened_at" timestamp with time zone,
    "closed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid",
    "provider" "text" DEFAULT 'github'::"text" NOT NULL,
    "merged_at" timestamp with time zone,
    "first_review_at" timestamp with time zone,
    "first_approved_at" timestamp with time zone,
    "ready_for_review_at" timestamp with time zone,
    "reopen_count" bigint DEFAULT 0 NOT NULL,
    "reverted_at" timestamp with time zone,
    "additions" bigint,
    "deletions" bigint,
    "changed_files" bigint,
    "first_ci_sha" "text",
    "first_ci_status" "text",
    "first_ci_at" timestamp with time zone,
    CONSTRAINT "chk_pull_request_first_ci_status" CHECK (("first_ci_status" = ANY (ARRAY['success'::"text", 'failure'::"text"]))),
    CONSTRAINT "chk_pull_request_provider" CHECK (("provider" = ANY (ARRAY['github'::"text", 'gitlab'::"text"]))),
    CONSTRAINT "chk_pull_request_state" CHECK (("state" = ANY (ARRAY['open'::"text", 'closed'::"text", 'merged'::"text"])))
);


ALTER TABLE "public"."pull_request" OWNER TO "postgres";


COMMENT ON TABLE "public"."pull_request" IS 'Tracks pull requests (GitHub) / merge requests (GitLab) opened against an app''s connected branch and the ephemeral preview env (if any) created for each.';



COMMENT ON COLUMN "public"."pull_request"."environment_id" IS 'Ephemeral preview env for this PR/MR; NULL when previews disabled or not yet created. ON DELETE SET NULL so teardown keeps the audit row.';



COMMENT ON COLUMN "public"."pull_request"."merged_at" IS 'When the PR/MR merged (provider payload time, not webhook delivery). NULL unless state = merged.';



COMMENT ON COLUMN "public"."pull_request"."first_review_at" IS 'Earliest non-author HUMAN review submitted (provider payload time). Bot reviews excluded — they would zero out pickup time. Monotone first-occurrence; NULL = no qualifying review observed. GitLab: always NULL (deferred).';



COMMENT ON COLUMN "public"."pull_request"."first_approved_at" IS 'Earliest non-author HUMAN approving review (provider payload time). Bot approvals excluded. Monotone first-occurrence; dismissal does not clear it. NULL = never approved as far as observed.';



COMMENT ON COLUMN "public"."pull_request"."ready_for_review_at" IS 'When the PR/MR first became ready for review (non-draft PRs: opened_at; drafts: the first draft→ready transition). Monotone first-occurrence. NULL = still draft or unknown; readers COALESCE to opened_at. Backfill approximates with opened_at for non-draft PRs (exact transitions come from webhooks).';



CREATE TABLE IF NOT EXISTS "public"."pull_request_session" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "pr_number" bigint NOT NULL,
    "trace_id" "text" NOT NULL,
    "session_id" "text" DEFAULT ''::"text" NOT NULL,
    "method" "text" NOT NULL,
    "verification" "text" DEFAULT 'pending'::"text" NOT NULL,
    "git_branch" "text" DEFAULT ''::"text" NOT NULL,
    "first_linked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_reconciled_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_pr_session_method" CHECK (("method" = ANY (ARRAY['pr_link'::"text", 'branch'::"text"]))),
    CONSTRAINT "chk_pr_session_verification" CHECK (("verification" = ANY (ARRAY['pending'::"text", 'confirmed'::"text", 'unmatched'::"text"])))
);


ALTER TABLE "public"."pull_request_session" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role" "public"."app_role" NOT NULL,
    "permission" "public"."app_permission" NOT NULL
);


ALTER TABLE "public"."role_permissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."role_permissions" IS 'Application permissions for each role.';



CREATE TABLE IF NOT EXISTS "public"."saved_trace_filters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "filter_config" "jsonb" NOT NULL,
    "page" "text" DEFAULT 'traces'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid",
    "app_id" "uuid" NOT NULL,
    CONSTRAINT "saved_trace_filters_name_length" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 100))),
    CONSTRAINT "saved_trace_filters_page_check" CHECK (("page" = ANY (ARRAY['traces'::"text", 'requests'::"text", 'sessions'::"text", 'agents-sessions'::"text"])))
);


ALTER TABLE "public"."saved_trace_filters" OWNER TO "postgres";


COMMENT ON TABLE "public"."saved_trace_filters" IS 'Org-scoped saved filter/view configurations for traces and requests views';



COMMENT ON COLUMN "public"."saved_trace_filters"."user_id" IS 'User who created this filter (metadata only, not used for access control)';



COMMENT ON COLUMN "public"."saved_trace_filters"."name" IS 'Filter name (1-100 chars, unique per tenant+page)';



COMMENT ON COLUMN "public"."saved_trace_filters"."filter_config" IS 'JSONB filter/view configuration: v1/v2 for traces, v3 for requests views';



COMMENT ON COLUMN "public"."saved_trace_filters"."page" IS 'Which page this filter belongs to: traces, requests, sessions, or agents-sessions';



CREATE TABLE IF NOT EXISTS "public"."sso_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "sso_config_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "event_type" "text" NOT NULL,
    "email" "text",
    "error_message" "text",
    "ip_address" "inet",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sso_audit_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."sso_audit_log" IS 'Immutable audit log of SSO authentication and configuration events';



CREATE TABLE IF NOT EXISTS "public"."sso_config" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "supabase_provider_id" "uuid",
    "metadata_url" "text",
    "entity_id" "text",
    "allowed_domains" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "enforcement_enabled" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "last_validated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid"
);


ALTER TABLE "public"."sso_config" OWNER TO "postgres";


COMMENT ON TABLE "public"."sso_config" IS 'Tenant-level SSO configuration for enterprise SAML authentication';



CREATE TABLE IF NOT EXISTS "public"."sso_identity" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "sso_config_id" "uuid" NOT NULL,
    "external_subject_id" "text" NOT NULL,
    "idp_issuer" "text",
    "first_login_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_login_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sso_identity" OWNER TO "postgres";


COMMENT ON TABLE "public"."sso_identity" IS 'Maps external IdP user identities to internal user accounts for SSO';



CREATE TABLE IF NOT EXISTS "public"."temp_access_grant" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_by" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "reason" "text",
    "customer_permission_confirmed" boolean DEFAULT false NOT NULL,
    "updated_by" "uuid"
);


ALTER TABLE "public"."temp_access_grant" OWNER TO "postgres";


COMMENT ON COLUMN "public"."temp_access_grant"."customer_permission_confirmed" IS 'Admin confirmed they received customer permission before granting access';



CREATE TABLE IF NOT EXISTS "public"."tenant" (
    "tenant_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "organization_name" character varying(255) NOT NULL,
    "company_name" character varying(255) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "first_trace_at" timestamp with time zone,
    "agent_capture_tier" "text" DEFAULT 'full'::"text" NOT NULL,
    CONSTRAINT "chk_tenant_agent_capture_tier" CHECK (("agent_capture_tier" = ANY (ARRAY['metrics'::"text", 'redacted'::"text", 'full'::"text"])))
);


ALTER TABLE "public"."tenant" OWNER TO "postgres";


COMMENT ON COLUMN "public"."tenant"."first_trace_at" IS 'Set once atomically on the tenant''s first successful trace ingest. Guards org_first_trace against billing-period reset false positives.';



CREATE TABLE IF NOT EXISTS "public"."tenant_entitlement_override" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "entitlement_key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "override_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid"
);


ALTER TABLE "public"."tenant_entitlement_override" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."terms_agreement" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "terms_version" "text" NOT NULL,
    "agreed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ip_address" "text",
    "user_agent" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "updated_by" "uuid",
    "consent_type" "text" DEFAULT 'explicit'::"text" NOT NULL,
    CONSTRAINT "terms_agreement_consent_type_check" CHECK (("consent_type" = ANY (ARRAY['explicit'::"text", 'implicit'::"text"])))
);


ALTER TABLE "public"."terms_agreement" OWNER TO "postgres";


COMMENT ON TABLE "public"."terms_agreement" IS 'Stores user consent records for Terms of Service and Privacy Policy. Append-only audit table.';



COMMENT ON COLUMN "public"."terms_agreement"."terms_version" IS 'Version identifier, typically a date string like 2026-01-10';



COMMENT ON COLUMN "public"."terms_agreement"."ip_address" IS 'Client IP address at time of agreement, for audit purposes';



COMMENT ON COLUMN "public"."terms_agreement"."user_agent" IS 'Client user agent string at time of agreement, for audit purposes';



COMMENT ON COLUMN "public"."terms_agreement"."consent_type" IS 'Type of consent: explicit (checkbox click), implicit (continued use or "by signing up you agree" language)';



CREATE TABLE IF NOT EXISTS "public"."user_git_identity" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "username" "text" NOT NULL,
    "email" "text",
    "provider_user_id" "text",
    "access_token" "text",
    "refresh_token" "text",
    "token_expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone,
    CONSTRAINT "chk_git_identity_provider" CHECK (("provider" = ANY (ARRAY['github'::"text", 'gitlab'::"text"])))
);


ALTER TABLE "public"."user_git_identity" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_git_identity" IS 'Stores user Git provider identities for committer validation';



COMMENT ON COLUMN "public"."user_git_identity"."provider" IS 'Git hosting provider: github or gitlab';



COMMENT ON COLUMN "public"."user_git_identity"."username" IS 'Username on the Git provider';



COMMENT ON COLUMN "public"."user_git_identity"."email" IS 'Email from the Git provider (for committer matching)';



COMMENT ON COLUMN "public"."user_git_identity"."provider_user_id" IS 'Provider internal user ID';



COMMENT ON COLUMN "public"."user_git_identity"."access_token" IS 'OAuth access token for API calls';



COMMENT ON COLUMN "public"."user_git_identity"."refresh_token" IS 'OAuth refresh token for obtaining new access tokens';



COMMENT ON COLUMN "public"."user_git_identity"."token_expires_at" IS 'When the access token expires';



CREATE TABLE IF NOT EXISTS "public"."worker_run" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "environment_id" "uuid",
    "agent" "text" NOT NULL,
    "task_prompt" "text" NOT NULL,
    "base_branch" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "dispatch" "text" DEFAULT 'fly'::"text" NOT NULL,
    "machine_id" "text",
    "outcome" "text",
    "branch_name" "text",
    "pr_url" "text",
    "pr_number" integer,
    "failure_code" "text",
    "error_message" "text",
    "cost_usd" numeric,
    "num_turns" integer,
    "raw_log" "text",
    "wall_clock_cap_s" integer DEFAULT 1800 NOT NULL,
    "started_at" timestamp with time zone,
    "heartbeat_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "duration_ms" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "workspace_id" "uuid",
    "turn_index" integer DEFAULT 0 NOT NULL,
    "attachments" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "model" "text",
    CONSTRAINT "chk_worker_run_cap" CHECK ((("wall_clock_cap_s" > 0) AND ("wall_clock_cap_s" <= 3600))),
    CONSTRAINT "chk_worker_run_dispatch" CHECK (("dispatch" = ANY (ARRAY['fly'::"text", 'local'::"text"]))),
    CONSTRAINT "chk_worker_run_outcome" CHECK ((("outcome" IS NULL) OR ("outcome" = ANY (ARRAY['changes'::"text", 'no_changes'::"text"])))),
    CONSTRAINT "chk_worker_run_status" CHECK (("status" = ANY (ARRAY['queued'::"text", 'provisioning'::"text", 'running'::"text", 'pushing'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text", 'timed_out'::"text"])))
);


ALTER TABLE "public"."worker_run" OWNER TO "postgres";


COMMENT ON TABLE "public"."worker_run" IS 'Cloud worker run: a terminal coding agent executed against the app''s repo on managed compute. Backs run history, transcript polling, cancel, and PR delivery.';



CREATE TABLE IF NOT EXISTS "public"."worker_run_event" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "worker_run_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "seq" bigint NOT NULL,
    "event_type" "text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."worker_run_event" OWNER TO "postgres";


COMMENT ON TABLE "public"."worker_run_event" IS 'Append-only normalized transcript for a worker_run. Written by the worker via the service role; read via the parent run''s worker_run.read permission.';



CREATE TABLE IF NOT EXISTS "public"."worker_workspace" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "app_id" "uuid" NOT NULL,
    "environment_id" "uuid",
    "agent" "text" NOT NULL,
    "base_branch" "text" DEFAULT ''::"text" NOT NULL,
    "work_branch" "text",
    "substrate" "text" DEFAULT 'local'::"text" NOT NULL,
    "machine_ref" "text",
    "workspace_ref" "text",
    "session_ref" "text",
    "status" "text" DEFAULT 'creating'::"text" NOT NULL,
    "current_run_id" "uuid",
    "idle_ttl_s" integer DEFAULT 1800 NOT NULL,
    "last_active_at" timestamp with time zone,
    "failure_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "updated_at" timestamp with time zone,
    "model" "text",
    CONSTRAINT "chk_worker_env_status" CHECK (("status" = ANY (ARRAY['creating'::"text", 'active'::"text", 'suspended'::"text", 'destroyed'::"text"]))),
    CONSTRAINT "chk_worker_env_substrate" CHECK (("substrate" = ANY (ARRAY['local'::"text", 'e2b'::"text", 'fly'::"text"]))),
    CONSTRAINT "chk_worker_env_ttl" CHECK (("idle_ttl_s" > 0))
);


ALTER TABLE "public"."worker_workspace" OWNER TO "postgres";


COMMENT ON TABLE "public"."worker_workspace" IS 'Persistent worker environment: durable compute (local dir / E2B sandbox / suspendable Fly machine) that many worker_run turns execute against, enabling multi-turn continue-in-the-same-workspace with agent session resume.';



ALTER TABLE ONLY "ops"."index_usage_snapshot"
    ADD CONSTRAINT "index_usage_snapshot_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "ops"."table_usage_snapshot"
    ADD CONSTRAINT "table_usage_snapshot_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "private"."api_key_secret"
    ADD CONSTRAINT "api_key_secret_pkey" PRIMARY KEY ("api_key_id");



ALTER TABLE ONLY "private"."api_key_secret"
    ADD CONSTRAINT "uc_api_key_secret_digest" UNIQUE ("key_digest");



ALTER TABLE ONLY "public"."agent_finding"
    ADD CONSTRAINT "agent_finding_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_theme"
    ADD CONSTRAINT "agent_theme_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_cost_config"
    ADD CONSTRAINT "ai_cost_config_pkey" PRIMARY KEY ("tenant_id");



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_api_key_id_key" UNIQUE ("api_key_id");



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "app_member_role_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app"
    ADD CONSTRAINT "app_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app"
    ADD CONSTRAINT "app_tenant_id_unique" UNIQUE ("tenant_id", "id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_pkey" PRIMARY KEY ("tenant_id");



ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_stripe_customer_id_key" UNIQUE ("stripe_customer_id");



ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_stripe_subscription_id_key" UNIQUE ("stripe_subscription_id");



ALTER TABLE ONLY "public"."context_blob"
    ADD CONSTRAINT "context_blob_pkey" PRIMARY KEY ("app_id", "blob_sha");



ALTER TABLE ONLY "public"."context_head"
    ADD CONSTRAINT "context_head_pkey" PRIMARY KEY ("app_id", "branch");



ALTER TABLE ONLY "public"."context_snapshot"
    ADD CONSTRAINT "context_snapshot_id_app_unique" UNIQUE ("id", "app_id");



ALTER TABLE ONLY "public"."context_snapshot"
    ADD CONSTRAINT "context_snapshot_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."context_sync_event"
    ADD CONSTRAINT "context_sync_event_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."context_tree_entry"
    ADD CONSTRAINT "context_tree_entry_pkey" PRIMARY KEY ("snapshot_id", "path");



ALTER TABLE ONLY "public"."custom_role_permission"
    ADD CONSTRAINT "custom_role_permission_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."custom_role_permission"
    ADD CONSTRAINT "custom_role_permission_unique" UNIQUE ("custom_role_id", "permission");



ALTER TABLE ONLY "public"."custom_role"
    ADD CONSTRAINT "custom_role_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard"
    ADD CONSTRAINT "dashboard_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dashboard_widget"
    ADD CONSTRAINT "dashboard_widget_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."env_escalation"
    ADD CONSTRAINT "env_escalation_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."env_var"
    ADD CONSTRAINT "env_var_app_key_env_unique" UNIQUE ("app_id", "key", "environment_id");



ALTER TABLE ONLY "public"."env_var"
    ADD CONSTRAINT "env_var_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."environment"
    ADD CONSTRAINT "environment_id_app_unique" UNIQUE ("id", "app_id");



ALTER TABLE ONLY "public"."environment"
    ADD CONSTRAINT "environment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."eval_run"
    ADD CONSTRAINT "eval_run_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."git_connection"
    ADD CONSTRAINT "excl_git_connection_installation_one_tenant" EXCLUDE USING "gist" ("installation_id" WITH =, "tenant_id" WITH <>) WHERE (("installation_id" IS NOT NULL));



ALTER TABLE ONLY "public"."feature_flag"
    ADD CONSTRAINT "feature_flag_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."feature_flag_override"
    ADD CONSTRAINT "feature_flag_override_flag_id_tenant_id_key" UNIQUE ("flag_id", "tenant_id");



ALTER TABLE ONLY "public"."feature_flag_override"
    ADD CONSTRAINT "feature_flag_override_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."feature_flag"
    ADD CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."git_connection"
    ADD CONSTRAINT "git_connection_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."git_branch"
    ADD CONSTRAINT "github_branch_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profile"
    ADD CONSTRAINT "github_username_unique" UNIQUE ("github_username");



ALTER TABLE ONLY "public"."membership"
    ADD CONSTRAINT "membership_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."membership"
    ADD CONSTRAINT "membership_user_tenant_unique" UNIQUE ("user_id", "tenant_id");



ALTER TABLE ONLY "public"."notification"
    ADD CONSTRAINT "notification_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_deployment"
    ADD CONSTRAINT "platform_deployment_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_dora_collection_state"
    ADD CONSTRAINT "platform_dora_collection_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_incident"
    ADD CONSTRAINT "platform_incident_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_role_permissions"
    ADD CONSTRAINT "platform_role_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_role_permissions"
    ADD CONSTRAINT "platform_role_permissions_role_permission_key" UNIQUE ("role", "permission");



ALTER TABLE ONLY "public"."platform_user_role"
    ADD CONSTRAINT "platform_user_role_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_user_role"
    ADD CONSTRAINT "platform_user_role_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."profile"
    ADD CONSTRAINT "profile_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pull_request"
    ADD CONSTRAINT "pull_request_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pull_request_session"
    ADD CONSTRAINT "pull_request_session_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_permission_key" UNIQUE ("role", "permission");



ALTER TABLE ONLY "public"."saved_trace_filters"
    ADD CONSTRAINT "saved_trace_filters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."saved_trace_filters"
    ADD CONSTRAINT "saved_trace_filters_unique_name_page" UNIQUE ("tenant_id", "app_id", "name", "page");



ALTER TABLE ONLY "public"."sso_audit_log"
    ADD CONSTRAINT "sso_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sso_config"
    ADD CONSTRAINT "sso_config_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sso_config"
    ADD CONSTRAINT "sso_config_tenant_unique" UNIQUE ("tenant_id");



ALTER TABLE ONLY "public"."sso_identity"
    ADD CONSTRAINT "sso_identity_config_subject_unique" UNIQUE ("sso_config_id", "external_subject_id");



ALTER TABLE ONLY "public"."sso_identity"
    ADD CONSTRAINT "sso_identity_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sso_identity"
    ADD CONSTRAINT "sso_identity_tenant_user_unique" UNIQUE ("tenant_id", "user_id");



ALTER TABLE ONLY "public"."temp_access_grant"
    ADD CONSTRAINT "temp_access_grant_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_entitlement_override"
    ADD CONSTRAINT "tenant_entitlement_override_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_entitlement_override"
    ADD CONSTRAINT "tenant_entitlement_override_tenant_id_entitlement_key_key" UNIQUE ("tenant_id", "entitlement_key");



ALTER TABLE ONLY "public"."tenant"
    ADD CONSTRAINT "tenant_organization_name_key" UNIQUE ("organization_name");



ALTER TABLE ONLY "public"."tenant"
    ADD CONSTRAINT "tenant_pkey" PRIMARY KEY ("tenant_id");



ALTER TABLE ONLY "public"."terms_agreement"
    ADD CONSTRAINT "terms_agreement_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."terms_agreement"
    ADD CONSTRAINT "terms_agreement_user_version_unique" UNIQUE ("user_id", "terms_version");



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "uc_api_key" UNIQUE ("name", "app_id");



ALTER TABLE ONLY "public"."context_snapshot"
    ADD CONSTRAINT "uc_context_snapshot" UNIQUE ("app_id", "commit_sha", "classifier_version");



ALTER TABLE ONLY "public"."git_connection"
    ADD CONSTRAINT "uc_git_connection" UNIQUE ("app_id", "tenant_id");



ALTER TABLE ONLY "public"."user_git_identity"
    ADD CONSTRAINT "uc_provider_username" UNIQUE ("provider", "username");



ALTER TABLE ONLY "public"."pull_request"
    ADD CONSTRAINT "uc_pull_request" UNIQUE ("app_id", "pr_number");



ALTER TABLE ONLY "public"."user_git_identity"
    ADD CONSTRAINT "uc_user_provider" UNIQUE ("profile_id", "provider");



ALTER TABLE ONLY "public"."git_branch"
    ADD CONSTRAINT "unique_git_repo_branch_constraint" UNIQUE ("repo", "branch_name", "tenant_id");



ALTER TABLE ONLY "public"."app"
    ADD CONSTRAINT "unique_name_per_tenant" UNIQUE ("tenant_id", "name");



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "uq_app_member_role_membership_app" UNIQUE ("membership_id", "app_id");



ALTER TABLE ONLY "public"."dashboard"
    ADD CONSTRAINT "uq_dashboard_tenant_app_name" UNIQUE ("tenant_id", "app_id", "name");



ALTER TABLE ONLY "public"."pull_request_session"
    ADD CONSTRAINT "uq_pull_request_session" UNIQUE ("app_id", "pr_number", "trace_id");



ALTER TABLE ONLY "public"."user_git_identity"
    ADD CONSTRAINT "user_git_identity_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."worker_run_event"
    ADD CONSTRAINT "worker_run_event_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."worker_run_event"
    ADD CONSTRAINT "worker_run_event_run_seq_unique" UNIQUE ("worker_run_id", "seq");



ALTER TABLE ONLY "public"."worker_run"
    ADD CONSTRAINT "worker_run_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."worker_workspace"
    ADD CONSTRAINT "worker_workspace_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "index_usage_snapshot_capture_idx_uniq" ON "ops"."index_usage_snapshot" USING "btree" ("captured_at", "schemaname", "indexrelname");



CREATE UNIQUE INDEX "table_usage_snapshot_capture_rel_uniq" ON "ops"."table_usage_snapshot" USING "btree" ("captured_at", "schemaname", "relname");



CREATE UNIQUE INDEX "env_var_app_key_kind_unique" ON "public"."env_var" USING "btree" ("app_id", "key", "target_kind") WHERE ("target_kind" IS NOT NULL);



CREATE INDEX "idx_agent_finding_app_id" ON "public"."agent_finding" USING "btree" ("app_id");



CREATE INDEX "idx_agent_finding_tenant_app" ON "public"."agent_finding" USING "btree" ("tenant_id", "app_id");



CREATE INDEX "idx_agent_theme_app_id" ON "public"."agent_theme" USING "btree" ("app_id");



CREATE INDEX "idx_agent_theme_tenant_app" ON "public"."agent_theme" USING "btree" ("tenant_id", "app_id");



CREATE INDEX "idx_api_key_actor_membership_id" ON "public"."api_key" USING "btree" ("actor_membership_id");



CREATE INDEX "idx_api_key_app" ON "public"."api_key" USING "btree" ("app_id");



CREATE INDEX "idx_api_key_environment" ON "public"."api_key" USING "btree" ("environment_id");



CREATE INDEX "idx_api_key_tenant" ON "public"."api_key" USING "btree" ("tenant_id");



CREATE INDEX "idx_app_commit_sha" ON "public"."app" USING "btree" ("commit_sha");



CREATE INDEX "idx_app_member_role_app" ON "public"."app_member_role" USING "btree" ("app_id");



CREATE INDEX "idx_app_member_role_custom_role" ON "public"."app_member_role" USING "btree" ("custom_role_id") WHERE ("custom_role_id" IS NOT NULL);



CREATE INDEX "idx_app_member_role_tenant_membership" ON "public"."app_member_role" USING "btree" ("tenant_id", "membership_id");



CREATE INDEX "idx_audit_log_action" ON "public"."audit_log" USING "btree" ("action_type");



CREATE INDEX "idx_audit_log_actor_id" ON "public"."audit_log" USING "btree" ("actor_id");



CREATE INDEX "idx_audit_log_created_at" ON "public"."audit_log" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_audit_log_target" ON "public"."audit_log" USING "btree" ("target_type", "target_id");



CREATE INDEX "idx_audit_log_tenant_created" ON "public"."audit_log" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "idx_context_blob_tenant_id" ON "public"."context_blob" USING "btree" ("tenant_id");



CREATE INDEX "idx_context_head_snapshot_id" ON "public"."context_head" USING "btree" ("snapshot_id");



CREATE INDEX "idx_context_head_tenant_id" ON "public"."context_head" USING "btree" ("tenant_id");



CREATE INDEX "idx_context_snapshot_tenant_id" ON "public"."context_snapshot" USING "btree" ("tenant_id");



CREATE INDEX "idx_context_sync_event_app_created" ON "public"."context_sync_event" USING "btree" ("app_id", "created_at" DESC);



CREATE INDEX "idx_context_sync_event_snapshot_id" ON "public"."context_sync_event" USING "btree" ("snapshot_id");



CREATE INDEX "idx_context_sync_event_tenant_id" ON "public"."context_sync_event" USING "btree" ("tenant_id");



CREATE INDEX "idx_context_tree_entry_app" ON "public"."context_tree_entry" USING "btree" ("app_id");



CREATE INDEX "idx_context_tree_entry_tenant_id" ON "public"."context_tree_entry" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_custom_role_tenant_name" ON "public"."custom_role" USING "btree" ("tenant_id", "lower"("name"));



CREATE INDEX "idx_dashboard_app_id" ON "public"."dashboard" USING "btree" ("app_id");



CREATE UNIQUE INDEX "idx_dashboard_one_default_per_tenant_app" ON "public"."dashboard" USING "btree" ("tenant_id", "app_id") WHERE ("is_default" = true);



CREATE INDEX "idx_dashboard_user_id" ON "public"."dashboard" USING "btree" ("user_id");



CREATE INDEX "idx_dashboard_widget_tenant_id" ON "public"."dashboard_widget" USING "btree" ("tenant_id");



CREATE INDEX "idx_env_escalation_app_created" ON "public"."env_escalation" USING "btree" ("app_id", "created_at" DESC);



CREATE INDEX "idx_env_escalation_eval_run_id" ON "public"."env_escalation" USING "btree" ("eval_run_id");



CREATE INDEX "idx_env_escalation_status_created" ON "public"."env_escalation" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_env_escalation_tenant" ON "public"."env_escalation" USING "btree" ("tenant_id");



CREATE INDEX "idx_env_var_environment" ON "public"."env_var" USING "btree" ("environment_id");



CREATE INDEX "idx_env_var_tenant" ON "public"."env_var" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_environment_app_name_unique" ON "public"."environment" USING "btree" ("app_id", "name");



CREATE UNIQUE INDEX "idx_environment_fly_app_name_unique" ON "public"."environment" USING "btree" ("tenant_id", "fly_app_name") WHERE ("fly_app_name" IS NOT NULL);



CREATE UNIQUE INDEX "idx_environment_one_default_per_app" ON "public"."environment" USING "btree" ("app_id") WHERE ("is_default" = true);



CREATE INDEX "idx_environment_tenant" ON "public"."environment" USING "btree" ("tenant_id");



CREATE INDEX "idx_eval_run_app_created" ON "public"."eval_run" USING "btree" ("app_id", "created_at" DESC);



CREATE INDEX "idx_eval_run_environment_id" ON "public"."eval_run" USING "btree" ("environment_id");



CREATE INDEX "idx_eval_run_tenant" ON "public"."eval_run" USING "btree" ("tenant_id");



CREATE INDEX "idx_feature_flag_override_tenant_id" ON "public"."feature_flag_override" USING "btree" ("tenant_id");



CREATE INDEX "idx_git_branch_app" ON "public"."git_branch" USING "btree" ("app_id");



CREATE INDEX "idx_git_branch_tenant" ON "public"."git_branch" USING "btree" ("tenant_id");



CREATE INDEX "idx_git_connection_provider_tenant" ON "public"."git_connection" USING "btree" ("provider", "tenant_id");



CREATE INDEX "idx_git_connection_tenant" ON "public"."git_connection" USING "btree" ("tenant_id");



CREATE INDEX "idx_git_identity_provider_email" ON "public"."user_git_identity" USING "btree" ("provider", "email");



CREATE INDEX "idx_git_identity_tenant" ON "public"."user_git_identity" USING "btree" ("tenant_id");



CREATE INDEX "idx_membership_custom_role_id" ON "public"."membership" USING "btree" ("custom_role_id") WHERE ("custom_role_id" IS NOT NULL);



CREATE INDEX "idx_membership_invited_by" ON "public"."membership" USING "btree" ("invited_by");



CREATE INDEX "idx_membership_status" ON "public"."membership" USING "btree" ("status") WHERE (("status")::"text" = 'pending'::"text");



CREATE INDEX "idx_membership_tenant_id" ON "public"."membership" USING "btree" ("tenant_id");



CREATE INDEX "idx_membership_tenant_role" ON "public"."membership" USING "btree" ("tenant_id", "role") WHERE (("status")::"text" = 'active'::"text");



CREATE INDEX "idx_membership_user_status" ON "public"."membership" USING "btree" ("user_id", "status");



CREATE INDEX "idx_notification_tenant" ON "public"."notification" USING "btree" ("tenant_id");



CREATE INDEX "idx_platform_deployment_env_started" ON "public"."platform_deployment" USING "btree" ("environment", "started_at" DESC);



CREATE UNIQUE INDEX "idx_platform_deployment_external_id" ON "public"."platform_deployment" USING "btree" ("external_id");



CREATE INDEX "idx_platform_deployment_service_started" ON "public"."platform_deployment" USING "btree" ("service", "started_at" DESC);



CREATE INDEX "idx_platform_deployment_started_at" ON "public"."platform_deployment" USING "btree" ("started_at" DESC);



CREATE INDEX "idx_platform_deployment_status" ON "public"."platform_deployment" USING "btree" ("status");



CREATE UNIQUE INDEX "idx_platform_dora_collection_state_source" ON "public"."platform_dora_collection_state" USING "btree" ("source");



CREATE INDEX "idx_platform_incident_deployment" ON "public"."platform_incident" USING "btree" ("deployment_id");



CREATE INDEX "idx_platform_incident_env_started" ON "public"."platform_incident" USING "btree" ("environment", "started_at" DESC);



CREATE UNIQUE INDEX "idx_platform_incident_external_id" ON "public"."platform_incident" USING "btree" ("external_id");



CREATE INDEX "idx_platform_incident_service" ON "public"."platform_incident" USING "btree" ("service");



CREATE INDEX "idx_platform_incident_started_at" ON "public"."platform_incident" USING "btree" ("started_at" DESC);



CREATE INDEX "idx_platform_incident_status" ON "public"."platform_incident" USING "btree" ("status");



CREATE INDEX "idx_pr_session_app_trace" ON "public"."pull_request_session" USING "btree" ("app_id", "trace_id");



CREATE INDEX "idx_pr_session_pending" ON "public"."pull_request_session" USING "btree" ("verification", "first_linked_at") WHERE ("verification" = 'pending'::"text");



CREATE INDEX "idx_pull_request_app_state" ON "public"."pull_request" USING "btree" ("app_id", "state");



CREATE INDEX "idx_pull_request_environment" ON "public"."pull_request" USING "btree" ("environment_id");



CREATE INDEX "idx_pull_request_session_tenant_id" ON "public"."pull_request_session" USING "btree" ("tenant_id");



CREATE INDEX "idx_pull_request_tenant" ON "public"."pull_request" USING "btree" ("tenant_id");



CREATE INDEX "idx_saved_trace_filters_user_id" ON "public"."saved_trace_filters" USING "btree" ("user_id");



CREATE INDEX "idx_sso_audit_log_config" ON "public"."sso_audit_log" USING "btree" ("sso_config_id");



CREATE INDEX "idx_sso_audit_log_tenant_created" ON "public"."sso_audit_log" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "idx_sso_audit_log_user_id" ON "public"."sso_audit_log" USING "btree" ("user_id");



CREATE INDEX "idx_sso_config_domains" ON "public"."sso_config" USING "gin" ("allowed_domains");



CREATE INDEX "idx_sso_identity_user_id" ON "public"."sso_identity" USING "btree" ("user_id");



CREATE INDEX "idx_temp_access_created_by" ON "public"."temp_access_grant" USING "btree" ("created_by");



CREATE INDEX "idx_temp_access_expires" ON "public"."temp_access_grant" USING "btree" ("expires_at") WHERE ("revoked_at" IS NULL);



CREATE INDEX "idx_temp_access_tenant" ON "public"."temp_access_grant" USING "btree" ("tenant_id");



CREATE INDEX "idx_terms_agreement_consent_type" ON "public"."terms_agreement" USING "btree" ("consent_type");



CREATE INDEX "idx_terms_agreement_version" ON "public"."terms_agreement" USING "btree" ("terms_version");



CREATE INDEX "idx_widget_dashboard" ON "public"."dashboard_widget" USING "btree" ("dashboard_id");



CREATE INDEX "idx_worker_run_app_created" ON "public"."worker_run" USING "btree" ("app_id", "created_at" DESC);



CREATE INDEX "idx_worker_run_environment_id" ON "public"."worker_run" USING "btree" ("environment_id");



CREATE INDEX "idx_worker_run_event_app_id" ON "public"."worker_run_event" USING "btree" ("app_id");



CREATE INDEX "idx_worker_run_event_tenant_id" ON "public"."worker_run_event" USING "btree" ("tenant_id");



CREATE INDEX "idx_worker_run_inflight" ON "public"."worker_run" USING "btree" ("status", "heartbeat_at") WHERE ("status" = ANY (ARRAY['queued'::"text", 'provisioning'::"text", 'running'::"text", 'pushing'::"text"]));



CREATE INDEX "idx_worker_run_tenant" ON "public"."worker_run" USING "btree" ("tenant_id");



CREATE INDEX "idx_worker_run_workspace_id" ON "public"."worker_run" USING "btree" ("workspace_id", "turn_index");



CREATE INDEX "idx_worker_workspace_app" ON "public"."worker_workspace" USING "btree" ("app_id", "created_at" DESC);



CREATE INDEX "idx_worker_workspace_environment_id" ON "public"."worker_workspace" USING "btree" ("environment_id");



CREATE INDEX "idx_worker_workspace_idle" ON "public"."worker_workspace" USING "btree" ("status", "last_active_at") WHERE ("status" = ANY (ARRAY['active'::"text", 'suspended'::"text"]));



CREATE INDEX "idx_worker_workspace_tenant" ON "public"."worker_workspace" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "profile_email_unique_lower" ON "public"."profile" USING "btree" ("lower"("email"));



CREATE UNIQUE INDEX "temp_access_grant_active_idx" ON "public"."temp_access_grant" USING "btree" ("created_by", "tenant_id") WHERE ("revoked_at" IS NULL);



CREATE UNIQUE INDEX "tenant_organization_name_unique_lower" ON "public"."tenant" USING "btree" ("lower"(("organization_name")::"text"));



CREATE OR REPLACE TRIGGER "audit_log_hash_chain_trigger" BEFORE INSERT ON "public"."audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."audit_log_hash_chain"();



CREATE OR REPLACE TRIGGER "enforce_app_policy_permission_trigger" BEFORE UPDATE ON "public"."app" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_app_policy_permission"();



CREATE OR REPLACE TRIGGER "enforce_membership_limit" BEFORE INSERT OR UPDATE ON "public"."membership" FOR EACH ROW EXECUTE FUNCTION "public"."check_membership_limit"();



CREATE OR REPLACE TRIGGER "on_billing_tier_change_nullify_custom_roles" AFTER UPDATE OF "tier_id" ON "public"."billing" FOR EACH ROW EXECUTE FUNCTION "public"."nullify_custom_role_on_downgrade"();



CREATE OR REPLACE TRIGGER "on_create_seed_default_env" AFTER INSERT ON "public"."app" FOR EACH ROW EXECUTE FUNCTION "public"."app_seed_default_env"();



CREATE OR REPLACE TRIGGER "on_create_set_app_tenant_id_column" BEFORE INSERT ON "public"."app" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_ai_cost_config_set_created_columns" BEFORE INSERT ON "public"."ai_cost_config" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_api_key" BEFORE INSERT ON "public"."api_key" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_api_key_set_created_columns" BEFORE INSERT ON "public"."api_key" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_app_member_role_set_created_columns" BEFORE INSERT ON "public"."app_member_role" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_app_member_role_set_tenant_id" BEFORE INSERT ON "public"."app_member_role" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_app_set_created_columns" BEFORE INSERT ON "public"."app" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_billing_set_created_columns" BEFORE INSERT ON "public"."billing" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_custom_role_set_created_columns" BEFORE INSERT ON "public"."custom_role" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_custom_role_set_tenant_id" BEFORE INSERT ON "public"."custom_role" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_dashboard_set_created_columns" BEFORE INSERT ON "public"."dashboard" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_dashboard_widget_set_created_columns" BEFORE INSERT ON "public"."dashboard_widget" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_env_escalation_set_created_columns" BEFORE INSERT ON "public"."env_escalation" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_env_var_set_created_columns" BEFORE INSERT ON "public"."env_var" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_env_var_set_tenant_id" BEFORE INSERT ON "public"."env_var" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_environment_set_created_columns" BEFORE INSERT ON "public"."environment" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_eval_run_set_created_columns" BEFORE INSERT ON "public"."eval_run" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_feature_flag_override_set_created_columns" BEFORE INSERT ON "public"."feature_flag_override" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_feature_flag_set_created_columns" BEFORE INSERT ON "public"."feature_flag" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_git_branch_set_created_columns" BEFORE INSERT ON "public"."git_branch" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_git_branch_set_tenant_id" BEFORE INSERT ON "public"."git_branch" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_git_connection_set_created_columns" BEFORE INSERT ON "public"."git_connection" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_git_connection_set_tenant_id" BEFORE INSERT ON "public"."git_connection" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_git_identity_set_tenant_id" BEFORE INSERT ON "public"."user_git_identity" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_membership_set_created_columns" BEFORE INSERT ON "public"."membership" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_notification_set_tenant_id" BEFORE INSERT ON "public"."notification" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_platform_user_role_set_created_columns" BEFORE INSERT ON "public"."platform_user_role" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_pull_request_set_created_columns" BEFORE INSERT ON "public"."pull_request" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_saved_trace_filters_set_created_columns" BEFORE INSERT ON "public"."saved_trace_filters" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_saved_trace_filters_set_tenant_id" BEFORE INSERT ON "public"."saved_trace_filters" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_id"();



CREATE OR REPLACE TRIGGER "on_insert_sso_config_set_created_columns" BEFORE INSERT ON "public"."sso_config" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_temp_access_grant_set_created_columns" BEFORE INSERT ON "public"."temp_access_grant" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_tenant_entitlement_override_set_created_columns" BEFORE INSERT ON "public"."tenant_entitlement_override" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_tenant_set_created_columns" BEFORE INSERT ON "public"."tenant" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_terms_agreement_set_created_columns" BEFORE INSERT ON "public"."terms_agreement" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_worker_run_set_created_columns" BEFORE INSERT ON "public"."worker_run" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_insert_worker_workspace_set_created_columns" BEFORE INSERT ON "public"."worker_workspace" FOR EACH ROW EXECUTE FUNCTION "public"."set_created_columns"();



CREATE OR REPLACE TRIGGER "on_update_app_member_role_set_updated_columns" BEFORE UPDATE ON "public"."app_member_role" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_custom_role_set_updated_columns" BEFORE UPDATE ON "public"."custom_role" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_dashboard_set_updated_columns" BEFORE UPDATE ON "public"."dashboard" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_dashboard_widget_set_updated_columns" BEFORE UPDATE ON "public"."dashboard_widget" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_env_escalation_set_updated_columns" BEFORE UPDATE ON "public"."env_escalation" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_env_var_set_updated_columns" BEFORE UPDATE ON "public"."env_var" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_environment_set_updated_columns" BEFORE UPDATE ON "public"."environment" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_eval_run_set_updated_columns" BEFORE UPDATE ON "public"."eval_run" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_git_branch_set_updated_columns" BEFORE UPDATE ON "public"."git_branch" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_git_connection_set_updated_columns" BEFORE UPDATE ON "public"."git_connection" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_git_identity_set_updated_at" BEFORE UPDATE ON "public"."user_git_identity" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at_only"();



CREATE OR REPLACE TRIGGER "on_update_notification_set_updated_columns" BEFORE UPDATE ON "public"."notification" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_platform_dora_collection_state_set_updated_at" BEFORE UPDATE ON "public"."platform_dora_collection_state" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at_only"();



CREATE OR REPLACE TRIGGER "on_update_platform_incident_set_updated_at" BEFORE UPDATE ON "public"."platform_incident" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at_only"();



CREATE OR REPLACE TRIGGER "on_update_saved_trace_filters_set_updated_columns" BEFORE UPDATE ON "public"."saved_trace_filters" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_ai_cost_config_updated_columns" BEFORE UPDATE ON "public"."ai_cost_config" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_api_key_updated_columns" BEFORE UPDATE ON "public"."api_key" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_app_updated_columns" BEFORE UPDATE ON "public"."app" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_billing_updated_columns" BEFORE UPDATE ON "public"."billing" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_pull_request_updated_columns" BEFORE UPDATE ON "public"."pull_request" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_tenant_entitlement_override_updated_columns" BEFORE UPDATE ON "public"."tenant_entitlement_override" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_updated_at" BEFORE UPDATE ON "public"."profile" FOR EACH ROW EXECUTE FUNCTION "public"."set_profile_updated_at"();



CREATE OR REPLACE TRIGGER "on_update_set_updated_columns" BEFORE UPDATE ON "public"."feature_flag" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_updated_columns" BEFORE UPDATE ON "public"."feature_flag_override" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_updated_columns" BEFORE UPDATE ON "public"."membership" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_updated_columns" BEFORE UPDATE ON "public"."platform_user_role" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_updated_columns" BEFORE UPDATE ON "public"."sso_config" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_updated_columns" BEFORE UPDATE ON "public"."temp_access_grant" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_set_updated_columns" BEFORE UPDATE ON "public"."tenant" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_terms_agreement_set_updated_columns" BEFORE UPDATE ON "public"."terms_agreement" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_columns"();



CREATE OR REPLACE TRIGGER "on_update_worker_run_set_updated_at" BEFORE UPDATE ON "public"."worker_run" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at_only"();



CREATE OR REPLACE TRIGGER "on_update_worker_workspace_set_updated_at" BEFORE UPDATE ON "public"."worker_workspace" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at_only"();



CREATE OR REPLACE TRIGGER "prevent_app_member_role_self_grant" BEFORE INSERT OR UPDATE ON "public"."app_member_role" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_app_member_role_self_grant"();



CREATE OR REPLACE TRIGGER "prevent_membership_self_privilege_change_trigger" BEFORE UPDATE ON "public"."membership" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_membership_self_privilege_change"();



CREATE OR REPLACE TRIGGER "prevent_membership_tenant_change_trigger" BEFORE UPDATE ON "public"."membership" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_membership_tenant_change"();



CREATE OR REPLACE TRIGGER "protect_last_owner_trigger" BEFORE DELETE OR UPDATE ON "public"."membership" FOR EACH ROW EXECUTE FUNCTION "public"."protect_last_owner"();



CREATE OR REPLACE TRIGGER "trg_environment_enforce_invariants" BEFORE DELETE OR UPDATE ON "public"."environment" FOR EACH ROW EXECUTE FUNCTION "public"."environment_enforce_invariants"();



ALTER TABLE ONLY "private"."api_key_secret"
    ADD CONSTRAINT "api_key_secret_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_finding"
    ADD CONSTRAINT "agent_finding_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_finding"
    ADD CONSTRAINT "agent_finding_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_finding"
    ADD CONSTRAINT "agent_finding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_theme"
    ADD CONSTRAINT "agent_theme_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_theme"
    ADD CONSTRAINT "agent_theme_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_theme"
    ADD CONSTRAINT "agent_theme_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_cost_config"
    ADD CONSTRAINT "ai_cost_config_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."ai_cost_config"
    ADD CONSTRAINT "ai_cost_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_cost_config"
    ADD CONSTRAINT "ai_cost_config_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_actor_membership_id_fkey" FOREIGN KEY ("actor_membership_id") REFERENCES "public"."membership"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."api_key"
    ADD CONSTRAINT "api_key_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."app"
    ADD CONSTRAINT "app_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "app_member_role_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "app_member_role_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "app_member_role_custom_role_id_fkey" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_role"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "app_member_role_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "app_member_role_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "app_member_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_member_role"
    ADD CONSTRAINT "app_member_role_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."app"
    ADD CONSTRAINT "app_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app"
    ADD CONSTRAINT "app_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing"
    ADD CONSTRAINT "billing_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."context_blob"
    ADD CONSTRAINT "context_blob_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_blob"
    ADD CONSTRAINT "context_blob_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_blob"
    ADD CONSTRAINT "context_blob_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_head"
    ADD CONSTRAINT "context_head_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_head"
    ADD CONSTRAINT "context_head_snapshot_app_fk" FOREIGN KEY ("snapshot_id", "app_id") REFERENCES "public"."context_snapshot"("id", "app_id");



ALTER TABLE ONLY "public"."context_head"
    ADD CONSTRAINT "context_head_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."context_snapshot"("id");



ALTER TABLE ONLY "public"."context_head"
    ADD CONSTRAINT "context_head_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_head"
    ADD CONSTRAINT "context_head_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_snapshot"
    ADD CONSTRAINT "context_snapshot_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_snapshot"
    ADD CONSTRAINT "context_snapshot_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_snapshot"
    ADD CONSTRAINT "context_snapshot_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_sync_event"
    ADD CONSTRAINT "context_sync_event_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_sync_event"
    ADD CONSTRAINT "context_sync_event_snapshot_app_fk" FOREIGN KEY ("snapshot_id", "app_id") REFERENCES "public"."context_snapshot"("id", "app_id") ON DELETE SET NULL ("snapshot_id");



ALTER TABLE ONLY "public"."context_sync_event"
    ADD CONSTRAINT "context_sync_event_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."context_snapshot"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."context_sync_event"
    ADD CONSTRAINT "context_sync_event_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_sync_event"
    ADD CONSTRAINT "context_sync_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_tree_entry"
    ADD CONSTRAINT "context_tree_entry_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_tree_entry"
    ADD CONSTRAINT "context_tree_entry_snapshot_app_fk" FOREIGN KEY ("snapshot_id", "app_id") REFERENCES "public"."context_snapshot"("id", "app_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_tree_entry"
    ADD CONSTRAINT "context_tree_entry_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "public"."context_snapshot"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_tree_entry"
    ADD CONSTRAINT "context_tree_entry_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_tree_entry"
    ADD CONSTRAINT "context_tree_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_role"
    ADD CONSTRAINT "custom_role_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."custom_role_permission"
    ADD CONSTRAINT "custom_role_permission_custom_role_id_fkey" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_role"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_role"
    ADD CONSTRAINT "custom_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."custom_role"
    ADD CONSTRAINT "custom_role_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dashboard"
    ADD CONSTRAINT "dashboard_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dashboard"
    ADD CONSTRAINT "dashboard_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dashboard"
    ADD CONSTRAINT "dashboard_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dashboard"
    ADD CONSTRAINT "dashboard_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dashboard"
    ADD CONSTRAINT "dashboard_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dashboard"
    ADD CONSTRAINT "dashboard_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profile"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dashboard_widget"
    ADD CONSTRAINT "dashboard_widget_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dashboard_widget"
    ADD CONSTRAINT "dashboard_widget_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "public"."dashboard"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dashboard_widget"
    ADD CONSTRAINT "dashboard_widget_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dashboard_widget"
    ADD CONSTRAINT "dashboard_widget_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."env_escalation"
    ADD CONSTRAINT "env_escalation_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."env_escalation"
    ADD CONSTRAINT "env_escalation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."env_escalation"
    ADD CONSTRAINT "env_escalation_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_run"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."env_escalation"
    ADD CONSTRAINT "env_escalation_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."env_escalation"
    ADD CONSTRAINT "env_escalation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."env_escalation"
    ADD CONSTRAINT "env_escalation_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."env_var"
    ADD CONSTRAINT "env_var_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."env_var"
    ADD CONSTRAINT "env_var_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."env_var"
    ADD CONSTRAINT "env_var_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."env_var"
    ADD CONSTRAINT "env_var_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."env_var"
    ADD CONSTRAINT "env_var_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."env_var"
    ADD CONSTRAINT "env_var_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."environment"
    ADD CONSTRAINT "environment_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."environment"
    ADD CONSTRAINT "environment_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."environment"
    ADD CONSTRAINT "environment_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."environment"
    ADD CONSTRAINT "environment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."environment"
    ADD CONSTRAINT "environment_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."eval_run"
    ADD CONSTRAINT "eval_run_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eval_run"
    ADD CONSTRAINT "eval_run_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."eval_run"
    ADD CONSTRAINT "eval_run_environment_app_fkey" FOREIGN KEY ("environment_id", "app_id") REFERENCES "public"."environment"("id", "app_id") ON DELETE SET NULL ("environment_id");



ALTER TABLE ONLY "public"."eval_run"
    ADD CONSTRAINT "eval_run_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eval_run"
    ADD CONSTRAINT "eval_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."eval_run"
    ADD CONSTRAINT "eval_run_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."feature_flag"
    ADD CONSTRAINT "feature_flag_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."feature_flag_override"
    ADD CONSTRAINT "feature_flag_override_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."feature_flag_override"
    ADD CONSTRAINT "feature_flag_override_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "public"."feature_flag"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."feature_flag_override"
    ADD CONSTRAINT "feature_flag_override_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."feature_flag_override"
    ADD CONSTRAINT "feature_flag_override_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."feature_flag"
    ADD CONSTRAINT "feature_flag_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."git_branch"
    ADD CONSTRAINT "git_branch_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."git_branch"
    ADD CONSTRAINT "git_branch_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."git_branch"
    ADD CONSTRAINT "git_branch_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."git_connection"
    ADD CONSTRAINT "git_connection_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."git_connection"
    ADD CONSTRAINT "git_connection_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."git_connection"
    ADD CONSTRAINT "git_connection_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."git_connection"
    ADD CONSTRAINT "git_connection_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."git_connection"
    ADD CONSTRAINT "git_connection_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."git_branch"
    ADD CONSTRAINT "github_branch_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."git_branch"
    ADD CONSTRAINT "github_branch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership"
    ADD CONSTRAINT "membership_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."membership"
    ADD CONSTRAINT "membership_custom_role_id_fkey" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_role"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."membership"
    ADD CONSTRAINT "membership_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."membership"
    ADD CONSTRAINT "membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."membership"
    ADD CONSTRAINT "membership_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."membership"
    ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification"
    ADD CONSTRAINT "notification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification"
    ADD CONSTRAINT "notification_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_incident"
    ADD CONSTRAINT "platform_incident_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "public"."platform_deployment"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_user_role"
    ADD CONSTRAINT "platform_user_role_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_user_role"
    ADD CONSTRAINT "platform_user_role_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_user_role"
    ADD CONSTRAINT "platform_user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profile"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profile"
    ADD CONSTRAINT "profile_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profile"
    ADD CONSTRAINT "profile_last_active_tenant_id_fkey" FOREIGN KEY ("last_active_tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pull_request"
    ADD CONSTRAINT "pull_request_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_request"
    ADD CONSTRAINT "pull_request_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pull_request"
    ADD CONSTRAINT "pull_request_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pull_request_session"
    ADD CONSTRAINT "pull_request_session_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_request_session"
    ADD CONSTRAINT "pull_request_session_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_request_session"
    ADD CONSTRAINT "pull_request_session_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_request"
    ADD CONSTRAINT "pull_request_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_request"
    ADD CONSTRAINT "pull_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pull_request"
    ADD CONSTRAINT "pull_request_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."saved_trace_filters"
    ADD CONSTRAINT "saved_trace_filters_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."saved_trace_filters"
    ADD CONSTRAINT "saved_trace_filters_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."saved_trace_filters"
    ADD CONSTRAINT "saved_trace_filters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."saved_trace_filters"
    ADD CONSTRAINT "saved_trace_filters_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."saved_trace_filters"
    ADD CONSTRAINT "saved_trace_filters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sso_audit_log"
    ADD CONSTRAINT "sso_audit_log_sso_config_id_fkey" FOREIGN KEY ("sso_config_id") REFERENCES "public"."sso_config"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sso_audit_log"
    ADD CONSTRAINT "sso_audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sso_audit_log"
    ADD CONSTRAINT "sso_audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sso_config"
    ADD CONSTRAINT "sso_config_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sso_config"
    ADD CONSTRAINT "sso_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sso_config"
    ADD CONSTRAINT "sso_config_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sso_identity"
    ADD CONSTRAINT "sso_identity_sso_config_id_fkey" FOREIGN KEY ("sso_config_id") REFERENCES "public"."sso_config"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sso_identity"
    ADD CONSTRAINT "sso_identity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sso_identity"
    ADD CONSTRAINT "sso_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."temp_access_grant"
    ADD CONSTRAINT "temp_access_grant_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."temp_access_grant"
    ADD CONSTRAINT "temp_access_grant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."temp_access_grant"
    ADD CONSTRAINT "temp_access_grant_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenant_entitlement_override"
    ADD CONSTRAINT "tenant_entitlement_override_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenant_entitlement_override"
    ADD CONSTRAINT "tenant_entitlement_override_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_entitlement_override"
    ADD CONSTRAINT "tenant_entitlement_override_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."terms_agreement"
    ADD CONSTRAINT "terms_agreement_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."terms_agreement"
    ADD CONSTRAINT "terms_agreement_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."terms_agreement"
    ADD CONSTRAINT "terms_agreement_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profile"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_git_identity"
    ADD CONSTRAINT "user_git_identity_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_git_identity"
    ADD CONSTRAINT "user_git_identity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_run"
    ADD CONSTRAINT "worker_run_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_run"
    ADD CONSTRAINT "worker_run_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."worker_run"
    ADD CONSTRAINT "worker_run_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."worker_run_event"
    ADD CONSTRAINT "worker_run_event_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_run_event"
    ADD CONSTRAINT "worker_run_event_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_run_event"
    ADD CONSTRAINT "worker_run_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_run_event"
    ADD CONSTRAINT "worker_run_event_worker_run_id_fkey" FOREIGN KEY ("worker_run_id") REFERENCES "public"."worker_run"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_run"
    ADD CONSTRAINT "worker_run_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_run"
    ADD CONSTRAINT "worker_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_run"
    ADD CONSTRAINT "worker_run_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."worker_workspace"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."worker_workspace"
    ADD CONSTRAINT "worker_workspace_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_workspace"
    ADD CONSTRAINT "worker_workspace_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profile"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."worker_workspace"
    ADD CONSTRAINT "worker_workspace_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."worker_workspace"
    ADD CONSTRAINT "worker_workspace_tenant_app_fk" FOREIGN KEY ("tenant_id", "app_id") REFERENCES "public"."app"("tenant_id", "id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."worker_workspace"
    ADD CONSTRAINT "worker_workspace_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("tenant_id") ON DELETE CASCADE;



ALTER TABLE "private"."api_key_secret" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Admins can remove users" ON "public"."membership" FOR DELETE USING ((("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('membership.delete'::"public"."app_permission") AS "authorize")));



CREATE POLICY "Allow auth admin to read user roles" ON "public"."role_permissions" FOR SELECT TO "supabase_auth_admin" USING (true);



CREATE POLICY "Allow authenticated to read role_permissions" ON "public"."role_permissions" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Enable api_key delete for users with admin access" ON "public"."api_key" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable api_key insert for users with write or admin access" ON "public"."api_key" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable api_key update for users with update access" ON "public"."api_key" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"))) WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable app delete for users" ON "public"."app" FOR DELETE TO "authenticated" USING (("private"."app_authorize"('app.delete'::"public"."app_permission", "id") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable app read access for users within tenant" ON "public"."app" FOR SELECT TO "authenticated" USING (("private"."app_authorize"('app.read'::"public"."app_permission", "id") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable app update access for users within tenant" ON "public"."app" FOR UPDATE TO "authenticated" USING (("private"."app_authorize"('app.update'::"public"."app_permission", "id") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable app write access for users within tenant" ON "public"."app" FOR INSERT TO "authenticated" WITH CHECK (("private"."app_authorize"('app.insert'::"public"."app_permission", "id") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable app_member_role delete for admins" ON "public"."app_member_role" FOR DELETE USING ((( SELECT "private"."authorize"('app_member_role.delete'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable app_member_role insert for admins" ON "public"."app_member_role" FOR INSERT WITH CHECK ((( SELECT "private"."authorize"('app_member_role.insert'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable app_member_role read for tenant users" ON "public"."app_member_role" FOR SELECT USING ((( SELECT "private"."authorize"('app_member_role.read'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable app_member_role update for admins" ON "public"."app_member_role" FOR UPDATE USING ((( SELECT "private"."authorize"('app_member_role.update'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable billing read access for tenant admins" ON "public"."billing" FOR SELECT TO "authenticated" USING ((( SELECT "private"."authorize"('billing.read'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable custom_role delete for admins" ON "public"."custom_role" FOR DELETE USING ((( SELECT "private"."authorize"('custom_role.delete'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable custom_role insert for admins" ON "public"."custom_role" FOR INSERT WITH CHECK ((( SELECT "private"."authorize"('custom_role.insert'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable custom_role read for tenant users" ON "public"."custom_role" FOR SELECT USING ((( SELECT "private"."authorize"('custom_role.read'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable custom_role update for admins" ON "public"."custom_role" FOR UPDATE USING ((( SELECT "private"."authorize"('custom_role.update'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable custom_role_permission delete for admins" ON "public"."custom_role_permission" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."custom_role" "cr"
  WHERE (("cr"."id" = "custom_role_permission"."custom_role_id") AND ("cr"."tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('custom_role.delete'::"public"."app_permission") AS "authorize")))));



CREATE POLICY "Enable custom_role_permission insert for admins" ON "public"."custom_role_permission" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."custom_role" "cr"
  WHERE (("cr"."id" = "custom_role_permission"."custom_role_id") AND ("cr"."tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('custom_role.insert'::"public"."app_permission") AS "authorize")))));



CREATE POLICY "Enable custom_role_permission read for tenant users" ON "public"."custom_role_permission" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."custom_role" "cr"
  WHERE (("cr"."id" = "custom_role_permission"."custom_role_id") AND ("cr"."tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('custom_role.read'::"public"."app_permission") AS "authorize")))));



CREATE POLICY "Enable delete access for eval_run" ON "public"."eval_run" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('eval_run.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable delete access for worker_run" ON "public"."worker_run" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable delete access for worker_workspace" ON "public"."worker_workspace" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable delete for ai cost config" ON "public"."ai_cost_config" FOR DELETE TO "authenticated" USING (("private"."authorize"('ai_cost_config.delete'::"public"."app_permission") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable delete for environment" ON "public"."environment" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('environment.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable delete for own identity" ON "public"."user_git_identity" FOR DELETE USING (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "Enable delete for users with sso_config.delete permission" ON "public"."sso_config" FOR DELETE USING ((( SELECT "private"."authorize"('sso_config.delete'::"public"."app_permission") AS "authorize") AND ("public"."tenant_id"() = "tenant_id")));



CREATE POLICY "Enable env_var delete for users" ON "public"."env_var" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('env_var.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable env_var insert for users" ON "public"."env_var" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('env_var.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable env_var read access for users" ON "public"."env_var" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('env_var.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable env_var update for users" ON "public"."env_var" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('env_var.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable insert access for eval_run" ON "public"."eval_run" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('eval_run.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable insert access for worker_run" ON "public"."worker_run" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable insert access for worker_workspace" ON "public"."worker_workspace" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable insert for ai cost config" ON "public"."ai_cost_config" FOR INSERT TO "authenticated" WITH CHECK (("private"."authorize"('ai_cost_config.insert'::"public"."app_permission") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable insert for environment" ON "public"."environment" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('environment.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable insert for own identity" ON "public"."user_git_identity" FOR INSERT WITH CHECK (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "Enable insert for users with sso_config.insert permission" ON "public"."sso_config" FOR INSERT WITH CHECK ((( SELECT "private"."authorize"('sso_config.insert'::"public"."app_permission") AS "authorize") AND ("public"."tenant_id"() = "tenant_id")));



CREATE POLICY "Enable policy delete for users" ON "public"."git_branch" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_branch.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable policy delete for users" ON "public"."git_connection" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable policy insert for users" ON "public"."git_branch" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_branch.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable policy insert for users" ON "public"."git_connection" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable policy update for users" ON "public"."git_branch" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_branch.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable policy update for users" ON "public"."git_connection" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for env_escalation" ON "public"."env_escalation" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('env_escalation.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for environment" ON "public"."environment" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('environment.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for eval_run" ON "public"."eval_run" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('eval_run.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."agent_finding" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('agents.findings.read'::"public"."app_permission") AS "authorized_app_ids")) AND ("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id"))));



CREATE POLICY "Enable read access for tenant users" ON "public"."agent_theme" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('agents.findings.read'::"public"."app_permission") AS "authorized_app_ids")) AND ("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id"))));



CREATE POLICY "Enable read access for tenant users" ON "public"."api_key" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('api_key.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."context_blob" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('context.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."context_head" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('context.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."context_snapshot" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('context.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."context_sync_event" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."member_app_ids"('context.read'::"public"."app_permission") AS "member_app_ids")) AND ("tenant_id" IN ( SELECT "private"."member_tenant_ids"() AS "member_tenant_ids"))));



CREATE POLICY "Enable read access for tenant users" ON "public"."context_tree_entry" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('context.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."git_branch" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_branch.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."git_connection" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."notification" FOR SELECT TO "authenticated" USING (("tenant_id" IN ( SELECT "private"."member_tenant_ids"() AS "member_tenant_ids")));



CREATE POLICY "Enable read access for tenant users" ON "public"."pull_request" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."pull_request_session" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('git_connection.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for tenant users" ON "public"."user_git_identity" FOR SELECT USING (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "Enable read access for worker_run" ON "public"."worker_run" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for worker_run_event" ON "public"."worker_run_event" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read access for worker_workspace" ON "public"."worker_workspace" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read for ai cost config" ON "public"."ai_cost_config" FOR SELECT TO "authenticated" USING (("private"."authorize"('ai_cost_config.read'::"public"."app_permission") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable read for users with sso_config.read permission" ON "public"."sso_audit_log" FOR SELECT USING ((( SELECT "private"."authorize"('sso_config.read'::"public"."app_permission") AS "authorize") AND ("public"."tenant_id"() = "tenant_id")));



CREATE POLICY "Enable read for users with sso_config.read permission" ON "public"."sso_config" FOR SELECT USING ((( SELECT "private"."authorize"('sso_config.read'::"public"."app_permission") AS "authorize") AND ("public"."tenant_id"() = "tenant_id")));



CREATE POLICY "Enable read for users with sso_config.read permission" ON "public"."sso_identity" FOR SELECT USING ((( SELECT "private"."authorize"('sso_config.read'::"public"."app_permission") AS "authorize") AND ("public"."tenant_id"() = "tenant_id")));



CREATE POLICY "Enable tenant admin to update tenant" ON "public"."tenant" FOR UPDATE USING ((( SELECT "private"."authorize"('tenant.update'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable update access for env_escalation" ON "public"."env_escalation" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('env_escalation.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"))) WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('env_escalation.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable update access for eval_run" ON "public"."eval_run" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('eval_run.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"))) WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('eval_run.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable update access for tenant users" ON "public"."notification" FOR UPDATE TO "authenticated" USING (("tenant_id" IN ( SELECT "private"."member_tenant_ids"() AS "member_tenant_ids"))) WITH CHECK (("tenant_id" IN ( SELECT "private"."member_tenant_ids"() AS "member_tenant_ids")));



CREATE POLICY "Enable update access for worker_run" ON "public"."worker_run" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"))) WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable update access for worker_workspace" ON "public"."worker_workspace" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"))) WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('worker_run.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable update for ai cost config" ON "public"."ai_cost_config" FOR UPDATE TO "authenticated" USING (("private"."authorize"('ai_cost_config.update'::"public"."app_permission") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable update for environment" ON "public"."environment" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('environment.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Enable update for own identity" ON "public"."user_git_identity" FOR UPDATE USING (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid")))) WITH CHECK (((( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id") AND ("profile_id" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "Enable update for users with sso_config.update permission" ON "public"."sso_config" FOR UPDATE USING ((( SELECT "private"."authorize"('sso_config.update'::"public"."app_permission") AS "authorize") AND ("public"."tenant_id"() = "tenant_id"))) WITH CHECK ((( SELECT "private"."authorize"('sso_config.update'::"public"."app_permission") AS "authorize") AND ("public"."tenant_id"() = "tenant_id")));



CREATE POLICY "Members can read own tenant audit trail" ON "public"."audit_log" FOR SELECT USING ((("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('audit_log.read'::"public"."app_permission") AS "authorize")));



CREATE POLICY "Org members can create dashboards" ON "public"."dashboard" FOR INSERT TO "authenticated" WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('dashboard.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Org members can create widgets" ON "public"."dashboard_widget" FOR INSERT TO "authenticated" WITH CHECK ((("private"."get_dashboard_app_id"("dashboard_id") IS NOT NULL) AND ("private"."get_dashboard_app_id"("dashboard_id") IN ( SELECT "private"."authorized_app_ids"('dashboard.insert'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Org members can delete dashboards" ON "public"."dashboard" FOR DELETE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('dashboard.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Org members can delete widgets" ON "public"."dashboard_widget" FOR DELETE TO "authenticated" USING ((("private"."get_dashboard_app_id"("dashboard_id") IS NOT NULL) AND ("private"."get_dashboard_app_id"("dashboard_id") IN ( SELECT "private"."authorized_app_ids"('dashboard.delete'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Org members can read dashboards" ON "public"."dashboard" FOR SELECT TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('dashboard.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Org members can read widgets" ON "public"."dashboard_widget" FOR SELECT TO "authenticated" USING ((("private"."get_dashboard_app_id"("dashboard_id") IS NOT NULL) AND ("private"."get_dashboard_app_id"("dashboard_id") IN ( SELECT "private"."authorized_app_ids"('dashboard.read'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Org members can update dashboards" ON "public"."dashboard" FOR UPDATE TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('dashboard.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Org members can update widgets" ON "public"."dashboard_widget" FOR UPDATE TO "authenticated" USING ((("private"."get_dashboard_app_id"("dashboard_id") IS NOT NULL) AND ("private"."get_dashboard_app_id"("dashboard_id") IN ( SELECT "private"."authorized_app_ids"('dashboard.update'::"public"."app_permission") AS "authorized_app_ids")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));



CREATE POLICY "Platform admins can delete entitlement overrides" ON "public"."tenant_entitlement_override" FOR DELETE TO "authenticated" USING ("private"."platform_authorize"('platform.entitlement.delete'::"public"."platform_permission"));



CREATE POLICY "Platform admins can delete feature flag overrides" ON "public"."feature_flag_override" FOR DELETE USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));



CREATE POLICY "Platform admins can delete feature flags" ON "public"."feature_flag" FOR DELETE USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));



CREATE POLICY "Platform admins can insert feature flag overrides" ON "public"."feature_flag_override" FOR INSERT WITH CHECK ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));



CREATE POLICY "Platform admins can insert feature flags" ON "public"."feature_flag" FOR INSERT WITH CHECK ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));



CREATE POLICY "Platform admins can read entitlement overrides" ON "public"."tenant_entitlement_override" FOR SELECT TO "authenticated" USING ("private"."platform_authorize"('platform.entitlement.read'::"public"."platform_permission"));



CREATE POLICY "Platform admins can read environment" ON "public"."environment" FOR SELECT TO "authenticated" USING ("private"."platform_authorize"('platform.environment.read'::"public"."platform_permission"));



CREATE POLICY "Platform admins can read feature flags" ON "public"."feature_flag" FOR SELECT USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));



CREATE POLICY "Platform admins can read sso audit logs" ON "public"."sso_audit_log" FOR SELECT USING ("private"."platform_authorize"('platform.sso_config.read'::"public"."platform_permission"));



CREATE POLICY "Platform admins can read sso config" ON "public"."sso_config" FOR SELECT USING ("private"."platform_authorize"('platform.sso_config.read'::"public"."platform_permission"));



CREATE POLICY "Platform admins can read sso identities" ON "public"."sso_identity" FOR SELECT USING ("private"."platform_authorize"('platform.sso_config.read'::"public"."platform_permission"));



CREATE POLICY "Platform admins can update entitlement overrides" ON "public"."tenant_entitlement_override" FOR UPDATE TO "authenticated" USING ("private"."platform_authorize"('platform.entitlement.write'::"public"."platform_permission")) WITH CHECK ("private"."platform_authorize"('platform.entitlement.write'::"public"."platform_permission"));



CREATE POLICY "Platform admins can update feature flag overrides" ON "public"."feature_flag_override" FOR UPDATE USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));



CREATE POLICY "Platform admins can update feature flags" ON "public"."feature_flag" FOR UPDATE USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));



CREATE POLICY "Platform admins can write entitlement overrides" ON "public"."tenant_entitlement_override" FOR INSERT TO "authenticated" WITH CHECK ("private"."platform_authorize"('platform.entitlement.write'::"public"."platform_permission"));



CREATE POLICY "Service role has full access to entitlement overrides" ON "public"."tenant_entitlement_override" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Users can accept invitations" ON "public"."membership" FOR UPDATE USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("status")::"text" = 'pending'::"text") AND (("expires_at" IS NULL) OR ("expires_at" > "now"())))) WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("status")::"text" = 'active'::"text")));



CREATE POLICY "Users can read feature flag overrides" ON "public"."feature_flag_override" FOR SELECT USING ("private"."platform_authorize"('platform.flag.manage'::"public"."platform_permission"));



CREATE POLICY "Users can read memberships" ON "public"."membership" FOR SELECT USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR (("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('membership.read'::"public"."app_permission") AS "authorize"))));



CREATE POLICY "Users can read profiles" ON "public"."profile" FOR SELECT USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR ("id" IN ( SELECT "m"."user_id"
   FROM "public"."membership" "m"
  WHERE (("m"."tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND (("m"."status")::"text" = 'active'::"text"))))));



CREATE POLICY "Users can read tenant" ON "public"."tenant" FOR SELECT USING (((( SELECT "private"."authorize"('tenant.read'::"public"."app_permission") AS "authorize") AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")) OR ("tenant_id" IN ( SELECT "m"."tenant_id"
   FROM "public"."membership" "m"
  WHERE (("m"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("m"."status")::"text" = 'active'::"text"))))));



CREATE POLICY "Users can update own profile" ON "public"."profile" FOR UPDATE USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));



ALTER TABLE "public"."agent_finding" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_theme" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_cost_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."api_key" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_member_role" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "block_delete" ON "public"."audit_log" AS RESTRICTIVE FOR DELETE USING (false);



CREATE POLICY "block_update" ON "public"."audit_log" AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);



ALTER TABLE "public"."context_blob" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."context_head" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."context_snapshot" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."context_sync_event" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."context_tree_entry" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_role" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_role_permission" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dashboard_widget" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."env_escalation" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."env_var" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."environment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."eval_run" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."feature_flag" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."feature_flag_override" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gateway_tenant_delete_api_key" ON "public"."api_key" FOR DELETE TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_delete_app" ON "public"."app" FOR DELETE TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_delete_environment" ON "public"."environment" FOR DELETE TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_delete_git_branch" ON "public"."git_branch" FOR DELETE TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_insert_api_key" ON "public"."api_key" FOR INSERT TO "gateway" WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_insert_app" ON "public"."app" FOR INSERT TO "gateway" WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_insert_environment" ON "public"."environment" FOR INSERT TO "gateway" WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_insert_git_branch" ON "public"."git_branch" FOR INSERT TO "gateway" WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_insert_worker_run" ON "public"."worker_run" FOR INSERT TO "gateway" WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_insert_worker_workspace" ON "public"."worker_workspace" FOR INSERT TO "gateway" WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_api_key" ON "public"."api_key" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_app" ON "public"."app" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_billing" ON "public"."billing" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_entitlement_override" ON "public"."tenant_entitlement_override" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_environment" ON "public"."environment" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_git_branch" ON "public"."git_branch" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_git_connection" ON "public"."git_connection" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_worker_run" ON "public"."worker_run" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_read_worker_workspace" ON "public"."worker_workspace" FOR SELECT TO "gateway" USING (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_token_refresh_git_connection" ON "public"."git_connection" FOR UPDATE TO "gateway" USING (("tenant_id" = "public"."tenant_id"())) WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_update_app" ON "public"."app" FOR UPDATE TO "gateway" USING (("tenant_id" = "public"."tenant_id"())) WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_update_environment" ON "public"."environment" FOR UPDATE TO "gateway" USING (("tenant_id" = "public"."tenant_id"())) WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_update_git_branch" ON "public"."git_branch" FOR UPDATE TO "gateway" USING (("tenant_id" = "public"."tenant_id"())) WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_update_worker_run" ON "public"."worker_run" FOR UPDATE TO "gateway" USING (("tenant_id" = "public"."tenant_id"())) WITH CHECK (("tenant_id" = "public"."tenant_id"()));



CREATE POLICY "gateway_tenant_update_worker_workspace" ON "public"."worker_workspace" FOR UPDATE TO "gateway" USING (("tenant_id" = "public"."tenant_id"())) WITH CHECK (("tenant_id" = "public"."tenant_id"()));



ALTER TABLE "public"."git_branch" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."git_connection" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."membership" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_deployment" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_dora_collection_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_incident" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_role_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_user_role" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profile" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pull_request" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pull_request_session" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."saved_trace_filters" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service_role_all" ON "public"."agent_finding" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."agent_theme" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."app_member_role" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."context_blob" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."context_head" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."context_snapshot" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."context_sync_event" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."context_tree_entry" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."custom_role" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."custom_role_permission" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."dashboard" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."dashboard_widget" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."env_var" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."platform_deployment" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."platform_dora_collection_state" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."platform_incident" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."platform_role_permissions" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."platform_user_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."sso_audit_log" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."sso_config" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."sso_identity" TO "service_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text")) WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_all" ON "public"."temp_access_grant" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_full_access" ON "public"."terms_agreement" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "service_role_insert" ON "public"."audit_log" FOR INSERT WITH CHECK ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



CREATE POLICY "service_role_select" ON "public"."audit_log" FOR SELECT USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));



ALTER TABLE "public"."sso_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sso_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sso_identity" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."temp_access_grant" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tenant" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tenant_entitlement_override" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_shared_filters" ON "public"."saved_trace_filters" TO "authenticated" USING ((("app_id" IN ( SELECT "private"."authorized_app_ids"('trace.read'::"public"."app_permission") AS "authorized_app_ids")) AND ("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")))) WITH CHECK ((("app_id" IN ( SELECT "private"."authorized_app_ids"('trace.read'::"public"."app_permission") AS "authorized_app_ids")) AND ("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id"))));



ALTER TABLE "public"."terms_agreement" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_git_identity" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_can_view_own_agreements" ON "public"."terms_agreement" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



ALTER TABLE "public"."worker_run" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."worker_run_event" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."worker_workspace" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."app";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."context_sync_event";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."env_var";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."notification";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."profile";



SET SESSION AUTHORIZATION "postgres";
RESET SESSION AUTHORIZATION;






GRANT USAGE ON SCHEMA "ops" TO "service_role";



GRANT USAGE ON SCHEMA "private" TO "anon";
GRANT USAGE ON SCHEMA "private" TO "authenticated";
GRANT USAGE ON SCHEMA "private" TO "service_role";
GRANT USAGE ON SCHEMA "private" TO "gateway";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";
GRANT USAGE ON SCHEMA "public" TO "gateway";







































GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"(character) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"("inet") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "anon";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "service_role";






















































































































































































































































































































































































































































































































































































































































































































































REVOKE ALL ON FUNCTION "ops"."capture_usage_snapshot"() FROM PUBLIC;
GRANT ALL ON FUNCTION "ops"."capture_usage_snapshot"() TO "service_role";



REVOKE ALL ON FUNCTION "ops"."index_usage_delta"("p_since" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "ops"."index_usage_delta"("p_since" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "ops"."table_usage_delta"("p_since" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "ops"."table_usage_delta"("p_since" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "private"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "private"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "private"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "private"."authorize"("requested_permission" "public"."app_permission") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."authorize"("requested_permission" "public"."app_permission") TO "anon";
GRANT ALL ON FUNCTION "private"."authorize"("requested_permission" "public"."app_permission") TO "authenticated";
GRANT ALL ON FUNCTION "private"."authorize"("requested_permission" "public"."app_permission") TO "service_role";



REVOKE ALL ON FUNCTION "private"."authorized_app_ids"("requested_permission" "public"."app_permission") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."authorized_app_ids"("requested_permission" "public"."app_permission") TO "authenticated";
GRANT ALL ON FUNCTION "private"."authorized_app_ids"("requested_permission" "public"."app_permission") TO "service_role";



REVOKE ALL ON FUNCTION "private"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "private"."effective_app_permissions"("target_app_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."effective_app_permissions"("target_app_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "private"."effective_app_permissions"("target_app_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "private"."get_dashboard_app_id"("target_dashboard_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_dashboard_app_id"("target_dashboard_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "private"."get_dashboard_app_id"("target_dashboard_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "private"."get_org_permission_set"("p_custom_role_id" "uuid", "p_role" "public"."app_role", "p_tenant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."get_org_permission_set"("p_custom_role_id" "uuid", "p_role" "public"."app_role", "p_tenant_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "private"."member_app_ids"("requested_permission" "public"."app_permission") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."member_app_ids"("requested_permission" "public"."app_permission") TO "authenticated";
GRANT ALL ON FUNCTION "private"."member_app_ids"("requested_permission" "public"."app_permission") TO "service_role";



REVOKE ALL ON FUNCTION "private"."member_tenant_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."member_tenant_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "private"."member_tenant_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "private"."platform_authorize"("required_permission" "public"."platform_permission") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."platform_authorize"("required_permission" "public"."platform_permission") TO "anon";
GRANT ALL ON FUNCTION "private"."platform_authorize"("required_permission" "public"."platform_permission") TO "authenticated";
GRANT ALL ON FUNCTION "private"."platform_authorize"("required_permission" "public"."platform_permission") TO "service_role";



REVOKE ALL ON FUNCTION "private"."resolve_member_tenant"("p_raw" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."resolve_member_tenant"("p_raw" "text") TO "anon";
GRANT ALL ON FUNCTION "private"."resolve_member_tenant"("p_raw" "text") TO "authenticated";
GRANT ALL ON FUNCTION "private"."resolve_member_tenant"("p_raw" "text") TO "service_role";
GRANT ALL ON FUNCTION "private"."resolve_member_tenant"("p_raw" "text") TO "gateway";



REVOKE ALL ON FUNCTION "private"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) TO "service_role";



REVOKE ALL ON FUNCTION "private"."verify_api_key"("p_key_digest" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "private"."verify_api_key"("p_key_digest" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_authorize"("requested_permission" "public"."app_permission", "target_app_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."app_seed_default_env"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."app_seed_default_env"() TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."audit_log" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



REVOKE ALL ON FUNCTION "public"."audit_log_compute_hash"("p_prev" "text", "r" "public"."audit_log") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_log_compute_hash"("p_prev" "text", "r" "public"."audit_log") TO "service_role";



REVOKE ALL ON FUNCTION "public"."audit_log_hash_chain"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_log_hash_chain"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."authorize"("requested_permission" "public"."app_permission") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."authorize"("requested_permission" "public"."app_permission") TO "anon";
GRANT ALL ON FUNCTION "public"."authorize"("requested_permission" "public"."app_permission") TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorize"("requested_permission" "public"."app_permission") TO "service_role";



REVOKE ALL ON FUNCTION "public"."change_member_role_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_new_role" character varying, "p_custom_role_id" "uuid", "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."change_member_role_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_new_role" character varying, "p_custom_role_id" "uuid", "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."change_user_password"("current_plain_password" character varying, "new_plain_password" character varying) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."change_user_password"("current_plain_password" character varying, "new_plain_password" character varying) TO "service_role";



REVOKE ALL ON FUNCTION "public"."check_membership_limit"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_membership_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_expired_temp_access"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_expired_temp_access"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_organization_transaction"("p_user_id" "uuid", "p_organization_name" "text", "p_company_name" "text", "p_stripe_customer_id" character varying, "p_tier_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_organization_transaction"("p_user_id" "uuid", "p_organization_name" "text", "p_company_name" "text", "p_stripe_customer_id" character varying, "p_tier_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "supabase_auth_admin";



REVOKE ALL ON FUNCTION "public"."delete_secret"("secret_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_secret"("secret_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."enforce_app_policy_permission"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_app_policy_permission"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_app_policy_permission"() TO "service_role";



GRANT ALL ON FUNCTION "public"."environment_enforce_invariants"() TO "anon";
GRANT ALL ON FUNCTION "public"."environment_enforce_invariants"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."environment_enforce_invariants"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_claim"("uid" "uuid", "claim" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_claim"("uid" "uuid", "claim" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_current_user_app_permissions"("target_app_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_current_user_app_permissions"("target_app_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_current_user_app_permissions"("target_app_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."grant_temp_access_transaction"("p_admin_user_id" "uuid", "p_tenant_id" "uuid", "p_reason" "text", "p_customer_permission_confirmed" boolean, "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."grant_temp_access_transaction"("p_admin_user_id" "uuid", "p_tenant_id" "uuid", "p_reason" "text", "p_customer_permission_confirmed" boolean, "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."insert_secret"("name" "text", "secret" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."insert_secret"("name" "text", "secret" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."invite_existing_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."invite_existing_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."invite_new_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_email" "public"."citext", "p_name" "text", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."invite_new_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_email" "public"."citext", "p_name" "text", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_claims_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_claims_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_claims_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."nullify_custom_role_on_downgrade"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."nullify_custom_role_on_downgrade"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."platform_admin_delete_tenant"("p_tenant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."platform_admin_delete_tenant"("p_tenant_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."prevent_app_member_role_self_grant"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prevent_app_member_role_self_grant"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_membership_self_privilege_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_membership_self_privilege_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_membership_self_privilege_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_membership_tenant_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_membership_tenant_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_membership_tenant_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_last_owner"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_last_owner"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."read_secret"("secret_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."read_secret"("secret_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."remove_member_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."remove_member_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_claim"("uid" "uuid", "claim" "text", "value" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_claim"("uid" "uuid", "claim" "text", "value" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_created_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_created_columns"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_profile_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_profile_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_tenant_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_tenant_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_tenant_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at_only"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at_only"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at_only"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_updated_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_updated_columns"() TO "service_role";



GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_auth_email_to_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_auth_email_to_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."tenant_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."tenant_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."tenant_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_secret"("secret_name" "text", "secret" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_secret"("secret_name" "text", "secret" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."verify_api_key"("p_key_digest" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_api_key"("p_key_digest" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."verify_audit_log_chain"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_audit_log_chain"() TO "service_role";












GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "service_role";















GRANT SELECT ON TABLE "ops"."index_usage_snapshot" TO "service_role";



GRANT SELECT ON TABLE "ops"."table_usage_snapshot" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."agent_finding" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."agent_finding" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_finding" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."agent_theme" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."agent_theme" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_theme" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."ai_cost_config" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."ai_cost_config" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_cost_config" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."api_key" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."api_key" TO "authenticated";
GRANT ALL ON TABLE "public"."api_key" TO "service_role";
GRANT SELECT,INSERT,DELETE ON TABLE "public"."api_key" TO "gateway";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."app" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."app" TO "authenticated";
GRANT ALL ON TABLE "public"."app" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."app" TO "gateway";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."app_member_role" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."app_member_role" TO "authenticated";
GRANT ALL ON TABLE "public"."app_member_role" TO "service_role";



GRANT ALL ON SEQUENCE "public"."audit_log_seq_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."audit_log_seq_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."audit_log_seq_seq" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."billing" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."billing" TO "authenticated";
GRANT ALL ON TABLE "public"."billing" TO "service_role";
GRANT SELECT ON TABLE "public"."billing" TO "gateway";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_blob" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_blob" TO "authenticated";
GRANT ALL ON TABLE "public"."context_blob" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_head" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_head" TO "authenticated";
GRANT ALL ON TABLE "public"."context_head" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_snapshot" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_snapshot" TO "authenticated";
GRANT ALL ON TABLE "public"."context_snapshot" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_sync_event" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_sync_event" TO "authenticated";
GRANT ALL ON TABLE "public"."context_sync_event" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_tree_entry" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."context_tree_entry" TO "authenticated";
GRANT ALL ON TABLE "public"."context_tree_entry" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."custom_role" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."custom_role" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_role" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."custom_role_permission" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."custom_role_permission" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_role_permission" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."dashboard" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."dashboard" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."dashboard_widget" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."dashboard_widget" TO "authenticated";
GRANT ALL ON TABLE "public"."dashboard_widget" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."env_escalation" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."env_escalation" TO "authenticated";
GRANT ALL ON TABLE "public"."env_escalation" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."env_var" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."env_var" TO "authenticated";
GRANT ALL ON TABLE "public"."env_var" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."environment" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."environment" TO "authenticated";
GRANT ALL ON TABLE "public"."environment" TO "service_role";
GRANT SELECT,INSERT,DELETE ON TABLE "public"."environment" TO "gateway";



GRANT UPDATE("fly_app_name") ON TABLE "public"."environment" TO "gateway";



GRANT UPDATE("updated_by") ON TABLE "public"."environment" TO "gateway";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."eval_run" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."eval_run" TO "authenticated";
GRANT ALL ON TABLE "public"."eval_run" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."feature_flag" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."feature_flag" TO "authenticated";
GRANT ALL ON TABLE "public"."feature_flag" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."feature_flag_override" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."feature_flag_override" TO "authenticated";
GRANT ALL ON TABLE "public"."feature_flag_override" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."git_branch" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."git_branch" TO "authenticated";
GRANT ALL ON TABLE "public"."git_branch" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."git_branch" TO "gateway";



GRANT ALL ON TABLE "public"."git_connection" TO "service_role";
GRANT DELETE ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("id") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("id"),INSERT("id") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("tenant_id") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("tenant_id"),INSERT("tenant_id") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("app_id") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("app_id"),INSERT("app_id"),UPDATE("app_id") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("provider") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("provider"),INSERT("provider"),UPDATE("provider") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("repository"),UPDATE("repository") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("repository"),INSERT("repository"),UPDATE("repository") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("installation_id") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("installation_id"),INSERT("installation_id"),UPDATE("installation_id") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("webhook_id"),UPDATE("webhook_id") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("webhook_id"),INSERT("webhook_id"),UPDATE("webhook_id") ON TABLE "public"."git_connection" TO "authenticated";



GRANT UPDATE("webhook_secret") ON TABLE "public"."git_connection" TO "gateway";



GRANT SELECT("created_at") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("created_at"),INSERT("created_at") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("created_by") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("created_by"),INSERT("created_by") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("updated_at") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("updated_at"),INSERT("updated_at") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT("updated_by") ON TABLE "public"."git_connection" TO "gateway";
GRANT SELECT("updated_by"),INSERT("updated_by") ON TABLE "public"."git_connection" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."membership" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."membership" TO "authenticated";
GRANT ALL ON TABLE "public"."membership" TO "service_role";
GRANT ALL ON TABLE "public"."membership" TO "supabase_auth_admin";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."notification" TO "anon";
GRANT ALL ON TABLE "public"."notification" TO "service_role";
GRANT SELECT ON TABLE "public"."notification" TO "authenticated";



GRANT UPDATE("read") ON TABLE "public"."notification" TO "authenticated";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_deployment" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_deployment" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_deployment" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_dora_collection_state" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_dora_collection_state" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_dora_collection_state" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_incident" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_incident" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_incident" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_role_permissions" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_role_permissions" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_user_role" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."platform_user_role" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_user_role" TO "service_role";
GRANT ALL ON TABLE "public"."platform_user_role" TO "supabase_auth_admin";



GRANT SELECT,INSERT,UPDATE ON TABLE "public"."profile" TO "anon";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."profile" TO "authenticated";
GRANT ALL ON TABLE "public"."profile" TO "service_role";
GRANT UPDATE ON TABLE "public"."profile" TO "supabase_auth_admin";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."pull_request" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."pull_request" TO "authenticated";
GRANT ALL ON TABLE "public"."pull_request" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."pull_request_session" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."pull_request_session" TO "authenticated";
GRANT ALL ON TABLE "public"."pull_request_session" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."role_permissions" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."role_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."saved_trace_filters" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."saved_trace_filters" TO "authenticated";
GRANT ALL ON TABLE "public"."saved_trace_filters" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."sso_audit_log" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."sso_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."sso_audit_log" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."sso_config" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."sso_config" TO "authenticated";
GRANT ALL ON TABLE "public"."sso_config" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."sso_identity" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."sso_identity" TO "authenticated";
GRANT ALL ON TABLE "public"."sso_identity" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."temp_access_grant" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."temp_access_grant" TO "authenticated";
GRANT ALL ON TABLE "public"."temp_access_grant" TO "service_role";
GRANT SELECT ON TABLE "public"."temp_access_grant" TO "supabase_auth_admin";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tenant" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tenant" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tenant_entitlement_override" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."tenant_entitlement_override" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_entitlement_override" TO "service_role";
GRANT SELECT ON TABLE "public"."tenant_entitlement_override" TO "gateway";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."terms_agreement" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."terms_agreement" TO "authenticated";
GRANT ALL ON TABLE "public"."terms_agreement" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."user_git_identity" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."user_git_identity" TO "authenticated";
GRANT ALL ON TABLE "public"."user_git_identity" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."worker_run" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."worker_run" TO "authenticated";
GRANT ALL ON TABLE "public"."worker_run" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."worker_run" TO "gateway";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."worker_run_event" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."worker_run_event" TO "authenticated";
GRANT ALL ON TABLE "public"."worker_run_event" TO "service_role";



GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."worker_workspace" TO "anon";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."worker_workspace" TO "authenticated";
GRANT ALL ON TABLE "public"."worker_workspace" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."worker_workspace" TO "gateway";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";































--
-- Dumped schema changes for auth and storage
--

CREATE OR REPLACE TRIGGER "on_auth_user_updated_sync_email" AFTER UPDATE ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."sync_auth_email_to_profile"();



CREATE POLICY "avatar_delete_own" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'avatar'::"text") AND ((("storage"."foldername"("name"))[1] = (( SELECT "auth"."uid"() AS "uid"))::"text") OR ("name" ~~ ((( SELECT "auth"."uid"() AS "uid"))::"text" || '.%'::"text")))));



CREATE POLICY "avatar_insert_own" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'avatar'::"text") AND (("storage"."foldername"("name"))[1] = (( SELECT "auth"."uid"() AS "uid"))::"text")));



CREATE POLICY "avatar_select_own" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'avatar'::"text") AND ((("storage"."foldername"("name"))[1] = (( SELECT "auth"."uid"() AS "uid"))::"text") OR ("name" ~~ ((( SELECT "auth"."uid"() AS "uid"))::"text" || '.%'::"text")))));



CREATE POLICY "avatar_update_own" ON "storage"."objects" FOR UPDATE TO "authenticated" USING ((("bucket_id" = 'avatar'::"text") AND ((("storage"."foldername"("name"))[1] = (( SELECT "auth"."uid"() AS "uid"))::"text") OR ("name" ~~ ((( SELECT "auth"."uid"() AS "uid"))::"text" || '.%'::"text"))))) WITH CHECK ((("bucket_id" = 'avatar'::"text") AND (("storage"."foldername"("name"))[1] = (( SELECT "auth"."uid"() AS "uid"))::"text")));




-- Privilege hardening: strip the REFERENCES/TRIGGER/TRUNCATE/DELETE grants
-- that Supabase default privileges hand to anon/authenticated on table
-- creation. A schema dump cannot express revokes-against-defaults, so they
-- are restated here; schemas/98-table-privilege-hardening.sql is the source.
revoke references on table "public"."agent_finding" from "anon";
revoke trigger on table "public"."agent_finding" from "anon";
revoke truncate on table "public"."agent_finding" from "anon";
revoke references on table "public"."agent_finding" from "authenticated";
revoke trigger on table "public"."agent_finding" from "authenticated";
revoke truncate on table "public"."agent_finding" from "authenticated";
revoke references on table "public"."agent_theme" from "anon";
revoke trigger on table "public"."agent_theme" from "anon";
revoke truncate on table "public"."agent_theme" from "anon";
revoke references on table "public"."agent_theme" from "authenticated";
revoke trigger on table "public"."agent_theme" from "authenticated";
revoke truncate on table "public"."agent_theme" from "authenticated";
revoke references on table "public"."ai_cost_config" from "anon";
revoke trigger on table "public"."ai_cost_config" from "anon";
revoke truncate on table "public"."ai_cost_config" from "anon";
revoke references on table "public"."ai_cost_config" from "authenticated";
revoke trigger on table "public"."ai_cost_config" from "authenticated";
revoke truncate on table "public"."ai_cost_config" from "authenticated";
revoke references on table "public"."api_key" from "anon";
revoke trigger on table "public"."api_key" from "anon";
revoke truncate on table "public"."api_key" from "anon";
revoke references on table "public"."api_key" from "authenticated";
revoke trigger on table "public"."api_key" from "authenticated";
revoke truncate on table "public"."api_key" from "authenticated";
revoke references on table "public"."app" from "anon";
revoke trigger on table "public"."app" from "anon";
revoke truncate on table "public"."app" from "anon";
revoke references on table "public"."app" from "authenticated";
revoke trigger on table "public"."app" from "authenticated";
revoke truncate on table "public"."app" from "authenticated";
revoke references on table "public"."app_member_role" from "anon";
revoke trigger on table "public"."app_member_role" from "anon";
revoke truncate on table "public"."app_member_role" from "anon";
revoke references on table "public"."app_member_role" from "authenticated";
revoke trigger on table "public"."app_member_role" from "authenticated";
revoke truncate on table "public"."app_member_role" from "authenticated";
revoke references on table "public"."audit_log" from "anon";
revoke trigger on table "public"."audit_log" from "anon";
revoke truncate on table "public"."audit_log" from "anon";
revoke references on table "public"."audit_log" from "authenticated";
revoke trigger on table "public"."audit_log" from "authenticated";
revoke truncate on table "public"."audit_log" from "authenticated";
revoke references on table "public"."billing" from "anon";
revoke trigger on table "public"."billing" from "anon";
revoke truncate on table "public"."billing" from "anon";
revoke references on table "public"."billing" from "authenticated";
revoke trigger on table "public"."billing" from "authenticated";
revoke truncate on table "public"."billing" from "authenticated";
revoke references on table "public"."context_blob" from "anon";
revoke trigger on table "public"."context_blob" from "anon";
revoke truncate on table "public"."context_blob" from "anon";
revoke references on table "public"."context_blob" from "authenticated";
revoke trigger on table "public"."context_blob" from "authenticated";
revoke truncate on table "public"."context_blob" from "authenticated";
revoke references on table "public"."context_head" from "anon";
revoke trigger on table "public"."context_head" from "anon";
revoke truncate on table "public"."context_head" from "anon";
revoke references on table "public"."context_head" from "authenticated";
revoke trigger on table "public"."context_head" from "authenticated";
revoke truncate on table "public"."context_head" from "authenticated";
revoke references on table "public"."context_snapshot" from "anon";
revoke trigger on table "public"."context_snapshot" from "anon";
revoke truncate on table "public"."context_snapshot" from "anon";
revoke references on table "public"."context_snapshot" from "authenticated";
revoke trigger on table "public"."context_snapshot" from "authenticated";
revoke truncate on table "public"."context_snapshot" from "authenticated";
revoke references on table "public"."context_sync_event" from "anon";
revoke trigger on table "public"."context_sync_event" from "anon";
revoke truncate on table "public"."context_sync_event" from "anon";
revoke references on table "public"."context_sync_event" from "authenticated";
revoke trigger on table "public"."context_sync_event" from "authenticated";
revoke truncate on table "public"."context_sync_event" from "authenticated";
revoke references on table "public"."context_tree_entry" from "anon";
revoke trigger on table "public"."context_tree_entry" from "anon";
revoke truncate on table "public"."context_tree_entry" from "anon";
revoke references on table "public"."context_tree_entry" from "authenticated";
revoke trigger on table "public"."context_tree_entry" from "authenticated";
revoke truncate on table "public"."context_tree_entry" from "authenticated";
revoke references on table "public"."custom_role" from "anon";
revoke trigger on table "public"."custom_role" from "anon";
revoke truncate on table "public"."custom_role" from "anon";
revoke references on table "public"."custom_role" from "authenticated";
revoke trigger on table "public"."custom_role" from "authenticated";
revoke truncate on table "public"."custom_role" from "authenticated";
revoke references on table "public"."custom_role_permission" from "anon";
revoke trigger on table "public"."custom_role_permission" from "anon";
revoke truncate on table "public"."custom_role_permission" from "anon";
revoke references on table "public"."custom_role_permission" from "authenticated";
revoke trigger on table "public"."custom_role_permission" from "authenticated";
revoke truncate on table "public"."custom_role_permission" from "authenticated";
revoke references on table "public"."dashboard" from "anon";
revoke trigger on table "public"."dashboard" from "anon";
revoke truncate on table "public"."dashboard" from "anon";
revoke references on table "public"."dashboard" from "authenticated";
revoke trigger on table "public"."dashboard" from "authenticated";
revoke truncate on table "public"."dashboard" from "authenticated";
revoke references on table "public"."dashboard_widget" from "anon";
revoke trigger on table "public"."dashboard_widget" from "anon";
revoke truncate on table "public"."dashboard_widget" from "anon";
revoke references on table "public"."dashboard_widget" from "authenticated";
revoke trigger on table "public"."dashboard_widget" from "authenticated";
revoke truncate on table "public"."dashboard_widget" from "authenticated";
revoke references on table "public"."env_escalation" from "anon";
revoke trigger on table "public"."env_escalation" from "anon";
revoke truncate on table "public"."env_escalation" from "anon";
revoke references on table "public"."env_escalation" from "authenticated";
revoke trigger on table "public"."env_escalation" from "authenticated";
revoke truncate on table "public"."env_escalation" from "authenticated";
revoke references on table "public"."env_var" from "anon";
revoke trigger on table "public"."env_var" from "anon";
revoke truncate on table "public"."env_var" from "anon";
revoke references on table "public"."env_var" from "authenticated";
revoke trigger on table "public"."env_var" from "authenticated";
revoke truncate on table "public"."env_var" from "authenticated";
revoke references on table "public"."environment" from "anon";
revoke trigger on table "public"."environment" from "anon";
revoke truncate on table "public"."environment" from "anon";
revoke references on table "public"."environment" from "authenticated";
revoke trigger on table "public"."environment" from "authenticated";
revoke truncate on table "public"."environment" from "authenticated";
revoke references on table "public"."eval_run" from "anon";
revoke trigger on table "public"."eval_run" from "anon";
revoke truncate on table "public"."eval_run" from "anon";
revoke references on table "public"."eval_run" from "authenticated";
revoke trigger on table "public"."eval_run" from "authenticated";
revoke truncate on table "public"."eval_run" from "authenticated";
revoke references on table "public"."feature_flag" from "anon";
revoke trigger on table "public"."feature_flag" from "anon";
revoke truncate on table "public"."feature_flag" from "anon";
revoke references on table "public"."feature_flag" from "authenticated";
revoke trigger on table "public"."feature_flag" from "authenticated";
revoke truncate on table "public"."feature_flag" from "authenticated";
revoke references on table "public"."feature_flag_override" from "anon";
revoke trigger on table "public"."feature_flag_override" from "anon";
revoke truncate on table "public"."feature_flag_override" from "anon";
revoke references on table "public"."feature_flag_override" from "authenticated";
revoke trigger on table "public"."feature_flag_override" from "authenticated";
revoke truncate on table "public"."feature_flag_override" from "authenticated";
revoke references on table "public"."git_branch" from "anon";
revoke trigger on table "public"."git_branch" from "anon";
revoke truncate on table "public"."git_branch" from "anon";
revoke references on table "public"."git_branch" from "authenticated";
revoke trigger on table "public"."git_branch" from "authenticated";
revoke truncate on table "public"."git_branch" from "authenticated";
revoke delete on table "public"."git_connection" from "anon";
revoke insert on table "public"."git_connection" from "anon";
revoke references on table "public"."git_connection" from "anon";
revoke select on table "public"."git_connection" from "anon";
revoke trigger on table "public"."git_connection" from "anon";
revoke truncate on table "public"."git_connection" from "anon";
revoke update on table "public"."git_connection" from "anon";
revoke insert on table "public"."git_connection" from "authenticated";
revoke references on table "public"."git_connection" from "authenticated";
revoke select on table "public"."git_connection" from "authenticated";
revoke trigger on table "public"."git_connection" from "authenticated";
revoke truncate on table "public"."git_connection" from "authenticated";
revoke update on table "public"."git_connection" from "authenticated";
revoke references on table "public"."membership" from "anon";
revoke trigger on table "public"."membership" from "anon";
revoke truncate on table "public"."membership" from "anon";
revoke references on table "public"."membership" from "authenticated";
revoke trigger on table "public"."membership" from "authenticated";
revoke truncate on table "public"."membership" from "authenticated";
revoke references on table "public"."notification" from "anon";
revoke trigger on table "public"."notification" from "anon";
revoke truncate on table "public"."notification" from "anon";
revoke delete on table "public"."notification" from "authenticated";
revoke insert on table "public"."notification" from "authenticated";
revoke references on table "public"."notification" from "authenticated";
revoke trigger on table "public"."notification" from "authenticated";
revoke truncate on table "public"."notification" from "authenticated";
revoke update on table "public"."notification" from "authenticated";
revoke references on table "public"."platform_deployment" from "anon";
revoke trigger on table "public"."platform_deployment" from "anon";
revoke truncate on table "public"."platform_deployment" from "anon";
revoke references on table "public"."platform_deployment" from "authenticated";
revoke trigger on table "public"."platform_deployment" from "authenticated";
revoke truncate on table "public"."platform_deployment" from "authenticated";
revoke references on table "public"."platform_dora_collection_state" from "anon";
revoke trigger on table "public"."platform_dora_collection_state" from "anon";
revoke truncate on table "public"."platform_dora_collection_state" from "anon";
revoke references on table "public"."platform_dora_collection_state" from "authenticated";
revoke trigger on table "public"."platform_dora_collection_state" from "authenticated";
revoke truncate on table "public"."platform_dora_collection_state" from "authenticated";
revoke references on table "public"."platform_incident" from "anon";
revoke trigger on table "public"."platform_incident" from "anon";
revoke truncate on table "public"."platform_incident" from "anon";
revoke references on table "public"."platform_incident" from "authenticated";
revoke trigger on table "public"."platform_incident" from "authenticated";
revoke truncate on table "public"."platform_incident" from "authenticated";
revoke references on table "public"."platform_role_permissions" from "anon";
revoke trigger on table "public"."platform_role_permissions" from "anon";
revoke truncate on table "public"."platform_role_permissions" from "anon";
revoke references on table "public"."platform_role_permissions" from "authenticated";
revoke trigger on table "public"."platform_role_permissions" from "authenticated";
revoke truncate on table "public"."platform_role_permissions" from "authenticated";
revoke references on table "public"."platform_user_role" from "anon";
revoke trigger on table "public"."platform_user_role" from "anon";
revoke truncate on table "public"."platform_user_role" from "anon";
revoke references on table "public"."platform_user_role" from "authenticated";
revoke trigger on table "public"."platform_user_role" from "authenticated";
revoke truncate on table "public"."platform_user_role" from "authenticated";
revoke delete on table "public"."profile" from "anon";
revoke references on table "public"."profile" from "anon";
revoke trigger on table "public"."profile" from "anon";
revoke truncate on table "public"."profile" from "anon";
revoke delete on table "public"."profile" from "authenticated";
revoke references on table "public"."profile" from "authenticated";
revoke trigger on table "public"."profile" from "authenticated";
revoke truncate on table "public"."profile" from "authenticated";
revoke references on table "public"."pull_request" from "anon";
revoke trigger on table "public"."pull_request" from "anon";
revoke truncate on table "public"."pull_request" from "anon";
revoke references on table "public"."pull_request" from "authenticated";
revoke trigger on table "public"."pull_request" from "authenticated";
revoke truncate on table "public"."pull_request" from "authenticated";
revoke references on table "public"."pull_request_session" from "anon";
revoke trigger on table "public"."pull_request_session" from "anon";
revoke truncate on table "public"."pull_request_session" from "anon";
revoke references on table "public"."pull_request_session" from "authenticated";
revoke trigger on table "public"."pull_request_session" from "authenticated";
revoke truncate on table "public"."pull_request_session" from "authenticated";
revoke references on table "public"."role_permissions" from "anon";
revoke trigger on table "public"."role_permissions" from "anon";
revoke truncate on table "public"."role_permissions" from "anon";
revoke references on table "public"."role_permissions" from "authenticated";
revoke trigger on table "public"."role_permissions" from "authenticated";
revoke truncate on table "public"."role_permissions" from "authenticated";
revoke references on table "public"."saved_trace_filters" from "anon";
revoke trigger on table "public"."saved_trace_filters" from "anon";
revoke truncate on table "public"."saved_trace_filters" from "anon";
revoke references on table "public"."saved_trace_filters" from "authenticated";
revoke trigger on table "public"."saved_trace_filters" from "authenticated";
revoke truncate on table "public"."saved_trace_filters" from "authenticated";
revoke references on table "public"."sso_audit_log" from "anon";
revoke trigger on table "public"."sso_audit_log" from "anon";
revoke truncate on table "public"."sso_audit_log" from "anon";
revoke references on table "public"."sso_audit_log" from "authenticated";
revoke trigger on table "public"."sso_audit_log" from "authenticated";
revoke truncate on table "public"."sso_audit_log" from "authenticated";
revoke references on table "public"."sso_config" from "anon";
revoke trigger on table "public"."sso_config" from "anon";
revoke truncate on table "public"."sso_config" from "anon";
revoke references on table "public"."sso_config" from "authenticated";
revoke trigger on table "public"."sso_config" from "authenticated";
revoke truncate on table "public"."sso_config" from "authenticated";
revoke references on table "public"."sso_identity" from "anon";
revoke trigger on table "public"."sso_identity" from "anon";
revoke truncate on table "public"."sso_identity" from "anon";
revoke references on table "public"."sso_identity" from "authenticated";
revoke trigger on table "public"."sso_identity" from "authenticated";
revoke truncate on table "public"."sso_identity" from "authenticated";
revoke references on table "public"."temp_access_grant" from "anon";
revoke trigger on table "public"."temp_access_grant" from "anon";
revoke truncate on table "public"."temp_access_grant" from "anon";
revoke references on table "public"."temp_access_grant" from "authenticated";
revoke trigger on table "public"."temp_access_grant" from "authenticated";
revoke truncate on table "public"."temp_access_grant" from "authenticated";
revoke references on table "public"."tenant" from "anon";
revoke trigger on table "public"."tenant" from "anon";
revoke truncate on table "public"."tenant" from "anon";
revoke references on table "public"."tenant" from "authenticated";
revoke trigger on table "public"."tenant" from "authenticated";
revoke truncate on table "public"."tenant" from "authenticated";
revoke references on table "public"."tenant_entitlement_override" from "anon";
revoke trigger on table "public"."tenant_entitlement_override" from "anon";
revoke truncate on table "public"."tenant_entitlement_override" from "anon";
revoke references on table "public"."tenant_entitlement_override" from "authenticated";
revoke trigger on table "public"."tenant_entitlement_override" from "authenticated";
revoke truncate on table "public"."tenant_entitlement_override" from "authenticated";
revoke references on table "public"."terms_agreement" from "anon";
revoke trigger on table "public"."terms_agreement" from "anon";
revoke truncate on table "public"."terms_agreement" from "anon";
revoke references on table "public"."terms_agreement" from "authenticated";
revoke trigger on table "public"."terms_agreement" from "authenticated";
revoke truncate on table "public"."terms_agreement" from "authenticated";
revoke references on table "public"."user_git_identity" from "anon";
revoke trigger on table "public"."user_git_identity" from "anon";
revoke truncate on table "public"."user_git_identity" from "anon";
revoke references on table "public"."user_git_identity" from "authenticated";
revoke trigger on table "public"."user_git_identity" from "authenticated";
revoke truncate on table "public"."user_git_identity" from "authenticated";
revoke references on table "public"."worker_run" from "anon";
revoke trigger on table "public"."worker_run" from "anon";
revoke truncate on table "public"."worker_run" from "anon";
revoke references on table "public"."worker_run" from "authenticated";
revoke trigger on table "public"."worker_run" from "authenticated";
revoke truncate on table "public"."worker_run" from "authenticated";
revoke references on table "public"."worker_run_event" from "anon";
revoke trigger on table "public"."worker_run_event" from "anon";
revoke truncate on table "public"."worker_run_event" from "anon";
revoke references on table "public"."worker_run_event" from "authenticated";
revoke trigger on table "public"."worker_run_event" from "authenticated";
revoke truncate on table "public"."worker_run_event" from "authenticated";
revoke references on table "public"."worker_workspace" from "anon";
revoke trigger on table "public"."worker_workspace" from "anon";
revoke truncate on table "public"."worker_workspace" from "anon";
revoke references on table "public"."worker_workspace" from "authenticated";
revoke trigger on table "public"."worker_workspace" from "authenticated";
revoke truncate on table "public"."worker_workspace" from "authenticated";

-- Seed data carried by the pre-baseline migration history. A schema dump
-- cannot carry rows, so the canonical seed blocks are restated here;
-- schemas/12-rbac.sql (generated from permission-seed.json) and
-- schemas/40-platform-admin.sql are the sources.

-- BEGIN GENERATED role_permissions — source: packages/db-types/permission-seed.json
-- Every row below is generated from permission-seed.json. This block is the
-- reviewable declarative mirror of the seed; the rows are applied to the
-- database by the role_permissions seed migrations. Edit the JSON and run
-- `yarn codegen:permissions` — never hand-edit between the markers.

-- Agent sessions are self-by-default: every active role reads its own
-- sessions and the team-level findings aggregate. Team-wide session read
-- (other members' sessions and transcripts) and agents/capture-tier
-- settings are admin-granted, so they go to owner/admin only.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'agents.findings.read'),
    ('admin', 'agents.findings.read'),
    ('write', 'agents.findings.read'),
    ('read', 'agents.findings.read'),
    ('owner', 'agents.sessions.self.read'),
    ('admin', 'agents.sessions.self.read'),
    ('write', 'agents.sessions.self.read'),
    ('read', 'agents.sessions.self.read'),
    ('owner', 'agents.sessions.team.read'),
    ('admin', 'agents.sessions.team.read'),
    ('owner', 'agents.settings.write'),
    ('admin', 'agents.settings.write')
ON CONFLICT (role, permission) DO NOTHING;

-- Org-wide seat-cost configuration (Settings -> AI costs): owner/admin
-- only, like billing — it is org-level financial config. The dashboard
-- widget that consumes the derived total reads via service_role, so members
-- still see Total Cost of AI without these grants.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'ai_cost_config.delete'),
    ('admin', 'ai_cost_config.delete'),
    ('owner', 'ai_cost_config.insert'),
    ('admin', 'ai_cost_config.insert'),
    ('owner', 'ai_cost_config.read'),
    ('admin', 'ai_cost_config.read'),
    ('owner', 'ai_cost_config.update'),
    ('admin', 'ai_cost_config.update')
ON CONFLICT (role, permission) DO NOTHING;

-- API keys: owner/admin/write view and create keys; rotating (update) and
-- revoking (delete) a key is owner/admin only.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'api_key.delete'),
    ('admin', 'api_key.delete'),
    ('owner', 'api_key.insert'),
    ('admin', 'api_key.insert'),
    ('write', 'api_key.insert'),
    ('owner', 'api_key.read'),
    ('admin', 'api_key.read'),
    ('write', 'api_key.read'),
    ('owner', 'api_key.update'),
    ('admin', 'api_key.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Apps: every role reads; creating, editing, and deleting an app is
-- owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'app.delete'),
    ('admin', 'app.delete'),
    ('owner', 'app.insert'),
    ('admin', 'app.insert'),
    ('owner', 'app.read'),
    ('admin', 'app.read'),
    ('write', 'app.read'),
    ('read', 'app.read'),
    ('owner', 'app.update'),
    ('admin', 'app.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Per-app role overrides: every role can see who holds which app role;
-- assigning and revoking overrides is owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'app_member_role.delete'),
    ('admin', 'app_member_role.delete'),
    ('owner', 'app_member_role.insert'),
    ('admin', 'app_member_role.insert'),
    ('owner', 'app_member_role.read'),
    ('admin', 'app_member_role.read'),
    ('write', 'app_member_role.read'),
    ('read', 'app_member_role.read'),
    ('owner', 'app_member_role.update'),
    ('admin', 'app_member_role.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Governs the app-level publish policy (require_pull_request). Owner/admin
-- only: it is a governance control, and a member who can publish must not
-- be able to remove the review gate. Owner is seeded explicitly because the
-- owner bypass in private.effective_app_permissions (01a-private-authz.sql)
-- returns the owner's org role_permissions set — an owner not seeded this
-- permission would be denied here.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'app_policy.update'),
    ('admin', 'app_policy.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Tenant audit-trail read. Owner/admin only: the trail carries member
-- emails, IPs, and denied-attempt records. The trail is written exclusively
-- by service_role, so there is no insert/update/delete.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'audit_log.read'),
    ('admin', 'audit_log.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Billing: every role sees the plan and usage; changing the subscription
-- (insert/update/delete) is owner only.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'billing.insert'),
    ('owner', 'billing.read'),
    ('admin', 'billing.read'),
    ('write', 'billing.read'),
    ('read', 'billing.read'),
    ('owner', 'billing.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Context mirror: every role reads the mirror; write roles save, update,
-- and delete context files.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'context.delete'),
    ('admin', 'context.delete'),
    ('write', 'context.delete'),
    ('owner', 'context.insert'),
    ('admin', 'context.insert'),
    ('write', 'context.insert'),
    ('owner', 'context.read'),
    ('admin', 'context.read'),
    ('write', 'context.read'),
    ('read', 'context.read'),
    ('owner', 'context.update'),
    ('admin', 'context.update'),
    ('write', 'context.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Custom roles: owner/admin define, edit, and delete custom roles.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'custom_role.delete'),
    ('admin', 'custom_role.delete'),
    ('owner', 'custom_role.insert'),
    ('admin', 'custom_role.insert'),
    ('owner', 'custom_role.read'),
    ('admin', 'custom_role.read'),
    ('owner', 'custom_role.update'),
    ('admin', 'custom_role.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Analytics dashboards: every role views; write roles create, edit, and
-- delete dashboards.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'dashboard.delete'),
    ('admin', 'dashboard.delete'),
    ('write', 'dashboard.delete'),
    ('owner', 'dashboard.insert'),
    ('admin', 'dashboard.insert'),
    ('write', 'dashboard.insert'),
    ('owner', 'dashboard.read'),
    ('admin', 'dashboard.read'),
    ('write', 'dashboard.read'),
    ('read', 'dashboard.read'),
    ('owner', 'dashboard.update'),
    ('admin', 'dashboard.update'),
    ('write', 'dashboard.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Environment variables: every role reads; write roles set, update, and
-- remove them.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'env_var.delete'),
    ('admin', 'env_var.delete'),
    ('write', 'env_var.delete'),
    ('owner', 'env_var.insert'),
    ('admin', 'env_var.insert'),
    ('write', 'env_var.insert'),
    ('owner', 'env_var.read'),
    ('admin', 'env_var.read'),
    ('write', 'env_var.read'),
    ('read', 'env_var.read'),
    ('owner', 'env_var.update'),
    ('admin', 'env_var.update'),
    ('write', 'env_var.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Env-build escalation queue: every role reads (the rows explain why a
-- repo's evals aren't running); write roles acknowledge and resolve. Rows
-- are written by the eval worker via service_role.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'env_escalation.read'),
    ('admin', 'env_escalation.read'),
    ('write', 'env_escalation.read'),
    ('read', 'env_escalation.read'),
    ('owner', 'env_escalation.update'),
    ('admin', 'env_escalation.update'),
    ('write', 'env_escalation.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Environment lifecycle: every role reads; write roles create, edit, and
-- promote (promote is the release action and covers both forward promotion
-- and rollback); deleting an environment is owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'environment.delete'),
    ('admin', 'environment.delete'),
    ('owner', 'environment.insert'),
    ('admin', 'environment.insert'),
    ('write', 'environment.insert'),
    ('owner', 'environment.promote'),
    ('admin', 'environment.promote'),
    ('write', 'environment.promote'),
    ('owner', 'environment.read'),
    ('admin', 'environment.read'),
    ('write', 'environment.read'),
    ('read', 'environment.read'),
    ('owner', 'environment.update'),
    ('admin', 'environment.update'),
    ('write', 'environment.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Eval runs: every role reads history; write roles dispatch and manage
-- runs.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'eval_run.delete'),
    ('admin', 'eval_run.delete'),
    ('write', 'eval_run.delete'),
    ('owner', 'eval_run.insert'),
    ('admin', 'eval_run.insert'),
    ('write', 'eval_run.insert'),
    ('owner', 'eval_run.read'),
    ('admin', 'eval_run.read'),
    ('write', 'eval_run.read'),
    ('read', 'eval_run.read'),
    ('owner', 'eval_run.update'),
    ('admin', 'eval_run.update'),
    ('write', 'eval_run.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Experiments: every role views. experiment.run is deliberately ungranted —
-- its only enforcement was the pending_experiment RLS policies, dropped
-- along with that table; benchmark/eval dispatch gates on eval_run.insert
-- instead (see the eval_run group).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'experiment.read'),
    ('admin', 'experiment.read'),
    ('write', 'experiment.read'),
    ('read', 'experiment.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Tracked git branches: every role reads; owner/admin manage.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'git_branch.delete'),
    ('admin', 'git_branch.delete'),
    ('owner', 'git_branch.insert'),
    ('admin', 'git_branch.insert'),
    ('owner', 'git_branch.read'),
    ('admin', 'git_branch.read'),
    ('write', 'git_branch.read'),
    ('read', 'git_branch.read'),
    ('owner', 'git_branch.update'),
    ('admin', 'git_branch.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Git provider connection: every role reads; write roles connect and
-- reconfigure; disconnecting is owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'git_connection.delete'),
    ('admin', 'git_connection.delete'),
    ('owner', 'git_connection.insert'),
    ('admin', 'git_connection.insert'),
    ('write', 'git_connection.insert'),
    ('owner', 'git_connection.read'),
    ('admin', 'git_connection.read'),
    ('write', 'git_connection.read'),
    ('read', 'git_connection.read'),
    ('owner', 'git_connection.update'),
    ('admin', 'git_connection.update'),
    ('write', 'git_connection.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Member lifecycle, kept separate from profile.* on purpose.
-- profile.insert/update are self-service and held by every role so a member
-- can create and edit their own profile; inviting a member, changing a
-- role, disabling and removing are privileged and belong to owner/admin
-- only. Never gate a lifecycle operation on a self-service permission.
-- membership.read stays broad because the member list is already visible to
-- every role.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'membership.delete'),
    ('admin', 'membership.delete'),
    ('owner', 'membership.insert'),
    ('admin', 'membership.insert'),
    ('owner', 'membership.read'),
    ('admin', 'membership.read'),
    ('write', 'membership.read'),
    ('read', 'membership.read'),
    ('owner', 'membership.update'),
    ('admin', 'membership.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Gateway-facing metrics read (SDK/CLI surface).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'metrics.read'),
    ('admin', 'metrics.read'),
    ('write', 'metrics.read'),
    ('read', 'metrics.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Member profiles: every active member reads teammates and creates/edits
-- their own profile; removing a member (delete) is owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'profile.delete'),
    ('admin', 'profile.delete'),
    ('owner', 'profile.insert'),
    ('admin', 'profile.insert'),
    ('write', 'profile.insert'),
    ('read', 'profile.insert'),
    ('owner', 'profile.read'),
    ('admin', 'profile.read'),
    ('write', 'profile.read'),
    ('read', 'profile.read'),
    ('owner', 'profile.update'),
    ('admin', 'profile.update'),
    ('write', 'profile.update'),
    ('read', 'profile.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Gateway-facing scores: every role reads; write roles write; owner/admin
-- delete.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'score.delete'),
    ('admin', 'score.delete'),
    ('owner', 'score.read'),
    ('admin', 'score.read'),
    ('write', 'score.read'),
    ('read', 'score.read'),
    ('owner', 'score.write'),
    ('admin', 'score.write'),
    ('write', 'score.write')
ON CONFLICT (role, permission) DO NOTHING;

-- Gateway-facing session read (SDK/CLI surface).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'session.read'),
    ('admin', 'session.read'),
    ('write', 'session.read'),
    ('read', 'session.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Gateway-facing span read (SDK/CLI surface).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'span.read'),
    ('admin', 'span.read'),
    ('write', 'span.read'),
    ('read', 'span.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Enterprise SSO config: owner/admin view and edit; only the owner deletes
-- the SSO connection.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'sso_config.delete'),
    ('owner', 'sso_config.insert'),
    ('admin', 'sso_config.insert'),
    ('owner', 'sso_config.read'),
    ('admin', 'sso_config.read'),
    ('owner', 'sso_config.update'),
    ('admin', 'sso_config.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Organization record: every role reads; write roles edit organization
-- settings. tenant.delete and tenant.insert are deliberately ungranted — no
-- RLS policy references them, so they conferred nothing. Orgs are created
-- by create_organization_transaction and deleted only by platform admins,
-- both SECURITY DEFINER paths that bypass RLS.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'tenant.read'),
    ('admin', 'tenant.read'),
    ('write', 'tenant.read'),
    ('read', 'tenant.read'),
    ('owner', 'tenant.update'),
    ('admin', 'tenant.update'),
    ('write', 'tenant.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Traces: every role reads; write roles ingest spans (SDK/CLI).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'trace.read'),
    ('admin', 'trace.read'),
    ('write', 'trace.read'),
    ('read', 'trace.read'),
    ('owner', 'trace.write'),
    ('admin', 'trace.write'),
    ('write', 'trace.write')
ON CONFLICT (role, permission) DO NOTHING;

-- Cloud workers: every role reads run history and transcripts; write roles
-- launch, cancel, and delete runs.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'worker_run.delete'),
    ('admin', 'worker_run.delete'),
    ('write', 'worker_run.delete'),
    ('owner', 'worker_run.insert'),
    ('admin', 'worker_run.insert'),
    ('write', 'worker_run.insert'),
    ('owner', 'worker_run.read'),
    ('admin', 'worker_run.read'),
    ('write', 'worker_run.read'),
    ('read', 'worker_run.read'),
    ('owner', 'worker_run.update'),
    ('admin', 'worker_run.update'),
    ('write', 'worker_run.update')
ON CONFLICT (role, permission) DO NOTHING;
-- END GENERATED role_permissions

INSERT INTO public.platform_role_permissions (role, permission) VALUES
    ('platform_admin', 'platform.org.read'),
    ('platform_admin', 'platform.org.delete'),
    ('platform_admin', 'platform.user.read'),
    ('platform_admin', 'platform.user.delete'),
    ('platform_admin', 'platform.temp_access.grant'),
    ('platform_admin', 'platform.flag.manage'),
    ('platform_admin', 'platform.audit.read'),
    ('platform_admin', 'platform.entitlement.read'),
    ('platform_admin', 'platform.entitlement.write'),
    ('platform_admin', 'platform.entitlement.delete'),
    ('platform_admin', 'platform.dora.read'),
    ('platform_admin', 'platform.environment.read'),
    ('platform_admin', 'platform.sso_config.read')
ON CONFLICT DO NOTHING;

-- Column-scoped grants: a schema dump cannot round-trip these (it emits
-- them, but the surrounding default-privilege grants it also emits mask
-- the withheld columns), and `db diff` does not compare column privileges.
-- Restated from schemas/22-git-connection.sql (credential columns are
-- withheld from authenticated) and schemas/27-notification.sql.
REVOKE ALL ON public.git_connection FROM anon;
REVOKE ALL ON public.git_connection FROM authenticated;
GRANT SELECT (
    id, tenant_id, app_id, provider, repository, installation_id, webhook_id,
    created_at, created_by, updated_at, updated_by
), INSERT (
    id, tenant_id, app_id, provider, repository, installation_id, webhook_id,
    created_at, created_by, updated_at, updated_by
), UPDATE (
    app_id, provider, installation_id, repository, webhook_id
) ON public.git_connection TO authenticated;
GRANT DELETE ON public.git_connection TO authenticated;
GRANT UPDATE (read) ON public.notification TO authenticated;

-- Function EXECUTE grants: the local runtime's default privileges grant
-- EXECUTE on every public-schema function to anon and authenticated at
-- CREATE time, so replaying the CREATE FUNCTION statements above re-adds
-- grants the source database does not hold — the dumped ACL section only
-- carries REVOKE ... FROM PUBLIC, which does not touch role-specific
-- default-privilege grants. Internal SECURITY DEFINER / trigger /
-- service-role functions hold no anon or authenticated EXECUTE; restated
-- from schemas/96-function-execution-grants.sql and the owning schema
-- files (23a-api-key-secret, 32-audit-log, 33-context,
-- 03-functions-transactions).
REVOKE EXECUTE ON FUNCTION "public"."app_seed_default_env"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."audit_log_compute_hash"("p_prev" "text", "r" "public"."audit_log") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."audit_log_hash_chain"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."change_member_role_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_new_role" character varying, "p_custom_role_id" "uuid", "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."change_user_password"("current_plain_password" character varying, "new_plain_password" character varying) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."check_membership_limit"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."cleanup_expired_temp_access"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."create_context_snapshot"("p_app_id" "uuid", "p_tenant_id" "uuid", "p_branch" "text", "p_commit_sha" "text", "p_classifier_version" bigint, "p_blobs" "jsonb", "p_entries" "jsonb", "p_excluded_counts" "jsonb") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."create_organization_transaction"("p_user_id" "uuid", "p_organization_name" "text", "p_company_name" "text", "p_stripe_customer_id" character varying, "p_tier_id" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."delete_secret"("secret_name" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."get_claim"("uid" "uuid", "claim" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."grant_temp_access_transaction"("p_admin_user_id" "uuid", "p_tenant_id" "uuid", "p_reason" "text", "p_customer_permission_confirmed" boolean, "p_expires_at" timestamp with time zone) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."insert_secret"("name" "text", "secret" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."invite_existing_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."invite_new_user_transaction"("p_user_id" "uuid", "p_tenant_id" "uuid", "p_invited_by" "uuid", "p_email" "public"."citext", "p_name" "text", "p_role" character varying, "p_invited_at" timestamp with time zone, "p_expires_at" timestamp with time zone, "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."nullify_custom_role_on_downgrade"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."platform_admin_delete_tenant"("p_tenant_id" "uuid") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."prevent_app_member_role_self_grant"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."protect_last_owner"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."read_secret"("secret_name" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."remove_member_transaction"("p_tenant_id" "uuid", "p_target_user_id" "uuid", "p_actor_id" "uuid", "p_ip_address" "inet", "p_user_agent" "text", "p_request_id" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."set_api_key_secret"("p_api_key_id" "uuid", "p_key_digest" "text", "p_pepper_version" smallint) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."set_claim"("uid" "uuid", "claim" "text", "value" "jsonb") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."set_created_columns"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."set_profile_updated_at"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."set_updated_columns"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."sync_auth_email_to_profile"() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."update_secret"("secret_name" "text", "secret" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."verify_api_key"("p_key_digest" "text") FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION "public"."verify_audit_log_chain"() FROM anon, authenticated;

-- The public INVOKER wrapper stays callable by authenticated (the
-- dashboard/gateway permission checks go through it); anon has no
-- membership and was never part of its surface (schemas/01a-private-authz.sql).
REVOKE EXECUTE ON FUNCTION "public"."get_current_user_app_permissions"("target_app_id" "uuid") FROM anon;

-- TRUNCATE, REFERENCES and TRIGGER are not gated by RLS, so the Data API
-- roles must never hold them; the default-privilege trim is cluster state
-- a schema dump does not carry, and without it every table created after
-- this baseline gets all three back. Restated from
-- schemas/98-table-privilege-hardening.sql.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;

-- pg_cron schedules are cron.job rows — data, not schema — so neither
-- `db diff` nor a schema dump carries them. Both jobs are asserted by the
-- integration suite (usage-snapshot-schedule, temp-access-cleanup-schedule).
-- pg_cron is superuser-installed and absent in some local databases;
-- skipping is correct there, and a hosted environment that lands in the
-- guard has a real configuration problem, hence WARNING rather than NOTICE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE WARNING 'pg_cron not installed — expired temp-access grants will NOT be cleaned up automatically';
    RETURN;
  END IF;

  -- cron.schedule() upserts on job name, so no unschedule guard is needed.
  PERFORM cron.schedule(
    'cleanup-expired-temp-access',
    '*/30 * * * *',
    'SELECT public.cleanup_expired_temp_access()'
  );
END $$;

-- Monthly, on the 1st at 04:10 UTC — after the 03:00/03:30 gateway crons,
-- so a capture never lands mid-retention-sweep and counts those scans as a
-- normal day.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'ops-capture-usage-snapshot',
      '10 4 1 * *',
      'SELECT ops.capture_usage_snapshot()'
    );
    RAISE NOTICE 'pg_cron job scheduled: ops-capture-usage-snapshot (monthly)';
  ELSE
    RAISE NOTICE 'pg_cron extension not available. Capture must be invoked manually.';
  END IF;
EXCEPTION
  WHEN undefined_function THEN
    RAISE NOTICE 'pg_cron extension not available. Capture must be invoked manually.';
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not schedule pg_cron job: %. Capture must be invoked manually.', SQLERRM;
END $$;

-- Seed a usage baseline. Without it the ops delta functions return nothing
-- (correctly) until the second cron firing, a month later than needed.
SELECT "ops"."capture_usage_snapshot"();
