import "server-only";

/**
 * Mints the API key a consumed device_auth_request row is redeemed for. The
 * poll route has no live user session (the caller is the anonymous CLI
 * process, not the approver's browser) — authorization already happened at
 * approval time, in a separately-authenticated request — so every client
 * here is the service-role admin client, mirroring how
 * `resolveDefaultEnvironmentIdAsSystem`/`checkApiKeyLimit` run system-driven
 * operations with no request-scoped identity to borrow.
 */

import { mintApiKey } from "@repo/api-key-service";
import { API_KEY_PEPPER } from "@/config-global.server";
import { writeAuditLog } from "./audit-log";
import { resolveMemberDisplayNames } from "./resolve-member-display-names";
import { resolveApproverUserId, type DeviceAuthRequestRow } from "./device-auth";
import { getAdminDataClient } from "./admin-client";

/** 30 days — matches the existing OAuth dev-key mint surface's TTL. */
const DEVICE_AUTH_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface MintedDeviceAuthKey {
  plaintext: string;
  appName: string;
  orgName: string | null;
}

/**
 * `row` must be one already returned by `consumeApprovedDeviceAuthRequest` —
 * this function does not itself enforce single-use; that guarantee lives
 * entirely in the atomic UPDATE the caller already ran to get `row`.
 */
export async function mintDeviceAuthApiKey(row: DeviceAuthRequestRow): Promise<MintedDeviceAuthKey> {
  if (!row.tenant_id || !row.app_id) {
    // Cannot happen for a row that passed through the 'approved' state (the
    // approval transition always sets both alongside status), but the
    // columns are nullable at the type level, so this is the honest guard.
    throw new Error("device_auth_request row is missing tenant_id/app_id at mint time");
  }
  const db = getAdminDataClient();

  const expiresAt = new Date(Date.now() + DEVICE_AUTH_KEY_TTL_MS).toISOString();
  const { plaintext, row: keyRow } = await mintApiKey({
    rowClient: db,
    adminClient: db,
    pepper: API_KEY_PEPPER,
    tenantId: row.tenant_id,
    appId: row.app_id,
    // The device_auth_request row's own id is unique per request, so this
    // name can never collide with uc_api_key(name, app_id) — including
    // across repeated logins from the same device, which each create a
    // fresh row.
    name: `CLI Device Login - ${row.id}`,
    environmentId: row.environment_id,
    permissions: ["trace.write"],
    expiresAt,
    actorMembershipId: row.approver_membership_id,
    createdBy: null,
  });

  const [{ data: app }, { data: tenant }] = await Promise.all([
    db.from("app").select("name").eq("id", row.app_id).maybeSingle(),
    db.from("tenant").select("organization_name").eq("tenant_id", row.tenant_id).maybeSingle(),
  ]);

  // Audit attribution: best-effort, and deliberately after the mint — a
  // failure here must not turn a successful key issuance into a reported
  // error (same "auditQuietly" discipline features/api-keys/actions.ts
  // uses, reimplemented here since there is no ctx to call getUser() on).
  try {
    const approverUserId = row.approver_membership_id
      ? await resolveApproverUserId(row.approver_membership_id)
      : null;
    const label = row.approver_membership_id
      ? (await resolveMemberDisplayNames(row.tenant_id, [row.approver_membership_id]))[
          row.approver_membership_id
        ]
      : undefined;
    await writeAuditLog({
      tenantId: row.tenant_id,
      actorId: approverUserId,
      actorLabel: label ?? null,
      actionType: "api_key_created",
      targetType: "api_key",
      targetId: keyRow.id,
      targetIdentifier: keyRow.name as string,
      details: { app_id: row.app_id, environment_id: row.environment_id, via: "device_login" },
      afterState: { permissions: ["trace.write"] },
    });
  } catch {
    // Deliberately empty — see the docstring above.
  }

  return {
    plaintext,
    appName: (app?.name as string | undefined) ?? "",
    orgName: (tenant?.organization_name as string | undefined) ?? null,
  };
}
