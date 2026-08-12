-- =============================================================================
-- Adds the `admin_api_key.{read,insert,update,delete}` app_permission enum
-- values and the admin_api_key / admin_api_key_secret tables backing them:
-- org-scoped machine credentials for the dashboard admin REST API.
--
-- Postgres has no `ALTER TYPE ... ADD VALUE` that takes effect within the same
-- transaction as dependent DDL, so the enum is rebuilt the same way
-- 20260806130000_remove_agent_insights.sql retired a value: rename the old
-- type, create the new one, retype the columns that use it, and drop the old
-- type. Every RLS policy and function bound to the type by OID is captured
-- BEFORE the rename (while `public.app_permission` still renders as that
-- name, which then resolves to the NEW type on replay), dropped, and replayed
-- afterwards. Function ACLs are captured and replayed alongside, because
-- DROP + CREATE loses the EXECUTE revokes that keep the SECURITY DEFINER
-- helpers off the PostgREST surface.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Capture every policy and function that binds `public.app_permission`.
--    Captured first: the rendered definitions must still say
--    `public.app_permission`, so replaying them binds the rebuilt type.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _perm_policy_defs ON COMMIT DROP AS
SELECT
    format(
        'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;',
        pol.polname,
        n.nspname,
        c.relname,
        CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
        CASE pol.polcmd
            WHEN 'r' THEN 'SELECT'
            WHEN 'a' THEN 'INSERT'
            WHEN 'w' THEN 'UPDATE'
            WHEN 'd' THEN 'DELETE'
            ELSE 'ALL'
        END,
        CASE
            WHEN pol.polroles = '{0}'::oid[] THEN 'public'
            ELSE (
                SELECT string_agg(quote_ident(r.rolname), ', ' ORDER BY r.rolname)
                FROM pg_roles r
                WHERE r.oid = ANY (pol.polroles)
            )
        END,
        CASE
            WHEN pol.polqual IS NULL THEN ''
            ELSE ' USING (' || pg_get_expr(pol.polqual, pol.polrelid) || ')'
        END,
        CASE
            WHEN pol.polwithcheck IS NULL THEN ''
            ELSE ' WITH CHECK (' || pg_get_expr(pol.polwithcheck, pol.polrelid) || ')'
        END
    ) AS create_stmt,
    format('DROP POLICY %I ON %I.%I;', pol.polname, n.nspname, c.relname) AS drop_stmt
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE EXISTS (
    -- Either a direct cast to the type, or a call to one of the authz helpers
    -- rebuilt below: DROP FUNCTION ... CASCADE would take those policies with
    -- it, so they are captured and replayed too.
    SELECT 1
    FROM pg_depend d
    WHERE d.classid = 'pg_policy'::regclass
      AND d.objid = pol.oid
      AND (
        d.refobjid = 'public.app_permission'::regtype
        OR d.refobjid IN (
            SELECT p.oid
            FROM pg_proc p
            WHERE EXISTS (
                SELECT 1
                FROM pg_depend fd
                WHERE fd.classid = 'pg_proc'::regclass
                  AND fd.objid = p.oid
                  AND fd.refobjid = 'public.app_permission'::regtype
            )
        )
      )
);

CREATE TEMP TABLE _perm_function_defs ON COMMIT DROP AS
SELECT
    p.oid AS func_oid,
    pg_get_functiondef(p.oid) AS create_stmt,
    format(
        'DROP FUNCTION IF EXISTS %I.%I(%s) CASCADE;',
        n.nspname,
        p.proname,
        pg_get_function_identity_arguments(p.oid)
    ) AS drop_stmt,
    format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS signature,
    p.proacl AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE EXISTS (
    SELECT 1
    FROM pg_depend d
    WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = p.oid
      AND d.refobjid = 'public.app_permission'::regtype
);

CREATE TEMP TABLE _perm_function_acls ON COMMIT DROP AS
SELECT
    f.signature,
    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
    a.privilege_type,
    a.is_grantable
FROM _perm_function_defs f
CROSS JOIN LATERAL aclexplode(f.acl) AS a
WHERE f.acl IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Drop the dependents, rebuild the enum, retype its columns, replay.
-- ---------------------------------------------------------------------------
DO $rebuild$
DECLARE
    stmt TEXT;
BEGIN
    FOR stmt IN SELECT drop_stmt FROM _perm_policy_defs LOOP
        EXECUTE stmt;
    END LOOP;

    FOR stmt IN SELECT drop_stmt FROM _perm_function_defs LOOP
        EXECUTE stmt;
    END LOOP;
END
$rebuild$;

ALTER TYPE public.app_permission RENAME TO app_permission_old;

CREATE TYPE public.app_permission AS ENUM (
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
    'context.read',
    'context.insert',
    'context.update',
    'context.delete',
    'agents.sessions.self.read',
    'agents.sessions.team.read',
    'agents.settings.write',
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
    'membership.delete',
    'admin_api_key.read',
    'admin_api_key.insert',
    'admin_api_key.update',
    'admin_api_key.delete'
);

