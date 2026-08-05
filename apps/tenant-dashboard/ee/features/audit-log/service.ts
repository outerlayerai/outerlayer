import "server-only";

import {
  getEntitlement,
  listAuditLogEntries,
  getAuditLogEntryDetail,
  listAuditLogEntriesForExport,
  auditLogRowsToCsv,
} from "@/lib/adapters";
import type {
  ActionType,
  TargetType,
  AuditLogListItem,
  AuditLogDetail,
  PaginatedResponse,
} from "@/types/platform-admin";

/**
 * The org needs the Enterprise `audit_log` entitlement to view/export its
 * trail (recording itself is always on, unconditionally). Shared preamble
 * for every read below.
 */
async function requireAuditLogEntitlement(
  tenantId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entitled = await getEntitlement(tenantId, "audit_log");
  if (!entitled) return { ok: false, error: "The audit log requires an Enterprise plan" };
  return { ok: true };
}

interface AuditLogListParams {
  page?: number;
  pageSize?: number;
  actionType?: ActionType;
  targetType?: TargetType;
  /** ISO bounds derived from the date filters (To is end-of-day inclusive). */
  startDate?: string;
  endDate?: string;
}

/**
 * Called both directly from the settings React Server Component (RSC) page (initial paint) and
 * through `listAuditLogAction` (the table's own subsequent page/filter
 * fetches).
 */
export async function listAuditLog(
  tenantId: string,
  params: AuditLogListParams,
): Promise<{ data?: PaginatedResponse<AuditLogListItem>; error?: string }> {
  const access = await requireAuditLogEntitlement(tenantId);
  if (!access.ok) return { error: access.error };

  return listAuditLogEntries({
    page: params.page ?? 1,
    pageSize: params.pageSize ?? 25,
    actionType: params.actionType,
    targetType: params.targetType,
    startDate: params.startDate,
    endDate: params.endDate,
    tenantId,
  });
}

export async function getAuditLogDetail(
  tenantId: string,
  logId: string,
): Promise<{ data?: AuditLogDetail; error?: string }> {
  const access = await requireAuditLogEntitlement(tenantId);
  if (!access.ok) return { error: access.error };

  return getAuditLogEntryDetail(logId, { tenantId });
}

/**
 * Full-trail CSV export (SIEM ingestion, compliance evidence). The CSV
 * encoder guards spreadsheet formula injection and never includes the chain
 * internals (seq/hashes).
 */
export async function exportAuditLog(
  tenantId: string,
): Promise<{ data?: { csv: string; filename: string }; error?: string }> {
  const access = await requireAuditLogEntitlement(tenantId);
  if (!access.ok) return { error: access.error };

  const rows = await listAuditLogEntriesForExport(tenantId);
  if (rows.error || !rows.data) return { error: rows.error ?? "Failed to export audit logs" };

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    data: {
      csv: auditLogRowsToCsv(rows.data),
      filename: `audit-log-${stamp}.csv`,
    },
  };
}
