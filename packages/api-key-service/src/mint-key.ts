import { generateApiKey, hashApiKey } from './crypto';

// Supabase client is typed as `any` deliberately — same rationale as
// create-key.ts: gateway and dashboard ship generic client shapes that don't
// assign cleanly between each other even though the runtime surface is
// identical. Runtime correctness is covered by integration tests in both
// consumers.
type AnySupabase = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/* eslint-disable import/no-unused-modules -- Public API types for DI and testing */

export interface MintApiKeyParams {
  /**
   * Client used to INSERT (and optionally DELETE) the public.api_key row. For
   * user-initiated keys this is the RLS-scoped client (the JWT carries the
   * tenant + drives the insert/delete policies); for machine keys it's the
   * service-role admin client. Its raw PostgREST error surfaces to the caller
   * so route handlers keep their 23505→409 mapping.
   */
  rowClient: AnySupabase;
  /**
   * Service-role client used for the `set_api_key_secret` RPC. The secret table
   * lives in the `private` schema with no grants, so only a DEFINER RPC invoked
   * by service_role can write the digest.
   */
  adminClient: AnySupabase;
  /** HMAC pepper (env secret). Empty → hashApiKey throws. */
  pepper: string;
  tenantId: string;
  appId: string;
  /** Display name. Unique per (name, app_id) — a collision surfaces as 23505. */
  name: string;
  environmentId?: string | null;
  allowedEnvKinds?: string[] | null;
  /** Gateway permission strings written to the enum[] column. */
  permissions: string[];
  /** ISO timestamp; NULL/undefined = never expires. */
  expiresAt?: string | null;
  isMachine?: boolean;
  /**
   * Developer-seat attribution (057 A6b). Membership id stamped onto agent
   * sessions ingested with this key (ActorId). NULL/undefined = shared key,
   * sessions attribute to the key itself.
   */
  actorMembershipId?: string | null;
  /**
   * Explicit created_by. Pass `null` for machine keys (no human author). Omit
   * entirely for user-initiated keys so the set_created_columns trigger stamps
   * auth.uid().
   */
  createdBy?: string | null;
  /**
   * When true, delete any existing key with the same (name, app_id) first —
   * doubles as rotation for fixed-name machine keys. The row's ON DELETE CASCADE
   * drops the old secret.
   */
  replaceExisting?: boolean;
  /** Plaintext prefix override (e.g. `sk_outerlayer_dev_`). */
  prefix?: string;
}

export interface MintApiKeyResult {
  /** Plaintext key — return to the user once, then drop. */
  plaintext: string;
  /** The inserted api_key row (id, api_key_id, key_prefix, permissions, …). */
  row: Record<string, unknown> & { id: string; api_key_id: string };
}

/**
 * Mint an API key: write the public.api_key row and its private digest.
 *
 * Ordering (chosen so a mid-flight failure never leaves a verifiable orphan):
 *   1. optional delete-by-(name, app_id) — rotation / replace
 *   2. generate plaintext + hash to a digest
 *   3. INSERT the row via rowClient (raw PostgREST error surfaces)
 *   4. set_api_key_secret via adminClient; on RPC failure, delete the row and
 *      rethrow — a visible never-verifying row is strictly better than an
 *      invisible orphan.
 *
 * Does NOT check entitlements — callers own that.
 */
export async function mintApiKey(params: MintApiKeyParams): Promise<MintApiKeyResult> {
  const {
    rowClient,
    adminClient,
    pepper,
    tenantId,
    appId,
    name,
    environmentId,
    allowedEnvKinds,
    permissions,
    expiresAt,
    isMachine,
    actorMembershipId,
    createdBy,
    replaceExisting,
    prefix,
  } = params;

  if (replaceExisting) {
    const { error: deleteError } = await rowClient
      .from('api_key')
      .delete()
      .eq('name', name)
      .eq('app_id', appId);
    if (deleteError) {
      throw deleteError;
    }
  }

  const { plaintext, keyPrefix, apiKeyId } = generateApiKey({ prefix });
  const keyDigest = await hashApiKey(plaintext, pepper);

  const insertPayload: Record<string, unknown> = {
    name,
    tenant_id: tenantId,
    api_key_id: apiKeyId,
    app_id: appId,
    environment_id: environmentId ?? null,
    allowed_env_kinds: allowedEnvKinds ?? null,
    permissions,
    key_prefix: keyPrefix,
    expires_at: expiresAt ?? null,
    is_machine: isMachine ?? false,
    actor_membership_id: actorMembershipId ?? null,
  };
  // Only set created_by when the caller is explicit (incl. null). Omitting it
  // lets the set_created_columns trigger stamp auth.uid() on user paths.
  if (createdBy !== undefined) {
    insertPayload.created_by = createdBy;
  }

  const { data: row, error: insertError } = await rowClient
    .from('api_key')
    .insert(insertPayload)
    .select()
    .single();
  if (insertError) {
    throw insertError;
  }

  const { error: rpcError } = await adminClient.rpc('set_api_key_secret', {
    p_api_key_id: row.id,
    p_key_digest: keyDigest,
    p_pepper_version: 1,
  });
  if (rpcError) {
    // Roll back the row so it can never be listed or (falsely) verified.
    await adminClient.from('api_key').delete().eq('id', row.id);
    throw rpcError;
  }

  return { plaintext, row };
}