ALTER TABLE public.role_permissions
    -- squawk-ignore changing-column-type
    ALTER COLUMN permission TYPE public.app_permission
    USING permission::text::public.app_permission;

ALTER TABLE public.custom_role_permission
    -- squawk-ignore changing-column-type
    ALTER COLUMN permission TYPE public.app_permission
    USING permission::text::public.app_permission;

ALTER TABLE public.api_key
    ALTER COLUMN permissions DROP DEFAULT;

-- Small permission-grant table rewritten inside this transaction to rebind
-- it to the rebuilt enum; the retype is the point of the migration, not
-- incidental risk.
ALTER TABLE public.api_key
    -- squawk-ignore changing-column-type
    ALTER COLUMN permissions TYPE public.app_permission[]
    USING permissions::text[]::public.app_permission[];

ALTER TABLE public.api_key
    ALTER COLUMN permissions SET DEFAULT '{}'::public.app_permission[];

DO $replay$
DECLARE
    stmt TEXT;
    acl RECORD;
BEGIN
    -- The helpers call one another, so a body would fail validation against a
    -- sibling that has not been recreated yet. Order is not knowable up front;
    -- deferring body checks makes the replay order-independent.
    SET LOCAL check_function_bodies = off;

    FOR stmt IN SELECT create_stmt FROM _perm_function_defs LOOP
        EXECUTE stmt;
    END LOOP;

    RESET check_function_bodies;

    -- A dropped-and-recreated function reverts to the default
    -- "EXECUTE TO PUBLIC" ACL. Restore the captured grants so the internal
    -- SECURITY DEFINER helpers stay revoked from anon/authenticated.
    FOR stmt IN SELECT DISTINCT signature FROM _perm_function_acls LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC;', stmt);
    END LOOP;

    FOR acl IN SELECT * FROM _perm_function_acls LOOP
        EXECUTE format(
            'GRANT %s ON FUNCTION %s TO %s%s;',
            acl.privilege_type,
            acl.signature,
            acl.grantee,
            CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
        );
    END LOOP;

    FOR stmt IN SELECT create_stmt FROM _perm_policy_defs LOOP
        EXECUTE stmt;
    END LOOP;
END
$replay$;

DROP TYPE public.app_permission_old;

-- ---------------------------------------------------------------------------
-- 3. Admin API key tables — org-scoped bearer credentials for the admin
--    REST API. Created after the enum rebuild so `admin_api_key.permissions`
--    binds directly to the final type.
-- ---------------------------------------------------------------------------

CREATE TABLE "private"."admin_api_key_secret" (
    "admin_api_key_id" uuid NOT NULL,
    "key_digest" text NOT NULL,
    "pepper_version" bigint NOT NULL DEFAULT 1,
    "created_at" timestamp with time zone DEFAULT now()
);

ALTER TABLE "private"."admin_api_key_secret" ENABLE ROW LEVEL SECURITY;

CREATE TABLE "public"."admin_api_key" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" uuid NOT NULL,
    "name" text NOT NULL,
    "admin_api_key_id" text NOT NULL,
    "key_prefix" text,
    "permissions" public.app_permission[] NOT NULL DEFAULT '{}'::public.app_permission[],
    "expires_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "created_by" uuid,
    "updated_at" timestamp with time zone,
    "updated_by" uuid
);

ALTER TABLE "public"."admin_api_key" ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX admin_api_key_secret_pkey ON private.admin_api_key_secret USING btree (admin_api_key_id);
CREATE UNIQUE INDEX uc_admin_api_key_secret_digest ON private.admin_api_key_secret USING btree (key_digest);

CREATE UNIQUE INDEX admin_api_key_admin_api_key_id_key ON public.admin_api_key USING btree (admin_api_key_id);
CREATE UNIQUE INDEX admin_api_key_pkey ON public.admin_api_key USING btree (id);
CREATE INDEX idx_admin_api_key_tenant ON public.admin_api_key USING btree (tenant_id);
CREATE UNIQUE INDEX uc_admin_api_key ON public.admin_api_key USING btree (name, tenant_id);

ALTER TABLE "private"."admin_api_key_secret" ADD CONSTRAINT "admin_api_key_secret_pkey" PRIMARY KEY USING INDEX "admin_api_key_secret_pkey";
ALTER TABLE "public"."admin_api_key" ADD CONSTRAINT "admin_api_key_pkey" PRIMARY KEY USING INDEX "admin_api_key_pkey";

ALTER TABLE "private"."admin_api_key_secret" ADD CONSTRAINT "admin_api_key_secret_admin_api_key_id_fkey" FOREIGN KEY (admin_api_key_id) REFERENCES public.admin_api_key(id) ON DELETE CASCADE;
ALTER TABLE "private"."admin_api_key_secret" ADD CONSTRAINT "uc_admin_api_key_secret_digest" UNIQUE USING INDEX "uc_admin_api_key_secret_digest";

