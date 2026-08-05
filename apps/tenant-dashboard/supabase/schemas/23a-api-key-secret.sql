-- =============================================================================
-- API Key Secret Store (private schema)
-- =============================================================================
-- Purpose: Hold the per-key HMAC digest that the gateway verifies against, plus
--   the two SECURITY DEFINER RPCs that read/write it. The digest lives in the
--   `private` schema (absent from config.toml [api].schemas → no PostgREST
--   surface) because public.api_key GRANTs ALL to authenticated — a signed-in
--   user must never be able to read key hashes.
--
-- Crypto: key = 'sk_outerlayer_' + base64url(32 CSPRNG bytes); the stored digest
--   is hex HMAC-SHA256(rawKey, API_KEY_PEPPER) computed in the app layer (Web
--   Crypto). The pepper is an env secret, never in the DB. Deterministic digest
--   → UNIQUE index → O(1) lookup; 256-bit entropy → no per-key salt.
--
-- Revocation = row deletion (ON DELETE CASCADE from public.api_key; there is no
--   is_active state).
--
-- Dependencies: 01a-private-authz.sql (private schema), 23-api-key.sql
-- Note: Bodies must match exact database format for declarative schema diffing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Secret Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS private.api_key_secret (
    api_key_id UUID PRIMARY KEY REFERENCES public.api_key(id) ON DELETE CASCADE,
    key_digest TEXT NOT NULL,
    -- Which pepper minted this digest. Ships day one so a future graceful
    -- dual-pepper rotation is code-only; today every row is 1.
    pepper_version SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT uc_api_key_secret_digest UNIQUE (key_digest)
);

COMMENT ON TABLE private.api_key_secret IS 'HMAC digests for public.api_key rows — private schema, no PostgREST surface, access only via DEFINER RPCs';

-- RLS on with NO policies and NO grants: the table is reachable ONLY through the
-- SECURITY DEFINER functions below (owned by the schema owner). Even service_role
-- (which has bypassrls) holds no table-level grant, so it cannot read digests
-- directly.
ALTER TABLE private.api_key_secret ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- verify_api_key — the gateway's hot path
-- -----------------------------------------------------------------------------
-- One round-trip: given a key digest, return the full UserMeta payload the
-- gateway expects (or NULL if no live key matches). Joins api_key/app/billing
-- and LATERAL-joins the first git_branch. jsonb_strip_nulls drops absent
-- optional fields so the app-layer Zod schema (which treats them as
-- `.optional()`, not nullable) parses cleanly.
CREATE OR REPLACE FUNCTION private.verify_api_key(p_key_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

-- -----------------------------------------------------------------------------
-- set_api_key_secret — mint / rotate a key's digest
-- -----------------------------------------------------------------------------
-- Upsert keyed on api_key_id. On a fresh mint the row is new (the api_key row's
-- id is fresh); ON CONFLICT keeps it idempotent for callers that re-set.
CREATE OR REPLACE FUNCTION private.set_api_key_secret(p_api_key_id uuid, p_key_digest text, p_pepper_version smallint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO private.api_key_secret (api_key_id, key_digest, pepper_version)
  VALUES (p_api_key_id, p_key_digest, p_pepper_version)
  ON CONFLICT (api_key_id) DO UPDATE
    SET key_digest = EXCLUDED.key_digest,
        pepper_version = EXCLUDED.pepper_version;
END;
$function$
;

-- -----------------------------------------------------------------------------
-- Public SECURITY INVOKER wrappers (service_role over PostgREST)
-- -----------------------------------------------------------------------------
-- The gateway calls these as service_role via the admin Supabase client. They
-- run as INVOKER and delegate to the private DEFINER bodies (owned by the schema
-- owner, which can read private.api_key_secret). Mirrors the 01a-private-authz
-- idiom: DEFINER bodies in `private`, thin INVOKER wrappers in `public`.
CREATE OR REPLACE FUNCTION public.verify_api_key(p_key_digest text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.verify_api_key(p_key_digest);
$function$
;

CREATE OR REPLACE FUNCTION public.set_api_key_secret(p_api_key_id uuid, p_key_digest text, p_pepper_version smallint)
 RETURNS void
 LANGUAGE sql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.set_api_key_secret(p_api_key_id, p_key_digest, p_pepper_version);
$function$
;

-- -----------------------------------------------------------------------------
-- Grants on the four functions
-- -----------------------------------------------------------------------------
-- Postgres default-grants EXECUTE to PUBLIC on creation; a REVOKE from a named
-- role does NOT remove that PUBLIC grant, so revoke PUBLIC explicitly first.
-- Only service_role (the gateway admin client) ever calls these — anon and
-- authenticated must never verify or set key digests.
REVOKE EXECUTE ON FUNCTION private.verify_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.verify_api_key(text) TO service_role;

REVOKE EXECUTE ON FUNCTION private.set_api_key_secret(uuid, text, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.set_api_key_secret(uuid, text, smallint) TO service_role;

REVOKE EXECUTE ON FUNCTION public.verify_api_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_api_key(text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.set_api_key_secret(uuid, text, smallint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_api_key_secret(uuid, text, smallint) TO service_role;
