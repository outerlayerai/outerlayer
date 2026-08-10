-- =============================================================================
-- Drops the `experiment.read` and `environment.promote` `app_permission` enum
-- values. Both gate zero gateway routes and zero RLS policies: `experiment.read`
-- is residue from the removed eval-run feature, and `environment.promote` was
-- never wired to a route (`POST /v1/environments/:id/promote` does not exist).
--
-- Postgres has no `ALTER TYPE ... DROP VALUE`, so the enum is rebuilt: rename
-- the old type, create the new one, retype every column that uses it, and drop
-- the old type. RLS policies and functions bind the type by OID, so their
-- definitions are captured BEFORE the rename (while `public.app_permission`
-- still renders as that name, which then resolves to the NEW type on replay),
-- dropped, and replayed afterwards. Function ACLs are captured and replayed
-- alongside, because DROP + CREATE loses the EXECUTE revokes that keep the
-- SECURITY DEFINER helpers off the PostgREST surface.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Retire the grants, so no stored row holds a value the new enum lacks.
-- ---------------------------------------------------------------------------
DELETE FROM public.role_permissions
WHERE permission IN (
    'experiment.read',
    'environment.promote'
);

DELETE FROM public.custom_role_permission
WHERE permission IN (
    'experiment.read',
    'environment.promote'
);

-- API keys carry their scopes as an enum ARRAY, so the retired values have to
-- be filtered out element-wise before the column can be retyped.
UPDATE public.api_key
SET permissions = (
    SELECT COALESCE(array_agg(p ORDER BY ord), '{}'::public.app_permission[])
    FROM unnest(permissions) WITH ORDINALITY AS t(p, ord)
    WHERE p::text NOT IN (
        'experiment.read',
        'environment.promote'
    )
)
WHERE permissions && ARRAY[
    'experiment.read',
    'environment.promote'
]::public.app_permission[];

-- ---------------------------------------------------------------------------
-- 2. Capture every policy and function that binds `public.app_permission`.
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
-- 3. Drop the dependents, rebuild the enum, retype its columns, replay.
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
    'membership.delete'
);

-- ---------------------------------------------------------------------------
-- 3b. Sweep any stored value the NEW enum lacks, whatever its origin.
--
--     Step 1 deletes the two values THIS migration retires, which is the
--     migration's intent. It cannot cover values that were already orphaned
--     before it ran, so this runs AFTER the CREATE TYPE above, when
--     `public.app_permission` resolves to the NEW type while the columns
--     still hold the old one — the only window where "not a label of the new
--     enum" is expressible. Being derived from pg_enum rather than a
--     hand-kept list, it stays correct for the next rebuild too.
-- ---------------------------------------------------------------------------
DELETE FROM public.role_permissions
WHERE permission::text NOT IN (
    SELECT enumlabel::text FROM pg_enum WHERE enumtypid = 'public.app_permission'::regtype
);

DELETE FROM public.custom_role_permission
WHERE permission::text NOT IN (
    SELECT enumlabel::text FROM pg_enum WHERE enumtypid = 'public.app_permission'::regtype
);

-- api_key holds scopes as an array, so unknown labels are filtered element-wise.
-- array_agg over the old-typed column yields app_permission_old[], so the empty
-- fallback must match that type — the column is retyped further down, not here.
UPDATE public.api_key
SET permissions = (
    SELECT COALESCE(array_agg(p ORDER BY ord), '{}'::public.app_permission_old[])
    FROM unnest(permissions) WITH ORDINALITY AS t(p, ord)
    WHERE p::text IN (
        SELECT enumlabel::text FROM pg_enum WHERE enumtypid = 'public.app_permission'::regtype
    )
)
WHERE EXISTS (
    SELECT 1 FROM unnest(permissions) AS p
    WHERE p::text NOT IN (
        SELECT enumlabel::text FROM pg_enum WHERE enumtypid = 'public.app_permission'::regtype
    )
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

-- Both tables are small permission-grant tables rewritten inside this
-- transaction to rebind them to the rebuilt enum; the retype is the point of
-- the migration, not incidental risk.
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

COMMIT;
