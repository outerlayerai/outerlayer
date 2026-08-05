-- =============================================================================
-- Core Functions Schema
-- =============================================================================
-- Purpose: Core utility functions used throughout the application
-- Dependencies: 00-extensions.sql, 01-types.sql
-- Note: Function bodies must match exact database format for declarative schema
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenant Context Functions
-- -----------------------------------------------------------------------------

-- The current request's tenant. Dual-source, header-precedence with claim
-- fallback. BOTH sources are validated against live membership for an
-- `authenticated` caller:
--   * X-Tenant-Id present → the header tenant, but ONLY if the caller is an
--     active member of it (private.resolve_member_tenant validates). A malformed
--     or non-member header fails closed to NULL and never falls back to the
--     claim, so a spoofed header yields empty result sets rather than free
--     cross-tenant access.
--   * No X-Tenant-Id header → the claim tenant (app_metadata.tenant_id), put
--     through the SAME membership validation.
--
-- Why the claim arm is validated too: `app_metadata.tenant_id` is minted into
-- the JWT at sign-in and is not revoked when a membership ends. Ending a
-- membership deletes the `membership` row but leaves the claim in place, and a
-- plain refresh-token grant re-mints a token still carrying it — so the claim
-- on its own says nothing about the caller's present authority.
--
-- Validating here rather than per-policy is also what covers Realtime and
-- Storage: request.headers is set by PostgREST only, so those transports ALWAYS
-- take this arm and no per-policy predicate can reach them.
--
-- Scoped to `authenticated` on purpose. The `gateway` role's JWT is minted by
-- the gateway itself with `sub` = a system user that has no membership row, so
-- validating its claim would resolve every gateway request to NULL and take the
-- whole ingest path down; its tenant isolation rests on the gateway putting the
-- correct tenantId into a 60-second token. service_role likewise bypasses this.
-- Any other role (or a request with no claims at all, e.g. a direct psql
-- session) keeps the raw claim.
--
-- The CASE is lazy, so headerless traffic never evaluates the header branch.
-- This function carries a SET clause, so it is never SQL-inlined; the cost is
-- once-per-statement only where a policy wraps it as (SELECT public.tenant_id()),
-- which the planner hoists to an InitPlan — a bare call evaluates per row.
CREATE OR REPLACE FUNCTION public.tenant_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Claims Management Functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_claims_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_claim(uid uuid, claim text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    declare retval jsonb;
    begin
      if not is_claims_admin() then
          return '{"error":"access denied"}'::jsonb;
      else
        select coalesce(raw_app_meta_data->claim, null) from auth.users into retval where id = uid::uuid;
        return retval;
      end if;
    end;
$function$
;

CREATE OR REPLACE FUNCTION public.set_claim(uid uuid, claim text, value jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Trigger Functions for Audit Columns
-- -----------------------------------------------------------------------------
--
-- TENANT ISOLATION MODEL — read this before touching either
-- trigger below, or the matching gateway_tenant_*/authenticated RLS policies.
--
-- Tenant scoping on every tenant-scoped table is enforced by a PAIR of
-- mechanisms that are only safe together:
--
--   1. set_tenant_id() BEFORE INSERT — the PRIMARY control. For any
--      non-service caller it OVERWRITES new.tenant_id with public.tenant_id()
--      (the JWT-derived tenant). A caller-supplied tenant_id is silently
--      discarded — no error is raised. Forgery is prevented by CONSTRUCTION,
--      not by rejection: a forged row lands under the CALLER's tenant, never
--      the attacker-named target.
--
--   2. RLS WITH CHECK (tenant_id = public.tenant_id()) — DEFENSE IN DEPTH.
--      Because the trigger already forced tenant_id to the JWT value, this
--      check passes trivially on the happy path, so it looks redundant. It is
--      not: it is the backstop if the trigger is ever dropped, disabled, or
--      bypassed. DO NOT delete a *_insert WITH CHECK policy because the
--      trigger "already handles it" — that collapses two layers into one.
--
-- Consequence for callers (gateway routes, headless agents, dashboard): NEVER
-- send tenant_id in a write body expecting it to be honored — it is derived
-- from the JWT. A request that sets tenant_id = X and reads back tenant_id = Y
-- is not a bug; it is this trigger doing its job. The gateway Create*Body
-- schemas omit tenant_id for exactly this reason.
--
-- set_updated_columns() applies the same shape to the audit column updated_by
-- (forced to auth.uid() for regular users; preserved as-is for service_role
-- and gateway). created_by follows suit via the column DEFAULT auth.uid().
-- (A gateway JWT's `sub` is the provisioned gateway system user — a real
-- profile.id; see apps/gateway/src/lib/jwt.ts. The set_updated_columns body
-- comment below predates that and still describes `sub` as the tenant_id.)
--
-- Why the two triggers read the caller's role differently:
--   - set_updated_columns() is SECURITY DEFINER, so it runs as the function
--     owner and may freely call auth.role()/auth.uid() (it has USAGE on the
--     auth schema).
--   - set_tenant_id() is NOT SECURITY DEFINER — it runs as the caller. The
--     `gateway` Postgres role has no USAGE on the auth schema, so calling
--     auth.role() there raises `permission denied for schema auth` and blocks
--     every gateway INSERT. It reads request.jwt.claim.role via current_setting
--     instead — no auth-schema access required, same value.
--
-- Coverage: forgery resistance is asserted end-to-end in
-- apps/integration-tests/src/tests/gateway-rls-matrix.test.ts for `app` and the
-- other gateway-writable table carrying this trigger (api_key).
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- set_updated_at_only(): the updated_at half, for tables with no updated_by.
--
-- set_updated_columns() assigns NEW.updated_by, which raises
-- `record "new" has no field "updated_by"` on a table that lacks the column.
-- Machine-written tables (worker runs, platform incidents) track when a row
-- changed but have no human actor to record, so they take this instead.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.set_updated_at_only() IS
  'Stamps updated_at. For tables that track modification time but carry no updated_by column.';

CREATE OR REPLACE FUNCTION public.set_updated_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- set_created_columns(): the INSERT-time counterpart to set_updated_columns
-- above. It stamps created_by for human writes and, for machine (gateway) and
-- service_role writes, preserves whatever the handler passed (NULL when unset).
-- Do NOT reintroduce a per-table `created_by UUID DEFAULT auth.uid()` default:
-- auth.uid() resolves to the tenant_id `sub` for gateway JWTs, which trips the
-- *_created_by_fkey FK (code 23503). With this trigger a machine write is
-- correct even if a handler forgets to pass created_by, so inserts need no
-- per-tenant gateway system user.
--
-- SECURITY DEFINER so auth.role() is readable even though the `gateway`
-- Postgres role lacks USAGE on the auth schema (same reasoning as
-- set_updated_columns).
CREATE OR REPLACE FUNCTION public.set_created_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- set_tenant_id(): the primitive that enforces tenant isolation. See the
-- TENANT ISOLATION MODEL block above (before set_updated_columns) for the
-- trigger + RLS pairing, why a forged tenant_id is silently corrected rather
-- than rejected, and why this function reads the role via current_setting
-- instead of auth.role().
CREATE OR REPLACE FUNCTION public.set_tenant_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Custom Access Token Hook
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- Grant hook access to supabase_auth_admin
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon;

-- -----------------------------------------------------------------------------
-- Downgrade Protection: Nullify Custom Role Assignments on Tier Change
-- -----------------------------------------------------------------------------

-- A billing write that rewrites authorization for a whole organization.
--
-- Updating tier_id changes what every member of the tenant may do. It deletes
-- rows rather than setting a disabled flag. No foreign key expresses that
-- coupling, so this comment is the only warning you get.
--
-- Fires AFTER UPDATE OF tier_id ON billing. One downgrade acts:
--
-- 1. Losing custom_roles (team/enterprise to hobby/growth).
--    Every membership in the tenant gets custom_role_id = NULL. Anyone whose
--    permissions came from a custom role drops to their built-in role. The
--    custom_role rows survive. The four custom_role.* permissions are deleted
--    from each of them, since those gate the custom-roles settings UI.
--
-- Permissions that no entitlement gates are untouched.
--
-- Nothing restores any of this. There is no inverse branch, because re-granting
-- would have to guess what a role held before and those rows are gone. A tenant
-- that downgrades then upgrades comes back with its custom roles stripped and
-- every custom_role_id still NULL. Support sees "our roles disappeared". Check
-- the tier history before hunting for a bug.
--
-- Making it reversible means recording what was suppressed, or filtering by
-- entitlement when permissions resolve. Both change the authz path.
CREATE OR REPLACE FUNCTION public.nullify_custom_role_on_downgrade()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;
