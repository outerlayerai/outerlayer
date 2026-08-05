"use server";
import "server-only";

/**
 * Tenant-facing audit trail reads (Settings -> Audit log). The list read is
 * seeded server-side by the settings page React Server Component (RSC) (`listAuditLog` called
 * directly, `// live:` not applicable — it's a per-request server render,
 * not a client poll); `listAuditLogAction` exists for the shared
 * `AuditLogTable`'s own subsequent page/filter fetches, which it drives
 * itself via a client callback (its contract is unchanged). Detail stays an
 * on-demand dialog fetch — not a live-view escape, so it needs no RSC
 * conversion. Export returns CSV bytes.
 */

import { authorizedAction } from "@/lib/action-kit";
import { Permissions } from "@/utils/permissions";
import type { ActionType, TargetType } from "@/types/platform-admin";
import {
  listAuditLogInputSchema,
  getAuditLogDetailInputSchema,
  exportAuditLogInputSchema,
} from "./schemas";
import { listAuditLog, getAuditLogDetail, exportAuditLog } from "./service";

export const listAuditLogAction = authorizedAction({
  input: listAuditLogInputSchema,
  permission: Permissions.AUDIT_LOG_READ,
  handler: (ctx, input) =>
    listAuditLog(ctx.tenantId, {
      page: input.page,
      pageSize: input.pageSize,
      actionType: input.actionType as ActionType | undefined,
      targetType: input.targetType as TargetType | undefined,
      startDate: input.startDate,
      endDate: input.endDate,
    }),
});

export const getAuditLogDetailAction = authorizedAction({
  input: getAuditLogDetailInputSchema,
  permission: Permissions.AUDIT_LOG_READ,
  handler: (ctx, input) => getAuditLogDetail(ctx.tenantId, input.logId),
});

export const exportAuditLogAction = authorizedAction({
  input: exportAuditLogInputSchema,
  permission: Permissions.AUDIT_LOG_READ,
  handler: (ctx) => exportAuditLog(ctx.tenantId),
});
