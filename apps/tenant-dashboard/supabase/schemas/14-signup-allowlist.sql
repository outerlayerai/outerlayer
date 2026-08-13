-- =============================================================================
-- Signup Domain Allowlist
-- =============================================================================
-- Purpose: GoTrue-level gate on new-user creation via the Before User Created
--          auth hook (`before_user_created_hook`)
-- Dependencies: none
-- =============================================================================
--
-- The gate has two independent halves, and both are required for it to act:
--
--   1. The hook must be ACTIVATED in the project's auth configuration —
--      locally via `[auth.hook.before_user_created]` in supabase/config.toml,
--      on a hosted project via Dashboard → Authentication → Hooks →
--      "Before User Created" → Postgres function
--      `public.before_user_created_hook`. Hosted activation is per-project
--      auth config, not part of what migrations deploy.
--
--   2. This table must contain at least one row. An EMPTY allowlist means the
--      gate is OFF and every signup passes. This is deliberate: the same
--      schema deploys to every environment, so which environments actually
--      gate signups is data, not schema — an environment with no rows behaves
--      exactly as if the hook were never installed, even if the hook is
--      accidentally activated there.
--
-- While the gate is active (non-empty allowlist), ONLY email signups whose
-- domain matches a row are accepted; signups without an email address
-- (phone, anonymous) are refused, since a domain allowlist cannot vouch for
-- them. The GoTrue admin create-user endpoint is not routed through the hook,
-- so direct operator provisioning (Supabase dashboard "Create new user")
-- always works; the admin INVITE endpoint IS routed through it, so invites —
-- including scripts/ops/provision-staging-user.mjs / the "Provision Staging
-- User" workflow — are limited to allowlisted domains while the gate is
-- active.
--
-- The allowlist is a DOMAIN check, not proof of mailbox ownership. It only
-- authenticates signups when the environment also verifies the mailbox:
-- email confirmations enabled, or email signups disabled in favor of OAuth
-- providers (which verify addresses themselves). With confirmations off,
-- anyone can claim an allowlisted address and receive a session immediately.
--
-- Corollary for seeded test domains: a non-routable domain row (e.g. the e2e
-- suite's test.example.com) is safe exactly as long as confirmations stay
-- enabled — such signups can never confirm, so they never yield a session.
-- Disabling confirmations while a test domain is seeded reopens
-- unauthenticated signup through that domain.

-- -----------------------------------------------------------------------------
-- Signup Domain Allowlist Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.signup_domain_allowlist (
    -- Bare domain, no leading '@'. Stored lowercased/trimmed so the hook can
    -- compare with a plain equality against the lowercased signup domain.
    domain TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT signup_domain_allowlist_domain_normalized
        CHECK (domain = lower(btrim(domain)) AND domain <> '' AND domain NOT LIKE '@%')
);

COMMENT ON TABLE public.signup_domain_allowlist IS 'Email domains allowed to sign up while the before-user-created auth hook is active; empty table disables the gate';

ALTER TABLE public.signup_domain_allowlist ENABLE ROW LEVEL SECURITY;

-- Managed by operators only (SQL editor / service-role scripts). No
-- anon/authenticated policy on purpose: the allowlist is not client-readable.
CREATE POLICY "service_role_all" ON "public"."signup_domain_allowlist" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- The hook runs as supabase_auth_admin; SELECT is all it needs.
grant select on table "public"."signup_domain_allowlist" to "supabase_auth_admin";

-- -----------------------------------------------------------------------------
-- Before User Created Hook
-- -----------------------------------------------------------------------------

-- Contract (GoTrue postgres hooks): return '{}' to let the signup proceed;
-- return {"error": {"http_code": ..., "message": ...}} to reject it — GoTrue
-- surfaces the message to the caller with that status. Raising an exception
-- instead would surface as a 500, so rejection is always via the error object.
CREATE OR REPLACE FUNCTION public.before_user_created_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  signup_domain text;
begin
  -- Empty allowlist = gate off. See the file header: which environments gate
  -- signups is data, so an unseeded environment must behave as ungated.
  if not exists (select 1 from public.signup_domain_allowlist) then
    return '{}'::jsonb;
  end if;

  signup_domain := lower(split_part(coalesce(event->'user'->>'email', ''), '@', 2));

  if signup_domain <> '' and exists (
    select 1 from public.signup_domain_allowlist
    where domain = signup_domain
  ) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Signups on this environment are restricted to approved email domains.'
    )
  );
end;
$function$;

GRANT EXECUTE ON FUNCTION public.before_user_created_hook TO supabase_auth_admin;
