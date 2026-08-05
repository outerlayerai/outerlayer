import "server-only";

import { getAdminDataClient } from '../admin-client';
import { AuditLogService, type AuditLogEntry } from './audit-log-service';

export {
  AuditLogService,
  captureRequestContext,
  type AuditLogEntry,
} from './audit-log-service';

/**
 * Denied WRITE attempts are audit-worthy (someone tried a mutation they are
 * not allowed to make); denied reads are just UI noise and would flood the
 * trail. Suffixes mirror the granular app_permission verbs. This is the one
 * definition — every denial-audit call site (the legacy tenant/app permission
 * checks, and each `authorizedAction` slice's own denial hook) imports it
 * from here rather than declaring its own copy.
 */
export const AUDITED_PERMISSION_SUFFIXES = new Set([
  "insert",
  "update",
  "delete",
  "write",
  "promote",
  "run",
  "review",
]);

export function isAuditedPermission(permission: string): boolean {
  const verb = permission.split(".").pop() ?? "";
  return AUDITED_PERMISSION_SUFFIXES.has(verb);
}

/**
 * The audit-log write seam for callers outside `lib/system` — constructs the
 * service-role client internally so a feature slice never needs its own
 * `getAdminDataClient()` call to record an entry. `audit_log`'s only INSERT
 * policy is `auth.role() = 'service_role'`, so this is the one sanctioned
 * write path.
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  await new AuditLogService({ db: getAdminDataClient() }).create(entry);
}
