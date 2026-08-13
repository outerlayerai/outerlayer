-- Adds `createdBy` to verify_management_api_key's result: the key's creator id,
-- so a caller can re-resolve the creator's CURRENT tenant role at request
-- time rather than trusting a mint-time grant.

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION private.verify_management_api_key(p_key_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'managementApiKeyId', k.id,
    'tenantId', k.tenant_id,
    'permissions', COALESCE(to_jsonb(k.permissions), '[]'::jsonb),
    'createdBy', k.created_by
  ))
  INTO v_result
  FROM public.management_api_key k
  JOIN private.management_api_key_secret s ON s.management_api_key_id = k.id
  WHERE s.key_digest = p_key_digest
    AND k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now());

  RETURN v_result;
END;
$function$
;
