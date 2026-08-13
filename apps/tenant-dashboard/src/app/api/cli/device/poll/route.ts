/**
 * CLI Device Login — Poll
 *
 * POST /api/cli/device/poll
 *
 * Unauthenticated: the caller identifies itself only by the device_code it
 * was handed at /start. Contract:
 * - Auth: none
 * - Body: { device_code }
 * - Response 200: { status: "pending" } | { status: "denied" } |
 *   { status: "expired" } | { status: "approved", key, app_id, base_url,
 *   org_name, app_name }
 * - Response 402: { error: "entitlement_denied", message } — the approved
 *   code was consumed but the tenant is at its API-key limit; the code
 *   cannot be reused (see consumeApprovedDeviceAuthRequest), so the CLI must
 *   report this as a fatal login failure rather than keep polling.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  consumeApprovedDeviceAuthRequest,
  findRequestByDeviceCode,
  type DeviceAuthRequestRow,
} from "@/lib/system/device-auth";
import { mintDeviceAuthApiKey } from "@/lib/system/mint-device-auth-key";
import { checkApiKeyLimit, buildDeniedInfo } from "@/lib/system/api-key-limit";
import { API_URL } from "@/config-global";
import { serverLogger } from "@/lib/observability/server-logger";

const PollDeviceAuthSchema = z.object({
  device_code: z.string().min(1, "device_code is required"),
});

/**
 * The read-only status a NON-winning poll reports. Not found and genuinely
 * expired collapse to the same "expired" the caller sees — the /poll
 * endpoint must not let an attacker distinguish "no such code ever existed"
 * from "that code existed but timed out" (enumeration safety: a bare
 * device_code, unlike a user_code, is never entered by a human, but the
 * contract holds regardless of who calls it).
 */
function statusFor(row: DeviceAuthRequestRow | null): "pending" | "denied" | "expired" {
  if (!row) return "expired";
  if (new Date(row.expires_at).getTime() <= Date.now()) return "expired";
  if (row.status === "denied") return "denied";
  if (row.status === "consumed") return "expired";
  if (row.status === "pending") return "pending";
  // status === 'approved' but this call did not win the atomic consume —
  // only reachable via a race with another poll for the same code (see
  // consumeApprovedDeviceAuthRequest's docstring); telling the caller to
  // keep polling is correct and loses nothing, the winning poll already
  // delivered the key to whichever caller made it.
  return "pending";
}

export async function POST(request: Request) {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = PollDeviceAuthSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
        { status: 400 },
      );
    }
    const { device_code: deviceCode } = parsed.data;

    // The ONLY path that may mint: a non-null return here is this specific
    // call's, and only this call's, permission to proceed.
    const consumed = await consumeApprovedDeviceAuthRequest(deviceCode);
    if (!consumed) {
      const row = await findRequestByDeviceCode(deviceCode);
      return NextResponse.json({ status: statusFor(row) });
    }

    const limitResult = await checkApiKeyLimit(consumed.tenant_id!);
    if (!limitResult.allowed) {
      return NextResponse.json(
        {
          error: "entitlement_denied",
          message: "API key limit reached",
          entitlement: buildDeniedInfo("max_api_keys", limitResult),
        },
        { status: 402 },
      );
    }

    const minted = await mintDeviceAuthApiKey(consumed);
    return NextResponse.json({
      status: "approved",
      key: minted.plaintext,
      app_id: consumed.app_id,
      base_url: API_URL,
      org_name: minted.orgName,
      app_name: minted.appName,
    });
  } catch (error) {
    await serverLogger.error(error as Error, {
      context: "[CLI API] POST /api/cli/device/poll failed",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
