-- =============================================================================
-- Admin API Key Secret Store (private schema)
-- =============================================================================
-- Purpose: Hold the per-key HMAC digest that withApi's bearer branch verifies
--   against, plus the two SECURITY DEFINER RPCs that read/write it. Mirrors
--   23a-api-key-secret.sql's split exactly — the digest lives in `private`
--   (absent from config.toml [api].schemas, so no PostgREST surface) because
--   public.admin_api_key GRANTs ALL to authenticated, and a signed-in user
--   must never be able to read key hashes.
--
-- Crypto: key = 'olk_' + base64url(32 CSPRNG bytes); the stored digest is hex
--   HMAC-SHA256(rawKey, ADMIN_API_KEY_PEPPER) computed in the app layer (Web
--   Crypto), same construction as @repo/api-key-service's hashApiKey.
--
-- Revocation: admin_api_key.revoked_at is set (not row deletion), so a
--   revoked key's audit trail survives — verify_admin_api_key gates on it.
--
-- Dependencies: 01a-private-authz.sql (private schema), 24-admin-api-key.sql
-- Note: Bodies must match exact database format for declarative schema diffing.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Secret Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS private.admin_api_key_secret (
    admin_api_key_id UUID PRIMARY KEY REFERENCES public.admin_api_key(id) ON DELETE CASCADE,
    key_digest TEXT NOT NULL,
    pepper_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(),

    CONSTRAINT uc_admin_api_key_secret_digest UNIQUE (key_digest)
);

COMMENT ON TABLE private.admin_api_key_secret IS 'HMAC digests for public.admin_api_key rows — private schema, no PostgREST surface, access only via DEFINER RPCs';

-- RLS on with NO policies and NO grants: reachable ONLY through the
-- SECURITY DEFINER functions below (owned by the schema owner). Even
-- service_role (bypassrls) holds no table-level grant, so it cannot read
-- digests directly.
ALTER TABLE private.admin_api_key_secret ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- verify_admin_api_key — the bearer-auth hot path (withApi's app-scoped
-- branch and the org-scoped `loadBearerServiceContext` seam both call it)
-- -----------------------------------------------------------------------------
-- One round-trip: given a key digest, return the tenant, permission set, and
-- creator the key resolves to (or NULL if no live, unrevoked, unexpired key
-- matches). `createdBy` lets a caller re-resolve the creator's CURRENT role
-- at request time — an admin API key acts as its creator, never a cached
-- mint-time grant, so a demoted or removed creator narrows or revokes the
-- key's practical authority automatically.
CREATE OR REPLACE FUNCTION private.verify_admin_api_key(p_key_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'adminApiKeyId', k.id,
    'tenantId', k.tenant_id,
    'permissions', COALESCE(to_jsonb(k.permissions), '[]'::jsonb),
    'createdBy', k.created_by
  ))
  INTO v_result
  FROM public.admin_api_key k
  JOIN private.admin_api_key_secret s ON s.admin_api_key_id = k.id
  WHERE s.key_digest = p_key_digest
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now());

  RETURN v_result;
END;
$function$
;

-- -----------------------------------------------------------------------------
-- touch_admin_api_key_last_used — bearer-path bookkeeping
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.touch_admin_api_key_last_used(p_admin_api_key_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.admin_api_key SET last_used_at = now() WHERE id = p_admin_api_key_id;
$function$
;

-- -----------------------------------------------------------------------------
-- set_admin_api_key_secret — mint a key's digest
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.set_admin_api_key_secret(p_admin_api_key_id uuid, p_key_digest text, p_pepper_version bigint)
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
$function$
;

-- -----------------------------------------------------------------------------
-- Public SECURITY INVOKER wrappers (service_role over PostgREST)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_admin_api_key(p_key_digest text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.verify_admin_api_key(p_key_digest);
$function$
;

CREATE OR REPLACE FUNCTION public.touch_admin_api_key_last_used(p_admin_api_key_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.touch_admin_api_key_last_used(p_admin_api_key_id);
$function$
;

CREATE OR REPLACE FUNCTION public.set_admin_api_key_secret(p_admin_api_key_id uuid, p_key_digest text, p_pepper_version bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  SELECT private.set_admin_api_key_secret(p_admin_api_key_id, p_key_digest, p_pepper_version);
$function$
;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
-- Only service_role (the withApi bearer-auth path, via the admin client) ever
-- calls these — anon and authenticated must never verify or set key digests.
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
