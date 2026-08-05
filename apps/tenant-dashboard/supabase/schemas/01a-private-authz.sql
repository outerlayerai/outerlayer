-- =============================================================================
-- Private Authorization Schema
-- =============================================================================
-- Purpose: Host the JWT-reading SECURITY DEFINER authorization helpers in a
--   schema that is NOT exposed over PostgREST, so signed-in users cannot invoke
--   them directly as RPCs (/rest/v1/rpc/*) while RLS policies can still call
--   them.
--
-- Background: Supabase's splinter linter (rules anon_/authenticated_
--   security_definer_function_executable) flags every SECURITY DEFINER function
--   in an API-exposed schema (default: public) that anon/authenticated can
--   EXECUTE. These authz helpers MUST stay callable by `authenticated` because
--   RLS policy expressions are evaluated as the querying role. The rule only
--   inspects functions whose schema is in `pgrst.db_schemas` (here: public),
--   so relocating the DEFINER bodies to `private` clears the finding without
--   weakening RLS — `private` is absent from config.toml `[api].schemas`.
--
-- search_path: every SECURITY DEFINER function lists pg_temp last. If pg_temp
--   is not listed, Postgres searches it FIRST for relation names, so a caller
--   who creates a temp table named like one the function reads can swap it out
--   and the function reads the fake as its definer. Listing pg_temp last makes
--   the real table win. Qualifying every reference works too, but that holds
--   only while nobody adds an unqualified one.
--
-- Shape:
--   * private.*           — the real SECURITY DEFINER bodies. RLS policies and
--                           other in-database callers reference these.
--   * public.* (wrappers) — thin SECURITY INVOKER wrappers, kept ONLY for the
--                           external PostgREST callers (gateway bearer check,
--                           dashboard permission hooks) that call
--                           public.authorize / public.app_authorize /
--                           public.get_current_user_app_permissions as the user.
--                           INVOKER functions are not flagged by splinter.
--
-- Resolver: private.effective_app_permissions(app_id) is the canonical per-app
--   permission precedence, scoped to public.tenant_id() — the current request
--   tenant only. private.app_authorize (per-app boolean), private.authorized_app_ids
--   (the set-inversion RLS filters by), and the public
--   get_current_user_app_permissions wrapper are all projections of it.
--   private.member_app_ids inlines the same I3 precedence a second time,
--   parameterized by tenant instead of reading it from request context — the
--   headerless Realtime paths (notification, context_sync_event) need to
--   evaluate it across the caller's WHOLE membership set in one query, which
--   tenant_id()-scoped effective_app_permissions cannot do.
--
-- Dependencies: 00-extensions.sql, 01-types.sql, 02-functions-core.sql
-- Note: Bodies must match exact database format for declarative schema diffing.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;

-- RLS evaluates policy expressions as the querying role, so anon/authenticated
-- need USAGE on the schema to reach the helpers from a policy. The schema is not
-- exposed over the API (config.toml [api].schemas omits it), so this grants no
-- RPC surface.
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Claimed-tenant validation (dual-source tenancy)
-- -----------------------------------------------------------------------------
-- Resolves a CLAIMED tenant id — from either the X-Tenant-Id header or the JWT's
-- app_metadata.tenant_id claim — to a tenant the caller may actually act as.
-- public.tenant_id() routes both sources through here for an `authenticated`
-- caller, so a NULL return means "claimed but invalid" and is fail-closed by
-- design: the caller must NOT fall back to any other source on NULL (that would
-- make a spoofed value free to attempt).
--
-- Named for the member, not the header: it validates a tenant id against the
-- caller's live membership regardless of which source produced it. The claim
-- arm is the one that depends on this — a JWT claim outlives the membership
-- that justified it, since ending a membership cannot revoke a minted token.
--
-- SECURITY DEFINER so the membership read bypasses RLS: membership's own SELECT
-- policy calls public.tenant_id(), so reading membership from inside the tenant
-- resolver as the querying role would be infinite policy recursion. It is keyed
-- solely to the caller's own membership (auth.uid()), so it discloses nothing
-- but whether the caller is an active member of the tenant they asked for —
-- something they already know.
CREATE OR REPLACE FUNCTION private.resolve_member_tenant(p_raw text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Org-level authorization
-- -----------------------------------------------------------------------------
-- The actor's org role and custom_role_id come from their ACTIVE membership in
-- public.tenant_id()'s tenant, NOT from the user_role / custom_role_id JWT
-- claims. Those claims are minted for the claim tenant; under a header scoping
-- the request to a DIFFERENT tenant they would apply the wrong tenant's role.
-- Reading the membership row keyed off tenant_id() keeps org-level checks
-- correct under dual-source tenancy, and mirrors the per-app resolver (already
-- fully table-driven). It inherits the same staleness semantics — a membership
-- edit takes effect immediately, with no stale-claim window.
CREATE OR REPLACE FUNCTION private.authorize(requested_permission app_permission)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Platform-level authorization
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.platform_authorize(required_permission platform_permission)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Helper: org-level permission SET for a membership
-- -----------------------------------------------------------------------------
-- Internal-only: takes tenant_id + custom_role_id AS PARAMETERS and bypasses
-- RLS, so it must never be reachable directly — it is called only by the DEFINER
-- resolver bodies (private.effective_app_permissions and private.authorize),
-- which run as the function owner.
CREATE OR REPLACE FUNCTION private.get_org_permission_set(p_custom_role_id uuid, p_role public.app_role, p_tenant_id uuid)
 RETURNS SETOF public.app_permission
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- The single per-app permission resolver (tenant-closed, state-gated).
-- -----------------------------------------------------------------------------
-- Returns every permission the CURRENT user effectively holds for target_app_id.
-- This is the ONLY copy of the per-app precedence chain; app_authorize,
-- authorized_app_ids, and the public get_current_user_app_permissions wrapper
-- are all projections of it.
--
-- Structured as three invariants — the structure IS the guarantee, not a set of
-- guard checks layered on top:
--
--   I1 (tenant closure). The universe is the actor's active tenant, public.tenant_id().
--       The membership→app join admits target_app_id only while it lies in the
--       tenant's app universe: an app owned by ANOTHER tenant produces no row — for
--       everyone, INCLUDING an owner. Cross-tenant is out of the domain, never a
--       value that gets denied downstream. An id owned by NO tenant is a prospective
--       app of the actor's tenant (INSERT WITH CHECK evaluates before the row
--       exists; the row's tenancy is pinned by the policy's tenant_id check and the
--       set_tenant_id trigger) and resolves like a tenant app with no per-app
--       override.
--   I2 (state gate). The domain admits only an ACTIVE, permission-bearing membership
--       (status = 'active' AND role <> 'disabled'). A disabled/inactive member yields
--       no row, so there is no effective role for a per-app override to attach to —
--       the override lookup below runs only for a row that already passed this gate.
--   I3 (single resolution). For the one admitted (member, tenant, app) row, exactly one
--       precedence yields the set: owner → per-app override (custom | built-in) → org
--       (custom | built-in). Owner is the top within the tenant and ignores per-app
--       overrides.
--
-- SECURITY DEFINER (bypasses RLS) because custom_role_permission / app_member_role
-- are RLS-gated; an app-scoped user assigned a custom role does NOT hold those
-- org-level read perms. It is keyed solely off the caller's own membership
-- (auth.uid() within public.tenant_id()) and takes no user_id argument, so it can
-- never disclose another user's permissions.
CREATE OR REPLACE FUNCTION private.effective_app_permissions(target_app_id uuid)
 RETURNS SETOF public.app_permission
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Per-app authorization boolean — thin projection of the resolver.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.app_authorize(requested_permission app_permission, target_app_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM private.effective_app_permissions(app_authorize.target_app_id) AS p
    WHERE p = app_authorize.requested_permission
  );
$function$
;

-- -----------------------------------------------------------------------------
-- Set inversion — the once-per-statement companion RLS filters app_id by.
-- -----------------------------------------------------------------------------
-- Every app in the actor's tenant whose effective set includes requested_permission.
-- Owner → all of the tenant's apps; disabled/non-member → none; per-app replacement
-- respected (an app-read override excludes that app from authorized_app_ids on
-- app.write). Same tenant closure as the resolver: it iterates only apps of
-- public.tenant_id(), so cross-tenant apps are never in range.
--
-- This is the set-based projection RLS policies filter by, replacing a per-row
-- app_authorize(perm, row.app_id) boolean. The canonical policy form is:
--   USING (
--     app_id IN (SELECT private.authorized_app_ids('<perm>'))
--     AND tenant_id = (SELECT public.tenant_id())
--   )
-- Both (SELECT ...) wraps matter for cost: the planner hoists each to an
-- InitPlan/hashed subplan evaluated ONCE per statement, so the resolver (and the
-- header membership check inside tenant_id()) run once, not once per row. The
-- boolean and the set are projections of the same resolver, so on an EXISTING
-- app id a converted table and an unconverted one cannot disagree. They
-- intentionally diverge only on an id the set can never contain: a prospective
-- id (the app table's own INSERT WITH CHECK, evaluating a row that does not
-- exist yet) or a NULL app_id. On those the boolean's org-level fallback grants
-- and the set (IN) does not. The app table keeps the boolean form for the
-- prospective-id case; child tables must forbid a NULL app_id (NOT NULL) so no
-- row can hide behind the diverging NULL case.
CREATE OR REPLACE FUNCTION private.authorized_app_ids(requested_permission app_permission)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Membership-derived tenant set — for the headerless Realtime paths.
-- -----------------------------------------------------------------------------
-- Every tenant the caller is currently an active, non-disabled member of — the
-- same domain predicate `private.authorize` uses. Realtime evaluates policies
-- with no request headers, so the notification / context_sync_event policies
-- derive their scope from membership alone; it deliberately answers for the
-- caller's whole membership set, and the client narrows to the org on screen.
CREATE OR REPLACE FUNCTION private.member_tenant_ids()
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
    SELECT m.tenant_id
    FROM public.membership m
    WHERE m.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role <> 'disabled';
END;
$function$
;

-- -----------------------------------------------------------------------------
-- Membership-derived app set with a permission — the multi-tenant companion
-- to `authorized_app_ids`, for the same headerless Realtime paths.
-- -----------------------------------------------------------------------------
-- Every app across the caller's ENTIRE active membership set (not just the
-- request tenant) for which their effective permission set includes
-- requested_permission. Mirrors `effective_app_permissions`'s I3 precedence
-- per (membership, app) pair without depending on `public.tenant_id()`:
-- an owner's set is always their org-level set; a per-app `app_member_role`
-- row replaces (never adds to) the org-level set for that one app; an
-- app-scoped non-owner with no such row for an app is excluded from it
-- entirely. `get_org_permission_set` is already tenant-parameterized (it
-- never reads `tenant_id()`), which is what makes this safe to evaluate
-- across tenants in one query.
CREATE OR REPLACE FUNCTION private.member_app_ids(requested_permission app_permission)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Grants on the private bodies
-- -----------------------------------------------------------------------------
-- Postgres default-grants EXECUTE to PUBLIC on creation; a REVOKE from a named
-- role does NOT remove that PUBLIC grant, so revoke PUBLIC explicitly first.
--
-- RLS-reachable helpers: policies run as the querying role, so anon +
-- authenticated need EXECUTE back. (Mirrors the pre-move public grants; the
-- schema is unexposed, so this is not an API surface.)
REVOKE EXECUTE ON FUNCTION private.authorize(public.app_permission) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.authorize(public.app_permission) TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION private.app_authorize(public.app_permission, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.app_authorize(public.app_permission, uuid) TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION private.platform_authorize(public.platform_permission) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.platform_authorize(public.platform_permission) TO anon, authenticated, service_role;

-- Resolver + set inversion: keyed off the caller's own membership, reached via the
-- public INVOKER wrapper (get_current_user_app_permissions) and by RLS policies
-- (app_authorize / authorized_app_ids) as the querying role. Never anon-callable —
-- an anon has no membership, and these were never part of the anon surface.
REVOKE EXECUTE ON FUNCTION private.effective_app_permissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.effective_app_permissions(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION private.authorized_app_ids(public.app_permission) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.authorized_app_ids(public.app_permission) TO authenticated, service_role;

-- Reached by RLS policies as the querying role (notification, context_sync_event).
REVOKE EXECUTE ON FUNCTION private.member_tenant_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.member_tenant_ids() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION private.member_app_ids(public.app_permission) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.member_app_ids(public.app_permission) TO authenticated, service_role;

-- Internal-only helper: only ever called from the DEFINER bodies above (which run
-- as the owner), so no role needs direct EXECUTE.
REVOKE EXECUTE ON FUNCTION private.get_org_permission_set(uuid, public.app_role, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.get_org_permission_set(uuid, public.app_role, uuid) TO service_role;

-- Reached from public.tenant_id() (SECURITY INVOKER), which RLS evaluates as the
-- querying role, so anon + authenticated need EXECUTE. Unexposed schema, so no
-- RPC surface; an anon has no membership and always resolves to NULL.
REVOKE EXECUTE ON FUNCTION private.resolve_member_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.resolve_member_tenant(text) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Public SECURITY INVOKER wrappers (external PostgREST callers only)
-- -----------------------------------------------------------------------------
-- These exist solely so the gateway bearer check and dashboard permission hooks
-- can keep calling public.authorize / public.app_authorize /
-- public.get_current_user_app_permissions as the signed-in user. They run as the
-- INVOKER and immediately delegate to the private DEFINER body, so they are NOT
-- flagged by splinter (the rule requires prosecdef = true). In-database callers
-- (RLS policies, trigger/transaction function bodies) must call private.* directly.
CREATE OR REPLACE FUNCTION public.authorize(requested_permission app_permission)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.authorize(requested_permission);
$function$
;

CREATE OR REPLACE FUNCTION public.app_authorize(requested_permission app_permission, target_app_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.app_authorize(requested_permission, target_app_id);
$function$
;

-- Set-returning sibling of app_authorize: the dashboard gates UI off the full
-- effective set for one app in a single round-trip. Delegates to the resolver.
CREATE OR REPLACE FUNCTION public.get_current_user_app_permissions(target_app_id uuid)
 RETURNS SETOF public.app_permission
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT * FROM private.effective_app_permissions(target_app_id);
$function$
;

-- Wrapper grants mirror the pre-move external contract exactly.
REVOKE EXECUTE ON FUNCTION public.authorize(public.app_permission) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.authorize(public.app_permission) TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.app_authorize(public.app_permission, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_authorize(public.app_permission, uuid) TO anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_current_user_app_permissions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_app_permissions(uuid) TO authenticated, service_role;