ALTER TABLE "public"."admin_api_key" ADD CONSTRAINT "admin_api_key_admin_api_key_id_key" UNIQUE USING INDEX "admin_api_key_admin_api_key_id_key";
ALTER TABLE "public"."admin_api_key" ADD CONSTRAINT "admin_api_key_created_by_fkey" FOREIGN KEY (created_by) REFERENCES public.profile(id) ON DELETE SET NULL;
ALTER TABLE "public"."admin_api_key" ADD CONSTRAINT "admin_api_key_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenant(tenant_id) ON DELETE CASCADE;
ALTER TABLE "public"."admin_api_key" ADD CONSTRAINT "admin_api_key_updated_by_fkey" FOREIGN KEY (updated_by) REFERENCES public.profile(id) ON DELETE SET NULL;
ALTER TABLE "public"."admin_api_key" ADD CONSTRAINT "uc_admin_api_key" UNIQUE USING INDEX "uc_admin_api_key";

CREATE FUNCTION private.verify_admin_api_key(p_key_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'adminApiKeyId', k.id,
    'tenantId', k.tenant_id,
    'permissions', COALESCE(to_jsonb(k.permissions), '[]'::jsonb)
  )
  INTO v_result
  FROM public.admin_api_key k
  JOIN private.admin_api_key_secret s ON s.admin_api_key_id = k.id
  WHERE s.key_digest = p_key_digest
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now());

  RETURN v_result;
END;
$function$;

CREATE FUNCTION private.touch_admin_api_key_last_used(p_admin_api_key_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.admin_api_key SET last_used_at = now() WHERE id = p_admin_api_key_id;
$function$;

CREATE FUNCTION private.set_admin_api_key_secret(p_admin_api_key_id uuid, p_key_digest text, p_pepper_version bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO private.admin_api_key_secret (admin_api_key_id, key_digest, pepper_version)
  VALUES (p_admin_api_key_id, p_key_digest, p_pepper_version)
  ON CONFLICT (admin_api_key_id) DO UPDATE
    SET key_digest = EXCLUDED.key_digest,
        pepper_version = EXCLUDED.pepper_version;
END;
$function$;

CREATE FUNCTION public.verify_admin_api_key(p_key_digest text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.verify_admin_api_key(p_key_digest);
$function$;

CREATE FUNCTION public.touch_admin_api_key_last_used(p_admin_api_key_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.touch_admin_api_key_last_used(p_admin_api_key_id);
$function$;

CREATE FUNCTION public.set_admin_api_key_secret(p_admin_api_key_id uuid, p_key_digest text, p_pepper_version bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.set_admin_api_key_secret(p_admin_api_key_id, p_key_digest, p_pepper_version);
$function$;

REVOKE EXECUTE ON FUNCTION private.verify_admin_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.verify_admin_api_key(text) TO service_role;

REVOKE EXECUTE ON FUNCTION private.touch_admin_api_key_last_used(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.touch_admin_api_key_last_used(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION private.set_admin_api_key_secret(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.set_admin_api_key_secret(uuid, text, bigint) TO service_role;

REVOKE EXECUTE ON FUNCTION public.verify_admin_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_admin_api_key(text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.touch_admin_api_key_last_used(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_admin_api_key_last_used(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.set_admin_api_key_secret(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_admin_api_key_secret(uuid, text, bigint) TO service_role;

GRANT ALL ON public.admin_api_key TO authenticated;
GRANT ALL ON public.admin_api_key TO service_role;

CREATE POLICY "Enable admin_api_key delete for users with admin access" ON "public"."admin_api_key" FOR DELETE TO "authenticated" USING (( SELECT "private"."authorize"('admin_api_key.delete'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

CREATE POLICY "Enable admin_api_key insert for users with admin access" ON "public"."admin_api_key" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "private"."authorize"('admin_api_key.insert'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

CREATE POLICY "Enable read access for tenant users" ON "public"."admin_api_key" FOR SELECT TO "authenticated" USING (( SELECT "private"."authorize"('admin_api_key.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

CREATE POLICY "Enable admin_api_key update for users with update access" ON "public"."admin_api_key" FOR UPDATE TO "authenticated" USING (( SELECT "private"."authorize"('admin_api_key.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")) WITH CHECK (( SELECT "private"."authorize"('admin_api_key.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id"));

-- Org-scoped bearer credentials for the admin REST API (member/role
-- management, SCIM-layerable later). More privileged than a gateway api_key
-- by design — a key carries org-wide member/role permissions — so creating
-- and reading are owner/admin only, unlike api_key.insert/read which also
-- grant write.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'admin_api_key.delete'),
    ('admin', 'admin_api_key.delete'),
    ('owner', 'admin_api_key.insert'),
    ('admin', 'admin_api_key.insert'),
    ('owner', 'admin_api_key.read'),
    ('admin', 'admin_api_key.read'),
    ('owner', 'admin_api_key.update'),
    ('admin', 'admin_api_key.update')
ON CONFLICT (role, permission) DO NOTHING;

COMMIT;
