import "server-only";

/**
 * Service-role data access for `public.device_auth_request` — the
 * `outerlayer login` device-code handshake. This table carries no RLS
 * policies (see supabase/schemas/24-device-auth.sql): its rows exist before
 * any tenant is known, so this module is the ONLY sanctioned access path,
 * exactly like `api-key-limit.ts` is for its service-role reads.
 *
 * `device_code` never appears in this file's return types as anything but a
 * function PARAMETER — every read/write keys off its HMAC digest
 * (`hashApiKey`, the same primitive and pepper `api_key` uses), so the
 * plaintext is never round-tripped through a database row, a log line, or an
 * audit `details` payload.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { hashApiKey } from "@repo/api-key-service";
import { API_KEY_PEPPER } from "@/config-global.server";
import type { Database } from "@/types/db";
import { getAdminDataClient } from "./admin-client";

/** 10 minutes — mirrors GIT_CONNECT_STATE_TTL_SECONDS' short-lived,
 * single-use state-token discipline. */
export const DEVICE_AUTH_TTL_SECONDS = 10 * 60;

/** Suggested CLI poll cadence, returned in the `/start` response. */
const DEVICE_AUTH_POLL_INTERVAL_SECONDS = 5;

/** Crockford base32 — excludes I, L, O, U to avoid transcription ambiguity
 * when a user reads the code off one screen and types it into another. */
const USER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type DeviceAuthRequestRow = Database["public"]["Tables"]["device_auth_request"]["Row"];

function db(): SupabaseClient<Database> {
  return getAdminDataClient();
}

/**
 * 8 Crockford-base32 characters, formatted `XXXX-XXXX`. The alphabet is
 * exactly 32 symbols (2^5): `byte % 32` on a uniformly random byte has zero
 * modulo bias (256 / 32 = 8 exactly), so no rejection sampling is needed.
 */
function generateUserCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += USER_CODE_ALPHABET[bytes[i]! % 32];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Unpadded base64url of 32 CSPRNG bytes — 256 bits of entropy, same budget
 * as an API key's secret segment (crypto.ts's DEFAULT_KEY_PREFIX sibling). */
function generateDeviceCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function digestDeviceCode(deviceCode: string): Promise<string> {
  return hashApiKey(deviceCode, API_KEY_PEPPER);
}

interface CreatedDeviceAuthRequest {
  deviceCode: string;
  userCode: string;
  expiresAt: string;
  ttlSeconds: number;
  pollIntervalSeconds: number;
}

/**
 * Creates a fresh pending request. `user_code`/`device_code_digest` are both
 * UNIQUE columns, so a collision (astronomically unlikely at these entropy
 * budgets — 40 bits and 256 bits respectively) surfaces as a thrown
 * PostgREST 23505 rather than silently overwriting another in-flight login;
 * callers do not retry, matching the same posture `mintApiKey` takes on its
 * own uniqueness constraint.
 */
export async function createDeviceAuthRequest(): Promise<CreatedDeviceAuthRequest> {
  const deviceCode = generateDeviceCode();
  const userCode = generateUserCode();
  const deviceCodeDigest = await digestDeviceCode(deviceCode);
  const expiresAt = new Date(Date.now() + DEVICE_AUTH_TTL_SECONDS * 1000).toISOString();

  const { error } = await db().from("device_auth_request").insert({
    user_code: userCode,
    device_code_digest: deviceCodeDigest,
    expires_at: expiresAt,
  });
  if (error) throw error;

  return {
    deviceCode,
    userCode,
    expiresAt,
    ttlSeconds: DEVICE_AUTH_TTL_SECONDS,
    pollIntervalSeconds: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
  };
}

/**
 * The pending row for a user-entered code, or null if it does not exist, has
 * already left `pending`, or has expired — the approval action treats all
 * three identically ("that code isn't waiting for you"), so this collapses
 * them rather than returning a reason.
 */
export async function findPendingRequestByUserCode(userCode: string): Promise<DeviceAuthRequestRow | null> {
  const { data } = await db()
    .from("device_auth_request")
    .select("*")
    .eq("user_code", userCode)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return data ?? null;
}

interface ApproveDeviceAuthRequestParams {
  id: string;
  tenantId: string;
  appId: string;
  environmentId: string | null;
  approverMembershipId: string;
}

/**
 * Atomic pending→approved transition: the UPDATE's own WHERE carries the
 * precondition (`status = 'pending' AND expires_at > now`), so a second
 * concurrent approval attempt, a denial that raced it, or an expiry that
 * landed in between all resolve to zero rows updated — this returns null
 * rather than a row, and the caller must treat that as "already resolved,"
 * never retry the write.
 */
export async function approveDeviceAuthRequest(
  params: ApproveDeviceAuthRequestParams,
): Promise<DeviceAuthRequestRow | null> {
  const { data, error } = await db()
    .from("device_auth_request")
    .update({
      status: "approved",
      tenant_id: params.tenantId,
      app_id: params.appId,
      environment_id: params.environmentId,
      approver_membership_id: params.approverMembershipId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("*");
  if (error) throw error;
  return data?.[0] ?? null;
}

/** Same single-use guarantee as {@link approveDeviceAuthRequest}, for the
 * denial branch of the same approval page. */
export async function denyDeviceAuthRequest(id: string): Promise<DeviceAuthRequestRow | null> {
  const { data, error } = await db()
    .from("device_auth_request")
    .update({ status: "denied" })
    .eq("id", id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("*");
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Read-only lookup by device code, for the poll route's non-minting
 * response branches (pending / denied / already-consumed / expired). Never
 * used to decide whether to mint — {@link consumeApprovedDeviceAuthRequest}
 * is the only function that may do that.
 */
export async function findRequestByDeviceCode(deviceCode: string): Promise<DeviceAuthRequestRow | null> {
  const digest = await digestDeviceCode(deviceCode);
  const { data } = await db().from("device_auth_request").select("*").eq("device_code_digest", digest).maybeSingle();
  return data ?? null;
}

/**
 * The single statement the entire "exactly one mint per approved code"
 * guarantee rests on. The UPDATE's WHERE clause carries the transition's own
 * precondition (`status = 'approved' AND consumed_at IS NULL AND expires_at
 * > now`); Postgres serializes concurrent UPDATEs to the same row, so of two
 * simultaneous polls for the same code, the first to commit flips the row
 * and gets it back, and the second's WHERE no longer matches — it gets back
 * null and MUST NOT mint. Callers may not use the return value's contents to
 * mint on behalf of any other invocation; only the caller that itself
 * received a non-null row may mint.
 */
export async function consumeApprovedDeviceAuthRequest(deviceCode: string): Promise<DeviceAuthRequestRow | null> {
  const digest = await digestDeviceCode(deviceCode);
  const { data, error } = await db()
    .from("device_auth_request")
    .update({ status: "consumed", consumed_at: new Date().toISOString() })
    .eq("device_code_digest", digest)
    .eq("status", "approved")
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("*");
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * `membership.user_id` for an approver, service-role (the poll route has no
 * live user session to attribute the `api_key_created` audit row to —
 * approval already happened in an earlier, separately-authenticated
 * request). Null on any lookup failure: a missing attribution is a smaller
 * problem than a thrown error turning a successful mint into a 500 for the
 * CLI.
 */
export async function resolveApproverUserId(membershipId: string): Promise<string | null> {
  try {
    const { data } = await db().from("membership").select("user_id").eq("id", membershipId).maybeSingle();
    return data?.user_id ?? null;
  } catch {
    return null;
  }
}
