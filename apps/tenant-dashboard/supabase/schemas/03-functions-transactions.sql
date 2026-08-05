-- =============================================================================
-- Transaction Functions Schema
-- =============================================================================
-- Purpose: Complex transactional functions for business operations
-- Dependencies: 02-functions-core.sql, all table schemas
-- Note: Function bodies must match exact database format for declarative schema
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Password Management
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.change_user_password(current_plain_password character varying, new_plain_password character varying)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Organization Management Functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_organization_transaction(p_user_id uuid, p_organization_name text, p_company_name text, p_stripe_customer_id character varying DEFAULT NULL::character varying, p_tier_id text DEFAULT 'hobby'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$
;

CREATE OR REPLACE FUNCTION public.platform_admin_delete_tenant(p_tenant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Set compensation mode flag to bypass protect_last_owner trigger
  -- This allows cascading deletes of user_role records without blocking
  PERFORM set_config('app.compensating', 'true', true);

  -- Delete the tenant - cascades to all related tables including:
  -- user_role, membership, app, api_key, billing, git_connection, etc.
  DELETE FROM tenant WHERE tenant_id = p_tenant_id;

  -- Flag is automatically cleared when transaction ends (third param = true means local)
END $function$
;

-- -----------------------------------------------------------------------------
-- Invitation Functions
-- -----------------------------------------------------------------------------

-- Audit rows are written INSIDE the invitation transactions so the membership
-- change and its audit entry commit or roll back together, keeping the
-- membership lifecycle atomic with its trail. Request context params default
-- to NULL so callers that omit them keep working.
CREATE OR REPLACE FUNCTION public.invite_existing_user_transaction(p_user_id uuid, p_tenant_id uuid, p_invited_by uuid, p_role character varying, p_invited_at timestamp with time zone, p_expires_at timestamp with time zone, p_ip_address inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.invite_new_user_transaction(p_user_id uuid, p_tenant_id uuid, p_invited_by uuid, p_email citext, p_name text, p_role character varying, p_invited_at timestamp with time zone, p_expires_at timestamp with time zone, p_ip_address inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- Atomic role change: pre-image read, mutation, and audit row commit or roll
-- back together. The actor's authority (holds membership.update, is not
-- self-targeting, and is an owner if minting one) is enforced here, not just
-- in the service layer — this function runs SECURITY DEFINER under
-- service_role, which has no session for RLS to gate. Assigning a custom role
-- sets custom_role_id AND pins role to the 'read' built-in fallback (custom
-- active ⇔ custom_role_id IS NOT NULL; role is only consulted once the custom
-- role is cleared). Otherwise the explicit built-in role is applied and any
-- custom role is cleared.
CREATE OR REPLACE FUNCTION public.change_member_role_transaction(p_tenant_id uuid, p_target_user_id uuid, p_actor_id uuid, p_new_role character varying DEFAULT NULL::character varying, p_custom_role_id uuid DEFAULT NULL::uuid, p_ip_address inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- Atomic member removal: pre-image read, delete, and audit row commit or roll
-- back together. Last-owner protection stays in the service layer.
CREATE OR REPLACE FUNCTION public.remove_member_transaction(p_tenant_id uuid, p_target_user_id uuid, p_actor_id uuid, p_ip_address inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Temporary Access Functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cleanup_expired_temp_access()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.grant_temp_access_transaction(p_admin_user_id uuid, p_tenant_id uuid, p_reason text, p_customer_permission_confirmed boolean, p_expires_at timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Vault/Secrets Functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.insert_secret(name text, secret text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if current_setting('role') != 'service_role' then
    raise exception 'authentication required';
  end if;

  return vault.create_secret(secret, name);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.read_secret(secret_name text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.delete_secret(secret_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if current_setting('role') != 'service_role' then
    raise exception 'authentication required';
  end if;

  delete from vault.decrypted_secrets where name = secret_name;
end;
$function$
;

-- update_secret replaces a secret's value in place under its existing name,
-- so a value replacement never has a window where the old and new values are
-- both absent (unlike a delete-then-insert pair against a deterministic
-- name, which cannot hold two values under the same name at once). Returns
-- false rather than raising when no secret exists under that name yet, so a
-- caller with a legitimate reason to fall back to a plain insert (a
-- migration-window row whose live secret is still under a legacy name) can
-- do so without treating "not found" as a hard failure.
CREATE OR REPLACE FUNCTION public.update_secret(secret_name text, secret text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- Profile Functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_profile_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

-- Sync email changes from auth.users to public.profile
-- Triggered AFTER UPDATE on auth.users so profile email stays in sync
CREATE OR REPLACE FUNCTION public.sync_auth_email_to_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profile
    SET email = NEW.email
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$
;

-- -----------------------------------------------------------------------------
-- Membership Trigger Functions
-- -----------------------------------------------------------------------------

-- Caps how many organizations one user may belong to at 10 active memberships.
-- This is a per-user bound, not a per-tenant seat allowance: it reads no billing
-- tier and no plan entitlement, and the same 10 applies to every tenant.
--
-- The count takes no row lock, so two concurrent inserts can each observe 9 and
-- both commit. It bounds accidental fan-out; it is not a hard guarantee. The
-- service layer pre-checks the same limit before writing, and this backstops the
-- window between that read and the insert.
CREATE OR REPLACE FUNCTION public.check_membership_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.protect_last_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.prevent_membership_tenant_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
    IF OLD.tenant_id != NEW.tenant_id THEN
        RAISE EXCEPTION 'Cannot change tenant_id of membership record';
    END IF;
    RETURN NEW;
END;
$function$
;

-- No self-grant of a per-app role. `app_member_role.insert` sits in the admin
-- set, and a policy cannot express "not your own row", so a trigger is what
-- keeps an app-scoped admin from widening their own scope. Mirrors
-- prevent_membership_self_privilege_change below: the trigger, not the policy,
-- is what stops a caller editing their own authority.
--
-- Gated on auth.role() = 'authenticated' so the service-role paths that
-- legitimately provision app roles during invite acceptance are unaffected.
CREATE OR REPLACE FUNCTION public.prevent_app_member_role_self_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

-- No direct EXECUTE: this only ever runs as the trigger's function-call
-- context, and an authenticated/anon grant would let a client invoke it
-- standalone with an arbitrary NEW row shape outside a trigger context.
REVOKE EXECUTE ON FUNCTION public.prevent_app_member_role_self_grant() FROM PUBLIC, anon, authenticated;


-- Column guard for the self-service "Users can accept invitations" UPDATE
-- policy (12-rbac.sql). That policy lets a member UPDATE their OWN membership
-- row, but RLS is row-level and cannot restrict WHICH columns change. The one
-- legitimate purpose is accepting an invite (status pending -> active, stamp
-- accepted_at), so this guard is what confines the update to those columns —
-- `role` above all, since custom_access_token_hook stamps user_role into the
-- JWT on the next refresh and protect_last_owner only fires when
-- OLD.role='owner', leaving promotion TO owner otherwise unguarded.
--
-- Every legitimate membership mutation (invite, role change via
-- change_member_role_transaction, app-scoping, and the app's own invite
-- acceptance) runs through the service-role client or a SECURITY DEFINER RPC,
-- where current_user is 'service_role' or the function owner. The only caller
-- that reaches the enforced branch is a direct interactive PostgREST update
-- running as the 'authenticated' DB role, for which we permit only the
-- invitation-acceptance columns to change.
--
-- current_user (NOT auth.role()) is the discriminator on purpose: auth.role()
-- reads the JWT 'role' claim, which stays 'authenticated' INSIDE a SECURITY
-- DEFINER role-change RPC and would wrongly trip this guard; current_user
-- reflects the post-definer privilege context and is 'authenticated' only for
-- genuine direct calls. SECURITY INVOKER (the default) is required so
-- current_user is the caller's role, not this function's owner.
CREATE OR REPLACE FUNCTION public.prevent_membership_self_privilege_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- App Publish Policy Guard
-- -----------------------------------------------------------------------------

-- Enforce the dedicated `app_policy.update` permission on app-level publish
-- policy columns. RLS is row-level and cannot single out one column, so the
-- `app` table's `app.update` policy still governs every other column while this
-- trigger guards the policy fields: a caller who can edit the app (`app.update`)
-- still cannot flip `require_pull_request` without `app_policy.update`.
--
-- Only enforced for interactive (`authenticated`) callers. service_role and
-- migration/seed paths bypass RLS entirely and must remain able to backfill the
-- column, so they are not subject to the permission check.
CREATE OR REPLACE FUNCTION public.enforce_app_policy_permission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
$function$
;
